import { createHash } from 'node:crypto';
import { canonicalDigest, type QualityCheck } from './production';
import {
  type EvaluationCatalogKind,
  type MissingResultAction,
  type MissingResultPolicy,
} from './evaluation';

/**
 * 统一评估器协议、证据格式与分层指标（Issue #42）。
 *
 * 本文件只新增"结果/证据/适配/分层指标"这一层，不重新实现 EvaluationRun、
 * 冻结快照、case/sample attempt、事件/恢复或 DataEvent/Outbox/Projector。
 *
 * 状态语义（严格五态）：
 *  - pass/fail        ：对象本身通过/不通过，基于有效证据与量表阈值。
 *  - uncertain        ：证据不足或落在阈值区间内；不计为通过，也不计为失败。
 *  - skipped          ：评估器被显式跳过（前置不适用、未授权等）；对象未被评判。
 *  - evaluator_error ：评估器自身异常（适配器/超时/证据不可用/内部错误）；
 *                       这不是对象 fail，对象状态保持未知。
 *
 * 未知与缺失永远是 null / 独立计数，绝不当 0，也不当通过。
 */

export const EVALUATOR_PROTOCOL_VERSION = 'lyra-evaluator-result/1';

/* -------------------------------------------------------------------------- */
/* 五态                                                                         */
/* -------------------------------------------------------------------------- */

export type EvaluationResultStatus = 'pass' | 'fail' | 'uncertain' | 'skipped' | 'evaluator_error';

export const EVALUATION_RESULT_STATUSES: readonly EvaluationResultStatus[] = Object.freeze([
  'pass', 'fail', 'uncertain', 'skipped', 'evaluator_error',
]);

/** 只有这两态代表对对象做出了"有效数值/有效判断"；其余都是非有效观测。 */
export const EVALUATION_RESULT_VALID_STATUSES: readonly EvaluationResultStatus[] = Object.freeze(['pass', 'fail']);

export const EVALUATION_RESULT_STATUS_SEMANTICS: Readonly<Record<EvaluationResultStatus, string>> = Object.freeze({
  pass: '对象满足阈值；基于有效证据。',
  fail: '对象不满足阈值；基于有效证据。',
  uncertain: '证据不足或落在阈值区间；不计通过也不计失败。',
  skipped: '评估被显式跳过；对象未被评判。',
  evaluator_error: '评估器自身异常；对象状态未知，不是对象失败。',
});

export function isValidEvaluationResultStatus(status: EvaluationResultStatus): boolean {
  return EVALUATION_RESULT_VALID_STATUSES.includes(status);
}

/* -------------------------------------------------------------------------- */
/* 评估器定义与版本                                                             */
/* -------------------------------------------------------------------------- */

export type EvaluatorAdapterKind = 'rule_based' | 'model_based' | 'human' | 'hybrid';

export const EVALUATOR_ADAPTER_KINDS: readonly EvaluatorAdapterKind[] = Object.freeze([
  'rule_based', 'model_based', 'human', 'hybrid',
]);

/**
 * 一个评估器的静态定义。version 与 digest 由 EvaluatorVersion 冻结。
 * - rule_based ：确定性规则，无付费模型调用。
 * - model_based：付费模型评分；结果必须带模型连接摘要，不得记录密钥。
 * - human      ：人工判断；必须记录评判时间，不能被自动覆盖。
 * - hybrid     ：规则 + 模型 + 人工组合；各适配器语义在 evidence/metrics 中可分。
 */
export interface EvaluatorDefinition {
  evaluatorId: string;
  adapterKind: EvaluatorAdapterKind;
  /** 适用的评测目录种类；空数组表示通用。 */
  catalogKinds: readonly EvaluationCatalogKind[];
  /** 分层指标在达到该有效样本数前，聚合结论只能是 uncertain。 */
  minSampleSize: number;
  description: string;
}

/** 冻结的评估器版本身份。digest 覆盖 definition 与 version。 */
export interface EvaluatorVersion {
  evaluatorId: string;
  version: string;
  digest: string;
}

/* -------------------------------------------------------------------------- */
/* 结果定位、证据与指标                                                          */
/* -------------------------------------------------------------------------- */

/** 被评估对象的定位：kind + id + 可选 revisionId + digest。 */
export interface EvaluationSubjectRef {
  kind: string;
  id: string;
  revisionId: string | null;
  digest: string;
}

/** 评估结果在运行层级中的位置；任一上级可为 null（独立于 run 的结果）。 */
export interface EvaluationResultLocator {
  runId: string | null;
  caseId: string | null;
  sampleIndex: number | null;
}

/**
 * 证据引用。证据本体不在结果里；这里只有来源、摘要、定位与可用性/可见性。
 * locator 的字段都是可选的，按 kind 适用。
 */
