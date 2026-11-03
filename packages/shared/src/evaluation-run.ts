import { canonicalDigest } from './production';
import {
  EVALUATION_CATALOG_KINDS,
  normalizeEvaluationText,
  type EvaluationCatalogKind,
} from './evaluation';

/**
 * 评测运行契约：冻结快照、状态机与运行/尝试/事件结构。
 *
 * 本文件只做类型、纯校验、规范化与摘要。持久化、执行与 HTTP 由 main 负责。
 * 快照字段使用闭合集合，禁止携带密钥、媒体、完整供应商响应或无授权原文。
 */

export const EVALUATION_RUN_SCHEMA_VERSION = 'lyra-evaluation-run/1';
export const EVALUATION_SNAPSHOT_SCHEMA_VERSION = 'lyra-evaluation-snapshot/1';

export type EvaluationRunStatus =
  | 'prepared' | 'running' | 'waiting_external' | 'waiting_human' | 'completed' | 'failed' | 'cancelled';
export const EVALUATION_RUN_STATUSES: readonly EvaluationRunStatus[] = Object.freeze([
  'prepared', 'running', 'waiting_external', 'waiting_human', 'completed', 'failed', 'cancelled',
]);
export const EVALUATION_RUN_TERMINAL_STATUSES: readonly EvaluationRunStatus[] = Object.freeze([
  'completed', 'failed', 'cancelled',
]);

/** 只允许这些迁移；终态没有出边。 */
export const EVALUATION_RUN_TRANSITIONS: Readonly<Record<EvaluationRunStatus, readonly EvaluationRunStatus[]>> =
  Object.freeze({
    prepared: ['running', 'cancelled'],
    running: ['waiting_external', 'waiting_human', 'completed', 'failed', 'cancelled'],
    waiting_external: ['running', 'failed', 'cancelled'],
    waiting_human: ['running', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
  });

export const EVALUATION_RUN_STATUS_SEMANTICS: Readonly<Record<EvaluationRunStatus, string>> = Object.freeze({
  prepared: '已冻结快照但尚未开始执行；不是完成，也不是通过。',
  running: '正在执行；不是完成，也不是通过。',
  waiting_external: '等待外部结果；不计入完成或通过。',
  waiting_human: '等待人工判断；不计入完成或通过。',
  completed: '执行已经结束；只表示不再执行，不等于评测通过。',
  failed: '执行失败并终止；不计入完成或通过。',
  cancelled: '被取消并终止；不计入完成或通过。',
});

export function isEvaluationRunTerminal(status: EvaluationRunStatus): boolean {
  return EVALUATION_RUN_TERMINAL_STATUSES.includes(status);
}

export function canTransitionEvaluationRun(from: EvaluationRunStatus, to: EvaluationRunStatus): boolean {
  return EVALUATION_RUN_TRANSITIONS[from].includes(to);
}

/** completed 只表示执行结束；不要用本函数推断评测通过。 */
export function isEvaluationRunExecutionFinished(status: EvaluationRunStatus): boolean {
  return status === 'completed';
}

export interface EvaluationRunFieldIssue {
  path: string;
  code: string;
  message: string;
}

export class EvaluationRunContractError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: EvaluationRunFieldIssue[] = [],
  ) {
    super(message);
    this.name = 'EvaluationRunContractError';
    this.details = details;
  }
}

function invalid(path: string, message: string, code = 'EVALUATION_RUN_INPUT_INVALID'): never {
  throw new EvaluationRunContractError(400, code, '评测运行契约校验失败。', [{ path, code, message }]);
}

function object(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(path, '必须是对象。');
  }
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

function text(value: unknown, path: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim()) invalid(path, '必须是非空字符串。');
  if (value.length > max) invalid(path, `长度不能超过 ${max}。`);
  return normalizeEvaluationText(value);
}

function rawText(value: unknown, path: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim()) invalid(path, '必须是非空字符串。');
  if (value.length > max) invalid(path, `长度不能超过 ${max}。`);
  return value;
}

function safeId(value: unknown, path: string): string {
  const parsed = rawText(value, path, 128);
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{2,127}$/u.test(parsed)) invalid(path, 'ID 格式不合法。');
  return parsed;
}

