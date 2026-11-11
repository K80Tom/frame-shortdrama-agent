// 候选门禁闭环 Postgres 仓储（#135）。
// 租户来源与 PostgresEvolutionRepository 一致：会话变量 lyra_current_workspace_id()
// 是唯一权威（认证事务设置），绝不信任调用方传入的租户参数；方法签名中的
// workspaceId 仅用于 InMemory 实现的隔离语义，SQL 一律走会话变量。

import type { PoolClient } from 'pg';
import type { PostgresDatabase } from '../db/client';
import type {
  EvolutionAuditEvent, EvolutionCandidate, EvolutionGateBinding, EvolutionRollout,
} from '@lyra/shared';
import { ProductionError, EvolutionGateError } from '@lyra/shared';
import type { EvolutionGateRepository, EvolutionRegistryRevision } from './gate-repository';

const WS = "COALESCE(lyra_current_workspace_id(), 'ws_00000000000000000000000000000000')";

function failure(error: unknown): never {
  if (error instanceof ProductionError) throw error;
  throw new ProductionError(503, 'EVOLUTION_GATE_PERSISTENCE_UNAVAILABLE', '候选门禁数据暂时不可用，请稍后重试。');
}

interface CandidateRow {
  candidate_id: string; candidate_digest: string; workspace_id: string;
  domain: EvolutionCandidate['domain']; scope: EvolutionCandidate['scope']; project_id: string | null;
  state: EvolutionCandidate['state']; baseline_revision: string; baseline_digest: string;
  candidate_revision: string; payload_json: Record<string, unknown>; proposal_key: string;
  generated_by: EvolutionCandidate['generatedBy']; token_limit: number; cost_limit_minor: number;
  currency: string; max_candidates: number; created_by: string;
  created_at: string; updated_at: string; state_version: number; state_digest: string;
}

function mapCandidate(row: CandidateRow): EvolutionCandidate {
  const payload = row.payload_json as { diff: EvolutionCandidate['diff']; summary: string };
  return {
    candidateId: row.candidate_id,
    workspaceId: row.workspace_id,
    domain: row.domain,
    scope: row.scope,
    projectId: row.project_id,
    state: row.state,
    baselineRevision: row.baseline_revision,
    baselineDigest: row.baseline_digest,
    candidateRevision: row.candidate_revision,
    candidateDigest: row.candidate_digest,
    diff: payload.diff,
    summary: payload.summary,
    generatedBy: row.generated_by,
    generatorVersion: String((payload as { generatorVersion?: unknown }).generatorVersion ?? ''),
    tokenLimit: row.token_limit,
    costLimitMinor: row.cost_limit_minor,
    currency: row.currency,
    proposalKey: row.proposal_key,
    maxCandidatesPerProposal: row.max_candidates,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    stateVersion: row.state_version,
    stateDigest: row.state_digest,
  };
}

export class PostgresEvolutionGateRepository implements EvolutionGateRepository {
  constructor(private readonly database: Pick<PostgresDatabase, 'query' | 'transaction'>) {}

  async authorizePublisher(workspaceId: string, actorId?: string): Promise<void> {
    const allowed = await this.database.query(`
      SELECT m.user_id FROM workspace_members m
      JOIN users u ON u.id = m.user_id
      JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.workspace_id = $1 AND m.workspace_id = lyra_current_workspace_id()
        AND m.user_id = NULLIF(current_setting('lyra.user_id', true), '')
        AND ($2::text IS NULL OR m.user_id = $2)
        AND m.status = 'active' AND m.role IN ('owner', 'admin')
        AND u.status = 'active' AND u.kind = 'human' AND w.status = 'active'
      FOR SHARE OF m, u, w`, [workspaceId, actorId ?? null]);
    if (allowed.rowCount !== 1) {
      throw new EvolutionGateError(403, 'EVOLUTION_PUBLISHER_REQUIRED', '当前主体没有工作区发布权限。');
    }
  }

  async atomic<T>(work: (repository: EvolutionGateRepository) => Promise<T>): Promise<T> {
    return this.database.transaction(client => work(new PostgresEvolutionGateRepository({
      query: (text, values = []) => client.query(text, [...values]),
      transaction: callback => callback(client),
    })));
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    try { return await this.database.transaction(work); } catch (error) { return failure(error); }
  }