export interface EvidenceLocator {
  entity: string | null;
  jsonPath: string | null;
  shotId: string | null;
  frameIndex: number | null;
  timecodeSec: number | null;
}

export type EvidenceAvailability = 'available' | 'missing' | 'restricted';
export type EvidenceVisibility = 'public' | 'internal' | 'confidential';

export const EVIDENCE_AVAILABILITIES: readonly EvidenceAvailability[] = Object.freeze(
  ['available', 'missing', 'restricted'],
);
export const EVIDENCE_VISIBILITIES: readonly EvidenceVisibility[] = Object.freeze(
  ['public', 'internal', 'confidential'],
);

export interface EvidenceRef {
  evidenceId: string;
  /** 来源系统/表名，例如 evolution_evidence、production_quality、evaluation_cases。 */
  source: string;
  /** 证据内容的 64 位摘要；证据缺失时为 null 而不是空串。 */
  sourceDigest: string | null;
  locator: EvidenceLocator;
  availability: EvidenceAvailability;
  visibility: EvidenceVisibility;
  note: string;
}

/**
 * 单条指标。value 为 null 表示该指标未知/缺失——绝不能用 0 表示缺失。
 * status 记录这条指标来自五态中的哪一态；valid 指标才有数值。
 */
export interface MetricResult {
  key: string;
  layer: MetricLayer;
  value: number | null;
  status: EvaluationResultStatus;
}

export type MetricLayer = 'sample' | 'case' | 'scene' | 'shot' | 'run' | 'version';

export const METRIC_LAYERS: readonly MetricLayer[] = Object.freeze(
  ['sample', 'case', 'scene', 'shot', 'run', 'version'],
);

/** 评估器自身异常的结构化描述；只挂在 status=evaluator_error 的结果上。 */
export interface EvaluatorError {
  category: 'adapter' | 'timeout' | 'availability' | 'internal';
  code: string;
  message: string;
}

/**
 * 旧结果类型的类型约束扩展。不是 Record<string, unknown>：
 * 每个成员都用具体旧类型的身份字段表达，保证可校验、可往返。
 */
export type EvaluationLegacyOrigin =
  | { kind: 'quality_check'; checkId: string; runId: string; level: QualityCheck['level']; ruleVersion: string }
  | { kind: 'asset_probe'; reportId: string; caseKey: string; fixtureVersion: string }
  | { kind: 'novel_breakdown_case'; datasetRevisionId: string; caseId: string };

/**
 * 统一评估结果。闭合、可运行时校验、追加式不可变。
 * resultDigest 是确定性幂等身份：同一定位 + 同一定位对象 + 同一评估器版本 +
 * 同一结论内容得到相同摘要；重放不应产生第二份。
 */
export interface EvaluationResult {
  schemaVersion: typeof EVALUATOR_PROTOCOL_VERSION;
  resultId: string;
  locator: EvaluationResultLocator;
  subject: EvaluationSubjectRef;
  evaluator: EvaluatorVersion;
  status: EvaluationResultStatus;
  /** 输入摘要（不含原文/密钥/媒体）。 */
  inputSummary: string;
  /** 输出摘要（不含原文/密钥/媒体）。 */
  outputSummary: string;
  /** 0..1；未知为 null。 */
  confidence: number | null;
  durationMs: number;
  evidence: readonly EvidenceRef[];
  metrics: readonly MetricResult[];
  error: EvaluatorError | null;
  legacy: EvaluationLegacyOrigin | null;
  /** 确定性幂等身份摘要。 */
  resultDigest: string;
  occurredAt: string;
  recordedAt: string;
}

/* -------------------------------------------------------------------------- */
/* 校验工具（与 evaluation.ts / evaluation-run.ts 同风格）                        */
/* -------------------------------------------------------------------------- */

export class EvaluatorContractError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: EvaluatorFieldIssue[] = [],
  ) {
    super(message);
    this.name = 'EvaluatorContractError';
  }
}

export interface EvaluatorFieldIssue {
  path: string;
  code: string;
  message: string;
}

function invalid(path: string, message: string, code = 'EVALUATOR_INPUT_INVALID'): never {
  throw new EvaluatorContractError(400, code, '评估器协议契约校验失败。', [{ path, code, message }]);
}

function object(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(path, '必须是对象。');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) invalid(`${path}.${key}`, '未知字段。');
  }
  return record;
}

function required(record: Record<string, unknown>, key: string, path: string): unknown {
  if (!(key in record) || record[key] === undefined) invalid(`${path}.${key}`, '缺少字段。');
  return record[key];
}

function text(value: unknown, path: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim()) invalid(path, '必须是非空字符串。');
  if (value.length > max) invalid(path, `长度不能超过 ${max}。`);
  return value;
}

