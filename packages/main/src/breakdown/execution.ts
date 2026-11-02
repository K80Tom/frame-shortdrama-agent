import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import type { ErrorObject } from "ajv";
import { Type, type Static } from "@sinclair/typebox";
import { BreakdownError, PaidModelExecutionError, type PaidModelCallState } from "./errors";
import { ModelError } from "@lyra/shared";
import { findModel } from "../models/registry";
import type { CreateExtractFactsCandidateRequest, PlanRevisionRecord } from "./plan";
import type {
  BreakdownRepository,
  ExecutionSnapshot,
  ModelCallUsage,
  SafeExecutionError,
  StoredScriptVersion,
  ResolvedModelConfig,
} from "./repository";
import { canonicalJsonSha256, type BreakdownService } from "./service";
import {
  buildEvidenceAliasCatalog,
  createPromptChunks,
  type EvidenceAlias,
  type SourceRef,
} from "./source-index";

export const EXTRACT_FACTS_CONTEXT_VERSION = "extract-facts-context/1";
export const EXTRACT_FACTS_PROMPT_VERSION = "extract-facts-prompt/3";
export const SINGLE_CALL_EXECUTOR_VERSION = "single-model-call-executor/1";

export const EXTRACT_FACTS_SYSTEM_PROMPT = `你是中文短剧剧本事实拆解 Agent。只输出一个 JSON 对象；禁止 Markdown、注释或 JSON 之外的任何文字。

【最重要的格式规则】
凡有原文来源的文字值，一律写成"溯源文本对象"：{"value":"文字","evidence":[{"chunkId":"chunk_0001","alias":"E001"}]}。
绝对禁止直接输出字符串：
错误："name":"林晚"
正确："name":{"value":"林晚","evidence":[{"chunkId":"chunk_0001","alias":"E001"}]}
name、title、description、synopsis 等所有文字字段都适用这条规则，没有例外。
evidence 至少一个指针，且至少一个来自 primary 别名（E 开头；C 开头是上下文别名，不能单独支撑任何输出）。
chunkId 与 alias 必须逐字取自输入提供的值，不得自造。无法确定的字段写 null；数组无内容写 []。

【顶层结构】
只含 synopsis,characters,locations,props,scenes,dialogues 六个字段。
synopsis 是溯源文本对象或 null。

【实体 characters/locations/props】
{"tempId":"chr1","name":溯源文本对象,"aliases":[溯源文本对象,...],"description":溯源文本对象或null,"evidence":[{"chunkId":"...","alias":"..."}]}
name、aliases、description 里每个文字都各自带 evidence；实体自身的 evidence 指向该实体出处原文。

【场次 scenes】
{"tempId":"scn1","order":1,"title":溯源文本对象,"locationTempId":"loc1"或null,"characterTempIds":["chr1"],"evidence":[...],"timeOfDay":溯源文本对象或null}
order 从 1 起连续递增；evidence 覆盖该场全部原文段落。

【对白 dialogues】
{"tempId":"dlg1","sceneTempId":"scn1","speakerTempId":"chr1"或null,"speakerEvidence":[...],"source":{"evidence":{"chunkId":"...","alias":"..."},"quote":"对白原文"}}
source.quote 必须是该别名原文中唯一出现的逐字对白，不含说话人前缀。所有对白必须全部拆出。
未知说话人写 "speakerTempId":null 且 "speakerEvidence":[]。

【其他】
tempId 全局唯一、至少 3 个字符、以小写字母开头，只含小写字母数字连字符下划线（人物用 chr1,chr2；地点用 loc1,loc2；道具用 prp1；场次用 scn1,scn2；对白用 dlg1,dlg2）。保留原剧情与对白，不得编造原文不存在的事实。`;

export const EXTRACT_FACTS_REPAIR_INSTRUCTIONS = `

【本次任务：修正上一次输出】
用户消息是一个 JSON 对象：{"ruleViolationReport":"协议违规清单","previousOutput":你上次的完整输出,"evidenceCatalog":[{"chunkId":"...","alias":"...","role":"...","quote":"..."},...]}。
evidenceCatalog 是当前唯一合法的证据指针目录：修正 evidence 指针时必须从中逐字选取 chunkId 与 alias，不得自造；对白的 quote 必须逐字取自所引指针的 quote 字段，且在该 quote 中唯一出现。
请逐条对照违规清单修正 previousOutput，输出修正后的完整 JSON 对象；结构、字段与格式要求与主任务完全一致。
未被点名的字段保持原样；只输出修正后的 JSON，不要输出解释。`;

