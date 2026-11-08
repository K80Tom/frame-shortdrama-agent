import { randomBytes } from 'node:crypto';
import { JobQueueError, type JobLease, type JobQueueRepository } from './contracts';
import type { JobTenantResolver } from './tenant';
import { tenantExecutionScope, type TenantExecutionScope } from '../tenancy/scope';

export interface JobHandlerContext {
  readonly lease: JobLease;
  readonly signal: AbortSignal;
  checkpoint(stepKey: string, checkpoint: Record<string, unknown>,
    outputRef?: Record<string, unknown> | null): Promise<void>;
  assertLease(): Promise<void>;
}

export interface JobHandler {
  readonly queueName: string;
  readonly kind: string;
  handle(context: JobHandlerContext): Promise<void>;
}

export class NonRetryableJobError extends Error {
  readonly retryable = false;
  constructor(message: string) { super(message); this.name = 'NonRetryableJobError'; }
}

export interface PersistentJobWorkerOptions {
  workerId?: string;
  leaseMs?: number;
  pollIntervalMs?: number;
  retryBaseMs?: number;
  now?: () => Date;
  executionScope?: Pick<TenantExecutionScope, 'runAsSystem' | 'runWithTenant'>;
  logger?: Pick<Console, 'warn'>;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, 2_000);
  return '任务处理失败。';
}

function unref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  timer.unref?.();
}

/** Durable, at-least-once job worker with lease heartbeats and fencing. */
export class PersistentJobWorker {
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly retryBaseMs: number;
  private readonly now: () => Date;
  private readonly executionScope: Pick<TenantExecutionScope, 'runAsSystem' | 'runWithTenant'>;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly queues: string[];
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly repository: JobQueueRepository,
    private readonly tenantResolver: JobTenantResolver,
    handlers: readonly JobHandler[],
    options: PersistentJobWorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `worker-${process.pid}-${randomBytes(8).toString('hex')}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 750;
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    this.now = options.now ?? (() => new Date());
    this.executionScope = options.executionScope ?? tenantExecutionScope;
    this.logger = options.logger ?? console;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 3_000 || this.leaseMs > 86_400_000) {
      throw new Error('leaseMs must be 3000..86400000');
    }
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 10 || this.pollIntervalMs > 60_000) {
      throw new Error('pollIntervalMs must be 10..60000');
    }
    if (!Number.isSafeInteger(this.retryBaseMs) || this.retryBaseMs < 0 || this.retryBaseMs > 3_600_000) {
      throw new Error('retryBaseMs must be 0..3600000');
    }
    for (const handler of handlers) {
      const key = this.handlerKey(handler.queueName, handler.kind);
      if (this.handlers.has(key)) throw new Error(`Duplicate job handler: ${key}`);
      this.handlers.set(key, handler);
    }
    this.queues = [...new Set(handlers.map(handler => handler.queueName))].sort();
    if (!this.queues.length) throw new Error('At least one job handler is required');
  }

  start(): void {
    if (this.running) return;
    this.controller = new AbortController();
    this.running = this.run(this.controller.signal);
  }

  async stop(): Promise<void> {
    this.controller?.abort(new Error('Worker shutdown requested'));
    await this.running;
    this.running = undefined;
    this.controller = undefined;
  }

  async runOnce(queueName: string): Promise<boolean> {
    const lease = await this.executionScope.runAsSystem('jobs.claim', () => this.repository.claim({
      queueName,
      workerId: this.workerId,
      leaseMs: this.leaseMs,
      now: this.timestamp(),
    }));
    if (!lease) return false;
    let tenant;
    try {
      tenant = await this.tenantResolver.resolve(lease.job.workspaceId, lease.job.id);
    } catch (error) {
      await this.executionScope.runAsSystem('jobs.tenant.failure', () => this.failLease(lease, error, true));
      return true;
    }
    await this.executionScope.runWithTenant(tenant, () => this.executeLease(lease));
    return true;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let worked = false;
      for (const queue of this.queues) {
        if (signal.aborted) break;
        try { worked = await this.runOnce(queue) || worked; }
        catch (error) { this.logger.warn(`Job worker poll failed for queue ${queue}: ${messageOf(error)}`); }
      }
      if (!worked && !signal.aborted) await this.wait(this.pollIntervalMs, signal);
    }
  }

  private async executeLease(lease: JobLease): Promise<void> {
    const handler = this.handlers.get(this.handlerKey(lease.job.queueName, lease.job.kind));
    const controller = new AbortController();
    let leaseLost = false;
    let heartbeatInFlight: Promise<void> | undefined;
    const heartbeat = async () => {
      if (heartbeatInFlight) return heartbeatInFlight;
      heartbeatInFlight = this.repository.heartbeat({
        workspaceId: lease.job.workspaceId,
        jobId: lease.job.id,
        workerId: lease.workerId,
        fencingToken: lease.fencingToken,
        leaseMs: this.leaseMs,
        now: this.timestamp(),
      }).then(() => undefined).catch(error => {
        leaseLost = true;
        controller.abort(error);
        throw error;
      }).finally(() => { heartbeatInFlight = undefined; });
      return heartbeatInFlight;
    };
    const timer = setInterval(() => { void heartbeat().catch(() => undefined); }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    unref(timer);
    const identity = () => ({
      workspaceId: lease.job.workspaceId,
      jobId: lease.job.id,
      workerId: lease.workerId,
      fencingToken: lease.fencingToken,
      now: this.timestamp(),
    });
    try {
      if (!handler) throw new NonRetryableJobError(`Unsupported job kind: ${lease.job.kind}`);
      await handler.handle({
        lease,
        signal: controller.signal,
        assertLease: heartbeat,
        checkpoint: async (stepKey, checkpoint, outputRef = null) => {
          await this.repository.saveStep({ ...identity(), stepKey, status: 'succeeded', checkpoint, outputRef });
        },
      });
      if (heartbeatInFlight) await heartbeatInFlight;
      if (leaseLost) return;
      await this.repository.complete(identity());
    } catch (error) {
      if (leaseLost || error instanceof JobQueueError && error.code === 'JOB_LEASE_LOST') return;
      await this.failLease(lease, error, !(error instanceof NonRetryableJobError));
    } finally {
      clearInterval(timer);
      controller.abort(new Error('Job attempt finished'));
    }
  }

  private async failLease(lease: JobLease, error: unknown, retryable: boolean): Promise<void> {
    const exponent = Math.min(Math.max(0, lease.attemptNumber - 1), 10);
    const retryAt = new Date(this.now().getTime() + this.retryBaseMs * (2 ** exponent)).toISOString();
    try {
      await this.repository.fail({
        workspaceId: lease.job.workspaceId,
        jobId: lease.job.id,
        workerId: lease.workerId,
        fencingToken: lease.fencingToken,
        now: this.timestamp(),
        error: messageOf(error),
        retryable,
        ...(retryable ? { retryAt } : {}),
      });
    } catch (failure) {
      if (!(failure instanceof JobQueueError) || failure.code !== 'JOB_LEASE_LOST') throw failure;
    }
  }

  private handlerKey(queueName: string, kind: string): string { return `${queueName}\0${kind}`; }
  private timestamp(): string { return this.now().toISOString(); }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, ms);
      unref(timer);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}
