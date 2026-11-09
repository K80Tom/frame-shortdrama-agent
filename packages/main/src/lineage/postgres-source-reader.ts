import type { QueryResultRow } from 'pg';
import type {
  ExternalOperation, ProductionArtifact, ProductionDelivery, ProductionInputSnapshot, ProductionTask,
  QualityCheck, ReviewDecision, StoredProductionRun, TaskAttempt, TimelineRevision, ShotSpecV2,
} from '@lyra/shared';
import { canonicalDigest, workspaceIdOfDataEvent } from '@lyra/shared';
import type { TenantDataEvent } from '../data/tenant-event';
import type { PostgresDatabase } from '../db/client';
import type {
  AuthoritativeFact, AuthoritativeInputRef, AuthoritativeLink, AuthoritativeNodeRef, SourceLineageReader,
} from './source-reader';

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{2,159}$/u;
const D64 = /^[a-f0-9]{64}$/u;

function safeId(value: unknown): string | null {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : null;
}

function digestOf(value: unknown): string | null {
  return typeof value === 'string' && D64.test(value) ? value : null;
}

function iso(value: unknown, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value) return value;
  return fallback;
}

function ref(kind: string, id: string, revisionId: string | null = null) {
  return { kind, id, revisionId };
}

interface RunRow extends QueryResultRow {
  id: string; project_id: string; script_version_id: string; workspace_id: string;
  run_json: StoredProductionRun; created_at: unknown; updated_at: unknown;
}
interface ScriptRow extends QueryResultRow {
  id: string; content_sha256: string; created_at: unknown; workspace_id: string;
}
interface PlanRow extends QueryResultRow {
  id: string; script_version_id: string; content_json: unknown; created_at: unknown;
}
interface StoryboardRow extends QueryResultRow {
  id: string; script_version_id: string; source_plan_revision_id: string; content_json: unknown;
  input_digest: string; created_at: unknown;
}
interface SnapshotRow extends QueryResultRow {
  id: string; workspace_id: string; project_id: string; episode_id: string;
  snapshot_digest: string; snapshot_json: ProductionInputSnapshot; created_at: unknown;
}
interface ShotRow extends QueryResultRow {
  id: string; workspace_id: string; project_id: string; episode_id: string; shot_id: string;
  content_digest: string; spec_json: ShotSpecV2; created_at: unknown;
}
interface AssetRow extends QueryResultRow {
  id: string; kind: string; name: string; resource_url: string; created_at: unknown; sha256: string | null;
  workspace_id: string;
}
interface NovelRow extends QueryResultRow {
  id: string; chapter_id: string; content_json: unknown; created_at: unknown; workspace_id: string;
}
interface EvalRunRow extends QueryResultRow {
  run_id: string; snapshot_digest: string; created_at: unknown; updated_at: unknown; workspace_id: string;
}

/**
 * 从 main 的权威业务表读取血缘事实的只读实现。
 *
 * 只 SELECT，不写业务表；所有查询依赖当前 tenant scope 的 RLS/workspace 过滤。
 * 生产 Run 的 tasks/attempts/artifacts/quality/delivery 都在 `production_runs.run_json`
 * 这个权威文档里，因此一次读取即可构建“剧本→镜头→资产→成片”的完整链。
 */
export class PostgresSourceLineageReader implements SourceLineageReader {
  constructor(private readonly database: PostgresDatabase) {}

  async resolve(event: TenantDataEvent): Promise<AuthoritativeFact | null> {
    switch (event.aggregateType) {
      case 'production_run': return this.resolveRun(event);
      case 'shot_spec': return this.resolveShotSpec(event);
      case 'production_input': return this.resolveProductionInput(event);
      case 'script': return this.resolveScript(event);
      case 'novel_chapter': return this.resolveNovelRevision(event);
      case 'asset': return this.resolveAsset(event);
      case 'evaluation_run': return this.resolveEvaluationRun(event);
      default: return null;
    }
  }

