// 候选门禁闭环仓储（#135）：接口 + InMemory 实现（测试与本地演示）。
// Postgres 实现见 gate-postgres-repository.ts；两者行为一致（含 CAS 与 append-only 语义）。

import { EvolutionGateError } from '@lyra/shared';
import type {
  EvolutionAuditEvent, EvolutionCandidate, EvolutionGateBinding, EvolutionRollout,
} from '@lyra/shared';

export interface EvolutionGateRepository {
  /** Verify the current trusted principal against live membership, within the command transaction. */
  authorizePublisher(workspaceId: string, actorId?: string): Promise<void>;
  /** All writes in a service command commit or roll back together. */
  atomic<T>(work: (repository: EvolutionGateRepository) => Promise<T>): Promise<T>;
  insertCandidate(candidate: EvolutionCandidate): Promise<void>;
  getCandidate(workspaceId: string, candidateId: string): Promise<EvolutionCandidate | null>;
  /** 同一 proposal_key 已存在的 Candidate 数（含全部非删除状态）。 */
  countCandidatesByProposal(workspaceId: string, proposalKey: string): Promise<number>;
  /** CAS 状态更新：仅当 state_version 匹配时写入；返回是否成功。 */
  updateCandidateState(workspaceId: string, candidateId: string, expectedVersion: number,
    next: EvolutionCandidate): Promise<boolean>;
  insertBinding(binding: EvolutionGateBinding): Promise<void>;
  getLatestBinding(workspaceId: string, candidateId: string): Promise<EvolutionGateBinding | null>;
  insertRollout(rollout: EvolutionRollout): Promise<void>;
  listCandidateRollouts(workspaceId: string, candidateId: string): Promise<EvolutionRollout[]>;
  getRollout(workspaceId: string, rolloutId: string): Promise<EvolutionRollout | null>;
  updateRollout(workspaceId: string, rolloutId: string, expectedVersion: number,
    next: EvolutionRollout): Promise<boolean>;
  /** 追加 Registry Revision；租户+域+作用域内 revision 冲突返回 false。 */
  insertRegistryRevision(revision: EvolutionRegistryRevision): Promise<boolean>;
  listRegistryRevisions(workspaceId: string, domain: string): Promise<EvolutionRegistryRevision[]>;
  appendAudit(event: EvolutionAuditEvent): Promise<void>;
  listAudit(workspaceId: string, candidateId: string): Promise<EvolutionAuditEvent[]>;
}

/** Registry Revision（Promote/Rollback 都是新行；历史保留）。 */
export interface EvolutionRegistryRevision {
  id: string;
  workspaceId: string;
  domain: string;
  scope: 'platform' | 'workspace' | 'project';
  projectId: string | null;
  revision: number;
  action: 'promote' | 'rollback';
  candidateId: string | null;
  candidateDigest: string | null;
  activeDigest: string;
  activeRevision: string;
  previousDigest: string | null;
  reason: string;
  actor: string;
  rolloutId: string | null;
  createdAt: string;
}

