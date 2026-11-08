import type { TenantContext } from '../tenancy/context';

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead_letter'] as const;
export type JobState = typeof JOB_STATES[number];
export type JobStepState = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface PersistentJob {
  id: string;
  workspaceId: string;
  queueName: string;
  kind: string;
  aggregateType: string | null;
  aggregateId: string | null;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  state: JobState;
  priority: number;
  maxAttempts: number;
  attemptCount: number;
  availableAt: string;
  leaseOwner: string | null;
  fencingToken: number;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  lastError: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
export interface JobLease {
  job: PersistentJob;
  attemptId: string;
  attemptNumber: number;
  workerId: string;
  fencingToken: number;
  leaseExpiresAt: string;
}
export interface EnqueueJobInput {
  queueName: string;
  kind: string;
  aggregateType?: string | null;
  aggregateId?: string | null;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  availableAt: string;
}
export interface ClaimJobInput {
  queueName: string;
  workerId: string;
  leaseMs: number;
  now: string;
}

export interface LeaseIdentity {
  workspaceId: string;
  jobId: string;
  workerId: string;
  fencingToken: number;
  now: string;
}

export interface HeartbeatJobInput extends LeaseIdentity {
  leaseMs: number;
}

export interface CompleteJobInput extends LeaseIdentity {}

export interface FailJobInput extends LeaseIdentity {
  error: string;
  retryable: boolean;
  retryAt?: string;
}

export interface SaveJobStepInput extends LeaseIdentity {
  stepKey: string;
  status: JobStepState;
  checkpoint: Record<string, unknown>;
  outputRef?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
}

export interface RequeueTerminalJobInput {
  workspaceId: string;
  jobId: string;
  /** Compare-and-swap guard from the terminal job snapshot being reconciled. */
  expectedVersion: number;
  /** Stable per operator/reconciler decision; repeating it is a no-op. */
  recoveryKey: string;
  reason: string;
  availableAt: string;
}

export interface RequeueTerminalJobResult {
  job: PersistentJob;
  requeued: boolean;
}

export class JobQueueError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'JobQueueError';
  }
}

export interface JobQueueRepository {
  enqueue(tenant: Pick<TenantContext, 'workspaceId'>, input: EnqueueJobInput):
    Promise<{ job: PersistentJob; created: boolean }>;
  claim(input: ClaimJobInput): Promise<JobLease | null>;
  heartbeat(input: HeartbeatJobInput): Promise<PersistentJob>;
  complete(input: CompleteJobInput): Promise<PersistentJob>;
  fail(input: FailJobInput): Promise<PersistentJob>;
  /**
   * Adds one recoverable attempt to failed/dead-letter work without deleting
   * prior attempts or step checkpoints. Callers must first reconcile any paid
   * or external side effect and supply an idempotent recoveryKey.
   */
  requeueTerminal(input: RequeueTerminalJobInput): Promise<RequeueTerminalJobResult>;
  saveStep(input: SaveJobStepInput): Promise<void>;
  get(tenant: Pick<TenantContext, 'workspaceId'>, jobId: string): Promise<PersistentJob | null>;
}