  private async one<Row extends QueryResultRow>(sql: string, values: readonly unknown[]): Promise<Row | null> {
    const result = await this.database.query<Row>(sql, values);
    return result.rows[0] ?? null;
  }

  private base(event: TenantDataEvent, kind: AuthoritativeFact['kind'], id: string,
    revisionId: string | null, digest: string | null, occurredAt: string, recordedAt: string,
    workspaceId: string, retention: AuthoritativeFact['retention'],
    authorization = 'project:read', refKind: string = kind): AuthoritativeFact {
    return {
      kind,
      businessId: id,
      revisionId,
      ref: ref(refKind, id, revisionId),
      digest: digest ?? canonicalDigest({ kind, id, revisionId }),
      occurredAt,
      recordedAt,
      retention,
      visibility: 'internal',
      authorization,
      workspaceId,
      inputs: [],
    };
  }

  private refNode(kind: AuthoritativeNodeRef['kind'], id: string, revisionId: string | null,
    digest: string | null, occurredAt: string, recordedAt: string,
    refKind: string = kind, present = true): AuthoritativeNodeRef {
    return {
      kind, businessId: id, revisionId, present, ref: ref(refKind, id, revisionId),
      digest, occurredAt, recordedAt,
    };
  }

  private missing(kind: AuthoritativeNodeRef['kind'], id: string, revisionId: string | null,
    occurredAt: string, recordedAt: string): AuthoritativeNodeRef {
    return this.refNode(kind, id, revisionId, null, occurredAt, recordedAt, 'unknown', false);
  }

  private input(kind: AuthoritativeInputRef['kind'], id: string, edgeType: AuthoritativeInputRef['edgeType'],
    present: boolean, digest: string | null, occurredAt: string, recordedAt: string,
    factIsTo = true, refKind: string = kind): AuthoritativeInputRef {
    return {
      kind, businessId: id, revisionId: null, edgeType, factIsTo, present,
      digest, ref: ref(refKind, id, null), occurredAt, recordedAt,
    };
  }

