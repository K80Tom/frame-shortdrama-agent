import Ajv from "ajv";
import { Type, type Static } from "@sinclair/typebox";
import {
  parseScriptStructure,
  serializeScriptStructure,
  validateScriptStructure,
  type ScriptStructure,
} from "@lyra/shared";
import { BreakdownError } from "./errors";

const ajv = new Ajv({ allErrors: false });

const OpaqueIdSchema = Type.String({
  minLength: 3,
  maxLength: 128,
  pattern: "^[a-z][a-z0-9_-]*$",
});
const NonblankText = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });

export const BreakdownRequirementsSchema = Type.Object({
  language: Type.Optional(NonblankText(80)),
  visualStyle: Type.Optional(NonblankText(1_000)),
  aspectRatio: Type.Optional(NonblankText(32)),
  targetDurationSeconds: Type.Optional(Type.Union([
    Type.Null(),
    Type.Object({
      min: Type.Integer({ minimum: 1, maximum: 86_400 }),
      max: Type.Integer({ minimum: 1, maximum: 86_400 }),
    }, { additionalProperties: false }),
  ])),
}, { additionalProperties: false });
export type BreakdownRequirements = Static<typeof BreakdownRequirementsSchema>;

const CreateProjectSchema = Type.Object({
  title: NonblankText(160),
  source: Type.Optional(Type.Object({
    url: NonblankText(2048),
    title: Type.Optional(NonblankText(160)),
    author: Type.Optional(NonblankText(160)),
    chapterTitle: Type.Optional(NonblankText(160)),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export type CreateProjectRequest = Static<typeof CreateProjectSchema>;

const CreateScriptVersionSchema = Type.Object({
  rawText: Type.Optional(NonblankText(2_000_000)),
  structure: Type.Optional(Type.Unknown()),
}, { additionalProperties: false });
export interface CreateScriptVersionRequest {
  rawText: string;
  /** 正式结构；与 rawText 同时提供时以结构派生文本为准。 */
  structure?: ScriptStructure;
}

const ReasoningEffortSchema = Type.Literal("model-default");

const ModelConfigOverrideSchema = Type.Object({
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_.:() /-]+$" })),
  reasoningEffort: Type.Optional(ReasoningEffortSchema),
}, { additionalProperties: false });
export type ModelConfigOverride = Static<typeof ModelConfigOverrideSchema>;

const CreateBreakdownRunSchema = Type.Object({
  scriptVersionId: Type.Optional(OpaqueIdSchema),
  requirements: Type.Optional(BreakdownRequirementsSchema),
  modelConfig: Type.Optional(ModelConfigOverrideSchema),
  maxModelCalls: Type.Integer({ minimum: 1, maximum: 8 }),
  maxOutputTokens: Type.Integer({ minimum: 256, maximum: 32_768 }),
  // P0.2 only creates reviewable draft candidates.  Auto adoption/execution is
  // intentionally not an API option yet.
  mode: Type.Optional(Type.Literal("checkpoints")),
  humanCheckpoints: Type.Optional(Type.Array(NonblankText(80), { minItems: 0, maxItems: 16 })),
}, { additionalProperties: false });
export type CreateBreakdownRunRequest = Static<typeof CreateBreakdownRunSchema>;

const validateProject = ajv.compile<CreateProjectRequest>(CreateProjectSchema);
const validateScript = ajv.compile<CreateScriptVersionRequest>(CreateScriptVersionSchema);
const validateRun = ajv.compile<CreateBreakdownRunRequest>(CreateBreakdownRunSchema);

const AdoptPlanSchema = Type.Object({
  planRevisionId: OpaqueIdSchema,
  checkId: OpaqueIdSchema,
  expectedActivePlanRevisionId: Type.Union([Type.Null(), OpaqueIdSchema]),
}, { additionalProperties: false });
export type AdoptPlanRequest = Static<typeof AdoptPlanSchema>;
const validateAdoptPlan = ajv.compile<AdoptPlanRequest>(AdoptPlanSchema);

function parse<T>(validate: { (value: unknown): boolean; errors?: unknown }, value: unknown, message: string): T {
  if (!validate(value)) throw new BreakdownError(400, "INVALID_BREAKDOWN_REQUEST", message);
  // The schemas are JSON-only.  Cloning gives the service an immutable input
  // boundary rather than retaining a Fastify request-body reference.
  return structuredClone(value) as T;
}

export function parseCreateProject(value: unknown): CreateProjectRequest {
  const parsed = parse<CreateProjectRequest>(validateProject, value, "项目创建请求不符合约定。");
  if (parsed.source) {
    let url: URL;
    try { url = new URL(parsed.source.url); }
    catch { throw new BreakdownError(400, "INVALID_SOURCE_URL", "来源链接格式不合法。"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new BreakdownError(400, "INVALID_SOURCE_URL", "来源链接须是无凭据的 HTTPS 地址。");
    }
    parsed.source.url = url.href;
  }
  return { title: parsed.title.trim(), ...(parsed.source ? { source: parsed.source } : {}) };
}

export function parseCreateScriptVersion(value: unknown): CreateScriptVersionRequest {
  const parsed = parse<{ rawText?: string; structure?: unknown }>(validateScript, value, "剧本文本请求不符合约定。");
  let rawText: string;
  let structure: ScriptStructure | undefined;
  if (parsed.structure !== undefined) {
    try {
      structure = validateScriptStructure(parsed.structure);
    } catch (reason) {
      throw new BreakdownError(400, "INVALID_SCRIPT_STRUCTURE",
        reason instanceof Error ? reason.message : "结构化剧本不符合约定。");
    }
    rawText = serializeScriptStructure(structure);
    if (!rawText.trim()) throw new BreakdownError(400, "INVALID_SCRIPT_STRUCTURE", "结构化剧本不能为空。");
  } else {
    if (typeof parsed.rawText !== "string" || !parsed.rawText.trim()) {
      throw new BreakdownError(400, "INVALID_BREAKDOWN_REQUEST", "剧本文本或结构化剧本至少提供一项。");
    }
    rawText = parsed.rawText;
    // 输入原文时立即做一次结构化拆解：分集/场次/元素成为正式快照，
    // 原文仍保留为用户输入，后续在结构化编辑器保存时才派生出 canonical rawText。
    structure = parseScriptStructure(rawText);
  }
  if (Buffer.byteLength(rawText, "utf8") > 2 * 1024 * 1024) {
    throw new BreakdownError(413, "SCRIPT_TOO_LARGE", "剧本文本超过当前 P0.2 的 2 MiB 上限。");
  }
  return { rawText, ...(structure ? { structure } : {}) };
}

export function parseCreateBreakdownRun(value: unknown): CreateBreakdownRunRequest {
  const parsed = parse<CreateBreakdownRunRequest>(validateRun, value, "拆解 Run 创建请求不符合约定。");
  const duration = parsed.requirements?.targetDurationSeconds;
  if (duration && duration.min > duration.max) {
    throw new BreakdownError(400, "INVALID_BREAKDOWN_REQUEST", "目标时长的 min 不能大于 max。");
  }
  return parsed;
}

export function parseAdoptPlan(value: unknown): AdoptPlanRequest {
  return parse<AdoptPlanRequest>(validateAdoptPlan, value, "采用候选计划的请求不符合约定。");
}

export function parseOpaqueId(value: string, label: string): string {
  if (!/^[a-z][a-z0-9_-]{2,127}$/.test(value)) {
    throw new BreakdownError(400, "INVALID_BREAKDOWN_REQUEST", `${label} 格式不合法。`);
  }
  return value;
}