function optionalText(value: unknown, path: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  return text(value, path, max);
}

function digest(value: unknown, path: string, requiredField = true): string {
  if (value === null && !requiredField) return '';
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    invalid(path, '必须是 64 位小写十六进制摘要。');
  }
  return value;
}

function nullableDigest(value: unknown, path: string): string | null {
  if (value === null) return null;
  return digest(value, path);
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    invalid(path, `必须是 ${min}..${max} 的整数。`);
  }
  return value;
}

function nullableInteger(value: unknown, path: string, min: number, max: number): number | null {
  if (value === null || value === undefined) return null;
  return integer(value, path, min, max);
}

function finite(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(path, `必须是 ${min}..${max} 的数值。`);
  }
  return value;
}

function nullableFinite(value: unknown, path: string, min: number, max: number): number | null {
  if (value === null || value === undefined) return null;
  return finite(value, path, min, max);
}

function timestamp(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    || Number.isNaN(Date.parse(value))) invalid(path, '必须是 UTC ISO 8601 时间。');
  return new Date(value).toISOString();
}

function nullableTimestamp(value: unknown, path: string): string | null {
  return value === null ? null : timestamp(value, path);
}

function enumValue<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    invalid(path, `必须是 ${allowed.join(' / ')}。`);
  }
  return value as T;
}

function array(value: unknown, path: string, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    invalid(path, `必须是 ${min}..${max} 项的数组。`);
  }
  return value;
}