/** Sanitized cause summary for a failed model-adapter call. Only whitelisted
 * fields from the domain error types are surfaced; raw error messages and
 * stack traces from unknown error shapes never reach the persisted record. */
function describeAdapterFailure(error: unknown): { summary: string; logCode: string } {
  if (error instanceof ModelError || error instanceof BreakdownError) {
    const upstreamStatus = error instanceof ModelError && typeof error.details.upstreamStatus === "number"
      ? error.details.upstreamStatus : null;
    const summary = `（${error.code}${upstreamStatus !== null ? `，上游状态 ${upstreamStatus}` : ""}）`;
    return { summary, logCode: `${error.code}${upstreamStatus !== null ? ` upstream=${upstreamStatus}` : ""}` };
  }
  return { summary: "", logCode: error instanceof Error ? error.constructor.name : typeof error };
}

export interface StageEvidence {
  alias: string;
  role: "primary" | "context";
  kind: EvidenceAlias["kind"];
  quote: string;
  speakerCandidate: string | null;
}

export interface ExtractFactsStageContext {
  methodReference?: string;
  schemaVersion: typeof EXTRACT_FACTS_CONTEXT_VERSION;
  runId: string;
  taskId: string;
  requirements: unknown;
  inputManifest: unknown;
  chunks: Array<{
    id: string;
    boundaryBefore: string;
    sectionHeadingAlias: string | null;
    evidence: StageEvidence[];
  }>;
}

export interface StageModelResult {
  output: unknown;
  providerRequestId: string | null;
  usage: ModelCallUsage | null;
}

export interface StageModelAdapter {
  forRun?(config: ResolvedModelConfig): StageModelAdapter;
  /** Fail before recording an attempt when the real service is not configured. */
  assertConfigured?(): void;
  call(input: {
    model: string;
    reasoningEffort: string;
    maxOutputTokens: number;
    payload: unknown;
  }): Promise<StageModelResult>;
}

export interface RecordedStageModelPort {
  call(payload: unknown): Promise<unknown>;
}

export interface ExtractFactsStageExecutor {
  readonly version: string;
  execute(context: ExtractFactsStageContext, model: RecordedStageModelPort): Promise<unknown>;
}

/** The first executor has one narrow responsibility. Pi can replace this class later. */
export class SingleModelCallExtractFactsExecutor implements ExtractFactsStageExecutor {
  readonly version = SINGLE_CALL_EXECUTOR_VERSION;

  async execute(context: ExtractFactsStageContext, model: RecordedStageModelPort): Promise<unknown> {
    return model.call({
      operation: "extractFacts",
      promptVersion: EXTRACT_FACTS_PROMPT_VERSION,
      rules: {
        preserveStoryFactsAndDialogue: true,
        factualEvidenceMustUsePrimaryAlias: true,
        contextAliasesCannotSolelySupportOutput: true,
        unknownFactsMustRemainNull: true,
      },
      context,
    });
  }
}

export interface ExtractFactsRunResult {
  plan: PlanRevisionRecord;
  execution: ExecutionSnapshot;
}

export interface ExtractFactsStageRunnerOptions {
  now?: () => Date;
  nextId?: (prefix: string) => string;
  targetEstimatedTokens?: number;
}

export class ExtractFactsStageRunner {
  private readonly now: () => Date;
  private readonly nextId: (prefix: string) => string;
  private readonly targetEstimatedTokens: number;

