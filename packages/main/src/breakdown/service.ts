import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "../config";
import { configuredModel } from "../models/registry";
import {
  buildScriptSourceIndex,
  createScriptVersion as createCanonicalScriptVersion,
  SOURCE_INDEX_SCHEMA_VERSION,
} from "./source-index";
import type {
  BreakdownRequirements,
  CreateBreakdownRunRequest,
  CreateProjectRequest,
  CreateScriptVersionRequest,
  ModelConfigOverride,
} from "./contracts";
import { BreakdownError } from "./errors";
import {
  materializeEntityEdits,
  materializeExtractFactsCandidate,
  parseCreateEntityEdits,
  ENTITY_EDIT_VALIDATOR_VERSION,
  PLAN_VALIDATOR_VERSION,
  type CreateEntityEditsRequest,
  type CreateExtractFactsCandidateRequest,
  type PlanRevisionRecord,
} from "./plan";
import {
  FACT_CHECK_RULE_VERSION,
  inspectExtractFactsPlan,
  type PlanAdoptionRecord,
  type PlanCheckRecord,
  type PlanIssueRecord,
} from "./quality";
import {
  INPUT_MANIFEST_SCHEMA_VERSION,
  type BreakdownRepository,
  type BreakdownRunRecord,
  type ProjectRecord,
  type ResolvedModelConfig,
  type ScriptVersionSummary,
  type StoredScriptVersion,
  type TaskInputManifest,
} from "./repository";

export interface BreakdownServicePort {
  createProject(input: CreateProjectRequest): Promise<ProjectRecord>;
  getProject(projectId: string): Promise<ProjectRecord>;
  listProjects(): Promise<ProjectRecord[]>;
  createScriptVersion(projectId: string, input: CreateScriptVersionRequest): Promise<StoredScriptVersion>;
  getScriptVersion(projectId: string, scriptVersionId: string): Promise<StoredScriptVersion>;
  listScriptVersions(projectId: string): Promise<ScriptVersionSummary[]>;
  createDraftRun(projectId: string, input: CreateBreakdownRunRequest): Promise<BreakdownRunRecord>;
  getRun(runId: string): Promise<BreakdownRunRecord>;
  listRuns(projectId: string): Promise<BreakdownRunRecord[]>;
  createExtractFactsCandidate(runId: string, input: CreateExtractFactsCandidateRequest): Promise<PlanRevisionRecord>;
  createEntityEditCandidate(baseRevisionId: string, input: CreateEntityEditsRequest): Promise<PlanRevisionRecord>;
  createExtractFactsCandidateForAttempt(
    runId: string,
    attemptId: string,
    input: CreateExtractFactsCandidateRequest,
  ): Promise<PlanRevisionRecord>;
  listPlanRevisions(runId: string): Promise<PlanRevisionRecord[]>;
  listProjectPlanRevisions(projectId: string): Promise<PlanRevisionRecord[]>;
  getPlanRevision(planRevisionId: string): Promise<PlanRevisionRecord>;
  checkPlan(planRevisionId: string): Promise<{ check: PlanCheckRecord; issues: PlanIssueRecord[] }>;
  listPlanChecks(planRevisionId: string): Promise<PlanCheckRecord[]>;
  listPlanIssues(checkId: string): Promise<PlanIssueRecord[]>;
  adoptPlan(projectId: string, input: {
    planRevisionId: string; checkId: string; expectedActivePlanRevisionId: string | null;
    /** Internal production orchestration may adopt a program-checked candidate. HTTP callers never set this field. */
    actor?: "user" | "agent";
  }): Promise<PlanAdoptionRecord>;
}

export interface BreakdownServiceOptions {
  now?: () => Date;
  nextId?: (prefix: string) => string;
}

/**
 * P0.2 coordinates only deterministic persistence work.  It intentionally has
 * no ModelClient dependency: creating a draft must not spend money or start a
 * background task.
 */
export class BreakdownService implements BreakdownServicePort {
  private readonly now: () => Date;
  private readonly nextId: (prefix: string) => string;