  private async resolveRun(event: TenantDataEvent): Promise<AuthoritativeFact | null> {
    const runId = safeId(event.aggregateId);
    if (!runId) return null;
    const row = await this.one<RunRow>(`
      SELECT id, project_id, script_version_id, workspace_id, run_json, created_at, updated_at
      FROM production_runs WHERE id = $1
    `, [runId]);
    if (!row) return null;
    const run = row.run_json;
    if (!run || run.id !== row.id) return null;

    const now = event.recordedAt;
    const createdAt = iso(row.created_at, run.createdAt ?? event.occurredAt);
    const workspaceId = row.workspace_id || workspaceIdOfDataEvent(event);
    const fact = this.base(event, 'production_run', run.id, null,
      canonicalDigest(run), createdAt, now, workspaceId, 'run_lifetime');
    const links: AuthoritativeLink[] = [];

    // 1) 剧本版本：Run 的直接上游。
    const script = row.script_version_id
      ? await this.one<ScriptRow>(`
          SELECT id, content_sha256, created_at, workspace_id FROM script_versions WHERE id = $1
        `, [row.script_version_id])
      : null;
    if (script) {
      const node = this.refNode('script_version', script.id, null,
        digestOf(script.content_sha256), iso(script.created_at, createdAt), now, 'script_versions');
      links.push({ edgeType: 'derived-from', from: node, to: this.refNode('production_run', run.id, null,
        canonicalDigest(run), createdAt, now, 'production_runs') });
    } else if (row.script_version_id) {
      const node = this.missing('script_version', row.script_version_id, null, createdAt, now);
      links.push({ edgeType: 'derived-from', from: node, to: this.refNode('production_run', run.id, null,
        canonicalDigest(run), createdAt, now, 'production_runs') });
    }

    // 2) 冻结输入快照（若该 Run 由 production_input 创建）。
    const snapshot = await this.loadSnapshot(run, workspaceId, now);
    if (snapshot) {
      const snapshotRef = this.refNode('production_input', snapshot.id, null,
        digestOf(snapshot.snapshot_digest), iso(snapshot.created_at, createdAt), now, 'production_input_snapshots');
      links.push({ edgeType: 'used-by', from: snapshotRef,
        to: this.refNode('production_run', run.id, null, canonicalDigest(run), createdAt, now, 'production_runs') });
      for (const [kind, input, refKind] of [
        ['script_version', snapshot.script, 'script_versions'],
        ['plan_revision', snapshot.plan, 'plan_revisions'],
        ['storyboard_revision', snapshot.storyboard, 'storyboard_revisions'],
      ] as const) {
        if (!input?.versionId) continue;
        links.push({ edgeType: 'derived-from',
          from: this.refNode(kind, input.versionId, null, digestOf(input.digest), createdAt, now, refKind),
          to: snapshotRef });
      }
      for (const shot of snapshot.shots ?? []) {
        const spec = await this.loadShotSpec(workspaceId, shot.revisionId, now);
        const shotRef = spec
          ? this.refNode('shot_spec', spec.shot_id, spec.spec_json?.revisionId ?? spec.id,
            digestOf(spec.content_digest), iso(spec.created_at, createdAt), now, 'shot_spec_versions')
          : this.missing('shot_spec', shot.shotId, shot.revisionId, createdAt, now);
        links.push({ edgeType: 'used-by', from: shotRef, to: snapshotRef });
        if (spec) this.addAssetLinks(links, spec, createdAt, now);
      }
    }

    // 3) 生产任务/尝试/外部操作：全部来自 run_json 权威文档。
    const taskRefs = new Map<string, AuthoritativeNodeRef>();
    for (const task of run.tasks ?? []) {
      const taskId = safeId(task.id);
      if (!taskId) continue;
      const taskRef = this.refNode('production_task', taskId, null,
        canonicalDigest(task), task.createdAt, task.updatedAt, 'production_tasks');
      taskRefs.set(taskId, taskRef);
      links.push({ edgeType: 'derived-from', from: this.refNode('production_run', run.id, null,
        canonicalDigest(run), createdAt, now, 'production_runs'), to: taskRef });
    }
    const attemptRefs = new Map<string, AuthoritativeNodeRef>();
    for (const attempt of run.attempts ?? []) {
      const attemptId = safeId(attempt.id);
      if (!attemptId) continue;
      const attemptRef = this.refNode('production_attempt', attemptId, null,
        canonicalDigest(attempt), attempt.startedAt, attempt.endedAt ?? attempt.startedAt, 'production_attempts');
      attemptRefs.set(attemptId, attemptRef);
      const parent = taskRefs.get(attempt.taskId) ?? this.refNode('production_run', run.id, null,
        canonicalDigest(run), createdAt, now, 'production_runs');
      links.push({ edgeType: 'derived-from', from: parent, to: attemptRef });
    }
    for (const operation of run.externalOperations ?? []) {
      const operationId = safeId(operation.id);
      if (!operationId) continue;
      const opRef = this.refNode('external_operation', operationId, null,
        canonicalDigest(operation), operation.createdAt, operation.updatedAt, 'external_operations');
      const parent = attemptRefs.get(operation.attemptId) ?? taskRefs.get(operation.taskId)
        ?? this.refNode('production_run', run.id, null, canonicalDigest(run), createdAt, now, 'production_runs');
      links.push({ edgeType: 'derived-from', from: parent, to: opRef });
    }
    for (const artifact of run.artifacts ?? []) {
      const artifactId = safeId(artifact.id);
      if (!artifactId) continue;
      const artifactRef = this.refNode('artifact', artifactId, null,
        digestOf(artifact.sha256) ?? canonicalDigest(artifact), artifact.createdAt, artifact.createdAt,
        'production_artifacts');
      const parent = taskRefs.get(artifact.taskId)
        ?? this.refNode('production_run', run.id, null, canonicalDigest(run), createdAt, now, 'production_runs');
      links.push({ edgeType: 'generated-by', from: parent, to: artifactRef });
    }
    for (const check of run.qualityChecks ?? []) {
      const checkId = safeId(check.id);
      if (!checkId) continue;
      const checkRef = this.refNode('quality_check', checkId, null,
        canonicalDigest(check), check.createdAt, check.createdAt, 'quality_checks');
      const target = taskRefs.get(check.taskId) ?? this.refNode('production_run', run.id, null,
        canonicalDigest(run), createdAt, now, 'production_runs');
      links.push({ edgeType: 'validated-by', from: checkRef, to: target });
    }
    for (const review of run.reviews ?? []) {
      const reviewId = safeId(review.id);
      if (!reviewId) continue;
      const reviewRef = this.refNode('review_decision', reviewId, null,
        canonicalDigest(review), review.createdAt, review.createdAt, 'review_decisions');
      const target = taskRefs.get(review.taskId) ?? this.refNode('production_run', run.id, null,
        canonicalDigest(run), createdAt, now, 'production_runs');
      links.push({ edgeType: 'validated-by', from: reviewRef, to: target });
    }
    for (const timeline of run.timeline ?? []) {
      const timelineId = safeId(timeline.id);
      if (!timelineId) continue;
      const timelineRef = this.refNode('timeline_revision', timelineId,
        timeline.version === undefined ? null : `v_${timeline.version}`,  
        canonicalDigest(timeline), timeline.createdAt, timeline.createdAt, 'timeline_revisions');
      links.push({ edgeType: 'derived-from', from: this.refNode('production_run', run.id, null,
        canonicalDigest(run), createdAt, now, 'production_runs'), to: timelineRef });
      for (const track of timeline.tracks ?? []) {
        for (const artifactId of track.artifactIds ?? []) {
          const artifact = safeId(artifactId);
          if (!artifact) continue;
          links.push({ edgeType: 'used-by',
            from: this.refNode('artifact', artifact, null, null, timeline.createdAt, now, 'production_artifacts'),
            to: timelineRef });
        }
      }
    }
    if (run.delivery) {
      const deliveryId = safeId(run.delivery.id);
      if (deliveryId) {
        const deliveryRef = this.refNode('delivery', deliveryId, null,
          canonicalDigest(run.delivery), run.delivery.createdAt, run.delivery.createdAt, 'production_deliveries');
        links.push({ edgeType: 'delivered-as', from: this.refNode('production_run', run.id, null,
          canonicalDigest(run), createdAt, now, 'production_runs'), to: deliveryRef });
        const artifactId = safeId(run.delivery.artifactId);
        if (artifactId) {
          links.push({ edgeType: 'delivered-as',
            from: this.refNode('artifact', artifactId, null, null, run.delivery.createdAt, now, 'production_artifacts'),
            to: deliveryRef });
        }
      }
    }

    fact.links = links;
    return fact;
  }