  constructor(
    private readonly repository: BreakdownRepository,
    private readonly service: BreakdownService,
    private readonly executor: ExtractFactsStageExecutor,
    private readonly adapter: StageModelAdapter,
    options: ExtractFactsStageRunnerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.nextId = options.nextId ?? ((prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`);
    this.targetEstimatedTokens = options.targetEstimatedTokens ?? 4_000;
  }

  async run(runId: string, methodReference = ""): Promise<ExtractFactsRunResult> {
    const run = await this.service.getRun(runId);
    const model = findModel(run.modelConfig.model);
    if (!this.adapter.forRun && (run.modelConfig.provider !== "maas" || !model || !model.reasoningEfforts.includes(run.modelConfig.reasoningEffort))) {
      throw new BreakdownError(409, "MODEL_CONFIGURATION_CHANGED", "此 Run 使用已移除的模型配置。历史结果仍可查看和校对，请新建 Run 使用当前模型。");
    }
    const adapter = this.adapter.forRun?.(run.modelConfig) ?? this.adapter;
    adapter.assertConfigured?.();
    const script = await this.repository.getScriptVersion(run.projectId, run.scriptVersionId);
    if (!script) throw new BreakdownError(409, "SCRIPT_VERSION_UNAVAILABLE", "执行所需剧本版本不可用。");
    const built = buildExtractFactsStageContext(run, script, this.targetEstimatedTokens);
    if (methodReference) built.context.methodReference = methodReference;
    const inputDigest = canonicalJsonSha256({
      ...(methodReference ? { methodReference } : {}),
      contextVersion: EXTRACT_FACTS_CONTEXT_VERSION,
      promptVersion: EXTRACT_FACTS_PROMPT_VERSION,
      executorVersion: this.executor.version,
      targetEstimatedTokens: this.targetEstimatedTokens,
      inputManifest: run.task.inputManifest,
      chunks: built.context.chunks,
    });
    const attempt = await this.repository.beginAttempt({
      id: this.nextId("attempt"),
      runId: run.id,
      taskId: run.task.id,
      promptVersion: EXTRACT_FACTS_PROMPT_VERSION,
      executorVersion: this.executor.version,
      inputDigest,
      startedAt: this.timestamp(),
    });

    let callOrdinal = 0;
    const modelPort: RecordedStageModelPort = {
      call: async (payload) => {
        callOrdinal += 1;
        const call = await this.repository.createModelCall({
          id: this.nextId("modelcall"),
          attemptId: attempt.id,
          operationKey: `${attempt.id}:extractFacts:${callOrdinal}`,
          provider: run.modelConfig.provider,
          model: run.modelConfig.model,
          requestDigest: canonicalJsonSha256(payload),
          createdAt: this.timestamp(),
        });
        await this.repository.markModelCallSubmitted(call.id);
        let result: StageModelResult;
        try {
          result = await adapter.call({
            model: run.modelConfig.model,
            reasoningEffort: run.modelConfig.reasoningEffort,
            maxOutputTokens: run.task.maxOutputTokens,
            payload,
          });
        } catch (error) {
          // Keep the sanitized surface but preserve WHY the adapter failed
          // (upstream status, timeout, network) so a failed paid attempt can
          // be diagnosed from the recorded model call instead of re-paying.
          const cause = describeAdapterFailure(error);
          console.error(
            `[breakdown] extract-facts model call failed: ${cause.logCode}` +
              ` (model=${run.modelConfig.model}, provider=${run.modelConfig.provider})`,
          );
          const detail = cause.summary ? `模型适配器调用失败。${cause.summary}` : "模型适配器调用失败。";
          await this.repository.failModelCall({
            modelCallId: call.id,
            providerRequestId: null,
            error: { code: "MODEL_ADAPTER_FAILED", message: detail },
            endedAt: this.timestamp(),
          });
          throw new BreakdownError(502, "MODEL_ADAPTER_FAILED", detail);
        }
        try {
          await this.repository.completeModelCall({
            modelCallId: call.id,
            providerRequestId: result.providerRequestId,
            usage: normalizeUsage(result.usage),
            endedAt: this.timestamp(),
            response: result.output,
          });
        } catch (error) {
          if (error instanceof BreakdownError) throw error;
          // The provider already returned. A missing response_json column
          // (migration 017) or a later ledger write error must not be stored
          // as an adapter failure: that hides the paid payload and invites
          // another charge.
          const errorName = error instanceof Error ? error.name : typeof error;
          console.error(
            `[breakdown] extract-facts ledger write failed after the model returned` +
              ` (model=${run.modelConfig.model}, provider=${run.modelConfig.provider}, error=${errorName})`,
          );
          throw new BreakdownError(
            503,
            "MODEL_CALL_LEDGER_UNAVAILABLE",
            "模型已经返回，但结果未能写入执行账本。请先执行 npm run db:migrate（需要迁移 017）后再核对，不要直接重新发起付费调用。",
          );
        }
        return result.output;
      },
    };

    try {
      const rawOutput = await this.executor.execute(built.context, modelPort);
      const submitCandidate = async (output: unknown): Promise<PlanRevisionRecord> => {
        const candidate = resolveAliasedExtractFactsCandidate(output, built.aliases);
        // Plan-level validation (ordering, quotes vs raw text, scene refs) runs
        // strictly before any persistence, so a rejected candidate has no side
        // effects and can safely go through the repair path below.
        return this.service.createExtractFactsCandidateForAttempt(run.id, attempt.id, candidate);
      };
      let plan: PlanRevisionRecord;
      try {
        plan = await submitCandidate(rawOutput);
      } catch (validation) {
        // Protocol-internal repair: the first pass produced output that failed
        // validation — schema shape, evidence pointers, quote matching, speaker
        // rules or plan-level ordering. When the attempt still has model call
        // budget (balanced presets reserve a second call), send the sanitized
        // violation report, the previous output and the evidence catalog back
        // for one bounded correction, then re-validate just as strictly.
        if (!(validation instanceof BreakdownError) || validation.status !== 422) throw validation;
        // The candidate may echo private scripts or method excerpts. The model call
        // record already owns the replayable result; keep only its diagnostic here.
        console.error(`[breakdown] extract-facts validation failed (attempt ${attempt.id}): ${validation.code}`);
        const evidenceCatalog = [...built.aliases.entries()].map(([key, entry]) => ({
          chunkId: key.slice(0, key.indexOf(":")),
          alias: entry.alias,
          role: entry.role,
          quote: entry.sourceRef.quote,
        }));
        let repairedOutput: unknown;
        try {
          repairedOutput = await modelPort.call({
            operation: "extractFacts",
            promptVersion: EXTRACT_FACTS_PROMPT_VERSION,
            systemPrompt: EXTRACT_FACTS_SYSTEM_PROMPT + EXTRACT_FACTS_REPAIR_INSTRUCTIONS,
            messages: [{
              role: "user",
              content: JSON.stringify({
                operation: "repairExtractFacts",
                ruleViolationReport: validation.message,
                previousOutput: rawOutput,
                evidenceCatalog,
                ...(methodReference ? { methodReference } : {}),
              }),
            }],
          });
        } catch (repairError) {
          // Budget exhausted: the original validation failure is the honest
          // diagnosis; do not mask it with the repair mechanism's error.
          if (repairError instanceof BreakdownError && repairError.code === "MODEL_CALL_LIMIT_REACHED") throw validation;
          throw repairError;
        }
        plan = await submitCandidate(repairedOutput);
      }
      await this.repository.completeAttempt({
        attemptId: attempt.id,
        planRevisionId: plan.id,
        endedAt: this.timestamp(),
      });
      const execution = await this.repository.getExecutionSnapshot(attempt.id);
      if (!execution) throw new Error("execution snapshot missing after completion");
      return { plan, execution };
    } catch (error) {
      const snapshot = await this.repository.getExecutionSnapshot(attempt.id);
      if (snapshot?.attempt.status === "running") {
        await this.repository.failAttempt({
          attemptId: attempt.id,
          error: safeExecutionError(error),
          endedAt: this.timestamp(),
        });
      }
      const paidModelCallState: PaidModelCallState = snapshot?.modelCalls.some(call => call.status === "succeeded")
        ? "confirmed"
        : snapshot?.modelCalls.some(call => call.status === "submitted" || call.status === "failed")
          ? "unknown"
          : "none";
      if (error instanceof BreakdownError) {
        throw new PaidModelExecutionError(error.status, error.code, error.message, paidModelCallState);
      }
      throw new PaidModelExecutionError(422, "STAGE_OUTPUT_INVALID", "事实提取结果未通过程序校验。", paidModelCallState);
    }
  }

  private timestamp(): string {
    const value = this.now();
    if (Number.isNaN(value.valueOf())) throw new Error("Clock returned an invalid date");
    return value.toISOString();
  }
}

interface BuiltStageContext {
  context: ExtractFactsStageContext;
  aliases: Map<string, EvidenceAlias>;
}

function buildExtractFactsStageContext(
  run: Awaited<ReturnType<BreakdownService["getRun"]>>,
  script: StoredScriptVersion,
  targetEstimatedTokens: number,
): BuiltStageContext {
  const chunks = createPromptChunks(script.sourceIndex, { targetEstimatedTokens });
  const aliases = new Map<string, EvidenceAlias>();
  const contextChunks = chunks.map((chunk) => {
    const catalog = buildEvidenceAliasCatalog(script.sourceIndex, chunk);
    for (const evidence of catalog) aliases.set(aliasKey(chunk.id, evidence.alias), evidence);
    const heading = chunk.sectionHeadingSpanId
      ? catalog.find((entry) => entry.spanId === chunk.sectionHeadingSpanId)
      : undefined;
    return {
      id: chunk.id,
      boundaryBefore: chunk.boundaryBefore,
      sectionHeadingAlias: heading?.alias ?? null,
      evidence: catalog.map((entry): StageEvidence => ({
        alias: entry.alias,
        role: entry.role,
        kind: entry.kind,
        quote: entry.sourceRef.quote,
        speakerCandidate: entry.speakerCandidate,
      })),
    };
  });
  return {
    context: {
      schemaVersion: EXTRACT_FACTS_CONTEXT_VERSION,
      runId: run.id,
      taskId: run.task.id,
      requirements: structuredClone(run.requirements),
      inputManifest: structuredClone(run.task.inputManifest),
      chunks: contextChunks,
    },
    aliases,
  };
}

const OpaqueId = Type.String({ minLength: 3, maxLength: 128, pattern: "^[a-z][a-z0-9_-]*$" });
const Nonblank = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const AliasPointerSchema = Type.Object({
  chunkId: Type.String({ pattern: "^chunk_[0-9]{4}$" }),
  alias: Type.String({ pattern: "^[EC][0-9]{3}$" }),
}, { additionalProperties: false });
const EvidenceListSchema = Type.Array(AliasPointerSchema, { minItems: 1, maxItems: 1_000 });
const AliasedSourcedTextSchema = Type.Object({
  value: Nonblank(20_000),
  evidence: EvidenceListSchema,
}, { additionalProperties: false });
const AliasedEntitySchema = Type.Object({
  tempId: OpaqueId,
  name: AliasedSourcedTextSchema,
  aliases: Type.Array(AliasedSourcedTextSchema, { maxItems: 128 }),
  description: Type.Union([Type.Null(), AliasedSourcedTextSchema]),
  evidence: EvidenceListSchema,
}, { additionalProperties: false });
const AliasedSceneSchema = Type.Object({
  tempId: OpaqueId,
  order: Type.Integer({ minimum: 1, maximum: 100_000 }),
  title: AliasedSourcedTextSchema,
  locationTempId: Type.Union([Type.Null(), OpaqueId]),
  characterTempIds: Type.Array(OpaqueId, { maxItems: 1_000, uniqueItems: true }),
  evidence: EvidenceListSchema,
  timeOfDay: Type.Union([Type.Null(), AliasedSourcedTextSchema]),
}, { additionalProperties: false });
const AliasedDialogueSchema = Type.Object({
  tempId: OpaqueId,
  sceneTempId: OpaqueId,
  speakerTempId: Type.Union([Type.Null(), OpaqueId]),
  speakerEvidence: Type.Array(AliasPointerSchema, { maxItems: 1_000 }),
  source: Type.Object({
    evidence: AliasPointerSchema,
    quote: Nonblank(20_000),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
const AliasedCandidateSchema = Type.Object({
  synopsis: Type.Union([Type.Null(), AliasedSourcedTextSchema]),
  characters: Type.Array(AliasedEntitySchema, { maxItems: 2_000 }),
  locations: Type.Array(AliasedEntitySchema, { maxItems: 2_000 }),
  props: Type.Array(AliasedEntitySchema, { maxItems: 2_000 }),
  scenes: Type.Array(AliasedSceneSchema, { maxItems: 2_000 }),
  dialogues: Type.Array(AliasedDialogueSchema, { maxItems: 20_000 }),
}, { additionalProperties: false });

type AliasPointer = Static<typeof AliasPointerSchema>;
type AliasedSourcedText = Static<typeof AliasedSourcedTextSchema>;
type AliasedEntity = Static<typeof AliasedEntitySchema>;
type AliasedScene = Static<typeof AliasedSceneSchema>;
type AliasedDialogue = Static<typeof AliasedDialogueSchema>;
type AliasedCandidate = Static<typeof AliasedCandidateSchema>;

const validateAliasedCandidate = new Ajv({ allErrors: true }).compile<AliasedCandidate>(AliasedCandidateSchema);

export function resolveAliasedExtractFactsCandidate(
  value: unknown,
  aliases: ReadonlyMap<string, EvidenceAlias>,
): CreateExtractFactsCandidateRequest {
  if (!validateAliasedCandidate(value)) {
    invalidStageOutput(describeSchemaIssues(validateAliasedCandidate.errors));
  }
  const candidate = structuredClone(value) as AliasedCandidate;
  const resolveEvidence = (pointers: AliasPointer[], label: string): SourceRef[] => {
    const resolved = pointers.map((pointer) => requireAlias(aliases, pointer));
    if (!resolved.some((entry) => entry.role === "primary")) {
      throw new BreakdownError(422, "CONTEXT_ONLY_EVIDENCE", `${label}只引用了上下文别名，必须至少引用一个 primary 别名（E 开头）。`);
    }
    return uniqueRefs(resolved.map((entry) => entry.sourceRef));
  };
  const sourced = (entry: AliasedSourcedText, label = "溯源文本字段") => ({
    value: entry.value,
    origin: "source" as const,
    sourceRefs: resolveEvidence(entry.evidence, `${label}的 evidence`),
    answerIds: [] as [],
  });
  const entity = (entry: AliasedEntity) => ({
    tempId: entry.tempId,
    name: sourced(entry.name),
    aliases: entry.aliases.map((item) => sourced(item)),
    description: entry.description ? sourced(entry.description) : null,
    sourceRefs: resolveEvidence(entry.evidence, `实体 ${entry.tempId} 的 evidence`),
  });
  const scene = (entry: AliasedScene) => ({
    tempId: entry.tempId,
    order: entry.order,
    title: sourced(entry.title),
    locationTempId: entry.locationTempId,
    characterTempIds: [...entry.characterTempIds],
    sourceRefs: resolveEvidence(entry.evidence, `场次 ${entry.tempId} 的 evidence`),
    timeOfDay: entry.timeOfDay ? sourced(entry.timeOfDay) : null,
  });
  const dialogue = (entry: AliasedDialogue) => {
    const sourceAlias = requireAlias(aliases, entry.source.evidence);
    if (sourceAlias.role !== "primary") {
      throw new BreakdownError(422, "CONTEXT_ONLY_EVIDENCE", `对白 ${entry.tempId} 的原文必须引用 primary 别名（E 开头）。`);
    }
    const speakerSourceRefs = entry.speakerEvidence.length
      ? resolveEvidence(entry.speakerEvidence, `对白 ${entry.tempId} 的 speakerEvidence`)
      : [];
    if (entry.speakerTempId !== null && speakerSourceRefs.length === 0) {
      throw new BreakdownError(422, "SPEAKER_EVIDENCE_MISSING", `说话人指定了实体，但没有提供说话证据（对白 ${entry.tempId}）。`);
    }
    if (entry.speakerTempId === null && speakerSourceRefs.length > 0) {
      throw new BreakdownError(422, "SPEAKER_EVIDENCE_ORPHANED", `说话人未指定实体，却提供了说话证据（对白 ${entry.tempId}）。`);
    }
    return {
      tempId: entry.tempId,
      sceneTempId: entry.sceneTempId,
      speakerTempId: entry.speakerTempId,
      speakerSourceRefs,
      speakerAnswerIds: [] as [],
      sourceRef: narrowQuote(sourceAlias.sourceRef, entry.source.quote, entry.tempId),
    };
  };
  const issues: string[] = [];
  let firstValidationError: BreakdownError | null = null;
  const attemptItem = <T>(resolve: () => T): T | undefined => {
    try {
      return resolve();
    } catch (error) {
      if (error instanceof BreakdownError && error.status === 422) {
        issues.push(error.message);
        firstValidationError ??= error;
        return undefined;
      }
      throw error;
    }
  };
  const resolved = {
    synopsis: attemptItem(() => (candidate.synopsis ? sourced(candidate.synopsis) : null)),
    characters: candidate.characters.map((entry) => attemptItem(() => entity(entry))),
    locations: candidate.locations.map((entry) => attemptItem(() => entity(entry))),
    props: candidate.props.map((entry) => attemptItem(() => entity(entry))),
    scenes: candidate.scenes.map((entry) => attemptItem(() => scene(entry))),
    dialogues: candidate.dialogues.map((entry) => attemptItem(() => dialogue(entry))),
  };
  if (firstValidationError) {
    // Single issue: keep the specific error code for the UI. Multiple issues:
    // report the complete list so one bounded repair call can fix them all.
    if (issues.length === 1) throw firstValidationError;
    throw new BreakdownError(422, "STAGE_OUTPUT_INVALID",
      `事实提取结果存在 ${issues.length} 处内容校验问题：${issues.join("；")}`);
  }
  sortDialoguesIntoScriptOrder(resolved as CreateExtractFactsCandidateRequest);
  return resolved as CreateExtractFactsCandidateRequest;
}

/**
 * Dialogue ordering is a property of the SCRIPT, not of the model's emission
 * order — models legitimately list dialogues per scene in discovery order.
 * Sort deterministically by (scene order, source position) instead of
 * rejecting unordered output; duplicate starting points are left for plan
 * validation because they indicate duplicated turns, which is a model error.
 */
function sortDialoguesIntoScriptOrder(candidate: CreateExtractFactsCandidateRequest): void {
  const sceneOrderById = new Map(candidate.scenes.map((scene) => [scene.tempId, scene.order] as const));
  if (!candidate.dialogues.every((dialogue) => sceneOrderById.has(dialogue.sceneTempId))) return;
  candidate.dialogues.sort((a, b) => {
    const sceneDelta = sceneOrderById.get(a.sceneTempId)! - sceneOrderById.get(b.sceneTempId)!;
    return sceneDelta !== 0 ? sceneDelta : a.sourceRef.start - b.sourceRef.start;
  });
}

function requireAlias(aliases: ReadonlyMap<string, EvidenceAlias>, pointer: AliasPointer): EvidenceAlias {
  const alias = aliases.get(aliasKey(pointer.chunkId, pointer.alias));
  if (!alias) throw new BreakdownError(422, "UNKNOWN_EVIDENCE_ALIAS", `引用了不存在的证据别名 ${pointer.chunkId}/${pointer.alias}；请改用 evidenceCatalog 中真实存在的指针。`);
  return alias;
}

function aliasKey(chunkId: string, alias: string): string {
  return `${chunkId}:${alias}`;
}

function narrowQuote(container: SourceRef, quote: string, tempId: string): SourceRef {
  // SourceRef offsets are Unicode CODE POINT indices; every computation below
  // stays in code point space so astral characters (emoji etc.) stay aligned.
  const haystack = Array.from(container.quote);
  const needle = Array.from(quote);
  const exactPositions: number[] = [];
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((point, offset) => point === haystack[start + offset]!)) exactPositions.push(start);
  }
  if (exactPositions.length === 1) {
    const start = container.start + exactPositions[0]!;
    return { scriptVersionId: container.scriptVersionId, start, end: start + needle.length,
      quote: haystack.slice(exactPositions[0]!, exactPositions[0]! + needle.length).join("") };
  }
  if (exactPositions.length === 0) {
    // Tolerant tier — NFKC per code point (full-width/half-width unification)
    // with whitespace skipped. Index maps stay in code points so the narrowed
    // ref always quotes the ORIGINAL span text verbatim.
    const normalizedHaystack = normalizeForQuote(haystack);
    const normalizedNeedle = normalizeForQuote(needle);
    if (normalizedNeedle.points.length > 0 && normalizedNeedle.points.length <= normalizedHaystack.points.length) {
      const tolerantPositions: Array<[number, number]> = [];
      outer: for (let i = 0; i <= normalizedHaystack.points.length - normalizedNeedle.points.length; i += 1) {
        for (let j = 0; j < normalizedNeedle.points.length; j += 1) {
          if (normalizedHaystack.points[i + j] !== normalizedNeedle.points[j]) continue outer;
        }
        tolerantPositions.push([
          normalizedHaystack.offsets[i]!,
          normalizedHaystack.ends[i + normalizedNeedle.points.length - 1]!,
        ]);
      }
      if (tolerantPositions.length === 1) {
        const [startOffset, endOffset] = tolerantPositions[0]!;
        return { scriptVersionId: container.scriptVersionId,
          start: container.start + startOffset, end: container.start + endOffset,
          quote: haystack.slice(startOffset, endOffset).join("") };
      }
    }
  }
  const containerExcerpt = container.quote.length > 60 ? `${container.quote.slice(0, 60)}…` : container.quote;
  throw new BreakdownError(422, "DIALOGUE_QUOTE_AMBIGUOUS",
    `对白 ${tempId} 的 quote 必须在其所引证据原文中逐字且唯一地出现（quote："${quote}"；证据原文："${containerExcerpt}"）。`);
}

interface NormalizedQuoteText {
  points: string[];
  offsets: number[];
  ends: number[];
}

/** Per-code-point NFKC with whitespace skipped; maps back to code point indices of the original text. */
function normalizeForQuote(points: readonly string[]): NormalizedQuoteText {
  const normalized: string[] = [];
  const offsets: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const point of points) {
    if (!/\s/.test(point)) {
      for (const expanded of point.normalize("NFKC")) {
        normalized.push(expanded);
        offsets.push(index);
        ends.push(index + 1);
      }
    }
    index += 1;
  }
  return { points: normalized, offsets, ends };
}

function uniqueRefs(refs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.scriptVersionId}:${ref.start}:${ref.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((ref) => ({ ...ref }));
}

function normalizeUsage(value: ModelCallUsage | null): ModelCallUsage | null {
  if (value === null) return null;
  const result: ModelCallUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const amount = value[key];
    if (amount !== undefined) {
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new BreakdownError(502, "MODEL_USAGE_INVALID", "模型适配器返回了无效的用量信息。");
      }
      result[key] = amount;
    }
  }
  return result;
}

function safeExecutionError(error: unknown): SafeExecutionError {
  if (error instanceof BreakdownError) return { code: error.code, message: error.message };
  return { code: "STAGE_EXECUTION_FAILED", message: "事实提取执行失败。" };
}

function invalidStageOutput(detail?: string): never {
  const suffix = detail ? `字段诊断：${detail}。` : "";
  throw new BreakdownError(422, "STAGE_OUTPUT_INVALID", `事实提取结果不符合阶段输出协议。${suffix}`);
}

const MAX_DIAGNOSTIC_ISSUES = 5;
const MAX_DIAGNOSTIC_PATH_LENGTH = 120;
const MAX_DIAGNOSTIC_TOKEN_LENGTH = 40;

/**
 * Turn Ajv schema failures into a short, sanitized Chinese diagnosis.
 * Only JSON pointer paths and schema-side constraints are reported; the
 * model-generated values themselves are never copied into the message.
 */
function describeSchemaIssues(errors: readonly ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "";
  const seenPaths = new Set<string>();
  const described: string[] = [];
  for (const error of errors) {
    if (described.length >= MAX_DIAGNOSTIC_ISSUES) break;
    if (seenPaths.has(error.instancePath)) continue;
    seenPaths.add(error.instancePath);
    described.push(formatSchemaIssue(error));
  }
  const omitted = errors.length - described.length;
  const summary = described.join("；");
  return omitted > 0 ? `${summary}；另有 ${omitted} 处未列出` : summary;
}

function formatSchemaIssue(error: ErrorObject): string {
  const path = formatIssuePath(error.instancePath);
  const params = (error.params ?? {}) as Record<string, unknown>;
  let reason: string;
  switch (error.keyword) {
    case "required":
      reason = `缺少必需字段 ${safeToken(params.missingProperty)}`;
      break;
    case "additionalProperties":
      reason = `出现未约定字段 ${safeToken(params.additionalProperty)}（协议不接受额外字段）`;
      break;
    case "type":
      reason = `类型应为 ${safeToken(params.type)}`;
      break;
    case "anyOf":
    case "oneOf":
      reason = "类型或结构不符合该字段的约定";
      break;
    case "pattern":
      reason = "格式不符合约定";
      break;
    case "minLength":
      reason = "内容为空或过短";
      break;
    case "maxLength":
      reason = "内容超过长度限制";
      break;
    case "minItems":
      reason = "条目数量不足";
      break;
    case "maxItems":
      reason = "条目数量超限";
      break;
    case "minimum":
    case "maximum":
      reason = "数值越界";
      break;
    case "enum":
      reason = "取值不在允许范围";
      break;
    case "uniqueItems":
      reason = "存在重复条目";
      break;
    default:
      reason = "不符合字段约定";
      break;
  }
  return `${path}：${reason}`;
}

function formatIssuePath(instancePath: string): string {
  const segments = instancePath.split("/").filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let result = "";
  for (const segment of segments) {
    if (/^[0-9]+$/.test(segment)) result += `[${segment}]`;
    else result += result ? `.${segment}` : segment;
  }
  return (result || "顶层").slice(0, MAX_DIAGNOSTIC_PATH_LENGTH);
}

function safeToken(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  const text = typeof value === "string" ? value : "";
  const cleaned = text.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return "?";
  return cleaned.length > MAX_DIAGNOSTIC_TOKEN_LENGTH
    ? `${cleaned.slice(0, MAX_DIAGNOSTIC_TOKEN_LENGTH)}…`
    : cleaned;
}