function idToken(value: unknown, path: string, pattern: RegExp, label: string): string {
  const parsed = text(value, path, 160);
  if (!pattern.test(parsed)) invalid(path, `${label} 格式不合法。`);
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* 解析器                                                                       */
/* -------------------------------------------------------------------------- */

const RESULT_ID = /^evalres_[a-f0-9]{32}$/u;
const EVIDENCE_ID = /^evidev_[a-f0-9]{32}$/u;
const RUN_ID = /^evalrun_[a-f0-9]{32}$/u;

function parseEvaluatorVersion(value: unknown, path: string): EvaluatorVersion {
  const record = object(value, path, ['evaluatorId', 'version', 'digest']);
  return {
    evaluatorId: idToken(required(record, 'evaluatorId', path), `${path}.evaluatorId`,
      /^[a-z][a-z0-9_.-]{1,95}$/u, '评估器 ID'),
    version: text(required(record, 'version', path), `${path}.version`, 80),
    digest: digest(required(record, 'digest', path), `${path}.digest`),
  };
}

/** 计算评估器定义的冻结摘要。 */
export function evaluatorDefinitionDigest(definition: EvaluatorDefinition): string {
  return canonicalDigest({
    evaluatorId: definition.evaluatorId,
    adapterKind: definition.adapterKind,
    catalogKinds: [...definition.catalogKinds].sort(),
    minSampleSize: definition.minSampleSize,
    description: definition.description,
  });
}

export function parseEvaluatorDefinition(value: unknown, path = 'evaluator'): EvaluatorDefinition {
  const record = object(value, path, ['evaluatorId', 'adapterKind', 'catalogKinds', 'minSampleSize', 'description']);
  const kinds = array(required(record, 'catalogKinds', path), `${path}.catalogKinds`, 0, 8)
    .map((item) => enumValue(item, `${path}.catalogKinds`,
      ['novel_breakdown', 'asset_retrieval', 'shot_review'] as const));
  return {
    evaluatorId: idToken(required(record, 'evaluatorId', path), `${path}.evaluatorId`,
      /^[a-z][a-z0-9_.-]{1,95}$/u, '评估器 ID'),
    adapterKind: enumValue(required(record, 'adapterKind', path), `${path}.adapterKind`, EVALUATOR_ADAPTER_KINDS),
    catalogKinds: kinds,
    minSampleSize: integer(required(record, 'minSampleSize', path), `${path}.minSampleSize`, 1, 1000),
    description: text(required(record, 'description', path), `${path}.description`, 500),
  };
}

function parseSubject(value: unknown, path: string): EvaluationSubjectRef {
  const record = object(value, path, ['kind', 'id', 'revisionId', 'digest']);
  return {
    kind: text(required(record, 'kind', path), `${path}.kind`, 80),
    id: text(required(record, 'id', path), `${path}.id`, 160),
    revisionId: optionalText(record.revisionId, `${path}.revisionId`, 160),
    digest: digest(required(record, 'digest', path), `${path}.digest`),
  };
}

function parseLocator(value: unknown, path: string): EvaluationResultLocator {
  const record = object(value, path, ['runId', 'caseId', 'sampleIndex']);
  const runId = record.runId === null || record.runId === undefined
    ? null
    : idToken(record.runId, `${path}.runId`, RUN_ID, '运行 ID');
  const caseId = record.caseId === null || record.caseId === undefined
    ? null
    : text(record.caseId, `${path}.caseId`, 80);
  const sampleIndex = nullableInteger(record.sampleIndex, `${path}.sampleIndex`, 0, 19);
  if (runId === null && (caseId !== null || sampleIndex !== null)) {
    invalid(path, 'caseId/sampleIndex 必须挂靠在 runId 之下。');
  }
  if (caseId === null && sampleIndex !== null) invalid(path, 'sampleIndex 必须挂靠在 caseId 之下。');
  return { runId, caseId, sampleIndex };
}

function parseEvidenceLocator(value: unknown, path: string): EvidenceLocator {
  const record = object(value, path, ['entity', 'jsonPath', 'shotId', 'frameIndex', 'timecodeSec']);
  return {
    entity: optionalText(record.entity, `${path}.entity`, 160),
    jsonPath: optionalText(record.jsonPath, `${path}.jsonPath`, 200),
    shotId: optionalText(record.shotId, `${path}.shotId`, 160),
    frameIndex: nullableInteger(record.frameIndex, `${path}.frameIndex`, 0, 10_000_000),
    timecodeSec: nullableFinite(record.timecodeSec, `${path}.timecodeSec`, 0, 86_400),
  };
}

function parseEvidenceRef(value: unknown, path: string): EvidenceRef {
  const record = object(value, path,
    ['evidenceId', 'source', 'sourceDigest', 'locator', 'availability', 'visibility', 'note']);
  return {
    evidenceId: idToken(required(record, 'evidenceId', path), `${path}.evidenceId`, EVIDENCE_ID, '证据 ID'),
    source: text(required(record, 'source', path), `${path}.source`, 120),
    sourceDigest: nullableDigest(record.sourceDigest, `${path}.sourceDigest`),
    locator: parseEvidenceLocator(required(record, 'locator', path), `${path}.locator`),
    availability: enumValue(required(record, 'availability', path), `${path}.availability`, EVIDENCE_AVAILABILITIES),
    visibility: enumValue(required(record, 'visibility', path), `${path}.visibility`, EVIDENCE_VISIBILITIES),
    note: optionalText(record.note, `${path}.note`, 300) ?? '',
  };
}

function parseMetricResult(input: unknown, path: string): MetricResult {
  const record = object(input, path, ['key', 'layer', 'value', 'status']);
  const status = enumValue(required(record, 'status', path), `${path}.status`, EVALUATION_RESULT_STATUSES);
  const numValue = nullableFinite(record.value, `${path}.value`, -1e12, 1e12);
  if (numValue !== null && !isValidEvaluationResultStatus(status)) {
    invalid(path, '只有有效状态（pass/fail）的指标才能带数值；缺失用 null。');
  }
  if (numValue === null && isValidEvaluationResultStatus(status)) {
    invalid(path, '有效状态的指标必须带数值；未知请用 uncertain/skipped/evaluator_error。');
  }
  return {
    key: text(required(record, 'key', path), `${path}.key`, 80),
    layer: enumValue(required(record, 'layer', path), `${path}.layer`, METRIC_LAYERS),
    value: numValue,
    status,
  };
}

function parseEvaluatorError(value: unknown, path: string): EvaluatorError | null {
  if (value === null || value === undefined) return null;
  const record = object(value, path, ['category', 'code', 'message']);
  return {
    category: enumValue(required(record, 'category', path), `${path}.category`,
      ['adapter', 'timeout', 'availability', 'internal'] as const),
    code: text(required(record, 'code', path), `${path}.code`, 80),
    message: text(required(record, 'message', path), `${path}.message`, 500),
  };
}

function parseLegacyOrigin(value: unknown, path: string): EvaluationLegacyOrigin | null {
  if (value === null || value === undefined) return null;
  const record = object(value, path, ['kind', 'checkId', 'runId', 'level', 'ruleVersion',
    'reportId', 'caseKey', 'fixtureVersion', 'datasetRevisionId', 'caseId']);
  const kind = text(required(record, 'kind', path), `${path}.kind`, 40);
  if (kind === 'quality_check') {
    return {
      kind,
      checkId: text(required(record, 'checkId', path), `${path}.checkId`, 160),
      runId: text(required(record, 'runId', path), `${path}.runId`, 160),
      level: enumValue(required(record, 'level', path), `${path}.level`, ['shot', 'scene', 'episode'] as const),
      ruleVersion: text(required(record, 'ruleVersion', path), `${path}.ruleVersion`, 120),
    };
  }
  if (kind === 'asset_probe') {
    return {
      kind,
      reportId: text(required(record, 'reportId', path), `${path}.reportId`, 160),
      caseKey: text(required(record, 'caseKey', path), `${path}.caseKey`, 160),
      fixtureVersion: text(required(record, 'fixtureVersion', path), `${path}.fixtureVersion`, 120),
    };
  }
  if (kind === 'novel_breakdown_case') {
    return {
      kind,
      datasetRevisionId: text(required(record, 'datasetRevisionId', path), `${path}.datasetRevisionId`, 160),
      caseId: text(required(record, 'caseId', path), `${path}.caseId`, 160),
    };
  }
  invalid(path, 'legacy.kind 必须是 quality_check / asset_probe / novel_breakdown_case。');
}

/** 计算结果的确定性幂等身份摘要；不含 recordedAt（写入时间）。 */
export function evaluationResultDigest(result: {
  locator: EvaluationResultLocator;
  subject: EvaluationSubjectRef;
  evaluator: EvaluatorVersion;
  status: EvaluationResultStatus;
  inputSummary: string;
  outputSummary: string;
  confidence: number | null;
  durationMs: number;
  evidence: readonly EvidenceRef[];
  metrics: readonly MetricResult[];
  error: EvaluatorError | null;
  legacy: EvaluationLegacyOrigin | null;
  occurredAt: string;
}): string {
  return canonicalDigest({
    locator: result.locator,
    subject: result.subject,
    evaluator: result.evaluator,
    status: result.status,
    inputSummary: result.inputSummary,
    outputSummary: result.outputSummary,
    confidence: result.confidence,
    durationMs: result.durationMs,
    evidence: result.evidence,
    metrics: result.metrics,
    error: result.error,
    legacy: result.legacy,
    occurredAt: result.occurredAt,
  });
}

export function parseEvaluationResult(value: unknown, path = 'result'): EvaluationResult {
  const record = object(value, path, [
    'schemaVersion', 'resultId', 'locator', 'subject', 'evaluator', 'status', 'inputSummary',
    'outputSummary', 'confidence', 'durationMs', 'evidence', 'metrics', 'error', 'legacy',
    'resultDigest', 'occurredAt', 'recordedAt',
  ]);
  if (required(record, 'schemaVersion', path) !== EVALUATOR_PROTOCOL_VERSION) {
    invalid(`${path}.schemaVersion`, `必须是 ${EVALUATOR_PROTOCOL_VERSION}。`);
  }
  const status = enumValue(required(record, 'status', path), `${path}.status`, EVALUATION_RESULT_STATUSES);
  const error = parseEvaluatorError(record.error, `${path}.error`);
  if (status === 'evaluator_error' && error === null) {
    invalid(`${path}.error`, 'evaluator_error 结果必须记录结构化错误。');
  }
  if (status !== 'evaluator_error' && error !== null) {
    invalid(`${path}.error`, '非 evaluator_error 结果不能携带评估器错误。');
  }
  const evidence = array(required(record, 'evidence', path), `${path}.evidence`, 0, 64)
    .map((item, index) => parseEvidenceRef(item, `${path}.evidence[${index}]`));
  const metrics = array(required(record, 'metrics', path), `${path}.metrics`, 0, 32)
    .map((item, index) => parseMetricResult(item, `${path}.metrics[index]`));
  if (new Set(evidence.map(item => item.evidenceId)).size !== evidence.length) {
    invalid(`${path}.evidence`, '证据 ID 不能重复。');
  }
  if (new Set(metrics.map(item => item.key)).size !== metrics.length) {
    invalid(`${path}.metrics`, '指标 key 不能重复。');
  }
  const locator = parseLocator(required(record, 'locator', path), `${path}.locator`);
  const subject = parseSubject(required(record, 'subject', path), `${path}.subject`);
  const evaluator = parseEvaluatorVersion(required(record, 'evaluator', path), `${path}.evaluator`);
  const legacy = parseLegacyOrigin(record.legacy, `${path}.legacy`);
  const occurredAt = timestamp(required(record, 'occurredAt', path), `${path}.occurredAt`);
  const recordedAt = timestamp(required(record, 'recordedAt', path), `${path}.recordedAt`);
  if (recordedAt < occurredAt) invalid(`${path}.recordedAt`, '记录时间不能早于发生时间。');
  const parsed: EvaluationResult = {
    schemaVersion: EVALUATOR_PROTOCOL_VERSION,
    resultId: idToken(required(record, 'resultId', path), `${path}.resultId`, RESULT_ID, '结果 ID'),
    locator,
    subject,
    evaluator,
    status,
    inputSummary: optionalText(record.inputSummary, `${path}.inputSummary`, 2000) ?? '',
    outputSummary: optionalText(record.outputSummary, `${path}.outputSummary`, 2000) ?? '',
    confidence: nullableFinite(record.confidence, `${path}.confidence`, 0, 1),
    durationMs: integer(required(record, 'durationMs', path), `${path}.durationMs`, 0, 86_400_000),
    evidence,
    metrics,
    error,
    legacy,
    resultDigest: '',
    occurredAt,
    recordedAt,
  };
  const expected = evaluationResultDigest(parsed);
  const claimed = digest(required(record, 'resultDigest', path), `${path}.resultDigest`);
  if (claimed !== expected) {
    invalid(`${path}.resultDigest`, '结果摘要与内容不一致。', 'EVALUATOR_RESULT_DIGEST_MISMATCH');
  }
  parsed.resultDigest = claimed;
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* 分层指标聚合（顺序无关）                                                       */
/* -------------------------------------------------------------------------- */

export interface MetricObservation {
  value: number | null;
  status: EvaluationResultStatus;
}

export interface MetricSummary {
  key: string;
  layer: MetricLayer;
  total: number;
  valid: number;
  missing: number;
  uncertain: number;
  skipped: number;
  error: number;
  /** 仅对有效（pass/fail 且带数值）观测求统计；无有效观测时为 null。 */
  mean: number | null;
  variance: number | null;
  p50: number | null;
  p95: number | null;
  /** valid/total；total=0 时为 null。 */
  coverage: number | null;
  /** 基于 pass/valid 的 Wilson 区间；无有效观测时为 null。 */
  lowerBound: number | null;
  upperBound: number | null;
  minSampleSize: number;
  /** 应用 MissingResultPolicy 后的整体结论；不满足 minSampleSize 时强制 uncertain。 */
  effectiveStatus: EvaluationResultStatus;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) throw new Error('empty');
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const a = sorted[base]!;
  const b = sorted[base + 1] ?? a;
  return a + rest * (b - a);
}

/**
 * 把 MissingResultPolicy 应用到非有效观测上，得到"参与判定"的 pass/fail 计数。
 * 原始计数始终保留在 summary 中；这里只决定 effectiveStatus。
 */
function applyPolicy(
  counts: { valid: number; pass: number; uncertain: number; skipped: number; error: number },
  policy: MissingResultPolicy,
): EvaluationResultStatus {
  let failWeight = 0;
  let uncertainWeight = 0;
  // 只有该桶非空时才按策略加权；exclude 从判定中剔除，但原始计数仍保留。
  const apply = (action: MissingResultAction, bucket: number): void => {
    if (bucket === 0) return;
    if (action === 'fail') failWeight += bucket;
    else if (action === 'review') uncertainWeight += bucket;
  };
  apply(policy.uncertain, counts.uncertain);
  apply(policy.skipped, counts.skipped);
  apply(policy.evaluator_error, counts.error);
  // 纯评估器自身异常：没有任何有效判定，且非有效态全是 error → 保留 evaluator_error。
  if (counts.valid === 0 && counts.error > 0 && counts.uncertain === 0 && counts.skipped === 0) {
    return 'evaluator_error';
  }
  if (failWeight > 0) return 'fail';
  if (counts.valid > 0 && counts.pass < counts.valid) return 'fail';
  if (uncertainWeight > 0) return 'uncertain';
  if (counts.valid === 0) return 'uncertain';
  return 'pass';
}

/**
 * 顺序无关的分层指标聚合。
 * - 输入顺序不影响输出（计数用 Map、数值先排序再求分位数）。
 * - 低于 minSampleSize（有效观测数）时 effectiveStatus 强制为 uncertain。
 * - 未知/缺失永远进 missing/uncertain/skipped/error，不进数值统计，不当 0。
 */
export function summarizeMetric(
  key: string,
  layer: MetricLayer,
  observations: readonly MetricObservation[],
  minSampleSize: number,
  policy: MissingResultPolicy,
): MetricSummary {
  const total = observations.length;
  let valid = 0;
  let pass = 0;
  let missing = 0;
  let uncertain = 0;
  let skipped = 0;
  let error = 0;
  const values: number[] = [];
  for (const obs of observations) {
    switch (obs.status) {
      case 'pass':
        valid += 1; pass += 1;
        if (obs.value !== null) values.push(obs.value);
        break;
      case 'fail':
        valid += 1;
        if (obs.value !== null) values.push(obs.value);
        break;
      case 'uncertain':
        uncertain += 1;
        if (obs.value === null) missing += 1;
        break;
      case 'skipped':
        skipped += 1;
        if (obs.value === null) missing += 1;
        break;
      case 'evaluator_error':
        error += 1;
        if (obs.value === null) missing += 1;
        break;
    }
  }
  values.sort((a, b) => a - b);
  const n = values.length;
  const mean = n > 0 ? values.reduce((a, b) => a + b, 0) / n : null;
  const variance = n > 1
    ? values.reduce((acc, v) => acc + (v - mean!) * (v - mean!), 0) / n
    : null;
  const p50 = n > 0 ? quantile(values, 0.5) : null;
  const p95 = n > 0 ? quantile(values, 0.95) : null;
  const coverage = total > 0 ? valid / total : null;

  // Wilson 区间，针对 pass/valid 比例
  let lowerBound: number | null = null;
  let upperBound: number | null = null;
  if (valid > 0) {
    const p = pass / valid;
    const z = 1.96;
    const denom = 1 + z * z / valid;
    const center = (p + z * z / (2 * valid)) / denom;
    const margin = (z * Math.sqrt(p * (1 - p) / valid + z * z / (4 * valid * valid))) / denom;
    lowerBound = Math.max(0, center - margin);
    upperBound = Math.min(1, center + margin);
  }

  let effectiveStatus = applyPolicy(
    { valid, pass, uncertain, skipped, error },
    policy,
  );
  if (valid < Math.max(1, minSampleSize)) {
    // 样本不足：任何结论都只能是 uncertain（评估器自身异常保留为 evaluator_error）
    if (!(error > 0 && policy.evaluator_error === 'exclude' && valid === 0 && uncertain === 0 && skipped === 0)) {
      effectiveStatus = 'uncertain';
    }
  }
  return {
    key, layer, total, valid, missing, uncertain, skipped, error,
    mean, variance, p50, p95, coverage, lowerBound, upperBound,
    minSampleSize, effectiveStatus,
  };
}

/* -------------------------------------------------------------------------- */
/* 适配器：旧结果类型 → 统一结果（无损、类型约束、可往返）                         */
/* -------------------------------------------------------------------------- */

export interface AdaptContext {
  locator: EvaluationResultLocator;
  subject: EvaluationSubjectRef;
  evaluator: EvaluatorVersion;
  occurredAt: string;
  recordedAt: string;
  confidence: number | null;
  durationMs: number;
  inputSummary: string;
}

function evidenceId(): string {
  return `evidev_${createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 32)}`;
}

/**
 * QualityCheck（生产技术检查）→ 统一结果。
 * result: pass/fail/uncertain 直接映射；level: shot/scene/episode → shot/scene/run 层。
 * 旧字段全部进入 subject/legacy/metrics，不丢弃。
 */
export function fromQualityCheck(check: QualityCheck, ctx: AdaptContext): EvaluationResult {
  const status: EvaluationResultStatus = check.result;
  const layer: MetricLayer = check.level === 'episode' ? 'run' : check.level;
  const evidence: EvidenceRef = {
    evidenceId: evidenceId(),
    source: 'production_quality',
    sourceDigest: null,
    locator: {
      entity: check.taskId,
      jsonPath: null,
      shotId: null,
      frameIndex: null,
      timecodeSec: null,
    },
    availability: 'available',
    visibility: 'internal',
    note: `QualityCheck ${check.id} ${check.ruleVersion}: ${check.summary}`,
  };
  const metrics: MetricResult[] = [{
    key: 'quality_check',
    layer,
    value: status === 'pass' ? 1 : status === 'fail' ? 0 : null,
    status,
  }];
  const legacy: EvaluationLegacyOrigin = {
    kind: 'quality_check',
    checkId: check.id,
    runId: check.runId,
    level: check.level,
    ruleVersion: check.ruleVersion,
  };
  const base = {
    locator: ctx.locator,
    subject: ctx.subject,
    evaluator: ctx.evaluator,
    status,
    inputSummary: ctx.inputSummary,
    outputSummary: `${check.summary}${check.issues.length ? `；issues: ${check.issues.join('; ')}` : ''}`,
    confidence: ctx.confidence,
    durationMs: ctx.durationMs,
    evidence: [evidence],
    metrics,
    error: null,
    legacy,
    occurredAt: ctx.occurredAt,
  };
  return {
    schemaVersion: EVALUATOR_PROTOCOL_VERSION,
    resultId: `evalres_${createHash('sha256').update(JSON.stringify(base)).digest('hex').slice(0, 32)}`,
    ...base,
    resultDigest: evaluationResultDigest(base),
    recordedAt: ctx.recordedAt,
  };
}

/**
 * AssetProbeCase（离线资产检索探针）→ 统一结果。
 * probeCase.pass 是确定性布尔；expected=missing 且正确识别为缺失也算 pass。
 * 探针 modelCalls 必须为 0，适配器固定走 rule_based 语义。
 */
export function fromAssetProbeCase(
  reportId: string,
  fixtureVersion: string,
  probeCase: { caseKey: string; expected: 'unique' | 'ambiguous' | 'missing'; pass: boolean },
  ctx: AdaptContext,
): EvaluationResult {
  const status: EvaluationResultStatus = probeCase.pass ? 'pass' : 'fail';
  const evidence: EvidenceRef = {
    evidenceId: evidenceId(),
    source: 'evolution_probes',
    sourceDigest: null,
    locator: {
      entity: probeCase.caseKey,
      jsonPath: null,
      shotId: null,
      frameIndex: null,
      timecodeSec: null,
    },
    availability: 'available',
    visibility: 'internal',
    note: `AssetProbe ${reportId} case=${probeCase.caseKey} expected=${probeCase.expected}`,
  };
  const metrics: MetricResult[] = [{
    key: 'asset_probe_case',
    layer: 'case',
    value: probeCase.pass ? 1 : 0,
    status,
  }];
  const legacy: EvaluationLegacyOrigin = {
    kind: 'asset_probe',
    reportId,
    caseKey: probeCase.caseKey,
    fixtureVersion,
  };
  const base = {
    locator: ctx.locator,
    subject: ctx.subject,
    evaluator: ctx.evaluator,
    status,
    inputSummary: ctx.inputSummary,
    outputSummary: `expected=${probeCase.expected}; pass=${probeCase.pass}`,
    confidence: ctx.confidence,
    durationMs: ctx.durationMs,
    evidence: [evidence],
    metrics,
    error: null,
    legacy,
    occurredAt: ctx.occurredAt,
  };
  return {
    schemaVersion: EVALUATOR_PROTOCOL_VERSION,
    resultId: `evalres_${createHash('sha256').update(JSON.stringify(base)).digest('hex').slice(0, 32)}`,
    ...base,
    resultDigest: evaluationResultDigest(base),
    recordedAt: ctx.recordedAt,
  };
}

/**
 * NovelBreakdown case/sample 输出 → 统一结果。
 * 不虚构历史结果类型：只接收规则比对后的原始计数（期望实体数、命中实体数、
 * 期望来源引用数、实际来源引用数），由 rule_based 适配器映射为五态。
 * 命中不足 → uncertain（证据不足），而不是 fail。
 */
export interface NovelBreakdownComparison {
  expectedEntityCount: number;
  matchedEntityCount: number;
  expectedSourceRefCount: number;
  matchedSourceRefCount: number;
}

export function fromNovelBreakdownCaseOutput(
  datasetRevisionId: string,
  caseId: string,
  comparison: NovelBreakdownComparison,
  ctx: AdaptContext,
): EvaluationResult {
  const entityRatio = comparison.expectedEntityCount > 0
    ? comparison.matchedEntityCount / comparison.expectedEntityCount
    : 1;
  const sourceRatio = comparison.expectedSourceRefCount > 0
    ? comparison.matchedSourceRefCount / comparison.expectedSourceRefCount
    : 1;
  // 1.0 = pass；缺实体但仍有部分命中 = uncertain；完全未命中 = fail。
  let status: EvaluationResultStatus;
  if (comparison.expectedEntityCount > 0 && comparison.matchedEntityCount === 0) status = 'fail';
  else if (entityRatio >= 1 && sourceRatio >= 1) status = 'pass';
  else status = 'uncertain';
  const evidence: EvidenceRef = {
    evidenceId: evidenceId(),
    source: 'evaluation_cases',
    sourceDigest: null,
    locator: {
      entity: caseId,
      jsonPath: null,
      shotId: null,
      frameIndex: null,
      timecodeSec: null,
    },
    availability: 'available',
    visibility: 'confidential',
    note: `NovelBreakdown case ${caseId}: entities ${comparison.matchedEntityCount}/${comparison.expectedEntityCount}`,
  };
  const metrics: MetricResult[] = [
    { key: 'entity_match_ratio', layer: 'case', value: entityRatio, status },
    { key: 'source_ref_ratio', layer: 'case', value: sourceRatio, status },
  ];
  const legacy: EvaluationLegacyOrigin = { kind: 'novel_breakdown_case', datasetRevisionId, caseId };
  const base = {
    locator: ctx.locator,
    subject: ctx.subject,
    evaluator: ctx.evaluator,
    status,
    inputSummary: ctx.inputSummary,
    outputSummary: `entities ${comparison.matchedEntityCount}/${comparison.expectedEntityCount}; `
      + `sources ${comparison.matchedSourceRefCount}/${comparison.expectedSourceRefCount}`,
    confidence: ctx.confidence,
    durationMs: ctx.durationMs,
    evidence: [evidence],
    metrics,
    error: null,
    legacy,
    occurredAt: ctx.occurredAt,
  };
  return {
    schemaVersion: EVALUATOR_PROTOCOL_VERSION,
    resultId: `evalres_${createHash('sha256').update(JSON.stringify(base)).digest('hex').slice(0, 32)}`,
    ...base,
    resultDigest: evaluationResultDigest(base),
    recordedAt: ctx.recordedAt,
  };
}