  private async loadSnapshot(run: StoredProductionRun, workspaceId: string,
    now: string): Promise<SnapshotRow | null> {
    const snapshotId = safeId(run.inputSnapshot?.snapshotId);
    if (!snapshotId) return null;
    return this.one<SnapshotRow>(`
      SELECT id, workspace_id, project_id, episode_id, snapshot_digest, snapshot_json, created_at
      FROM production_input_snapshots WHERE id = $1
    `, [snapshotId]);
  }

  private async loadShotSpec(workspaceId: string, revisionId: string,
    now: string): Promise<ShotRow | null> {
    const id = safeId(revisionId);
    if (!id) return null;
    return this.one<ShotRow>(`
      SELECT id, workspace_id, project_id, episode_id, shot_id, content_digest, spec_json, created_at
      FROM shot_spec_versions WHERE id = $1
    `, [id]);
  }

  private addAssetLinks(links: AuthoritativeLink[], spec: ShotRow, occurredAt: string,
    recordedAt: string): void {
    const specRef = this.refNode('shot_spec', spec.shot_id, spec.spec_json?.revisionId ?? spec.id,
      digestOf(spec.content_digest), iso(spec.created_at, occurredAt), recordedAt, 'shot_spec_versions');
    for (const pack of spec.spec_json?.assetPacks ?? []) {
      const assetId = safeId(pack.entityId);
      if (!assetId) continue;
      links.push({
        edgeType: 'used-by',
        from: this.refNode('asset', assetId, null, null, occurredAt, recordedAt, 'asset_catalog'),
        to: specRef,
      });
    }
  }

