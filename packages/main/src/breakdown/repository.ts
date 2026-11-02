import type { PoolClient, QueryResultRow } from "pg";
import type { NovelAdaptationPreview, NovelAdaptationResult, NovelAdaptationSource } from '@lyra/shared';
import {
  SOURCE_INDEX_SCHEMA_VERSION,
  buildScriptSourceIndex,
  createScriptVersion,
  sha256Utf8,
  type ScriptSourceIndex,
  type ScriptVersion,
  validateScriptSourceIndex,
} from "./source-index";
import { BreakdownError } from "./errors";
import type { BreakdownRequirements, CreateProjectRequest } from "./contracts";
import type { PostgresDatabase } from "../db/client";
import { ENTITY_EDIT_VALIDATOR_VERSION, PLAN_VALIDATOR_VERSION, validateStoredPlanContent, type PlanRevisionRecord } from "./plan";
import { FACT_CHECK_RULE_VERSION, type PlanAdoptionRecord, type PlanCheckRecord, type PlanIssueRecord } from "./quality";

export const INPUT_MANIFEST_SCHEMA_VERSION = "breakdown-input-manifest/1";

export interface ProjectRecord {
  id: string;
  title: string;
  source: CreateProjectRequest["source"] | NovelAdaptationSource | null;
  currentScriptVersionId: string | null;
  activePlanRevisionId: string | null;
  activeStoryboardRevisionId: string | null;
  createdAt: string;
}

export interface ScriptVersionSummary {
  id: string;
  projectId: string;
  version: number;
  contentSha256: string;
  createdAt: string;
  sourceIndex: {
    schemaVersion: string;
    unitCount: number;
    spanCount: number;
    blockCount: number;
  };
}

export interface StoredScriptVersion extends ScriptVersion {
  sourceIndex: ScriptSourceIndex;
}

export interface RunScope {
  kind: "project";
  targetId: null;
}

export interface ResolvedModelConfig {
  /** Historical identifiers are metadata, not executable provider adapters. */
  provider: string;
  model: string;
  reasoningEffort: string;
  connectionRevision?: string;
}

export interface InputManifestEntry {
  kind: "script" | "requirements";
  id: string;
  revisionId: string;
  fields: string[];
  digest: string;
}

export interface TaskInputManifest {
  schemaVersion: typeof INPUT_MANIFEST_SCHEMA_VERSION;
  sourceIndexSchemaVersion: typeof SOURCE_INDEX_SCHEMA_VERSION;
  entries: InputManifestEntry[];
}

export interface BreakdownTaskRecord {
  id: string;
  runId: string;
  type: "extractFacts";
  scope: RunScope;
  inputManifest: TaskInputManifest;
  state: "pending" | "running" | "waitingHuman" | "failed";
  activeAttemptId: string | null;
  maxModelCalls: number;
  maxOutputTokens: number;
  createdAt: string;
}

export interface BreakdownRunRecord {
  id: string;
  projectId: string;
  target: "breakdown";
  scriptVersionId: string;
  requirements: BreakdownRequirements;
  modelConfig: ResolvedModelConfig;
  scope: RunScope;
  mode: "auto" | "checkpoints";
  humanCheckpoints: string[];
  status: "draft" | "running" | "waiting" | "failed";
  maxModelCalls: number;
  maxOutputTokens: number;
  sealedAt: string | null;
  createdAt: string;
  task: BreakdownTaskRecord;
}

export interface CreateProjectRecordInput {
  id: string;
  title: string;
  source?: CreateProjectRequest["source"];
  createdAt: string;
}

export interface CreateStoredScriptVersionInput {
  id: string;
  projectId: string;
  rawText: string;
  contentSha256: string;
  createdAt: string;
  buildIndex: (version: number) => ScriptSourceIndex;
}

export interface CreateDraftRunInput {
  run: Omit<BreakdownRunRecord, "task">;
  task: BreakdownTaskRecord;
}

export interface SafeExecutionError {
  code: string;
  message: string;
}

export interface BreakdownAttemptRecord {
  id: string;
  taskId: string;
  number: number;
  status: "running" | "succeeded" | "failed";
  promptVersion: string;
  executorVersion: string;
  inputDigest: string;
  outputPlanRevisionId: string | null;
  error: SafeExecutionError | null;
  startedAt: string;
  endedAt: string | null;
}

export interface ModelCallUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ModelCallRecord {
  id: string;
  attemptId: string;
  operationKey: string;
  provider: string;
  model: string;
  requestDigest: string;
  providerRequestId: string | null;
  status: "prepared" | "submitted" | "succeeded" | "failed";
  usage: ModelCallUsage | null;
  error: SafeExecutionError | null;
  createdAt: string;
  endedAt: string | null;
}

export interface ExecutionSnapshot {
  attempt: BreakdownAttemptRecord;
  modelCalls: ModelCallRecord[];
}

export interface BreakdownRepository {
  saveNovelAdaptation(draft: NovelAdaptationPreview): Promise<NovelAdaptationResult>;
  createProject(input: CreateProjectRecordInput): Promise<ProjectRecord>;
  getProject(projectId: string): Promise<ProjectRecord | null>;
  listProjects(): Promise<ProjectRecord[]>;
  createScriptVersion(input: CreateStoredScriptVersionInput): Promise<StoredScriptVersion>;
  getScriptVersion(projectId: string, scriptVersionId: string): Promise<StoredScriptVersion | null>;
  listScriptVersions(projectId: string): Promise<ScriptVersionSummary[]>;
  createDraftRun(input: CreateDraftRunInput): Promise<BreakdownRunRecord>;
  getRun(runId: string): Promise<BreakdownRunRecord | null>;
  listRuns(projectId: string): Promise<BreakdownRunRecord[]>;
  createPlanRevision(input: PlanRevisionRecord): Promise<PlanRevisionRecord>;
  createEntityEditRevision(input: PlanRevisionRecord, expectedActivePlanRevisionId: string | null): Promise<PlanRevisionRecord>;
  listPlanRevisions(runId: string): Promise<PlanRevisionRecord[]>;
  listProjectPlanRevisions(projectId: string): Promise<PlanRevisionRecord[]>;
  getPlanRevision(planRevisionId: string): Promise<PlanRevisionRecord | null>;
  savePlanCheck(check: PlanCheckRecord, issues: PlanIssueRecord[]): Promise<PlanCheckRecord>;
  listPlanChecks(planRevisionId: string): Promise<PlanCheckRecord[]>;
  listPlanIssues(checkId: string): Promise<PlanIssueRecord[]>;
  adoptPlan(input: PlanAdoptionRecord): Promise<PlanAdoptionRecord>;
  beginAttempt(input: {
    id: string; runId: string; taskId: string; promptVersion: string;
    executorVersion: string; inputDigest: string; startedAt: string;
  }): Promise<BreakdownAttemptRecord>;
  createModelCall(input: {
    id: string; attemptId: string; operationKey: string; provider: string;
    model: string; requestDigest: string; createdAt: string;
  }): Promise<ModelCallRecord>;
  markModelCallSubmitted(modelCallId: string): Promise<ModelCallRecord>;
  completeModelCall(input: {
    modelCallId: string; providerRequestId: string | null;
    usage: ModelCallUsage | null; endedAt: string;
    /** Raw paid response payload, persisted for post-mortem (ledger only). */
    response: unknown;
  }): Promise<ModelCallRecord>;
  failModelCall(input: {
    modelCallId: string; providerRequestId: string | null;
    error: SafeExecutionError; endedAt: string;
  }): Promise<ModelCallRecord>;
  completeAttempt(input: { attemptId: string; planRevisionId: string; endedAt: string }): Promise<BreakdownAttemptRecord>;
  failAttempt(input: { attemptId: string; error: SafeExecutionError; endedAt: string }): Promise<BreakdownAttemptRecord>;
  getExecutionSnapshot(attemptId: string): Promise<ExecutionSnapshot | null>;
}

interface ProjectRow extends QueryResultRow {
  id: string;
  title: string;
  source_json: ProjectRecord["source"];
  current_script_version_id: string | null;
  active_plan_revision_id: string | null;
  active_storyboard_revision_id: string | null;
  created_at: Date | string;
}

