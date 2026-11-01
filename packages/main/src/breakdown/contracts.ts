import Ajv from "ajv";
import { Type, type Static } from "@sinclair/typebox";
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
  rawText: NonblankText(2_000_000),
}, { additionalProperties: false });
export type CreateScriptVersionRequest = Static<typeof CreateScriptVersionSchema>;

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
  const parsed = parse<CreateScriptVersionRequest>(validateScript, value, "剧本文本请求不符合约定。");
  if (Buffer.byteLength(parsed.rawText, "utf8") > 2 * 1024 * 1024) {
    throw new BreakdownError(413, "SCRIPT_TOO_LARGE", "剧本文本超过当前 P0.2 的 2 MiB 上限。");
  }
  return parsed;
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