  private async resolveShotSpec(event: TenantDataEvent): Promise<AuthoritativeFact | null> {
    const revisionId = safeId(event.authoritativeRef.id) ?? safeId(event.aggregateId);
    if (!revisionId) return null;
    const row = await this.loadShotSpec(workspaceIdOfDataEvent(event), revisionId, event.recordedAt);
    if (!row) return null;
    const fact = this.base(event, 'shot_spec', row.shot_id, row.spec_json?.revisionId ?? row.id,
      digestOf(row.content_digest), iso(row.created_at, event.occurredAt), event.recordedAt,
      row.workspace_id, 'project_lifetime', 'project:read', 'shot_spec_versions');
    const specRef = this.refNode('shot_spec', row.shot_id, row.spec_json?.revisionId ?? row.id,
      digestOf(row.content_digest), iso(row.created_at, event.occurredAt), event.recordedAt, 'shot_spec_versions');
    const links: AuthoritativeLink[] = [];
    for (const [kind, input, refKind] of [
      ['script_version', row.spec_json?.scriptVersionId, 'script_versions'],
      ['plan_revision', row.spec_json?.planRevisionId, 'plan_revisions'],
      ['storyboard_revision', row.spec_json?.storyboardRevisionId, 'storyboard_revisions'],
    ] as const) {
      if (!input) continue;
      const id = safeId(input);
      if (!id) continue;
      links.push({ edgeType: 'derived-from',
        from: this.refNode(kind, id, null, null, iso(row.created_at, event.occurredAt), event.recordedAt, refKind),
        to: specRef });
    }
    this.addAssetLinks(links, row, iso(row.created_at, event.occurredAt), event.recordedAt);
    fact.links = links;
    return fact;
  }

  private async resolveProductionInput(event: TenantDataEvent): Promise<AuthoritativeFact | null> {
    const snapshotId = safeId(event.authoritativeRef.id) ?? safeId(event.aggregateId);
    if (!snapshotId) return null;
    const row = await this.one<SnapshotRow>(`
      SELECT id, workspace_id, project_id, episode_id, snapshot_digest, snapshot_json, created_at
      FROM production_input_snapshots WHERE id = $1
    `, [snapshotId]);
    if (!row) return null;
    const fact = this.base(event, 'production_input', row.id, null, digestOf(row.snapshot_digest),
      iso(row.created_at, event.occurredAt), event.recordedAt, row.workspace_id, 'project_lifetime',
      'project:read', 'production_input_snapshots');
    const snapshotRef = this.refNode('production_input', row.id, null, digestOf(row.snapshot_digest),
      iso(row.created_at, event.occurredAt), event.recordedAt, 'production_input_snapshots');
    const links: AuthoritativeLink[] = [];
    for (const [kind, input, refKind] of [
      ['script_version', row.snapshot_json.script, 'script_versions'],
      ['plan_revision', row.snapshot_json.plan, 'plan_revisions'],
      ['storyboard_revision', row.snapshot_json.storyboard, 'storyboard_revisions'],
    ] as const) {
      if (!input?.versionId) continue;
      links.push({ edgeType: 'derived-from',
        from: this.refNode(kind, input.versionId, null, digestOf(input.digest),
          iso(row.created_at, event.occurredAt), event.recordedAt, refKind),
        to: snapshotRef });
    }
    for (const shot of row.snapshot_json.shots ?? []) {
      const spec = await this.loadShotSpec(row.workspace_id, shot.revisionId, event.recordedAt);
      const shotRef = spec
        ? this.refNode('shot_spec', spec.shot_id, spec.spec_json?.revisionId ?? spec.id,
          digestOf(spec.content_digest), iso(spec.created_at, event.occurredAt), event.recordedAt, 'shot_spec_versions')
        : this.missing('shot_spec', shot.shotId, shot.revisionId, event.occurredAt, event.recordedAt);
      links.push({ edgeType: 'used-by', from: shotRef, to: snapshotRef });
      if (spec) this.addAssetLinks(links, spec, event.occurredAt, event.recordedAt);
    }
    fact.links = links;
    return fact;
  }