function patternId(value: unknown, path: string, pattern: RegExp, label: string): string {
  const parsed = rawText(value, path, 160);
  if (!pattern.test(parsed)) invalid(path, `${label} 格式不合法。`);
  return parsed;
}

function digest(value: unknown, path: string, requiredField = true): string {
  if (value === null && !requiredField) return '';
  const parsed = rawText(value, path, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) invalid(path, '必须是 64 位小写十六进制摘要。');
  return parsed;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    invalid(path, `必须是 ${min}..${max} 的整数。`);
  }
  return value;
}

function timestamp(value: unknown, path: string): string {
  const parsed = rawText(value, path, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(parsed)
    || Number.isNaN(Date.parse(parsed))) invalid(path, '必须是 UTC ISO 8601 时间。');
  return new Date(parsed).toISOString();
}

function enumValue<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(path, `必须是 ${allowed.join(' / ')}。`);
  return value as T;
}

function array(value: unknown, path: string, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    invalid(path, `必须是 ${min}..${max} 项的数组。`);
  }
  return value;
}

function nullableTimestamp(value: unknown, path: string): string | null {
  return value === null ? null : timestamp(value, path);
}

/* -------------------------------------------------------------------------- */
/* 敏感内容黑名单                                                              */
/* -------------------------------------------------------------------------- */

export const EVALUATION_SNAPSHOT_FORBIDDEN_KEYS: readonly string[] = Object.freeze([
  'apiKey', 'api_key', 'token', 'accessToken', 'refreshToken', 'authorization', 'password', 'secret',
  'credential', 'credentials', 'providerResponse', 'rawResponse', 'rawText', 'quote', 'content',
  'mediaBytes', 'binary', 'signedUrl', 'absolutePath', 'headers', 'cookie',
]);

const NORMALIZED_FORBIDDEN_KEYS = new Set(EVALUATION_SNAPSHOT_FORBIDDEN_KEYS.map(normalizeKey));

function normalizeKey(key: string): string {
  return key.replace(/[_-]/gu, '').toLowerCase();
}