interface PlanRevisionRow extends QueryResultRow {
  id: string;
  project_id: string;
  script_version_id: string;
  run_id: string;
  source_task_id: string;
  attempt_id: string | null;
  parent_revision_id: string | null;
  rebased_from_revision_id: null;
  created_at: Date | string;
  created_by: PlanRevisionRecord["createdBy"];
  reason: PlanRevisionRecord["reason"];
  scope_json: unknown;
  requirements_json: unknown;
  content_json: unknown;
  status: "candidate";
  validator_version: string;
  raw_text: string;
}

interface ScriptRow extends QueryResultRow {
  id: string;
  project_id: string;
  version: number;
  raw_text: string;
  content_sha256: string;
  source_index_json: unknown;
  created_at: Date | string;
}

interface RunRow extends QueryResultRow {
  id: string;
  project_id: string;
  target: "breakdown";
  script_version_id: string;
  requirements_json: unknown;
  model_config_json: unknown;
  scope_json: unknown;
  mode: "auto" | "checkpoints";
  human_checkpoints_json: unknown;
  status: BreakdownRunRecord["status"];
  max_model_calls: number;
  max_output_tokens: number;
  sealed_at: Date | string | null;
  created_at: Date | string;
  task_id: string;
  task_type: "extractFacts";
  task_scope_json: unknown;
  input_manifest_json: unknown;
  task_state: BreakdownTaskRecord["state"];
  task_active_attempt_id: string | null;
  task_max_model_calls: number;
  task_max_output_tokens: number;
  task_created_at: Date | string;
}

interface AttemptRow extends QueryResultRow {
  id: string;
  task_id: string;
  number: number;
  status: BreakdownAttemptRecord["status"];
  prompt_version: string;
  executor_version: string;
  input_digest: string;
  output_plan_revision_id: string | null;
  error_json: unknown | null;
  started_at: Date | string;
  ended_at: Date | string | null;
}

interface ModelCallRow extends QueryResultRow {
  id: string;
  attempt_id: string;
  operation_key: string;
  provider: string;
  model: string;
  request_digest: string;
  provider_request_id: string | null;
  status: ModelCallRecord["status"];
  usage_json: unknown | null;
  error_json: unknown | null;
  created_at: Date | string;
  ended_at: Date | string | null;
}

interface CheckRow extends QueryResultRow {
  id: string; project_id: string; plan_revision_id: string; rule_version: string;
  method: "program"; result: "passed" | "failed"; content_digest: string;
  created_at: Date | string;
}
interface IssueRow extends QueryResultRow {
  id: string; check_id: string; project_id: string; plan_revision_id: string;
  kind: "validation" | "storyAmbiguity"; code: string; message: string;
  scope_json: unknown; source_refs_json: unknown; blocking: true;
  status: "open"; created_at: Date | string;
}

const projectColumns = "id, title, source_json, current_script_version_id, active_plan_revision_id, active_storyboard_revision_id, created_at";
const runColumns = `
  r.id, r.project_id, r.target, r.script_version_id, r.requirements_json,
  r.model_config_json, r.scope_json, r.mode, r.human_checkpoints_json, r.status,
  r.max_model_calls, r.max_output_tokens, r.sealed_at, r.created_at,
  t.id AS task_id, t.type AS task_type, t.scope_json AS task_scope_json,
  t.input_manifest_json, t.state AS task_state, t.max_model_calls AS task_max_model_calls,
  t.max_output_tokens AS task_max_output_tokens, t.active_attempt_id AS task_active_attempt_id,
  t.created_at AS task_created_at
`;

function novelAdaptationIds(draft: NovelAdaptationPreview): NovelAdaptationResult {
  return { projectId: 'project_novel_' + draft.digest, scriptVersionId: 'script_novel_' + draft.digest };
}
function requireCurrentAdaptation(current: string | null | undefined, ids: NovelAdaptationResult) {
  if (current !== ids.scriptVersionId) {
    throw new BreakdownError(409, 'NOVEL_ADAPTATION_PROJECT_EDITED', '该剧本项目已有更新版本，请从自动制片页选择该项目的当前版本。');
  }
}