  private async resolveScript(event: TenantDataEvent): Promise<AuthoritativeFact | null> {
    const id = safeId(event.aggregateId);
    if (!id) return null;
    const row = await this.one<ScriptRow>(`
      SELECT id, content_sha256, created_at, workspace_id FROM script_versions WHERE id = $1
    `, [id]);
    if (!row) return null;
    return this.base(event, 'script_version', row.id, null, digestOf(row.content_sha256),
      iso(row.created_at, event.occurredAt), event.recordedAt, row.workspace_id || workspaceIdOfDataEvent(event),
      'project_lifetime', 'project:read', 'script_versions');
  }

  private async resolveNovelRevision(event: TenantDataEvent): Promise<AuthoritativeFact | null> {
    const id = safeId(event.aggregateId);
    if (!id) return null;
    const row = await this.one<NovelRow>(`
      SELECT r.id, r.chapter_id, r.content_json, r.created_at, r.workspace_id
      FROM novel_revisions r WHERE r.id = $1
    `, [id]) ?? await this.one<NovelRow>(`
      SELECT r.id, r.chapter_id, r.content_json, r.created_at, r.workspace_id
      FROM novel_revisions r JOIN novel_chapters c ON c.latest_revision_id = r.id
      WHERE c.id = $1
    `, [id]);
    if (!row) return null;
    return this.base(event, 'novel_revision', row.id, null, canonicalDigest(row.content_json),
      iso(row.created_at, event.occurredAt), event.recordedAt, row.workspace_id || workspaceIdOfDataEvent(event),
      'project_lifetime', 'project:read', 'novel_revisions');
  }

  private async resolveAsset(event: TenantDataEvent): Promise<AuthoritativeFact | null> {
    const id = safeId(event.aggregateId);
    if (!id) return null;
    const row = await this.one<AssetRow>(`
      SELECT a.id, a.kind, a.name, a.resource_url, a.created_at, a.workspace_id, m.sha256
      FROM asset_catalog a LEFT JOIN asset_media m ON m.asset_id = a.id
      WHERE a.id = $1
    `, [id]);
    if (!row) return null;
    return this.base(event, 'asset', row.id, null,
      digestOf(row.sha256) ?? canonicalDigest({ id: row.id, kind: row.kind, name: row.name, url: row.resource_url }),
      iso(row.created_at, event.occurredAt), event.recordedAt, row.workspace_id || workspaceIdOfDataEvent(event),
      'project_lifetime', 'asset:read', 'asset_catalog');
  }

  private async resolveEvaluationRun(event: TenantDataEvent): Promise<AuthoritativeFact | null> {
    const runId = safeId(event.aggregateId);
    if (!runId) return null;
    const row = await this.one<EvalRunRow>(`
      SELECT run_id, snapshot_digest, created_at, updated_at, workspace_id
      FROM evaluation_runs WHERE run_id = $1
    `, [runId]);
    if (!row) return null;
    return this.base(event, 'evaluation_run', row.run_id, null, digestOf(row.snapshot_digest),
      iso(row.created_at, event.occurredAt), event.recordedAt, row.workspace_id,
      'run_lifetime', 'project:read', 'evaluation_runs');
  }
}