function assertSafeValue(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value)
      || /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/u.test(value)
      || /\bsk-[A-Za-z0-9_-]{16,}/u.test(value)
      || /data:(?:image|video|audio)\/[a-z0-9.+-]+;base64,/iu.test(value)
      || /(?:^|[/\\])Users[/\\][^/\\]+[/\\]/u.test(value)
      || /[?&](?:X-Amz-Signature|Signature|token)=/iu.test(value)) {
      invalid(path, '快照不得包含密钥、媒体二进制、签名 URL 或绝对路径。', 'EVALUATION_RUN_SENSITIVE_FIELD');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeValue(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (NORMALIZED_FORBIDDEN_KEYS.has(normalizeKey(key))) {
        invalid(`${path}.${key}`, '快照不得包含敏感字段。', 'EVALUATION_RUN_SENSITIVE_FIELD');
      }
      assertSafeValue(item, `${path}.${key}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 冻结快照                                                                    */
/* -------------------------------------------------------------------------- */

export interface FrozenEvaluationDatasetRef {
  datasetId: string;
  revisionId: string;
  digest: string;
}

export interface FrozenEvaluationRubricRef {
  rubricId: string;
  revisionId: string;
  digest: string;
}

export interface FrozenEvaluationEvaluatorRef {
  evaluatorId: string;
  version: string;
  digest: string;
}

export interface FrozenEvaluationCandidateRef {
  candidateId: string;
  version: string;
  digest: string;
}

export interface FrozenEvaluationModelConnectionRef {
  connectionId: string;
  revisionId: string;
  provider: string;
  model: string;
  digest: string;
}

export interface FrozenEvaluationPromptRef {
  promptId: string;
  version: string;
  digest: string;
}

export interface FrozenEvaluationWorkflowRef {
  workflowId: string;
  version: string;
  digest: string;
}

export interface FrozenEvaluationCodeRef {
  version: string;
  commit: string;
  digest: string;
}

export interface FrozenEvaluationShardConfig {
  shardCount: number;
  shardIndex: number;
  concurrency: number;
  timeoutMs: number;
  samplesPerCase: number;
}

export interface FrozenEvaluationSnapshot {
  schemaVersion: typeof EVALUATION_SNAPSHOT_SCHEMA_VERSION;
  catalogKind: EvaluationCatalogKind;
  dataset: FrozenEvaluationDatasetRef;
  rubric: FrozenEvaluationRubricRef;
  evaluator: FrozenEvaluationEvaluatorRef;
  candidates: readonly FrozenEvaluationCandidateRef[];
  modelConnection: FrozenEvaluationModelConnectionRef;
  prompt: FrozenEvaluationPromptRef;
  workflow: FrozenEvaluationWorkflowRef;
  code: FrozenEvaluationCodeRef;
  seed: string;
  shards: FrozenEvaluationShardConfig;
  createdAt: string;
}

function parseDatasetRef(value: unknown, path: string): FrozenEvaluationDatasetRef {
  const record = object(value, path, ['datasetId', 'revisionId', 'digest']);
  return {
    datasetId: patternId(required(record, 'datasetId', path), `${path}.datasetId`,
      /^evalds_[a-f0-9]{32}$/u, '数据集 ID'),
    revisionId: patternId(required(record, 'revisionId', path), `${path}.revisionId`,
      /^evaldsrev_[a-f0-9]{32}$/u, '数据集 revision ID'),
    digest: digest(required(record, 'digest', path), `${path}.digest`),
  };
}

function parseRubricRef(value: unknown, path: string): FrozenEvaluationRubricRef {
  const record = object(value, path, ['rubricId', 'revisionId', 'digest']);
  return {
    rubricId: patternId(required(record, 'rubricId', path), `${path}.rubricId`,
      /^evalrub_[a-f0-9]{32}$/u, '量表 ID'),
    revisionId: patternId(required(record, 'revisionId', path), `${path}.revisionId`,
      /^evalrubrev_[a-f0-9]{32}$/u, '量表 revision ID'),
    digest: digest(required(record, 'digest', path), `${path}.digest`),
  };
}

function parseEvaluatorRef(value: unknown, path: string): FrozenEvaluationEvaluatorRef {
  const record = object(value, path, ['evaluatorId', 'version', 'digest']);
  return {
    evaluatorId: safeId(required(record, 'evaluatorId', path), `${path}.evaluatorId`),
    version: text(required(record, 'version', path), `${path}.version`, 80),
    digest: digest(required(record, 'digest', path), `${path}.digest`),
  };
}

function parseCandidateRef(value: unknown, path: string): FrozenEvaluationCandidateRef {
  const record = object(value, path, ['candidateId', 'version', 'digest']);
  return {
    candidateId: safeId(required(record, 'candidateId', path), `${path}.candidateId`),
    version: text(required(record, 'version', path), `${path}.version`, 80),
    digest: digest(required(record, 'digest', path), `${path}.digest`),
  };
}

function parseModelRef(value: unknown, path: string): FrozenEvaluationModelConnectionRef {
  const record = object(value, path, ['connectionId', 'revisionId', 'provider', 'model', 'digest']);
  return {
    connectionId: safeId(required(record, 'connectionId', path), `${path}.connectionId`),
    revisionId: text(required(record, 'revisionId', path), `${path}.revisionId`, 128),
    provider: text(required(record, 'provider', path), `${path}.provider`, 80),
    model: text(required(record, 'model', path), `${path}.model`, 120),
    digest: digest(required(record, 'digest', path), `${path}.digest`),
  };
}

function parsePromptRef(value: unknown, path: string): FrozenEvaluationPromptRef {
  const record = object(value, path, ['promptId', 'version', 'digest']);
  return {
    promptId: safeId(required(record, 'promptId', path), `${path}.promptId`),
    version: text(required(record, 'version', path), `${path}.version`, 80),
    digest: digest(required(record, 'digest', path), `${path}.digest`),
  };
}

function parseWorkflowRef(value: unknown, path: string): FrozenEvaluationWorkflowRef {
  const record = object(value, path, ['workflowId', 'version', 'digest']);
  return {
    workflowId: safeId(required(record, 'workflowId', path), `${path}.workflowId`),
    version: text(required(record, 'version', path), `${path}.version`, 80),
    digest: digest(required(record, 'digest', path), `${path}.digest`),
  };
}

function parseCodeRef(value: unknown, path: string): FrozenEvaluationCodeRef {
  const record = object(value, path, ['version', 'commit', 'digest']);
  return {
    version: text(required(record, 'version', path), `${path}.version`, 80),
    commit: patternId(required(record, 'commit', path), `${path}.commit`, /^[a-f0-9]{7,40}$/u, '代码 commit'),
    digest: digest(required(record, 'digest', path), `${path}.digest`),
  };
}

function parseShards(value: unknown, path: string): FrozenEvaluationShardConfig {
  const record = object(value, path, ['shardCount', 'shardIndex', 'concurrency', 'timeoutMs', 'samplesPerCase']);
  const shardCount = integer(required(record, 'shardCount', path), `${path}.shardCount`, 1, 256);
  const shardIndex = integer(required(record, 'shardIndex', path), `${path}.shardIndex`, 0, shardCount - 1);
  return {
    shardCount,
    shardIndex,
    concurrency: integer(required(record, 'concurrency', path), `${path}.concurrency`, 1, 64),
    timeoutMs: integer(required(record, 'timeoutMs', path), `${path}.timeoutMs`, 1000, 86_400_000),
    samplesPerCase: integer(required(record, 'samplesPerCase', path), `${path}.samplesPerCase`, 1, 20),
  };
}

export function parseFrozenEvaluationSnapshot(value: unknown, path = 'snapshot'): FrozenEvaluationSnapshot {
  assertSafeValue(value, path);
  const record = object(value, path, ['schemaVersion', 'catalogKind', 'dataset', 'rubric', 'evaluator',
    'candidates', 'modelConnection', 'prompt', 'workflow', 'code', 'seed', 'shards', 'createdAt']);
  if (required(record, 'schemaVersion', path) !== EVALUATION_SNAPSHOT_SCHEMA_VERSION) {
    invalid(`${path}.schemaVersion`, `必须是 ${EVALUATION_SNAPSHOT_SCHEMA_VERSION}。`);
  }
  const candidates = array(required(record, 'candidates', path), `${path}.candidates`, 1, 16)
    .map((item, index) => parseCandidateRef(item, `${path}.candidates[${index}]`));
  if (new Set(candidates.map(item => item.candidateId)).size !== candidates.length) {
    invalid(`${path}.candidates`, '候选 ID 不能重复。');
  }
  const snapshot: FrozenEvaluationSnapshot = {
    schemaVersion: EVALUATION_SNAPSHOT_SCHEMA_VERSION,
    catalogKind: enumValue(required(record, 'catalogKind', path), `${path}.catalogKind`, EVALUATION_CATALOG_KINDS),
    dataset: parseDatasetRef(required(record, 'dataset', path), `${path}.dataset`),
    rubric: parseRubricRef(required(record, 'rubric', path), `${path}.rubric`),
    evaluator: parseEvaluatorRef(required(record, 'evaluator', path), `${path}.evaluator`),
    candidates,
    modelConnection: parseModelRef(required(record, 'modelConnection', path), `${path}.modelConnection`),
    prompt: parsePromptRef(required(record, 'prompt', path), `${path}.prompt`),
    workflow: parseWorkflowRef(required(record, 'workflow', path), `${path}.workflow`),
    code: parseCodeRef(required(record, 'code', path), `${path}.code`),
    seed: text(required(record, 'seed', path), `${path}.seed`, 128),
    shards: parseShards(required(record, 'shards', path), `${path}.shards`),
    createdAt: timestamp(required(record, 'createdAt', path), `${path}.createdAt`),
  };
  return normalizeFrozenEvaluationSnapshot(snapshot);
}

/** 排序候选与规范化文本，使等价快照得到相同摘要；createdAt 不进入摘要。 */
export function normalizeFrozenEvaluationSnapshot(snapshot: FrozenEvaluationSnapshot): FrozenEvaluationSnapshot {
  return {
    ...snapshot,
    candidates: [...snapshot.candidates].map(item => ({
      ...item,
      version: normalizeEvaluationText(item.version),
    })).sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
  };
}

export function evaluationSnapshotDigest(snapshot: FrozenEvaluationSnapshot): string {
  const normalized = normalizeFrozenEvaluationSnapshot(snapshot);
  return canonicalDigest({
    schemaVersion: normalized.schemaVersion,
    catalogKind: normalized.catalogKind,
    dataset: normalized.dataset,
    rubric: normalized.rubric,
    evaluator: normalized.evaluator,
    candidates: normalized.candidates,
    modelConnection: normalized.modelConnection,
    prompt: normalized.prompt,
    workflow: normalized.workflow,
    code: normalized.code,
    seed: normalized.seed,
    shards: normalized.shards,
  });
}

export function assertEvaluationSnapshotDigest(snapshot: FrozenEvaluationSnapshot, claimed: string): void {
  const expected = evaluationSnapshotDigest(snapshot);
  if (digest(claimed, 'snapshotDigest') !== expected) {
    invalid('snapshotDigest', '快照摘要与冻结内容不一致。', 'EVALUATION_RUN_SNAPSHOT_DIGEST_MISMATCH');
  }
}

/* -------------------------------------------------------------------------- */
/* 创建、运行与 Replay                                                         */
/* -------------------------------------------------------------------------- */

export interface EvaluationRunCreateRequest {
  idempotencyKey: string;
  snapshot: FrozenEvaluationSnapshot;
}

export function parseEvaluationRunCreate(value: unknown, path = 'run'): EvaluationRunCreateRequest {
  const record = object(value, path, ['idempotencyKey', 'snapshot']);
  const snapshot = parseFrozenEvaluationSnapshot(required(record, 'snapshot', path), `${path}.snapshot`);
  return {
    idempotencyKey: patternId(required(record, 'idempotencyKey', path), `${path}.idempotencyKey`,
      /^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/u, '幂等键'),
    snapshot,
  };
}

/** 服务层用该摘要判断同一幂等键是否复用了不同请求。 */
export function evaluationRunRequestDigest(request: EvaluationRunCreateRequest): string {
  return canonicalDigest({
    idempotencyKey: request.idempotencyKey,
    snapshotDigest: evaluationSnapshotDigest(request.snapshot),
  });
}

export interface EvaluationRun {
  runId: string;
  status: EvaluationRunStatus;
  snapshot: FrozenEvaluationSnapshot;
  snapshotDigest: string;
  requestDigest: string;
  idempotencyKey: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  replayedFromRunId: string | null;
}

export function parseEvaluationRun(value: unknown, path = 'run'): EvaluationRun {
  const record = object(value, path, ['runId', 'status', 'snapshot', 'snapshotDigest', 'requestDigest',
    'idempotencyKey', 'version', 'createdAt', 'updatedAt', 'startedAt', 'endedAt', 'replayedFromRunId']);
  const runId = patternId(required(record, 'runId', path), `${path}.runId`, /^evalrun_[a-f0-9]{32}$/u, '运行 ID');
  const status = enumValue(required(record, 'status', path), `${path}.status`, EVALUATION_RUN_STATUSES);
  const snapshot = parseFrozenEvaluationSnapshot(required(record, 'snapshot', path), `${path}.snapshot`);
  const snapshotDigest = digest(required(record, 'snapshotDigest', path), `${path}.snapshotDigest`);
  if (snapshotDigest !== evaluationSnapshotDigest(snapshot)) {
    invalid(`${path}.snapshotDigest`, '快照摘要与冻结内容不一致。', 'EVALUATION_RUN_SNAPSHOT_DIGEST_MISMATCH');
  }
  const createdAt = timestamp(required(record, 'createdAt', path), `${path}.createdAt`);
  const updatedAt = timestamp(required(record, 'updatedAt', path), `${path}.updatedAt`);
  if (updatedAt < createdAt) invalid(`${path}.updatedAt`, '更新时间不能早于创建时间。');
  const startedAt = nullableTimestamp(required(record, 'startedAt', path), `${path}.startedAt`);
  const endedAt = nullableTimestamp(required(record, 'endedAt', path), `${path}.endedAt`);
  if (isEvaluationRunTerminal(status) && endedAt === null) invalid(`${path}.endedAt`, '终态运行必须有结束时间。');
  if (!isEvaluationRunTerminal(status) && endedAt !== null) invalid(`${path}.endedAt`, '非终态运行不能有结束时间。');
  if (startedAt !== null && startedAt < createdAt) invalid(`${path}.startedAt`, '开始时间不能早于创建时间。');
  if (endedAt !== null && startedAt !== null && endedAt < startedAt) {
    invalid(`${path}.endedAt`, '结束时间不能早于开始时间。');
  }
  const replayedFromRunId = record.replayedFromRunId === null ? null
    : patternId(record.replayedFromRunId, `${path}.replayedFromRunId`, /^evalrun_[a-f0-9]{32}$/u, '来源运行 ID');
  if (replayedFromRunId === runId) invalid(`${path}.replayedFromRunId`, '重放必须创建新运行，不能引用自身。');
  return {
    runId,
    status,
    snapshot,
    snapshotDigest,
    requestDigest: digest(required(record, 'requestDigest', path), `${path}.requestDigest`),
    idempotencyKey: patternId(required(record, 'idempotencyKey', path), `${path}.idempotencyKey`,
      /^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/u, '幂等键'),
    version: integer(required(record, 'version', path), `${path}.version`, 1, 1_000_000_000),
    createdAt,
    updatedAt,
    startedAt,
    endedAt,
    replayedFromRunId,
  };
}

export interface EvaluationRunReplayRequest {
  sourceRunId: string;
  idempotencyKey: string;
}

export function parseEvaluationRunReplay(value: unknown, path = 'replay'): EvaluationRunReplayRequest {
  const record = object(value, path, ['sourceRunId', 'idempotencyKey']);
  return {
    sourceRunId: patternId(required(record, 'sourceRunId', path), `${path}.sourceRunId`,
      /^evalrun_[a-f0-9]{32}$/u, '来源运行 ID'),
    idempotencyKey: patternId(required(record, 'idempotencyKey', path), `${path}.idempotencyKey`,
      /^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/u, '幂等键'),
  };
}

export function evaluationRunReplayRequestDigest(request: EvaluationRunReplayRequest): string {
  return canonicalDigest({ sourceRunId: request.sourceRunId, idempotencyKey: request.idempotencyKey });
}

/* -------------------------------------------------------------------------- */
/* Attempt / Sample / Event                                                    */
/* -------------------------------------------------------------------------- */

export type EvaluationAttemptStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export const EVALUATION_ATTEMPT_STATUSES: readonly EvaluationAttemptStatus[] = Object.freeze([
  'pending', 'running', 'completed', 'failed', 'interrupted', 'cancelled',
]);
export const EVALUATION_ATTEMPT_TERMINAL_STATUSES: readonly EvaluationAttemptStatus[] = Object.freeze([
  'completed', 'failed', 'interrupted', 'cancelled',
]);

export interface EvaluationAttemptError {
  category: 'validation' | 'execution' | 'timeout' | 'cancelled' | 'unknown';
  code: string;
  message: string;
}

function parseAttemptError(value: unknown, path: string): EvaluationAttemptError | null {
  if (value === null) return null;
  const record = object(value, path, ['category', 'code', 'message']);
  return {
    category: enumValue(required(record, 'category', path), `${path}.category`,
      ['validation', 'execution', 'timeout', 'cancelled', 'unknown'] as const),
    code: text(required(record, 'code', path), `${path}.code`, 80),
    message: text(required(record, 'message', path), `${path}.message`, 500),
  };
}

export interface EvaluationSampleAttempt {
  sampleAttemptId: string;
  caseAttemptId: string;
  sampleIndex: number;
  status: EvaluationAttemptStatus;
  outputDigest: string | null;
  durationMs: number;
  costMicros: number;
  currency: string;
  error: EvaluationAttemptError | null;
}

export function parseEvaluationSampleAttempt(value: unknown, path = 'sample'): EvaluationSampleAttempt {
  const record = object(value, path, ['sampleAttemptId', 'caseAttemptId', 'sampleIndex', 'status',
    'outputDigest', 'durationMs', 'costMicros', 'currency', 'error']);
  const status = enumValue(required(record, 'status', path), `${path}.status`, EVALUATION_ATTEMPT_STATUSES);
  const outputDigest = record.outputDigest === null ? null : digest(record.outputDigest, `${path}.outputDigest`);
  const error = parseAttemptError(required(record, 'error', path), `${path}.error`);
  if (status === 'completed' && outputDigest === null) invalid(`${path}.outputDigest`, '完成的 sample 必须有输出摘要。');
  if (status !== 'completed' && outputDigest !== null) invalid(`${path}.outputDigest`, '未完成的 sample 不能有输出摘要。');
  if ((status === 'failed' || status === 'interrupted') && error === null) {
    invalid(`${path}.error`, '失败或中断的 sample 必须记录错误。');
  }
  if (status === 'completed' && error !== null) invalid(`${path}.error`, '完成的 sample 不能带错误。');
  return {
    sampleAttemptId: patternId(required(record, 'sampleAttemptId', path), `${path}.sampleAttemptId`,
      /^evalsample_[a-f0-9]{32}$/u, 'sample attempt ID'),
    caseAttemptId: patternId(required(record, 'caseAttemptId', path), `${path}.caseAttemptId`,
      /^evalattempt_[a-f0-9]{32}$/u, 'case attempt ID'),
    sampleIndex: integer(required(record, 'sampleIndex', path), `${path}.sampleIndex`, 0, 19),
    status,
    outputDigest,
    durationMs: integer(required(record, 'durationMs', path), `${path}.durationMs`, 0, 86_400_000),
    costMicros: integer(required(record, 'costMicros', path), `${path}.costMicros`, 0, Number.MAX_SAFE_INTEGER),
    currency: patternId(required(record, 'currency', path), `${path}.currency`, /^[A-Z]{3}$/u, '币种'),
    error,
  };
}

export interface EvaluationCaseAttempt {
  caseAttemptId: string;
  runId: string;
  caseId: string;
  shardIndex: number;
  attemptNumber: number;
  status: EvaluationAttemptStatus;
  startedAt: string | null;
  endedAt: string | null;
  error: EvaluationAttemptError | null;
  samples: readonly EvaluationSampleAttempt[];
}

export function parseEvaluationCaseAttempt(value: unknown, path = 'caseAttempt'): EvaluationCaseAttempt {
  const record = object(value, path, ['caseAttemptId', 'runId', 'caseId', 'shardIndex', 'attemptNumber',
    'status', 'startedAt', 'endedAt', 'error', 'samples']);
  const caseAttemptId = patternId(required(record, 'caseAttemptId', path), `${path}.caseAttemptId`,
    /^evalattempt_[a-f0-9]{32}$/u, 'case attempt ID');
  const runId = patternId(required(record, 'runId', path), `${path}.runId`, /^evalrun_[a-f0-9]{32}$/u, '运行 ID');
  const status = enumValue(required(record, 'status', path), `${path}.status`, EVALUATION_ATTEMPT_STATUSES);
  const samples = array(required(record, 'samples', path), `${path}.samples`, 0, 20)
    .map((item, index) => parseEvaluationSampleAttempt(item, `${path}.samples[${index}]`));
  if (new Set(samples.map(item => item.sampleIndex)).size !== samples.length) {
    invalid(`${path}.samples`, 'sample 序号不能重复。');
  }
  if (samples.some(item => item.caseAttemptId !== caseAttemptId)) {
    invalid(`${path}.samples`, 'sample 必须属于当前 case attempt。');
  }
  const error = parseAttemptError(required(record, 'error', path), `${path}.error`);
  const startedAt = nullableTimestamp(required(record, 'startedAt', path), `${path}.startedAt`);
  const endedAt = nullableTimestamp(required(record, 'endedAt', path), `${path}.endedAt`);
  if (status === 'completed' && samples.some(item => item.status !== 'completed')) {
    invalid(`${path}.status`, 'case 完成时所有 sample 必须完成。');
  }
  if ((status === 'failed' || status === 'interrupted') && error === null) {
    invalid(`${path}.error`, '失败或中断的 case 必须记录错误。');
  }
  if (status === 'completed' && error !== null) invalid(`${path}.error`, '完成的 case 不能带错误。');
  if (isAttemptTerminal(status) && endedAt === null) invalid(`${path}.endedAt`, '终态 attempt 必须有结束时间。');
  if (!isAttemptTerminal(status) && endedAt !== null) invalid(`${path}.endedAt`, '非终态 attempt 不能有结束时间。');
  return {
    caseAttemptId,
    runId,
    caseId: safeId(required(record, 'caseId', path), `${path}.caseId`),
    shardIndex: integer(required(record, 'shardIndex', path), `${path}.shardIndex`, 0, 255),
    attemptNumber: integer(required(record, 'attemptNumber', path), `${path}.attemptNumber`, 1, 100),
    status,
    startedAt,
    endedAt,
    error,
    samples,
  };
}

export function isAttemptTerminal(status: EvaluationAttemptStatus): boolean {
  return EVALUATION_ATTEMPT_TERMINAL_STATUSES.includes(status);
}

export type EvaluationRunEventType =
  | 'prepared' | 'started' | 'case_attempt_started' | 'case_attempt_completed' | 'case_attempt_failed'
  | 'sample_attempt_completed' | 'waiting_external' | 'waiting_human' | 'completed' | 'failed'
  | 'cancelled' | 'replayed';

export const EVALUATION_RUN_EVENT_TYPES: readonly EvaluationRunEventType[] = Object.freeze([
  'prepared', 'started', 'case_attempt_started', 'case_attempt_completed', 'case_attempt_failed',
  'sample_attempt_completed', 'waiting_external', 'waiting_human', 'completed', 'failed', 'cancelled', 'replayed',
]);

export interface EvaluationRunEvent {
  eventId: string;
  runId: string;
  sequence: number;
  eventType: EvaluationRunEventType;
  occurredAt: string;
  payload: {
    status?: EvaluationRunStatus;
    fromStatus?: EvaluationRunStatus;
    toStatus?: EvaluationRunStatus;
    caseId?: string;
    caseAttemptId?: string;
    sampleIndex?: number;
    errorCode?: string;
    reason?: string;
  };
}

export function parseEvaluationRunEvent(value: unknown, path = 'event'): EvaluationRunEvent {
  const record = object(value, path, ['eventId', 'runId', 'sequence', 'eventType', 'occurredAt', 'payload']);
  const payload = object(required(record, 'payload', path), `${path}.payload`,
    ['status', 'fromStatus', 'toStatus', 'caseId', 'caseAttemptId', 'sampleIndex', 'errorCode', 'reason']);
  const parsedPayload: EvaluationRunEvent['payload'] = {};
  if (payload.status !== undefined) parsedPayload.status =
    enumValue(payload.status, `${path}.payload.status`, EVALUATION_RUN_STATUSES);
  if (payload.fromStatus !== undefined) parsedPayload.fromStatus =
    enumValue(payload.fromStatus, `${path}.payload.fromStatus`, EVALUATION_RUN_STATUSES);
  if (payload.toStatus !== undefined) parsedPayload.toStatus =
    enumValue(payload.toStatus, `${path}.payload.toStatus`, EVALUATION_RUN_STATUSES);
  if (payload.caseId !== undefined) parsedPayload.caseId = safeId(payload.caseId, `${path}.payload.caseId`);
  if (payload.caseAttemptId !== undefined) parsedPayload.caseAttemptId =
    patternId(payload.caseAttemptId, `${path}.payload.caseAttemptId`, /^evalattempt_[a-f0-9]{32}$/u, 'case attempt ID');
  if (payload.sampleIndex !== undefined) parsedPayload.sampleIndex =
    integer(payload.sampleIndex, `${path}.payload.sampleIndex`, 0, 19);
  if (payload.errorCode !== undefined) parsedPayload.errorCode = text(payload.errorCode, `${path}.payload.errorCode`, 80);
  if (payload.reason !== undefined) parsedPayload.reason = text(payload.reason, `${path}.payload.reason`, 300);
  return {
    eventId: patternId(required(record, 'eventId', path), `${path}.eventId`,
      /^evalrunevt_[a-f0-9]{32}$/u, '运行事件 ID'),
    runId: patternId(required(record, 'runId', path), `${path}.runId`, /^evalrun_[a-f0-9]{32}$/u, '运行 ID'),
    sequence: integer(required(record, 'sequence', path), `${path}.sequence`, 1, 1_000_000_000),
    eventType: enumValue(required(record, 'eventType', path), `${path}.eventType`, EVALUATION_RUN_EVENT_TYPES),
    occurredAt: timestamp(required(record, 'occurredAt', path), `${path}.occurredAt`),
    payload: parsedPayload,
  };
}

export function evaluationRunEventDigest(event: EvaluationRunEvent): string {
  return canonicalDigest({
    eventId: event.eventId,
    runId: event.runId,
    sequence: event.sequence,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    payload: event.payload,
  });
}