export function randomEvolutionId(prefix: string): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${prefix}_${hex}`;
}

export class InMemoryEvolutionGateRepository implements EvolutionGateRepository {
  private readonly candidates = new Map<string, EvolutionCandidate>();
  private readonly bindings: EvolutionGateBinding[] = [];
  private readonly rollouts = new Map<string, EvolutionRollout>();
  private readonly revisions: EvolutionRegistryRevision[] = [];
  private readonly audit: EvolutionAuditEvent[] = [];

  constructor(private readonly publisherPolicy: (workspaceId: string, actorId?: string) => boolean = () => false) {}

  async authorizePublisher(workspaceId: string, actorId?: string): Promise<void> {
    if (!this.publisherPolicy(workspaceId, actorId)) {
      throw new EvolutionGateError(403, 'EVOLUTION_PUBLISHER_REQUIRED', '当前主体没有工作区发布权限。');
    }
  }

  private pending: Promise<void> = Promise.resolve();

  async atomic<T>(work: (repository: EvolutionGateRepository) => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const scoped = new InMemoryEvolutionGateRepository(this.publisherPolicy);
      for (const [id, value] of this.candidates) scoped.candidates.set(id, structuredClone(value));
      for (const [id, value] of this.rollouts) scoped.rollouts.set(id, structuredClone(value));
      scoped.bindings.push(...structuredClone(this.bindings));
      scoped.revisions.push(...structuredClone(this.revisions));
      scoped.audit.push(...structuredClone(this.audit));
      const result = await work(scoped);
      this.candidates.clear();
      for (const [id, value] of scoped.candidates) this.candidates.set(id, value);
      this.rollouts.clear();
      for (const [id, value] of scoped.rollouts) this.rollouts.set(id, value);
      this.bindings.splice(0, this.bindings.length, ...scoped.bindings);
      this.revisions.splice(0, this.revisions.length, ...scoped.revisions);
      this.audit.splice(0, this.audit.length, ...scoped.audit);
      return result;
    } finally { release(); }
  }

  async insertCandidate(candidate: EvolutionCandidate): Promise<void> {
    if (this.candidates.has(candidate.candidateId)) {
      throw new Error(`duplicate candidate ${candidate.candidateId}`);
    }
    this.candidates.set(candidate.candidateId, structuredClone(candidate));
  }

  async getCandidate(workspaceId: string, candidateId: string): Promise<EvolutionCandidate | null> {
    const candidate = this.candidates.get(candidateId);
    return candidate && candidate.workspaceId === workspaceId ? structuredClone(candidate) : null;
  }

  async countCandidatesByProposal(workspaceId: string, proposalKey: string): Promise<number> {
    let count = 0;
    for (const candidate of this.candidates.values()) {
      if (candidate.workspaceId === workspaceId && candidate.proposalKey === proposalKey) count += 1;
    }
    return count;
  }

  async updateCandidateState(workspaceId: string, candidateId: string, expectedVersion: number,
    next: EvolutionCandidate): Promise<boolean> {
    const current = this.candidates.get(candidateId);
    if (!current || current.workspaceId !== workspaceId) return false;
    if (current.stateVersion !== expectedVersion) return false;
    this.candidates.set(candidateId, structuredClone(next));
    return true;
  }

  async insertBinding(binding: EvolutionGateBinding): Promise<void> {
    this.bindings.push(structuredClone(binding));
  }

  async getLatestBinding(workspaceId: string, candidateId: string): Promise<EvolutionGateBinding | null> {
    for (const binding of [...this.bindings].reverse()) {
      if (binding.workspaceId === workspaceId && binding.candidateId === candidateId) {
        return structuredClone(binding);
      }
    }
    return null;
  }

  async insertRollout(rollout: EvolutionRollout): Promise<void> {
    if (this.rollouts.has(rollout.rolloutId)) throw new Error(`duplicate rollout ${rollout.rolloutId}`);
    this.rollouts.set(rollout.rolloutId, structuredClone(rollout));
  }

  async listCandidateRollouts(workspaceId: string, candidateId: string): Promise<EvolutionRollout[]> {
    return [...this.rollouts.values()].filter(row => row.workspaceId === workspaceId
      && row.candidateId === candidateId).map(row => structuredClone(row));
  }

  async getRollout(workspaceId: string, rolloutId: string): Promise<EvolutionRollout | null> {
    const rollout = this.rollouts.get(rolloutId);
    return rollout && rollout.workspaceId === workspaceId ? structuredClone(rollout) : null;
  }

  async updateRollout(workspaceId: string, rolloutId: string, expectedVersion: number,
    next: EvolutionRollout): Promise<boolean> {
    const current = this.rollouts.get(rolloutId);
    if (!current || current.workspaceId !== workspaceId) return false;
    if (current.stateVersion !== expectedVersion) return false;
    this.rollouts.set(rolloutId, structuredClone(next));
    return true;
  }

  async insertRegistryRevision(revision: EvolutionRegistryRevision): Promise<boolean> {
    const clash = this.revisions.some(existing => existing.workspaceId === revision.workspaceId
      && existing.domain === revision.domain && existing.scope === revision.scope
      && (existing.projectId ?? '') === (revision.projectId ?? '')
      && existing.revision === revision.revision);
    if (clash) return false;
    this.revisions.push(structuredClone(revision));
    return true;
  }

  async listRegistryRevisions(workspaceId: string, domain: string): Promise<EvolutionRegistryRevision[]> {
    return this.revisions
      .filter(revision => revision.workspaceId === workspaceId && revision.domain === domain)
      .map(revision => structuredClone(revision));
  }

  async appendAudit(event: EvolutionAuditEvent): Promise<void> {
    this.audit.push(structuredClone(event));
  }

  async listAudit(workspaceId: string, candidateId: string): Promise<EvolutionAuditEvent[]> {
    return this.audit
      .filter(event => event.workspaceId === workspaceId && event.candidateId === candidateId)
      .map(event => structuredClone(event));
  }
}