  constructor(
    private readonly repository: BreakdownRepository,
    private readonly config: Pick<AppConfig, "provider" | "defaultModel" | "reasoningEffort" | "modelConnections" | "connectionRevision">,
    options: BreakdownServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.nextId = options.nextId ?? ((prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`);
  }

  async createProject(input: CreateProjectRequest): Promise<ProjectRecord> {
    return this.repository.createProject({
      id: this.nextId("project"),
      title: input.title,
      source: input.source,
      createdAt: this.timestamp(),
    });
  }

  async getProject(projectId: string): Promise<ProjectRecord> { return this.requireProject(projectId); }

  async listProjects(): Promise<ProjectRecord[]> { return this.repository.listProjects(); }

  async createScriptVersion(projectId: string, input: CreateScriptVersionRequest): Promise<StoredScriptVersion> {
    await this.requireProject(projectId);
    const id = this.nextId("script");
    const createdAt = this.timestamp();
    return this.repository.createScriptVersion({
      id,
      projectId,
      rawText: input.rawText,
      contentSha256: sha256Utf8(input.rawText),
      createdAt,
      buildIndex: (version) => buildScriptSourceIndex(createCanonicalScriptVersion({
        id,
        projectId,
        version,
        rawText: input.rawText,
        createdAt,
      })),
    });
  }

  async getScriptVersion(projectId: string, scriptVersionId: string): Promise<StoredScriptVersion> {
    const script = await this.repository.getScriptVersion(projectId, scriptVersionId);
    if (!script) throw new BreakdownError(404, "SCRIPT_VERSION_NOT_FOUND", "剧本版本不存在或不属于该项目。");
    return script;
  }

  async listScriptVersions(projectId: string): Promise<ScriptVersionSummary[]> {
    await this.requireProject(projectId);
    return this.repository.listScriptVersions(projectId);
  }

  async createDraftRun(projectId: string, input: CreateBreakdownRunRequest): Promise<BreakdownRunRecord> {
    const project = await this.requireProject(projectId);
    const scriptVersionId = input.scriptVersionId ?? project.currentScriptVersionId;
    if (!scriptVersionId) {
      throw new BreakdownError(409, "SCRIPT_VERSION_REQUIRED", "请先保存一个剧本版本，再创建拆解 Run。");
    }
    const script = await this.repository.getScriptVersion(projectId, scriptVersionId);
    if (!script) {
      throw new BreakdownError(404, "SCRIPT_VERSION_NOT_FOUND", "剧本版本不存在或不属于该项目。");
    }

    const createdAt = this.timestamp();
    const runId = this.nextId("run");
    const requirements = cloneRequirements(input.requirements);
    const modelConfig = resolveModelConfig(this.config.modelConnections?.resolve('breakdown') ?? this.config, input.modelConfig);
    const scope = { kind: "project" as const, targetId: null };
    const maxModelCalls = input.maxModelCalls;
    const maxOutputTokens = input.maxOutputTokens;
    const mode = "checkpoints" as const;
    const humanCheckpoints = input.humanCheckpoints?.length
      ? [...input.humanCheckpoints]
      : ["candidatePlanReview"];
    const taskId = this.nextId("task");
    const inputManifest: TaskInputManifest = {
      schemaVersion: INPUT_MANIFEST_SCHEMA_VERSION,
      sourceIndexSchemaVersion: SOURCE_INDEX_SCHEMA_VERSION,
      entries: [
        {
          kind: "script",
          id: script.id,
          revisionId: script.id,
          fields: ["rawText", "sourceIndex"],
          digest: script.contentSha256,
        },
        {
          kind: "requirements",
          id: runId,
          revisionId: runId,
          fields: ["*"],
          digest: canonicalJsonSha256(requirements),
        },
      ],
    };

    return this.repository.createDraftRun({
      run: {
        id: runId,
        projectId,
        target: "breakdown",
        scriptVersionId: script.id,
        requirements,
        modelConfig,
        scope,
        mode,
        humanCheckpoints,
        status: "draft",
        maxModelCalls,
        maxOutputTokens,
        sealedAt: null,
        createdAt,
      },
      task: {
        id: taskId,
        runId,
        type: "extractFacts",
        scope,
        inputManifest,
        state: "pending",
        activeAttemptId: null,
        maxModelCalls,
        maxOutputTokens,
        createdAt,
      },
    });
  }

  async getRun(runId: string): Promise<BreakdownRunRecord> {
    const run = await this.repository.getRun(runId);
    if (!run) throw new BreakdownError(404, "BREAKDOWN_RUN_NOT_FOUND", "拆解 Run 不存在或已删除。");
    return run;
  }

  async listRuns(projectId: string): Promise<BreakdownRunRecord[]> {
    await this.requireProject(projectId);
    return this.repository.listRuns(projectId);
  }

  async createExtractFactsCandidate(
    runId: string,
    input: CreateExtractFactsCandidateRequest,
  ): Promise<PlanRevisionRecord> {
    return this.saveExtractFactsCandidate(runId, null, input);
  }

  async createExtractFactsCandidateForAttempt(
    runId: string,
    attemptId: string,
    input: CreateExtractFactsCandidateRequest,
  ): Promise<PlanRevisionRecord> {
    return this.saveExtractFactsCandidate(runId, attemptId, input);
  }

  private async saveExtractFactsCandidate(
    runId: string,
    attemptId: string | null,
    input: CreateExtractFactsCandidateRequest,
  ): Promise<PlanRevisionRecord> {
    const run = await this.getRun(runId);
    const script = await this.repository.getScriptVersion(run.projectId, run.scriptVersionId);
    if (!script) throw new BreakdownError(409, "SCRIPT_VERSION_UNAVAILABLE", "候选所需剧本版本不可用。");
    const content = materializeExtractFactsCandidate(input, {
      script,
      nextId: (prefix) => this.nextId(prefix),
    });
    return this.repository.createPlanRevision({
      id: this.nextId("plan"),
      projectId: run.projectId,
      scriptVersionId: run.scriptVersionId,
      runId: run.id,
      sourceTaskId: run.task.id,
      attemptId,
      parentRevisionId: null,
      rebasedFromRevisionId: null,
      createdAt: this.timestamp(),
      createdBy: "agent",
      reason: "extract",
      scope: { kind: "project", targetId: null },
      requirements: structuredClone(run.requirements),
      content,
      status: "candidate",
      validatorVersion: PLAN_VALIDATOR_VERSION,
    });
  }

  async listPlanRevisions(runId: string): Promise<PlanRevisionRecord[]> {
    await this.getRun(runId);
    return this.repository.listPlanRevisions(runId);
  }

  async listProjectPlanRevisions(projectId: string): Promise<PlanRevisionRecord[]> {
    await this.requireProject(projectId);
    return this.repository.listProjectPlanRevisions(projectId);
  }

  async createEntityEditCandidate(baseRevisionId: string, input: CreateEntityEditsRequest): Promise<PlanRevisionRecord> {
    const request = parseCreateEntityEdits(input);
    const base = await this.getPlanRevision(baseRevisionId);
    const script = await this.getScriptVersion(base.projectId, base.scriptVersionId);
    const revisionId = this.nextId("plan");
    const content = materializeEntityEdits(base.content, request.edits, { script, revisionId });
    return this.repository.createEntityEditRevision({
      id: revisionId,
      projectId: base.projectId,
      scriptVersionId: base.scriptVersionId,
      runId: base.runId,
      sourceTaskId: base.sourceTaskId,
      attemptId: null,
      parentRevisionId: base.id,
      rebasedFromRevisionId: null,
      createdAt: this.timestamp(),
      createdBy: "user",
      reason: "manualEdit",
      scope: { kind: "project", targetId: null },
      requirements: structuredClone(base.requirements),
      content,
      status: "candidate",
      validatorVersion: ENTITY_EDIT_VALIDATOR_VERSION,
    }, request.expectedActivePlanRevisionId);
  }

  async getPlanRevision(planRevisionId: string): Promise<PlanRevisionRecord> {
    const plan = await this.repository.getPlanRevision(planRevisionId);
    if (!plan) throw new BreakdownError(404, "PLAN_REVISION_NOT_FOUND", "候选计划版本不存在或已删除。");
    return plan;
  }

  async checkPlan(planRevisionId: string): Promise<{ check: PlanCheckRecord; issues: PlanIssueRecord[] }> {
    const plan = await this.getPlanRevision(planRevisionId);
    const script = await this.getScriptVersion(plan.projectId, plan.scriptVersionId);
    const findings = inspectExtractFactsPlan(plan, script.sourceIndex);
    const createdAt = this.timestamp();
    const checkId = this.nextId("check");
    const issues: PlanIssueRecord[] = findings.map((finding) => ({
      ...finding, id: this.nextId("issue"), checkId,
      projectId: plan.projectId, planRevisionId: plan.id,
      status: "open", createdAt,
    }));
    const check: PlanCheckRecord = {
      id: checkId, projectId: plan.projectId, planRevisionId: plan.id,
      ruleVersion: FACT_CHECK_RULE_VERSION, method: "program",
      result: issues.length === 0 ? "passed" : "failed",
      contentDigest: canonicalJsonSha256(plan.content),
      issueIds: issues.map((issue) => issue.id), createdAt,
    };
    await this.repository.savePlanCheck(check, issues);
    return { check, issues };
  }

  async listPlanChecks(planRevisionId: string): Promise<PlanCheckRecord[]> {
    await this.getPlanRevision(planRevisionId);
    return this.repository.listPlanChecks(planRevisionId);
  }

  async listPlanIssues(checkId: string): Promise<PlanIssueRecord[]> {
    return this.repository.listPlanIssues(checkId);
  }

  async adoptPlan(projectId: string, input: {
    planRevisionId: string; checkId: string; expectedActivePlanRevisionId: string | null;
    actor?: "user" | "agent";
  }): Promise<PlanAdoptionRecord> {
    const actor = input.actor ?? "user";
    if (actor !== "user" && actor !== "agent") {
      throw new BreakdownError(400, "PLAN_ADOPTION_ACTOR_INVALID", "采用操作者类型无效。");
    }
    const plan = await this.getPlanRevision(input.planRevisionId);
    if (plan.projectId !== projectId) throw new BreakdownError(404, "PLAN_REVISION_NOT_FOUND", "候选计划不属于该项目。");
    const checks = await this.repository.listPlanChecks(plan.id);
    const check = checks.find((entry) => entry.id === input.checkId);
    if (!check || check.result !== "passed" || check.ruleVersion !== FACT_CHECK_RULE_VERSION
      || check.contentDigest !== canonicalJsonSha256(plan.content)) {
      throw new BreakdownError(409, "PLAN_NOT_ADOPTABLE", "候选计划没有通过当前规则检查。");
    }
    return this.repository.adoptPlan({
      id: this.nextId("adoption"), projectId,
      fromRevisionId: input.expectedActivePlanRevisionId,
      toRevisionId: plan.id, checkId: check.id, actor, createdAt: this.timestamp(),
    });
  }

  private async requireProject(projectId: string): Promise<ProjectRecord> {
    const project = await this.repository.getProject(projectId);
    if (!project) throw new BreakdownError(404, "PROJECT_NOT_FOUND", "项目不存在或已删除。");
    return project;
  }

  private timestamp(): string {
    const time = this.now();
    if (Number.isNaN(time.valueOf())) throw new Error("Clock returned an invalid date");
    return time.toISOString();
  }
}

/** Used when DATABASE_URL is absent or migrations have not been applied. */
export class UnavailableBreakdownService implements BreakdownServicePort {
  constructor(
    private readonly code = "PERSISTENCE_UNAVAILABLE",
    private readonly message = "拆解持久化尚未就绪；请先配置本机 PostgreSQL 并执行迁移。",
  ) {}

  async createProject(_: CreateProjectRequest): Promise<ProjectRecord> { return this.unavailable(); }
  async getProject(_: string): Promise<ProjectRecord> { return this.unavailable(); }
  async listProjects(): Promise<ProjectRecord[]> { return this.unavailable(); }
  async createScriptVersion(_: string, __: CreateScriptVersionRequest): Promise<StoredScriptVersion> { return this.unavailable(); }
  async getScriptVersion(_: string, __: string): Promise<StoredScriptVersion> { return this.unavailable(); }
  async listScriptVersions(_: string): Promise<ScriptVersionSummary[]> { return this.unavailable(); }
  async createDraftRun(_: string, __: CreateBreakdownRunRequest): Promise<BreakdownRunRecord> { return this.unavailable(); }
  async getRun(_: string): Promise<BreakdownRunRecord> { return this.unavailable(); }
  async listRuns(_: string): Promise<BreakdownRunRecord[]> { return this.unavailable(); }
  async createExtractFactsCandidate(_: string, __: CreateExtractFactsCandidateRequest): Promise<PlanRevisionRecord> {
    return this.unavailable();
  }
  async createEntityEditCandidate(_: string, __: CreateEntityEditsRequest): Promise<PlanRevisionRecord> { return this.unavailable(); }
  async createExtractFactsCandidateForAttempt(
    _: string,
    __: string,
    ___: CreateExtractFactsCandidateRequest,
  ): Promise<PlanRevisionRecord> { return this.unavailable(); }
  async listPlanRevisions(_: string): Promise<PlanRevisionRecord[]> { return this.unavailable(); }
  async listProjectPlanRevisions(_: string): Promise<PlanRevisionRecord[]> { return this.unavailable(); }
  async getPlanRevision(_: string): Promise<PlanRevisionRecord> { return this.unavailable(); }
  async checkPlan(_: string): Promise<{ check: PlanCheckRecord; issues: PlanIssueRecord[] }> { return this.unavailable(); }
  async listPlanChecks(_: string): Promise<PlanCheckRecord[]> { return this.unavailable(); }
  async listPlanIssues(_: string): Promise<PlanIssueRecord[]> { return this.unavailable(); }
  async adoptPlan(_: string, __: {
    planRevisionId: string; checkId: string; expectedActivePlanRevisionId: string | null;
    actor?: "user" | "agent";
  }): Promise<PlanAdoptionRecord> { return this.unavailable(); }

  private unavailable(): never {
    throw new BreakdownError(503, this.code, this.message);
  }
}

function resolveModelConfig(
  config: Pick<AppConfig, "provider" | "defaultModel" | "reasoningEffort" | "connectionRevision">,
  requested: ModelConfigOverride | undefined,
): ResolvedModelConfig {
  const modelId = requested?.model ?? config.defaultModel;
  const model = configuredModel(modelId, config.defaultModel);
  if (config.connectionRevision && modelId !== config.defaultModel) throw new BreakdownError(400, "UNKNOWN_MODEL", "请求的模型与拆解配置不一致。");
  if (!model) throw new BreakdownError(400, "UNKNOWN_MODEL", "未配置此模型，请从 /api/models 选择。");
  const configuredEffort = model.id === config.defaultModel && config.reasoningEffort !== "model-default"
    ? config.reasoningEffort
    : model.defaultReasoningEffort;
  const reasoningEffort = requested?.reasoningEffort ?? configuredEffort;
  if (!model.reasoningEfforts.includes(reasoningEffort)) {
    throw new BreakdownError(400, "EFFORT_UNSUPPORTED", "所选模型不支持此推理档位。");
  }
  return { provider: config.provider, model: model.id, reasoningEffort,
    ...(config.connectionRevision ? { connectionRevision: config.connectionRevision } : {}) };
}

function cloneRequirements(value: BreakdownRequirements | undefined): BreakdownRequirements {
  return value ? structuredClone(value) : {};
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Deterministic JSON digest used by the task's frozen input manifest. */
export function canonicalJsonSha256(value: unknown): string {
  return sha256Utf8(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Canonical JSON only accepts safe integer numbers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareCodePoints);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("Canonical JSON only accepts JSON values");
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]!.codePointAt(0)!;
    const rightPoint = rightPoints[index]!.codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}