/** PostgreSQL implementation.  It never starts a task or calls a model. */
export class PostgresBreakdownRepository implements BreakdownRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async saveNovelAdaptation(draft: NovelAdaptationPreview): Promise<NovelAdaptationResult> {
    const ids = novelAdaptationIds(draft);
    const createdAt = new Date().toISOString();
    return this.database.transaction(async client => {
      // The project primary key serializes simultaneous adoptions of this exact preview.
      const inserted = await client.query(
        'INSERT INTO projects (id,title,source_json,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
        [ids.projectId, draft.title, draft.source, createdAt],
      );
      if (inserted.rowCount === 1) {
        const script = createScriptVersion({ id: ids.scriptVersionId, projectId: ids.projectId, version: 1, rawText: draft.rawText, createdAt });
        await client.query(`INSERT INTO script_versions
          (id,project_id,version,raw_text,content_sha256,source_index_json,created_at) VALUES ($1,$2,1,$3,$4,$5,$6)`,
          [script.id, script.projectId, script.rawText, script.contentSha256, buildScriptSourceIndex(script), createdAt]);
        await client.query('UPDATE projects SET current_script_version_id=$1 WHERE id=$2', [script.id, ids.projectId]);
      } else {
        const project = await client.query<{ current_script_version_id: string | null }>(
          'SELECT current_script_version_id FROM projects WHERE id=$1 FOR SHARE', [ids.projectId]);
        requireCurrentAdaptation(project.rows[0]?.current_script_version_id, ids);
      }
      return ids;
    });
  }

  async createProject(input: CreateProjectRecordInput): Promise<ProjectRecord> {
    const result = await this.database.query<ProjectRow>(`
      INSERT INTO projects (id, title, source_json, created_at)
      VALUES ($1, $2, $3, $4)
      RETURNING ${projectColumns}
    `, [input.id, input.title, input.source ?? null, input.createdAt]);
    return toProject(result.rows[0]!);
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const result = await this.database.query<ProjectRow>(`
      SELECT ${projectColumns} FROM projects WHERE id = $1
    `, [projectId]);
    return result.rows[0] ? toProject(result.rows[0]) : null;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const result = await this.database.query<ProjectRow>(`
      SELECT ${projectColumns} FROM projects ORDER BY created_at DESC, id DESC
    `);
    return result.rows.map(toProject);
  }

  async createScriptVersion(input: CreateStoredScriptVersionInput): Promise<StoredScriptVersion> {
    return this.database.transaction(async (client) => {
      const project = await client.query<ProjectRow>(`
        SELECT ${projectColumns} FROM projects WHERE id = $1 FOR UPDATE
      `, [input.projectId]);
      if (!project.rows[0]) throw notFound("PROJECT_NOT_FOUND", "项目不存在或已删除。");

      const current = await client.query<{ next_version: number }>(`
        SELECT COALESCE(MAX(version), 0)::integer + 1 AS next_version
        FROM script_versions WHERE project_id = $1
      `, [input.projectId]);
      const version = current.rows[0]!.next_version;
      const index = input.buildIndex(version);
      assertIndexMatchesStoredScript(index, input, version);

      const saved = await client.query<ScriptRow>(`
        INSERT INTO script_versions
          (id, project_id, version, raw_text, content_sha256, source_index_json, created_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        RETURNING id, project_id, version, raw_text, content_sha256, source_index_json, created_at
      `, [input.id, input.projectId, version, input.rawText, input.contentSha256, JSON.stringify(index), input.createdAt]);
      await client.query("UPDATE projects SET current_script_version_id = $1, active_plan_revision_id = NULL, active_storyboard_revision_id = NULL WHERE id = $2", [input.id, input.projectId]);
      return toStoredScript(saved.rows[0]!);
    });
  }

  async getScriptVersion(projectId: string, scriptVersionId: string): Promise<StoredScriptVersion | null> {
    const result = await this.database.query<ScriptRow>(`
      SELECT id, project_id, version, raw_text, content_sha256, source_index_json, created_at
      FROM script_versions WHERE project_id = $1 AND id = $2
    `, [projectId, scriptVersionId]);
    return result.rows[0] ? toStoredScript(result.rows[0]) : null;
  }

  async listScriptVersions(projectId: string): Promise<ScriptVersionSummary[]> {
    const result = await this.database.query<ScriptRow>(`
      SELECT id, project_id, version, raw_text, content_sha256, source_index_json, created_at
      FROM script_versions WHERE project_id = $1 ORDER BY version DESC
    `, [projectId]);
    return result.rows.map((row) => toSummary(toStoredScript(row)));
  }

  async createDraftRun(input: CreateDraftRunInput): Promise<BreakdownRunRecord> {
    return this.database.transaction(async (client) => {
      const script = await client.query<{ id: string }>(`
        SELECT id FROM script_versions WHERE id = $1 AND project_id = $2
      `, [input.run.scriptVersionId, input.run.projectId]);
      if (!script.rows[0]) throw notFound("SCRIPT_VERSION_NOT_FOUND", "剧本版本不存在或不属于该项目。");

      await client.query(`
        INSERT INTO breakdown_runs (
          id, project_id, target, script_version_id, requirements_json, model_config_json,
          scope_json, mode, human_checkpoints_json, status, max_model_calls,
          max_output_tokens, sealed_at, created_at
        ) VALUES ($1, $2, 'breakdown', $3, $4::jsonb, $5::jsonb, $6::jsonb, $7,
          $8::jsonb, 'draft', $9, $10, NULL, $11)
      `, [
        input.run.id, input.run.projectId, input.run.scriptVersionId,
        JSON.stringify(input.run.requirements), JSON.stringify(input.run.modelConfig),
        JSON.stringify(input.run.scope), input.run.mode, JSON.stringify(input.run.humanCheckpoints),
        input.run.maxModelCalls, input.run.maxOutputTokens, input.run.createdAt,
      ]);
      await client.query(`
        INSERT INTO breakdown_tasks (
          id, run_id, type, scope_json, input_manifest_json, state,
          max_model_calls, max_output_tokens, created_at
        ) VALUES ($1, $2, 'extractFacts', $3::jsonb, $4::jsonb, 'pending', $5, $6, $7)
      `, [
        input.task.id, input.run.id, JSON.stringify(input.task.scope),
        JSON.stringify(input.task.inputManifest), input.task.maxModelCalls,
        input.task.maxOutputTokens, input.task.createdAt,
      ]);
      return clone(inputToRun(input));
    });
  }

  async getRun(runId: string): Promise<BreakdownRunRecord | null> {
    const result = await this.database.query<RunRow>(`
      SELECT ${runColumns}
      FROM breakdown_runs r
      JOIN breakdown_tasks t ON t.run_id = r.id
      WHERE r.id = $1 AND t.type = 'extractFacts'
    `, [runId]);
    return result.rows[0] ? toRun(result.rows[0]) : null;
  }

  async listRuns(projectId: string): Promise<BreakdownRunRecord[]> {
    const result = await this.database.query<RunRow>(`
      SELECT ${runColumns}
      FROM breakdown_runs r JOIN breakdown_tasks t ON t.run_id = r.id
      WHERE r.project_id = $1 AND t.type = 'extractFacts'
      ORDER BY r.created_at DESC, r.id DESC
    `, [projectId]);
    return result.rows.map(toRun);
  }

  async createPlanRevision(input: PlanRevisionRecord): Promise<PlanRevisionRecord> {
    if (input.reason !== "extract" || input.createdBy !== "agent" || input.parentRevisionId !== null) {
      throw conflict("PLAN_REVISION_INVALID", "人工校对必须通过带基准检查的保存入口。");
    }
    return this.database.transaction(async (client) => {
      // Serialize candidate creation with edits and adoption for this project.
      const project = await client.query<{ id: string }>("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [input.projectId]);
      if (!project.rows[0]) throw notFound("PROJECT_NOT_FOUND", "项目不存在。");
      const source = await client.query<{ id: string }>(`
        SELECT r.id
        FROM breakdown_runs r
        JOIN breakdown_tasks t ON t.run_id = r.id
        WHERE r.id = $1 AND r.project_id = $2 AND r.script_version_id = $3
          AND t.id = $4 AND t.type = 'extractFacts'
      `, [input.runId, input.projectId, input.scriptVersionId, input.sourceTaskId]);
      if (!source.rows[0]) throw notFound("BREAKDOWN_RUN_NOT_FOUND", "拆解 Run 或事实提取任务不存在。");
      if (input.attemptId !== null) {
        const attempt = await client.query<{ id: string }>(`
          SELECT id FROM breakdown_attempts
          WHERE id = $1 AND task_id = $2 AND status = 'running'
        `, [input.attemptId, input.sourceTaskId]);
        if (!attempt.rows[0]) throw notFound("ATTEMPT_NOT_FOUND", "候选计划绑定的执行尝试不存在或已经结束。");
      }
      await client.query(`
        INSERT INTO plan_revisions (
          id, project_id, script_version_id, run_id, source_task_id,
          attempt_id, parent_revision_id, rebased_from_revision_id, created_at, created_by,
          reason, scope_json, requirements_json, content_json, status, validator_version
        ) VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7, 'agent', 'extract',
          $8::jsonb, $9::jsonb, $10::jsonb, 'candidate', $11)
      `, [
        input.id, input.projectId, input.scriptVersionId, input.runId, input.sourceTaskId,
        input.attemptId, input.createdAt, JSON.stringify(input.scope), JSON.stringify(input.requirements),
        JSON.stringify(input.content), input.validatorVersion,
      ]);
      return clone(input);
    });
  }

  async createEntityEditRevision(input: PlanRevisionRecord, expectedActivePlanRevisionId: string | null): Promise<PlanRevisionRecord> {
    if (input.reason !== "manualEdit" || input.createdBy !== "user" || input.parentRevisionId === null || input.attemptId !== null) {
      throw conflict("PLAN_REVISION_INVALID", "人工校对版本来源无效。");
    }
    return this.database.transaction(async (client) => {
      const project = await client.query<ProjectRow>(
        `SELECT ${projectColumns} FROM projects WHERE id = $1 FOR UPDATE`, [input.projectId]);
      const current = project.rows[0];
      if (!current) throw notFound("PROJECT_NOT_FOUND", "项目不存在。");
      if (current.current_script_version_id !== input.scriptVersionId
        || current.active_plan_revision_id !== expectedActivePlanRevisionId) {
        throw conflict("PLAN_EDIT_CONFLICT", "剧本或已采用版本已变化，请刷新后重新校对。");
      }
      const latest = await client.query<{ id: string; run_id: string; source_task_id: string }>(`
        SELECT id, run_id, source_task_id FROM plan_revisions
        WHERE project_id = $1 AND script_version_id = $2
        ORDER BY revision_order DESC LIMIT 1
      `, [input.projectId, input.scriptVersionId]);
      const base = latest.rows[0];
      if (!base || base.id !== input.parentRevisionId || base.run_id !== input.runId || base.source_task_id !== input.sourceTaskId) {
        throw conflict("PLAN_EDIT_CONFLICT", "已有更新的拆解候选，请刷新后基于最新版本校对。");
      }
      await client.query(`
        INSERT INTO plan_revisions (
          id, project_id, script_version_id, run_id, source_task_id,
          attempt_id, parent_revision_id, rebased_from_revision_id, created_at, created_by,
          reason, scope_json, requirements_json, content_json, status, validator_version
        ) VALUES ($1, $2, $3, $4, $5, NULL, $6, NULL, $7, 'user', 'manualEdit',
          $8::jsonb, $9::jsonb, $10::jsonb, 'candidate', $11)
      `, [input.id, input.projectId, input.scriptVersionId, input.runId, input.sourceTaskId,
        input.parentRevisionId, input.createdAt, JSON.stringify(input.scope), JSON.stringify(input.requirements),
        JSON.stringify(input.content), input.validatorVersion]);
      return clone(input);
    });
  }

  async listPlanRevisions(runId: string): Promise<PlanRevisionRecord[]> {
    const result = await this.database.query<PlanRevisionRow>(`
      SELECT p.*, s.raw_text
      FROM plan_revisions p
      JOIN script_versions s ON s.id = p.script_version_id
      WHERE p.run_id = $1
      ORDER BY p.revision_order
    `, [runId]);
    return result.rows.map(toPlanRevision);
  }

  async listProjectPlanRevisions(projectId: string): Promise<PlanRevisionRecord[]> {
    const result = await this.database.query<PlanRevisionRow>(`
      SELECT p.*, s.raw_text
      FROM plan_revisions p JOIN script_versions s ON s.id = p.script_version_id
      WHERE p.project_id = $1 ORDER BY p.revision_order
    `, [projectId]);
    return result.rows.map(toPlanRevision);
  }

  async getPlanRevision(planRevisionId: string): Promise<PlanRevisionRecord | null> {
    const result = await this.database.query<PlanRevisionRow>(`
      SELECT p.*, s.raw_text
      FROM plan_revisions p
      JOIN script_versions s ON s.id = p.script_version_id
      WHERE p.id = $1
    `, [planRevisionId]);
    return result.rows[0] ? toPlanRevision(result.rows[0]) : null;
  }

  async savePlanCheck(check: PlanCheckRecord, issues: PlanIssueRecord[]): Promise<PlanCheckRecord> {
    return this.database.transaction(async (client) => {
      const plan = await client.query<{ id: string }>(`
        SELECT id FROM plan_revisions WHERE id = $1 AND project_id = $2
      `, [check.planRevisionId, check.projectId]);
      if (!plan.rows[0]) throw notFound("PLAN_REVISION_NOT_FOUND", "候选计划不存在。");
      await client.query(`
        INSERT INTO plan_checks
          (id, project_id, plan_revision_id, rule_version, method, result, content_digest, created_at)
        VALUES ($1, $2, $3, $4, 'program', $5, $6, $7)
      `, [check.id, check.projectId, check.planRevisionId, check.ruleVersion,
        check.result, check.contentDigest, check.createdAt]);
      for (const issue of issues) {
        await client.query(`
          INSERT INTO plan_issues
            (id, check_id, project_id, plan_revision_id, kind, code, message,
             scope_json, source_refs_json, blocking, status, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, TRUE, 'open', $10)
        `, [issue.id, issue.checkId, issue.projectId, issue.planRevisionId,
          issue.kind, issue.code, issue.message, JSON.stringify(issue.scope),
          JSON.stringify(issue.sourceRefs), issue.createdAt]);
      }
      return clone(check);
    });
  }

  async listPlanChecks(planRevisionId: string): Promise<PlanCheckRecord[]> {
    const result = await this.database.query<CheckRow>(`
      SELECT * FROM plan_checks WHERE plan_revision_id = $1 ORDER BY created_at DESC, id DESC
    `, [planRevisionId]);
    const checks: PlanCheckRecord[] = [];
    for (const row of result.rows) {
      const issues = await this.listPlanIssues(row.id);
      checks.push(toCheck(row, issues.map((issue) => issue.id)));
    }
    return checks;
  }

  async listPlanIssues(checkId: string): Promise<PlanIssueRecord[]> {
    const result = await this.database.query<IssueRow>(`
      SELECT * FROM plan_issues WHERE check_id = $1 ORDER BY id
    `, [checkId]);
    return result.rows.map(toIssue);
  }

  async adoptPlan(input: PlanAdoptionRecord): Promise<PlanAdoptionRecord> {
    return this.database.transaction(async (client) => {
      const project = await client.query<ProjectRow>(`
        SELECT ${projectColumns} FROM projects WHERE id = $1 FOR UPDATE
      `, [input.projectId]);
      if (!project.rows[0]) throw notFound("PROJECT_NOT_FOUND", "项目不存在。");
      const current = project.rows[0];
      if (current.active_plan_revision_id !== input.fromRevisionId) {
        throw conflict("PLAN_ADOPTION_CONFLICT", "项目当前版本已变化，请刷新后再采用。");
      }
      const eligibility = await client.query<{ id: string }>(`
        SELECT p.id FROM plan_revisions p
        JOIN plan_checks c ON c.plan_revision_id = p.id
        WHERE p.id = $1 AND p.project_id = $2 AND p.script_version_id = $3
          AND c.id = $4 AND c.result = 'passed' AND c.rule_version = $5
          AND p.id = (SELECT latest.id FROM plan_revisions latest
            WHERE latest.project_id = p.project_id AND latest.script_version_id = p.script_version_id
            ORDER BY latest.revision_order DESC LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM plan_issues i WHERE i.check_id = c.id AND i.blocking)
      `, [input.toRevisionId, input.projectId, current.current_script_version_id,
        input.checkId, FACT_CHECK_RULE_VERSION]);
      if (!eligibility.rows[0]) {
        throw conflict("PLAN_NOT_ADOPTABLE", "候选计划未通过当前检查、与当前剧本不一致，或已有更新候选；请刷新后重新检查。");
      }
      await client.query(`
        INSERT INTO plan_adoptions
          (id, project_id, from_revision_id, to_revision_id, check_id, actor, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [input.id, input.projectId, input.fromRevisionId, input.toRevisionId,
        input.checkId, input.actor, input.createdAt]);
      await client.query("UPDATE projects SET active_plan_revision_id = $1, active_storyboard_revision_id = NULL WHERE id = $2",
        [input.toRevisionId, input.projectId]);
      return clone(input);
    });
  }

  async beginAttempt(input: {
    id: string; runId: string; taskId: string; promptVersion: string;
    executorVersion: string; inputDigest: string; startedAt: string;
  }): Promise<BreakdownAttemptRecord> {
    return this.database.transaction(async (client) => {
      const work = await client.query<{ run_status: string; task_state: string }>(`
        SELECT r.status AS run_status, t.state AS task_state
        FROM breakdown_tasks t JOIN breakdown_runs r ON r.id = t.run_id
        WHERE r.id = $1 AND t.id = $2 AND t.type = 'extractFacts'
        FOR UPDATE OF r, t
      `, [input.runId, input.taskId]);
      if (!work.rows[0]) throw notFound("BREAKDOWN_RUN_NOT_FOUND", "拆解 Run 或事实提取任务不存在。");
      if (work.rows[0].run_status !== "draft" || work.rows[0].task_state !== "pending") {
        throw conflict("BREAKDOWN_TASK_NOT_STARTABLE", "当前拆解任务不能开始新的执行尝试。");
      }
      const next = await client.query<{ number: number }>(`
        SELECT COALESCE(MAX(number), 0)::integer + 1 AS number
        FROM breakdown_attempts WHERE task_id = $1
      `, [input.taskId]);
      const saved = await client.query<AttemptRow>(`
        INSERT INTO breakdown_attempts (
          id, task_id, number, status, prompt_version, executor_version,
          input_digest, started_at
        ) VALUES ($1, $2, $3, 'running', $4, $5, $6, $7)
        RETURNING *
      `, [input.id, input.taskId, next.rows[0]!.number, input.promptVersion,
        input.executorVersion, input.inputDigest, input.startedAt]);
      await client.query(
        "UPDATE breakdown_tasks SET state = 'running', active_attempt_id = $1 WHERE id = $2",
        [input.id, input.taskId],
      );
      await client.query(
        "UPDATE breakdown_runs SET status = 'running', sealed_at = COALESCE(sealed_at, $1) WHERE id = $2",
        [input.startedAt, input.runId],
      );
      return toAttempt(saved.rows[0]!);
    });
  }

  async createModelCall(input: {
    id: string; attemptId: string; operationKey: string; provider: string;
    model: string; requestDigest: string; createdAt: string;
  }): Promise<ModelCallRecord> {
    return this.database.transaction(async (client) => {
      const attempt = await client.query<{ status: string; max_model_calls: number }>(`
        SELECT a.status, t.max_model_calls
        FROM breakdown_attempts a JOIN breakdown_tasks t ON t.id = a.task_id
        WHERE a.id = $1 FOR UPDATE OF a, t
      `, [input.attemptId]);
      if (!attempt.rows[0]) throw notFound("ATTEMPT_NOT_FOUND", "执行尝试不存在。");
      if (attempt.rows[0].status !== "running") {
        throw conflict("ATTEMPT_NOT_RUNNING", "当前执行尝试不能再发起模型调用。");
      }
      const count = await client.query<{ count: number }>(`
        SELECT COUNT(*)::integer AS count FROM model_calls WHERE attempt_id = $1
      `, [input.attemptId]);
      if (count.rows[0]!.count >= attempt.rows[0].max_model_calls) {
        throw conflict("MODEL_CALL_LIMIT_REACHED", "本次任务已达到模型调用上限。");
      }
      const saved = await client.query<ModelCallRow>(`
        INSERT INTO model_calls (
          id, attempt_id, operation_key, provider, model, request_digest, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'prepared', $7)
        RETURNING *
      `, [input.id, input.attemptId, input.operationKey, input.provider,
        input.model, input.requestDigest, input.createdAt]);
      return toModelCall(saved.rows[0]!);
    });
  }

  async markModelCallSubmitted(modelCallId: string): Promise<ModelCallRecord> {
    const saved = await this.database.query<ModelCallRow>(`
      UPDATE model_calls SET status = 'submitted'
      WHERE id = $1 AND status = 'prepared' RETURNING *
    `, [modelCallId]);
    if (!saved.rows[0]) throw conflict("MODEL_CALL_NOT_PREPARED", "模型调用没有处于待提交状态。");
    return toModelCall(saved.rows[0]);
  }

  async completeModelCall(input: {
    modelCallId: string; providerRequestId: string | null;
    usage: ModelCallUsage | null; endedAt: string;
    response: unknown;
  }): Promise<ModelCallRecord> {
    const saved = await this.database.query<ModelCallRow>(`
      UPDATE model_calls SET status = 'succeeded', provider_request_id = $2,
        usage_json = $3::jsonb, error_json = NULL, ended_at = $4, response_json = $5::jsonb
      WHERE id = $1 AND status = 'submitted' RETURNING *
    `, [input.modelCallId, input.providerRequestId,
      input.usage === null ? null : JSON.stringify(input.usage), input.endedAt,
      input.response === undefined || input.response === null ? null : JSON.stringify(input.response)]);
    if (!saved.rows[0]) throw conflict("MODEL_CALL_NOT_SUBMITTED", "模型调用没有处于已提交状态。");
    return toModelCall(saved.rows[0]);
  }

  async failModelCall(input: {
    modelCallId: string; providerRequestId: string | null;
    error: SafeExecutionError; endedAt: string;
  }): Promise<ModelCallRecord> {
    const saved = await this.database.query<ModelCallRow>(`
      UPDATE model_calls SET status = 'failed', provider_request_id = $2,
        error_json = $3::jsonb, ended_at = $4
      WHERE id = $1 AND status IN ('prepared', 'submitted') RETURNING *
    `, [input.modelCallId, input.providerRequestId, JSON.stringify(input.error), input.endedAt]);
    if (!saved.rows[0]) throw conflict("MODEL_CALL_ALREADY_FINISHED", "模型调用已经结束。");
    return toModelCall(saved.rows[0]);
  }

  async completeAttempt(input: {
    attemptId: string; planRevisionId: string; endedAt: string;
  }): Promise<BreakdownAttemptRecord> {
    return this.finishAttempt(input.attemptId, input.endedAt, async (client, row) => {
      const plan = await client.query<{ id: string }>(`
        SELECT id FROM plan_revisions
        WHERE id = $1 AND attempt_id = $2 AND source_task_id = $3
      `, [input.planRevisionId, input.attemptId, row.task_id]);
      if (!plan.rows[0]) throw conflict("ATTEMPT_PLAN_MISMATCH", "候选计划不属于当前执行尝试。");
      const saved = await client.query<AttemptRow>(`
        UPDATE breakdown_attempts SET status = 'succeeded', output_plan_revision_id = $2,
          error_json = NULL, ended_at = $3 WHERE id = $1 RETURNING *
      `, [input.attemptId, input.planRevisionId, input.endedAt]);
      await client.query("UPDATE breakdown_tasks SET state = 'waitingHuman' WHERE id = $1", [row.task_id]);
      await client.query("UPDATE breakdown_runs SET status = 'waiting' WHERE id = $1", [row.run_id]);
      return toAttempt(saved.rows[0]!);
    });
  }

  async failAttempt(input: {
    attemptId: string; error: SafeExecutionError; endedAt: string;
  }): Promise<BreakdownAttemptRecord> {
    return this.finishAttempt(input.attemptId, input.endedAt, async (client, row) => {
      const saved = await client.query<AttemptRow>(`
        UPDATE breakdown_attempts SET status = 'failed', error_json = $2::jsonb,
          ended_at = $3 WHERE id = $1 RETURNING *
      `, [input.attemptId, JSON.stringify(input.error), input.endedAt]);
      await client.query("UPDATE breakdown_tasks SET state = 'failed' WHERE id = $1", [row.task_id]);
      await client.query("UPDATE breakdown_runs SET status = 'failed' WHERE id = $1", [row.run_id]);
      return toAttempt(saved.rows[0]!);
    });
  }

  async getExecutionSnapshot(attemptId: string): Promise<ExecutionSnapshot | null> {
    const attempt = await this.database.query<AttemptRow>(
      "SELECT * FROM breakdown_attempts WHERE id = $1",
      [attemptId],
    );
    if (!attempt.rows[0]) return null;
    const calls = await this.database.query<ModelCallRow>(`
      SELECT * FROM model_calls WHERE attempt_id = $1 ORDER BY created_at, id
    `, [attemptId]);
    return { attempt: toAttempt(attempt.rows[0]), modelCalls: calls.rows.map(toModelCall) };
  }

  private async finishAttempt<T>(
    attemptId: string,
    _endedAt: string,
    finish: (client: PoolClient, row: { task_id: string; run_id: string }) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (client) => {
      const current = await client.query<{ status: string; task_id: string; run_id: string }>(`
        SELECT a.status, a.task_id, t.run_id
        FROM breakdown_attempts a JOIN breakdown_tasks t ON t.id = a.task_id
        WHERE a.id = $1 FOR UPDATE OF a, t
      `, [attemptId]);
      if (!current.rows[0]) throw notFound("ATTEMPT_NOT_FOUND", "执行尝试不存在。");
      if (current.rows[0].status !== "running") {
        throw conflict("ATTEMPT_ALREADY_FINISHED", "执行尝试已经结束。");
      }
      return finish(client, current.rows[0]);
    });
  }
}

/**
 * A deliberately explicit test adapter.  It shares the repository contract,
 * allowing unit/HTTP tests to prove P0 behavior without silently requiring a
 * developer's local database.  The application never constructs it by default.
 */
export class InMemoryBreakdownRepository implements BreakdownRepository {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly scripts = new Map<string, StoredScriptVersion>();
  private readonly runs = new Map<string, BreakdownRunRecord>();
  private readonly plans = new Map<string, PlanRevisionRecord>();
  private readonly attempts = new Map<string, BreakdownAttemptRecord>();
  private readonly modelCalls = new Map<string, ModelCallRecord>();
  private readonly checks = new Map<string, PlanCheckRecord>();
  private readonly issues = new Map<string, PlanIssueRecord>();
  private readonly adoptions = new Map<string, PlanAdoptionRecord>();

  async saveNovelAdaptation(draft: NovelAdaptationPreview): Promise<NovelAdaptationResult> {
    const ids = novelAdaptationIds(draft);
    const existing = this.projects.get(ids.projectId);
    if (existing) { requireCurrentAdaptation(existing.currentScriptVersionId, ids); return ids; }
    const createdAt = new Date().toISOString();
    const script = createScriptVersion({ id: ids.scriptVersionId, projectId: ids.projectId, version: 1, rawText: draft.rawText, createdAt });
    this.scripts.set(script.id, { ...script, sourceIndex: buildScriptSourceIndex(script) });
    this.projects.set(ids.projectId, { id: ids.projectId, title: draft.title, source: clone(draft.source),
      currentScriptVersionId: script.id, activePlanRevisionId: null, activeStoryboardRevisionId: null, createdAt });
    return ids;
  }

  async createProject(input: CreateProjectRecordInput): Promise<ProjectRecord> {
    const project: ProjectRecord = {
      id: input.id, title: input.title, source: input.source ?? null, currentScriptVersionId: null,
      activePlanRevisionId: null, activeStoryboardRevisionId: null, createdAt: input.createdAt,
    };
    this.projects.set(project.id, clone(project));
    return clone(project);
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const project = this.projects.get(projectId);
    return project ? clone(project) : null;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return [...this.projects.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(clone);
  }

  async createScriptVersion(input: CreateStoredScriptVersionInput): Promise<StoredScriptVersion> {
    const project = this.projects.get(input.projectId);
    if (!project) throw notFound("PROJECT_NOT_FOUND", "项目不存在或已删除。");
    const version = [...this.scripts.values()]
      .filter((script) => script.projectId === input.projectId)
      .reduce((max, script) => Math.max(max, script.version), 0) + 1;
    const index = input.buildIndex(version);
    assertIndexMatchesStoredScript(index, input, version);
    const script: StoredScriptVersion = {
      id: input.id, projectId: input.projectId, version, rawText: input.rawText,
      contentSha256: input.contentSha256, createdAt: input.createdAt, sourceIndex: index,
    };
    this.scripts.set(script.id, clone(script));
    project.currentScriptVersionId = script.id;
    project.activePlanRevisionId = null;
    project.activeStoryboardRevisionId = null;
    this.projects.set(project.id, clone(project));
    return clone(script);
  }

  async getScriptVersion(projectId: string, scriptVersionId: string): Promise<StoredScriptVersion | null> {
    const script = this.scripts.get(scriptVersionId);
    return script && script.projectId === projectId ? clone(script) : null;
  }

  async listScriptVersions(projectId: string): Promise<ScriptVersionSummary[]> {
    return [...this.scripts.values()]
      .filter((script) => script.projectId === projectId)
      .sort((left, right) => right.version - left.version)
      .map((script) => toSummary(script));
  }

  async createDraftRun(input: CreateDraftRunInput): Promise<BreakdownRunRecord> {
    const script = this.scripts.get(input.run.scriptVersionId);
    if (!script || script.projectId !== input.run.projectId) {
      throw notFound("SCRIPT_VERSION_NOT_FOUND", "剧本版本不存在或不属于该项目。");
    }
    const run = inputToRun(input);
    this.runs.set(run.id, clone(run));
    return clone(run);
  }

  async getRun(runId: string): Promise<BreakdownRunRecord | null> {
    const run = this.runs.get(runId);
    return run ? clone(run) : null;
  }

  async listRuns(projectId: string): Promise<BreakdownRunRecord[]> {
    return [...this.runs.values()].filter(run => run.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(clone);
  }

  async createPlanRevision(input: PlanRevisionRecord): Promise<PlanRevisionRecord> {
    const run = this.runs.get(input.runId);
    if (input.reason !== "extract" || input.createdBy !== "agent" || input.parentRevisionId !== null) {
      throw conflict("PLAN_REVISION_INVALID", "人工校对必须通过带基准检查的保存入口。");
    }
    if (!run || run.projectId !== input.projectId || run.scriptVersionId !== input.scriptVersionId
      || run.task.id !== input.sourceTaskId) {
      throw notFound("BREAKDOWN_RUN_NOT_FOUND", "拆解 Run 或事实提取任务不存在。");
    }
    if (input.attemptId !== null) {
      const attempt = this.attempts.get(input.attemptId);
      if (!attempt || attempt.taskId !== input.sourceTaskId) {
        throw notFound("ATTEMPT_NOT_FOUND", "候选计划绑定的执行尝试不存在。");
      }
    }
    this.plans.set(input.id, clone(input));
    return clone(input);
  }

  async createEntityEditRevision(input: PlanRevisionRecord, expectedActivePlanRevisionId: string | null): Promise<PlanRevisionRecord> {
    if (input.reason !== "manualEdit" || input.createdBy !== "user" || input.parentRevisionId === null || input.attemptId !== null) {
      throw conflict("PLAN_REVISION_INVALID", "人工校对版本来源无效。");
    }
    const project = this.projects.get(input.projectId);
    if (!project) throw notFound("PROJECT_NOT_FOUND", "项目不存在。");
    if (project.currentScriptVersionId !== input.scriptVersionId || project.activePlanRevisionId !== expectedActivePlanRevisionId) {
      throw conflict("PLAN_EDIT_CONFLICT", "剧本或已采用版本已变化，请刷新后重新校对。");
    }
    const latest = [...this.plans.values()].filter((plan) => plan.projectId === input.projectId && plan.scriptVersionId === input.scriptVersionId).at(-1);
    if (!latest || latest.id !== input.parentRevisionId || latest.runId !== input.runId || latest.sourceTaskId !== input.sourceTaskId) {
      throw conflict("PLAN_EDIT_CONFLICT", "已有更新的拆解候选，请刷新后基于最新版本校对。");
    }
    this.plans.set(input.id, clone(input));
    return clone(input);
  }

  async listPlanRevisions(runId: string): Promise<PlanRevisionRecord[]> {
    return [...this.plans.values()].filter((plan) => plan.runId === runId).map(clone);
  }

  async listProjectPlanRevisions(projectId: string): Promise<PlanRevisionRecord[]> {
    return [...this.plans.values()].filter((plan) => plan.projectId === projectId).map(clone);
  }

  async getPlanRevision(planRevisionId: string): Promise<PlanRevisionRecord | null> {
    const plan = this.plans.get(planRevisionId);
    return plan ? clone(plan) : null;
  }

  async savePlanCheck(check: PlanCheckRecord, issues: PlanIssueRecord[]): Promise<PlanCheckRecord> {
    const plan = this.plans.get(check.planRevisionId);
    if (!plan || plan.projectId !== check.projectId) throw notFound("PLAN_REVISION_NOT_FOUND", "候选计划不存在。");
    this.checks.set(check.id, clone(check));
    for (const issue of issues) this.issues.set(issue.id, clone(issue));
    return clone(check);
  }

  async listPlanChecks(planRevisionId: string): Promise<PlanCheckRecord[]> {
    return [...this.checks.values()].filter((check) => check.planRevisionId === planRevisionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(clone);
  }

  async listPlanIssues(checkId: string): Promise<PlanIssueRecord[]> {
    return [...this.issues.values()].filter((issue) => issue.checkId === checkId)
      .sort((a, b) => a.id.localeCompare(b.id)).map(clone);
  }

  async adoptPlan(input: PlanAdoptionRecord): Promise<PlanAdoptionRecord> {
    const project = this.projects.get(input.projectId);
    if (!project) throw notFound("PROJECT_NOT_FOUND", "项目不存在。");
    if (project.activePlanRevisionId !== input.fromRevisionId) {
      throw conflict("PLAN_ADOPTION_CONFLICT", "项目当前版本已变化，请刷新后再采用。");
    }
    const plan = this.plans.get(input.toRevisionId);
    const check = this.checks.get(input.checkId);
    const latest = [...this.plans.values()].filter((entry) => entry.projectId === project.id
      && entry.scriptVersionId === project.currentScriptVersionId).at(-1);
    if (!plan || plan.projectId !== project.id || plan.scriptVersionId !== project.currentScriptVersionId
      || latest?.id !== plan.id
      || !check || check.planRevisionId !== plan.id || check.result !== "passed"
      || check.ruleVersion !== FACT_CHECK_RULE_VERSION
      || [...this.issues.values()].some((issue) => issue.checkId === check.id && issue.blocking)) {
      throw conflict("PLAN_NOT_ADOPTABLE", "候选计划未通过当前检查、与当前剧本不一致，或已有更新候选；请刷新后重新检查。");
    }
    this.adoptions.set(input.id, clone(input));
    project.activePlanRevisionId = plan.id;
    project.activeStoryboardRevisionId = null;
    this.projects.set(project.id, clone(project));
    return clone(input);
  }

  async beginAttempt(input: {
    id: string; runId: string; taskId: string; promptVersion: string;
    executorVersion: string; inputDigest: string; startedAt: string;
  }): Promise<BreakdownAttemptRecord> {
    const run = this.runs.get(input.runId);
    if (!run || run.task.id !== input.taskId) {
      throw notFound("BREAKDOWN_RUN_NOT_FOUND", "拆解 Run 或事实提取任务不存在。");
    }
    if (run.status !== "draft" || run.task.state !== "pending") {
      throw conflict("BREAKDOWN_TASK_NOT_STARTABLE", "当前拆解任务不能开始新的执行尝试。");
    }
    const number = [...this.attempts.values()].filter((entry) => entry.taskId === input.taskId).length + 1;
    const attempt: BreakdownAttemptRecord = {
      id: input.id, taskId: input.taskId, number, status: "running",
      promptVersion: input.promptVersion, executorVersion: input.executorVersion,
      inputDigest: input.inputDigest, outputPlanRevisionId: null, error: null,
      startedAt: input.startedAt, endedAt: null,
    };
    this.attempts.set(attempt.id, clone(attempt));
    run.status = "running";
    run.sealedAt ??= input.startedAt;
    run.task.state = "running";
    run.task.activeAttemptId = attempt.id;
    this.runs.set(run.id, clone(run));
    return clone(attempt);
  }

  async createModelCall(input: {
    id: string; attemptId: string; operationKey: string; provider: string;
    model: string; requestDigest: string; createdAt: string;
  }): Promise<ModelCallRecord> {
    const attempt = this.attempts.get(input.attemptId);
    if (!attempt) throw notFound("ATTEMPT_NOT_FOUND", "执行尝试不存在。");
    if (attempt.status !== "running") throw conflict("ATTEMPT_NOT_RUNNING", "当前执行尝试不能再发起模型调用。");
    const run = [...this.runs.values()].find((entry) => entry.task.id === attempt.taskId)!;
    const count = [...this.modelCalls.values()].filter((entry) => entry.attemptId === input.attemptId).length;
    if (count >= run.task.maxModelCalls) throw conflict("MODEL_CALL_LIMIT_REACHED", "本次任务已达到模型调用上限。");
    if ([...this.modelCalls.values()].some((entry) => entry.operationKey === input.operationKey)) {
      throw conflict("MODEL_OPERATION_ALREADY_RECORDED", "模型操作键已经被记录。");
    }
    const call: ModelCallRecord = {
      id: input.id, attemptId: input.attemptId, operationKey: input.operationKey,
      provider: input.provider, model: input.model, requestDigest: input.requestDigest,
      providerRequestId: null, status: "prepared", usage: null, error: null,
      createdAt: input.createdAt, endedAt: null,
    };
    this.modelCalls.set(call.id, clone(call));
    return clone(call);
  }

  async markModelCallSubmitted(modelCallId: string): Promise<ModelCallRecord> {
    const call = this.requireModelCall(modelCallId);
    if (call.status !== "prepared") throw conflict("MODEL_CALL_NOT_PREPARED", "模型调用没有处于待提交状态。");
    call.status = "submitted";
    this.modelCalls.set(call.id, clone(call));
    return clone(call);
  }

  async completeModelCall(input: {
    modelCallId: string; providerRequestId: string | null;
    usage: ModelCallUsage | null; endedAt: string;
    response: unknown;
  }): Promise<ModelCallRecord> {
    // The in-memory fixture keeps the ledger shape only; raw response
    // persistence is a SQL-ledger concern (see migration 017).
    void input.response;
    const call = this.requireModelCall(input.modelCallId);
    if (call.status !== "submitted") throw conflict("MODEL_CALL_NOT_SUBMITTED", "模型调用没有处于已提交状态。");
    call.status = "succeeded";
    call.providerRequestId = input.providerRequestId;
    call.usage = input.usage ? clone(input.usage) : null;
    call.error = null;
    call.endedAt = input.endedAt;
    this.modelCalls.set(call.id, clone(call));
    return clone(call);
  }

  async failModelCall(input: {
    modelCallId: string; providerRequestId: string | null;
    error: SafeExecutionError; endedAt: string;
  }): Promise<ModelCallRecord> {
    const call = this.requireModelCall(input.modelCallId);
    if (call.status !== "prepared" && call.status !== "submitted") {
      throw conflict("MODEL_CALL_ALREADY_FINISHED", "模型调用已经结束。");
    }
    call.status = "failed";
    call.providerRequestId = input.providerRequestId;
    call.error = clone(input.error);
    call.endedAt = input.endedAt;
    this.modelCalls.set(call.id, clone(call));
    return clone(call);
  }

  async completeAttempt(input: {
    attemptId: string; planRevisionId: string; endedAt: string;
  }): Promise<BreakdownAttemptRecord> {
    const attempt = this.requireRunningAttempt(input.attemptId);
    const plan = this.plans.get(input.planRevisionId);
    if (!plan || plan.attemptId !== attempt.id || plan.sourceTaskId !== attempt.taskId) {
      throw conflict("ATTEMPT_PLAN_MISMATCH", "候选计划不属于当前执行尝试。");
    }
    attempt.status = "succeeded";
    attempt.outputPlanRevisionId = plan.id;
    attempt.endedAt = input.endedAt;
    this.attempts.set(attempt.id, clone(attempt));
    const run = this.requireRunForTask(attempt.taskId);
    run.status = "waiting";
    run.task.state = "waitingHuman";
    this.runs.set(run.id, clone(run));
    return clone(attempt);
  }

  async failAttempt(input: {
    attemptId: string; error: SafeExecutionError; endedAt: string;
  }): Promise<BreakdownAttemptRecord> {
    const attempt = this.requireRunningAttempt(input.attemptId);
    attempt.status = "failed";
    attempt.error = clone(input.error);
    attempt.endedAt = input.endedAt;
    this.attempts.set(attempt.id, clone(attempt));
    const run = this.requireRunForTask(attempt.taskId);
    run.status = "failed";
    run.task.state = "failed";
    this.runs.set(run.id, clone(run));
    return clone(attempt);
  }

  async getExecutionSnapshot(attemptId: string): Promise<ExecutionSnapshot | null> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return null;
    return {
      attempt: clone(attempt),
      modelCalls: [...this.modelCalls.values()]
        .filter((entry) => entry.attemptId === attemptId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .map(clone),
    };
  }

  private requireModelCall(id: string): ModelCallRecord {
    const call = this.modelCalls.get(id);
    if (!call) throw notFound("MODEL_CALL_NOT_FOUND", "模型调用记录不存在。");
    return clone(call);
  }

  private requireRunningAttempt(id: string): BreakdownAttemptRecord {
    const attempt = this.attempts.get(id);
    if (!attempt) throw notFound("ATTEMPT_NOT_FOUND", "执行尝试不存在。");
    if (attempt.status !== "running") throw conflict("ATTEMPT_ALREADY_FINISHED", "执行尝试已经结束。");
    return clone(attempt);
  }

  private requireRunForTask(taskId: string): BreakdownRunRecord {
    const run = [...this.runs.values()].find((entry) => entry.task.id === taskId);
    if (!run) throw notFound("BREAKDOWN_RUN_NOT_FOUND", "拆解 Run 不存在。");
    return clone(run);
  }
}

function toProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    title: row.title,
    source: row.source_json,
    currentScriptVersionId: row.current_script_version_id,
    activePlanRevisionId: row.active_plan_revision_id,
    activeStoryboardRevisionId: row.active_storyboard_revision_id,
    createdAt: toIso(row.created_at),
  };
}

function toCheck(row: CheckRow, issueIds: string[]): PlanCheckRecord {
  if (row.rule_version !== "extract-facts-completeness/1" && row.rule_version !== FACT_CHECK_RULE_VERSION) {
    throw new BreakdownError(500, "CHECK_RULE_UNSUPPORTED", "已保存的检查规则版本不受支持。");
  }
  return { id: row.id, projectId: row.project_id, planRevisionId: row.plan_revision_id,
    ruleVersion: row.rule_version, method: row.method, result: row.result,
    contentDigest: row.content_digest, issueIds, createdAt: toIso(row.created_at) };
}

function toIssue(row: IssueRow): PlanIssueRecord {
  return { id: row.id, checkId: row.check_id, projectId: row.project_id,
    planRevisionId: row.plan_revision_id, kind: row.kind, code: row.code,
    message: row.message, scope: decodeJson<PlanIssueRecord["scope"]>(row.scope_json, "stored issue scope"),
    sourceRefs: decodeJson<PlanIssueRecord["sourceRefs"]>(row.source_refs_json, "stored issue refs"),
    blocking: row.blocking, status: row.status, createdAt: toIso(row.created_at) };
}

function toAttempt(row: AttemptRow): BreakdownAttemptRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    number: row.number,
    status: row.status,
    promptVersion: row.prompt_version,
    executorVersion: row.executor_version,
    inputDigest: row.input_digest,
    outputPlanRevisionId: row.output_plan_revision_id,
    error: row.error_json === null ? null : decodeSafeError(row.error_json),
    startedAt: toIso(row.started_at),
    endedAt: row.ended_at ? toIso(row.ended_at) : null,
  };
}

function toModelCall(row: ModelCallRow): ModelCallRecord {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    operationKey: row.operation_key,
    provider: row.provider,
    model: row.model,
    requestDigest: row.request_digest,
    providerRequestId: row.provider_request_id,
    status: row.status,
    usage: row.usage_json === null ? null : decodeJson<ModelCallUsage>(row.usage_json, "stored model usage"),
    error: row.error_json === null ? null : decodeSafeError(row.error_json),
    createdAt: toIso(row.created_at),
    endedAt: row.ended_at ? toIso(row.ended_at) : null,
  };
}

function decodeSafeError(value: unknown): SafeExecutionError {
  const record = decodeJson<Record<string, unknown>>(value, "stored execution error");
  if (typeof record.code !== "string" || typeof record.message !== "string") {
    throw new BreakdownError(500, "PERSISTED_JSON_INVALID", "stored execution error 格式无效。");
  }
  return { code: record.code, message: record.message };
}

function toPlanRevision(row: PlanRevisionRow): PlanRevisionRecord {
  if (row.validator_version !== PLAN_VALIDATOR_VERSION && row.validator_version !== ENTITY_EDIT_VALIDATOR_VERSION) {
    throw new BreakdownError(500, "PERSISTED_PLAN_INVALID", "已保存的候选计划校验版本不受支持。");
  }
  if ((row.reason !== "extract" && row.reason !== "manualEdit")
    || (row.reason === "extract" && (row.created_by !== "agent" || row.parent_revision_id !== null || row.validator_version !== PLAN_VALIDATOR_VERSION))
    || (row.reason === "manualEdit" && (row.created_by !== "user" || row.parent_revision_id === null || row.attempt_id !== null
      || row.validator_version !== ENTITY_EDIT_VALIDATOR_VERSION))) {
    throw new BreakdownError(500, "PERSISTED_PLAN_INVALID", "已保存的候选计划来源无效。");
  }
  const content = decodeJson<PlanRevisionRecord["content"]>(row.content_json, "stored plan content");
  validateStoredPlanContent(content, { id: row.script_version_id, rawText: row.raw_text });
  return {
    id: row.id, projectId: row.project_id, scriptVersionId: row.script_version_id,
    runId: row.run_id, sourceTaskId: row.source_task_id, attemptId: row.attempt_id,
    parentRevisionId: row.parent_revision_id, rebasedFromRevisionId: row.rebased_from_revision_id,
    createdAt: toIso(row.created_at), createdBy: row.created_by, reason: row.reason,
    scope: decodeJson<PlanRevisionRecord["scope"]>(row.scope_json, "stored plan scope"),
    requirements: decodeJson<BreakdownRequirements>(row.requirements_json, "stored plan requirements"),
    content, status: row.status, validatorVersion: row.validator_version,
  };
}

function toStoredScript(row: ScriptRow): StoredScriptVersion {
  const sourceIndex = decodeJson<ScriptSourceIndex>(row.source_index_json, "stored source index");
  validateScriptSourceIndex(sourceIndex);
  const createdAt = toIso(row.created_at);
  if (
    sourceIndex.scriptVersion.id !== row.id
    || sourceIndex.scriptVersion.projectId !== row.project_id
    || sourceIndex.scriptVersion.version !== row.version
    || sourceIndex.scriptVersion.rawText !== row.raw_text
    || sourceIndex.scriptVersion.contentSha256 !== row.content_sha256
    || sourceIndex.scriptVersion.createdAt !== createdAt
    || sha256Utf8(row.raw_text) !== row.content_sha256
  ) {
    throw new BreakdownError(500, "PERSISTED_SOURCE_INDEX_INVALID", "已保存的原文索引与剧本版本不一致。");
  }
  return {
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    rawText: row.raw_text,
    contentSha256: row.content_sha256,
    createdAt,
    sourceIndex,
  };
}

function toSummary(script: StoredScriptVersion): ScriptVersionSummary {
  return {
    id: script.id,
    projectId: script.projectId,
    version: script.version,
    contentSha256: script.contentSha256,
    createdAt: script.createdAt,
    sourceIndex: {
      schemaVersion: script.sourceIndex.schemaVersion,
      unitCount: script.sourceIndex.units.length,
      spanCount: script.sourceIndex.spans.length,
      blockCount: script.sourceIndex.blocks.length,
    },
  };
}

function toRun(row: RunRow): BreakdownRunRecord {
  const task: BreakdownTaskRecord = {
    id: row.task_id,
    runId: row.id,
    type: row.task_type,
    scope: decodeJson<RunScope>(row.task_scope_json, "stored task scope"),
    inputManifest: decodeJson<TaskInputManifest>(row.input_manifest_json, "stored task input manifest"),
    state: row.task_state,
    activeAttemptId: row.task_active_attempt_id,
    maxModelCalls: row.task_max_model_calls,
    maxOutputTokens: row.task_max_output_tokens,
    createdAt: toIso(row.task_created_at),
  };
  return {
    id: row.id,
    projectId: row.project_id,
    target: row.target,
    scriptVersionId: row.script_version_id,
    requirements: decodeJson<BreakdownRequirements>(row.requirements_json, "stored requirements"),
    modelConfig: decodeJson<ResolvedModelConfig>(row.model_config_json, "stored model config"),
    scope: decodeJson<RunScope>(row.scope_json, "stored run scope"),
    mode: row.mode,
    humanCheckpoints: decodeJson<string[]>(row.human_checkpoints_json, "stored human checkpoints"),
    status: row.status,
    maxModelCalls: row.max_model_calls,
    maxOutputTokens: row.max_output_tokens,
    sealedAt: row.sealed_at ? toIso(row.sealed_at) : null,
    createdAt: toIso(row.created_at),
    task,
  };
}

function inputToRun(input: CreateDraftRunInput): BreakdownRunRecord {
  return { ...input.run, task: { ...input.task } };
}

function assertIndexMatchesStoredScript(
  index: ScriptSourceIndex,
  input: CreateStoredScriptVersionInput,
  version: number,
): void {
  validateScriptSourceIndex(index);
  if (
    index.scriptVersion.id !== input.id
    || index.scriptVersion.projectId !== input.projectId
    || index.scriptVersion.version !== version
    || index.scriptVersion.rawText !== input.rawText
    || index.scriptVersion.contentSha256 !== input.contentSha256
  ) {
    throw new BreakdownError(500, "SOURCE_INDEX_INVALID", "原文索引没有绑定到待保存的剧本版本。");
  }
}

function decodeJson<T>(value: unknown, label: string): T {
  if (value === null || typeof value !== "object") {
    throw new BreakdownError(500, "PERSISTED_JSON_INVALID", `${label} 格式无效。`);
  }
  return value as T;
}

function toIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new BreakdownError(500, "PERSISTED_TIMESTAMP_INVALID", "已保存的时间格式无效。");
  }
  return parsed.toISOString();
}

function notFound(code: string, message: string): BreakdownError {
  return new BreakdownError(404, code, message);
}

function conflict(code: string, message: string): BreakdownError {
  return new BreakdownError(409, code, message);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