  async insertCandidate(candidate: EvolutionCandidate): Promise<void> {
    await this.transaction(async client => {
      await client.query(
        `INSERT INTO evolution_gate_candidates (candidate_id, candidate_digest, workspace_id, domain, scope,
           project_id, state, baseline_revision, baseline_digest, candidate_revision, payload_json,
           proposal_key, generated_by, token_limit, cost_limit_minor, currency, max_candidates,
           created_by, created_at, updated_at, state_version, state_digest)
         VALUES ($1,$2,${WS},$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [candidate.candidateId, candidate.candidateDigest, candidate.domain, candidate.scope,
          candidate.projectId, candidate.state, candidate.baselineRevision, candidate.baselineDigest,
          candidate.candidateRevision, JSON.stringify({
            diff: candidate.diff, summary: candidate.summary, generatorVersion: candidate.generatorVersion,
          }), candidate.proposalKey, candidate.generatedBy, candidate.tokenLimit, candidate.costLimitMinor,
          candidate.currency, candidate.maxCandidatesPerProposal, candidate.createdBy,
          candidate.createdAt, candidate.updatedAt, candidate.stateVersion, candidate.stateDigest]);
    });
  }

  async getCandidate(workspaceId: string, candidateId: string): Promise<EvolutionCandidate | null> {
    void workspaceId;
    try {
      const result = await this.database.query(
        `SELECT * FROM evolution_gate_candidates WHERE candidate_id = $1 AND workspace_id = ${WS}`, [candidateId]);
      const row = result.rows[0] as CandidateRow | undefined;
      return row ? mapCandidate(row) : null;
    } catch (error) { return failure(error); }
  }

  async countCandidatesByProposal(workspaceId: string, proposalKey: string): Promise<number> {
    void workspaceId;
    try {
      const result = await this.database.query(
        `SELECT count(*)::int AS count FROM evolution_gate_candidates WHERE proposal_key = $1 AND workspace_id = ${WS}`,
        [proposalKey]);
      return (result.rows[0] as { count: number } | undefined)?.count ?? 0;
    } catch (error) { return failure(error); }
  }

  async updateCandidateState(workspaceId: string, candidateId: string, expectedVersion: number,
    next: EvolutionCandidate): Promise<boolean> {
    void workspaceId;
    return this.transaction(async client => {
      const result = await client.query(
        `UPDATE evolution_gate_candidates SET state = $3, state_version = $4, state_digest = $5, updated_at = $6
         WHERE candidate_id = $1 AND workspace_id = ${WS} AND state_version = $2`,
        [candidateId, expectedVersion, next.state, next.stateVersion, next.stateDigest, next.updatedAt]);
      return (result.rowCount ?? 0) === 1;
    });
  }

  async insertBinding(binding: EvolutionGateBinding): Promise<void> {
    await this.transaction(async client => {
      await client.query(
        `INSERT INTO evolution_gate_bindings (binding_id, workspace_id, candidate_id, candidate_digest,
           baseline_digest, decision, rule_version, verdict_json, decision_digest, bound_at)
         VALUES ($1,${WS},$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
        [binding.bindingId, binding.candidateId, binding.candidateDigest, binding.baselineDigest,
          binding.verdict.decision, binding.verdict.ruleVersion, binding.verdict,
          binding.verdict.decisionDigest, binding.boundAt]);
    });
  }

  async getLatestBinding(workspaceId: string, candidateId: string): Promise<EvolutionGateBinding | null> {
    void workspaceId;
    try {
      const result = await this.database.query(
        `SELECT binding_id, candidate_id, candidate_digest, baseline_digest, verdict_json, bound_at::text
         FROM evolution_gate_bindings WHERE candidate_id = $1 AND workspace_id = ${WS}
         ORDER BY bound_at DESC, binding_id DESC LIMIT 1`, [candidateId]);
      const row = result.rows[0] as { binding_id: string; candidate_id: string; candidate_digest: string;
        baseline_digest: string; verdict_json: EvolutionGateBinding['verdict']; bound_at: string } | undefined;
      return row ? {
        bindingId: row.binding_id,
        workspaceId: '',
        candidateId: row.candidate_id,
        candidateDigest: row.candidate_digest,
        baselineDigest: row.baseline_digest,
        verdict: row.verdict_json,
        boundAt: new Date(row.bound_at).toISOString(),
      } : null;
    } catch (error) { return failure(error); }
  }

  async insertRollout(rollout: EvolutionRollout): Promise<void> {
    await this.transaction(async client => {
      await client.query(
        `INSERT INTO evolution_gate_rollouts (rollout_id, workspace_id, candidate_id, candidate_digest,
           baseline_digest, domain, scope, project_id, status, traffic_permyriad, routing_key,
           hash_algorithm, anomaly_threshold, min_runs, sample_count, candidate_count,
           consecutive_anomalies, stopped_reason, started_at, updated_at, state_version)
         VALUES ($1,${WS},$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [rollout.rolloutId, rollout.candidateId, rollout.candidateDigest, rollout.baselineDigest,
          rollout.domain, rollout.scope, rollout.projectId, rollout.status, rollout.config.trafficPermyriad,
          rollout.config.routingKey, rollout.config.hashAlgorithmVersion, rollout.config.consecutiveAnomalyThreshold,
          rollout.config.minRuns, rollout.sampleCount, rollout.candidateCount, rollout.consecutiveAnomalies,
          rollout.stoppedReason, rollout.startedAt, rollout.updatedAt, rollout.stateVersion]);
    });
  }

  private static mapRollout(row: Record<string, unknown>): EvolutionRollout {
    return {
      rolloutId: row.rollout_id as string,
      workspaceId: row.workspace_id as string,
      candidateId: row.candidate_id as string,
      candidateDigest: row.candidate_digest as string,
      baselineDigest: row.baseline_digest as string,
      domain: row.domain as EvolutionRollout['domain'],
      scope: row.scope as EvolutionRollout['scope'],
      projectId: (row.project_id as string | null) ?? null,
      config: {
        trafficPermyriad: row.traffic_permyriad as number,
        routingKey: row.routing_key as string,
        hashAlgorithmVersion: row.hash_algorithm as string,
        consecutiveAnomalyThreshold: row.anomaly_threshold as number,
        minRuns: row.min_runs as number,
      },
      status: row.status as EvolutionRollout['status'],
      sampleCount: row.sample_count as number,
      candidateCount: row.candidate_count as number,
      consecutiveAnomalies: row.consecutive_anomalies as number,
      stoppedReason: (row.stopped_reason as string | null) ?? null,
      startedAt: new Date(row.started_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString(),
      stateVersion: row.state_version as number,
    };
  }

  async listCandidateRollouts(workspaceId: string, candidateId: string): Promise<EvolutionRollout[]> {
    void workspaceId;
    try {
      const result = await this.database.query(
        `SELECT * FROM evolution_gate_rollouts WHERE workspace_id = ${WS} AND candidate_id = $1`, [candidateId]);
      return result.rows.map(row => PostgresEvolutionGateRepository.mapRollout(row));
    } catch (error) { return failure(error); }
  }

  async getRollout(workspaceId: string, rolloutId: string): Promise<EvolutionRollout | null> {
    void workspaceId;
    try {
      const result = await this.database.query(
        `SELECT * FROM evolution_gate_rollouts WHERE rollout_id = $1 AND workspace_id = ${WS}`, [rolloutId]);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? PostgresEvolutionGateRepository.mapRollout(row) : null;
    } catch (error) { return failure(error); }
  }

  async updateRollout(workspaceId: string, rolloutId: string, expectedVersion: number,
    next: EvolutionRollout): Promise<boolean> {
    void workspaceId;
    return this.transaction(async client => {
      const result = await client.query(
        `UPDATE evolution_gate_rollouts SET status = $3, sample_count = $4, candidate_count = $5,
           consecutive_anomalies = $6, stopped_reason = $7, updated_at = $8, state_version = $9
         WHERE rollout_id = $1 AND workspace_id = ${WS} AND state_version = $2`,
        [rolloutId, expectedVersion, next.status, next.sampleCount, next.candidateCount,
          next.consecutiveAnomalies, next.stoppedReason, next.updatedAt, next.stateVersion]);
      return (result.rowCount ?? 0) === 1;
    });
  }

  async insertRegistryRevision(revision: EvolutionRegistryRevision): Promise<boolean> {
    return this.transaction(async client => {
      try {
        await client.query(
          `INSERT INTO evolution_registry_revisions (id, workspace_id, domain, scope, project_id, revision,
             action, candidate_id, candidate_digest, active_digest, active_revision, previous_digest,
             reason, actor, rollout_id, created_at)
           VALUES ($1,${WS},$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [revision.id, revision.domain, revision.scope, revision.projectId, revision.revision,
            revision.action, revision.candidateId, revision.candidateDigest, revision.activeDigest,
            revision.activeRevision, revision.previousDigest, revision.reason, revision.actor,
            revision.rolloutId, revision.createdAt]);
        return true;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === '23505' || code === '23P01' || code === '23000') return false;
        throw error;
      }
    });
  }

