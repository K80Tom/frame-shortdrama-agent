import { RuntimeWorkerError, type WorkerLeaseSnapshot } from './contracts';
import type { WorkerInstanceLeaseManager } from './instance-lease';

/**
 * 可挂载到 Worker 运行时的最小任务接口（移植自融光 worker 拓扑）：
 * start 收到 abort 信号后应在 stop 语义下尽快收尾；stop 用于优雅排空。
 */
export interface RuntimeTask {
  readonly name: string;
  start(signal: AbortSignal): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface WorkerRuntimeOptions {
  readonly lease: WorkerInstanceLeaseManager;
  readonly tasks: readonly RuntimeTask[];
  readonly now?: () => number;
  /** 心跳调度器（默认 setTimeout）；测试注入手动调度即可覆盖全生命周期。 */
  scheduleHeartbeat?: (callback: () => void, timeoutMs: number) => () => void;
  /** 租约丢失/被抢占回调（用于上报与进程退出决策）。 */
  onLeaseLost?: (error: RuntimeWorkerError, snapshot: WorkerLeaseSnapshot | null) => void;
}

export type WorkerRuntimeState = 'idle' | 'starting' | 'running' | 'draining' | 'stalled' | 'stopped';

/**
 * Worker 运行时：实例租约 + 可挂载任务。
 *
 * - start：先拿租约（同 role 互斥），再逐个启动任务（传入 abort 信号）；
 * - 心跳循环每 heartbeatIntervalMs 续约一次；续约失败（丢失/被抢占）视为
 *   崩溃抢占响应：中止全部任务、进入 stalled、触发 onLeaseLost；
 * - stop：停止心跳 → 通知任务排空 → 释放租约。
 */
export class WorkerRuntime {
  private state: WorkerRuntimeState = 'idle';
  private abortController: AbortController | null = null;
  private cancelHeartbeat: (() => void) | null = null;
  private heartbeatInFlight: Promise<void> | null = null;

  constructor(private readonly options: WorkerRuntimeOptions) {
    if (!Array.isArray(options.tasks) || options.tasks.length === 0) {
      throw new RuntimeWorkerError('LEASE_CONFIG_INVALID', 'Worker 至少需要挂载一个任务。');
    }
    const names = new Set<string>();
    for (const task of options.tasks) {
      if (names.has(task.name)) throw new RuntimeWorkerError('LEASE_CONFIG_INVALID', `任务名称重复：${task.name}`);
      names.add(task.name);
    }
  }

  get currentState(): WorkerRuntimeState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new RuntimeWorkerError('LEASE_NOT_ACTIVE',
        `Worker 当前状态 ${this.state} 不允许启动；停止后需以新实例身份重建 WorkerRuntime。`);
    }
    this.state = 'starting';
    const snapshot = await this.options.lease.acquire();
    this.abortController = new AbortController();
    for (const task of this.options.tasks) {
      await task.start(this.abortController.signal);
    }
    this.state = 'running';
    this.scheduleNextHeartbeat();
    return void snapshot;
  }

  /** 立即执行一次心跳；失败时触发租约丢失流程。 */
  async heartbeatOnce(): Promise<void> {
    if (this.state !== 'running' && this.state !== 'starting') return;
    if (this.heartbeatInFlight) return this.heartbeatInFlight;
    this.heartbeatInFlight = (async () => {
      try {
        await this.options.lease.renew();
      } catch (error) {
        await this.handleLeaseLost(error);
      } finally {
        this.heartbeatInFlight = null;
      }
    })();
    return this.heartbeatInFlight;
  }

  /** 优雅停机：中止任务并等待排空，然后释放租约。 */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'idle') return;
    const wasRunning = this.state === 'running';
    this.state = 'draining';
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = null;
    if (wasRunning) {
      this.abortController?.abort();
      for (const task of [...this.options.tasks].reverse()) {
        await task.stop();
      }
    }
    await this.options.lease.release().catch(error => {
      if (error instanceof RuntimeWorkerError && error.code === 'LEASE_STORE_UNAVAILABLE') throw error;
      return undefined;
    });
    this.state = 'stopped';
  }

  private scheduleNextHeartbeat(): void {
    const schedule = this.options.scheduleHeartbeat ?? ((callback: () => void, timeoutMs: number) => {
      const timer = setTimeout(callback, timeoutMs);
      return () => clearTimeout(timer);
    });
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = schedule(() => {
      void this.heartbeatOnce().then(() => {
        if (this.state === 'running') this.scheduleNextHeartbeat();
      });
    }, this.options.lease.heartbeatIntervalMs);
  }

  private async handleLeaseLost(error: unknown): Promise<void> {
    const leaseError = error instanceof RuntimeWorkerError
      ? error
      : new RuntimeWorkerError('LEASE_LOST', '租约续约失败。', error);
    if (leaseError.code !== 'LEASE_LOST' && leaseError.code !== 'LEASE_PREEMPTED'
      && leaseError.code !== 'LEASE_STORE_UNAVAILABLE') {
      throw leaseError;
    }
    if (leaseError.code === 'LEASE_STORE_UNAVAILABLE') {
      // 存储暂不可用不放弃租约，等待下一次心跳重试。
      return;
    }
    this.state = 'stalled';
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = null;
    this.abortController?.abort();
    this.options.onLeaseLost?.(leaseError, this.options.lease.snapshot);
  }
}