  async listRegistryRevisions(workspaceId: string, domain: string): Promise<EvolutionRegistryRevision[]> {
    void workspaceId;
    try {
      const result = await this.database.query(
        `SELECT id, domain, scope, project_id, revision, action, candidate_id, candidate_digest,
           active_digest, active_revision, previous_digest, reason, actor, rollout_id, created_at::text
         FROM evolution_registry_revisions WHERE workspace_id = ${WS} AND domain = $1 ORDER BY revision ASC`,
        [domain]);
      return (result.rows as Record<string, unknown>[]).map(row => ({
        id: row.id as string,
        workspaceId: '',
        domain: row.domain as string,
        scope: row.scope as EvolutionRegistryRevision['scope'],
        projectId: (row.project_id as string | null) ?? null,
        revision: row.revision as number,
        action: row.action as 'promote' | 'rollback',
        candidateId: (row.candidate_id as string | null) ?? null,
        candidateDigest: (row.candidate_digest as string | null) ?? null,
        activeDigest: row.active_digest as string,
        activeRevision: row.active_revision as string,
        previousDigest: (row.previous_digest as string | null) ?? null,
        reason: row.reason as string,
        actor: row.actor as string,
        rolloutId: (row.rollout_id as string | null) ?? null,
        createdAt: new Date(row.created_at as string).toISOString(),
      }));
    } catch (error) { return failure(error); }
  }

  async appendAudit(event: EvolutionAuditEvent): Promise<void> {
    await this.transaction(async client => {
      await client.query(
        `INSERT INTO evolution_gate_audit_events (event_id, workspace_id, candidate_id, rollout_id,
           actor_type, actor_id, action, reason, from_state, to_state, details_json, occurred_at)
         VALUES ($1,${WS},$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
        [event.eventId, event.candidateId, event.rolloutId, event.actorType, event.actorId,
          event.action, event.reason, event.fromState, event.toState, event.details, event.occurredAt]);
    });
  }

  async listAudit(workspaceId: string, candidateId: string): Promise<EvolutionAuditEvent[]> {
    void workspaceId;
    try {
      const result = await this.database.query(
        `SELECT event_id, candidate_id, rollout_id, actor_type, actor_id, action, reason, from_state,
           to_state, details_json, occurred_at::text
         FROM evolution_gate_audit_events WHERE workspace_id = ${WS} AND candidate_id = $1
         ORDER BY occurred_at ASC, event_id ASC`, [candidateId]);
      return (result.rows as Record<string, unknown>[]).map(row => ({
        eventId: row.event_id as string,
        workspaceId: '',
        candidateId: (row.candidate_id as string | null) ?? null,
        rolloutId: (row.rollout_id as string | null) ?? null,
        actorType: row.actor_type as 'user' | 'system',
        actorId: row.actor_id as string,
        action: row.action as string,
        reason: (row.reason as string | null) ?? null,
        fromState: (row.from_state as EvolutionAuditEvent['fromState'] | null) ?? null,
        toState: (row.to_state as EvolutionAuditEvent['toState'] | null) ?? null,
        details: (row.details_json ?? {}) as Record<string, unknown>,
        occurredAt: new Date(row.occurred_at as string).toISOString(),
      }));
    } catch (error) { return failure(error); }
  }
}
