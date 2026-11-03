import { canonicalDigest, ProductionError } from './production';

/**
 * 评测目录公共契约：稳定身份 + 不可变 Revision。
 *
 * shared 只做类型、纯校验、规范化与摘要计算；持久化、生命周期与 HTTP 由 main 负责。
 * 这里刻意不使用 Record<string, unknown> 承载三类输入：每一种输入都有闭合字段集，
 * 未知字段、未知类型与非法阈值必须在边界被拒绝。
 */

export const EVALUATION_DATASET_SCHEMA_VERSION = 'lyra-evaluation-dataset/1';
export const EVALUATION_RUBRIC_SCHEMA_VERSION = 'lyra-evaluation-rubric/1';
export const EVALUATION_JSONL_SCHEMA_VERSION = 'lyra-evaluation-jsonl/1';

export type EvaluationCatalogKind = 'novel_breakdown' | 'asset_retrieval' | 'shot_review';
export const EVALUATION_CATALOG_KINDS: readonly EvaluationCatalogKind[] =
  Object.freeze(['novel_breakdown', 'asset_retrieval', 'shot_review']);

export type EvaluationRevisionStatus = 'draft' | 'frozen' | 'deprecated';
export type EvaluationTargetKind = 'dataset' | 'rubric';
export type SensitivityLevel = 'public' | 'internal' | 'confidential' | 'restricted';
export type AuthorizationStatus = 'granted' | 'pending' | 'denied';
export type EvaluationSourceKind = 'synthetic' | 'internal' | 'licensed' | 'public_domain';
export type EvaluationEvidenceKind = 'frame' | 'transcript' | 'asset_metadata' | 'source_span' | 'human_note';
export type MissingResultAction = 'fail' | 'exclude' | 'review';

/** 缺失结果策略的固定语义；文档与实现共用同一段文字。 */
export const MISSING_RESULT_SEMANTICS: Readonly<Record<MissingResultAction, string>> = Object.freeze({
  fail: '该维度按不通过计入结果，并标记缺失来源，不得重试后自动改写。',
  exclude: '该维度从聚合分中排除，只记录覆盖率与原因，不得视为通过。',
  review: '本次结果不得自动判定，必须进入人工复核队列。',
});

export interface EvaluationFieldIssue {
  path: string;
  code: string;
  message: string;
  caseId?: string;
  line?: number;
}

export class EvaluationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: EvaluationFieldIssue[] = [],
  ) {
    super(message);
    this.name = 'EvaluationError';
    this.details = details;
  }
}

export interface EvaluationAuthorization {
  status: AuthorizationStatus;
  /** 授权依据：合同、内部审批或数据中台登记号。 */
  basis: string;
  /** 允许用途范围，不能只写“评测”。 */
  scope: string;
  grantedBy: string;
  /** YYYY-MM-DD */
  grantedAt: string;
  expiresAt: string | null;
  restrictions: string[];
}

export interface EvaluationSourceRef {
  refId: string;
  locator: string;
  digest: string;
}

export interface EvaluationProvenance {
  sourceKind: EvaluationSourceKind;
  sourceRefs: EvaluationSourceRef[];
  generator: 'human' | 'synthetic_fixture' | 'imported';
  notes: string;
  /** ISO 时间戳 */
  createdAt: string;
}

export type EvaluationVersionRefKind =
  | 'dataset_revision' | 'rubric_revision' | 'script_version' | 'storyboard_revision' | 'asset' | 'media_asset';

export interface EvaluationVersionRef {
  kind: EvaluationVersionRefKind;
  id: string;
  revisionId: string | null;
  /** 引用时刻的内容摘要，缺失即视为无效引用。 */
  digest: string;
}

export interface NovelBreakdownSegment {
  segmentId: string;
  order: number;
  text: string;
  chapterRef: string | null;
}

export type NovelEntityType = 'character' | 'location' | 'item' | 'organization' | 'concept';

export interface NovelBreakdownEntity {
  entityId: string;
  canonicalName: string;
  aliases: string[];
  type: NovelEntityType;
}

export interface NovelBreakdownScope {
  time: { start: string | null; end: string | null; label: string };
  space: { label: string; locations: string[] };
}

export interface NovelBreakdownCaseInput {
  kind: 'novel_breakdown';
  segments: NovelBreakdownSegment[];
  entities: NovelBreakdownEntity[];
  sourceRefs: EvaluationSourceRef[];
  scope: NovelBreakdownScope;
}

export interface AssetRetrievalQuery {
  text: string;
  filters: { kinds: string[]; statuses: string[] };
  limit: number;
}

export interface AssetRetrievalAssetMetadata {
  assetId: string;
  name: string;
  kind: string;
  status: string;
  summary: string;
  /** 只允许标量元数据，禁止嵌套供应商响应。 */
  metadata: Record<string, string | number | boolean>;
}

export interface AssetRetrievalHit {
  assetId: string;
  score: number;
  rank: number;
}

export interface AssetRetrievalCaseInput {
  kind: 'asset_retrieval';
  query: AssetRetrievalQuery;
  assets: AssetRetrievalAssetMetadata[];
  fixedHits: AssetRetrievalHit[];
}

export interface ShotDescriptor {
  shotId: string;
  description: string;
  durationSec: number;
  camera: string;
}

export interface MediaSummaryRef {
  refId: string;
  kind: 'image' | 'video' | 'frame';
  digest: string;
  locator: string;
  note: string;
}

export interface FrameEvidenceRequirement {
  requirementId: string;
  atSec: number;
  description: string;
}

export interface ShotReviewCaseInput {
  kind: 'shot_review';
  shot: ShotDescriptor;
  /** 只保存媒体摘要引用，不保存媒体二进制。 */
  mediaRefs: MediaSummaryRef[];
  /** 四维量表 revision 引用；必须与 versionRefs 中的 rubric_revision 一致。 */
  rubric: { rubricId: string; revisionId: string; digest: string };
  frameEvidence: FrameEvidenceRequirement[];
}

export type EvaluationCaseInput =
  | NovelBreakdownCaseInput
  | AssetRetrievalCaseInput
  | ShotReviewCaseInput;

export interface NovelBreakdownExpectation {
  kind: 'novel_breakdown';
  expectedEntities: Array<{ entityId: string; canonicalName: string; mentions: number }>;
  expectedSourceRefCount: number;
}

export interface AssetRetrievalExpectation {
  kind: 'asset_retrieval';
  result: 'unique' | 'ambiguous' | 'missing';
  expectedAssetId: string | null;
  minimumScore: number | null;
}

export interface ShotReviewExpectation {
  kind: 'shot_review';
  dimensionExpectations: Array<{ dimensionKey: string; expected: 'pass' | 'fail' | 'uncertain'; rationale: string }>;
}

export type EvaluationExpectation =
  | NovelBreakdownExpectation
  | AssetRetrievalExpectation
  | ShotReviewExpectation;

export interface EvaluationCase {
  /** 稳定 ID：跨 revision 保持不变，用于追踪同一条样例。 */
  caseId: string;
  kind: EvaluationCatalogKind;
  title: string;
  intent: string;
  input: EvaluationCaseInput;
  expectation: EvaluationExpectation;
  source: EvaluationProvenance;
  versionRefs: EvaluationVersionRef[];
  /** 人读的内容摘要，不含原文全文。 */
  contentSummary: string;
  authorization: EvaluationAuthorization;
  sensitivity: SensitivityLevel;
  tags: string[];
  slices: string[];
}

export interface EvaluationDataset {
  id: string;
  kind: EvaluationCatalogKind;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface EvaluationDatasetRevision {
  id: string;
  datasetId: string;
  kind: EvaluationCatalogKind;
  revision: number;
  /** 生命周期状态不参与内容摘要，废弃只追加事件。 */
  status: EvaluationRevisionStatus;
  note: string;
  contentSummary: string;
  slices: string[];
  tags: string[];
  authorization: EvaluationAuthorization;
  sensitivity: SensitivityLevel;
  provenance: EvaluationProvenance;
  /** 覆盖身份、编号与全部内容的摘要。 */
  digest: string;
  /** 只覆盖 kind + cases，跨 revision 稳定，可用于导出再导入比对。 */
  contentDigest: string;
  caseCount: number;
  createdAt: string;
  frozenAt: string | null;
  deprecatedAt: string | null;
}

export interface EvaluationDatasetBundle {
  revision: EvaluationDatasetRevision;
  cases: EvaluationCase[];
}

export interface EvaluationScale {
  min: number;
  max: number;
  step: number;
}

export interface EvaluationThresholds {
  /** score >= passAt 判为通过；score <= failAt 判为不通过；区间内为 uncertain。 */
  passAt: number;
  failAt: number;
}

export interface EvaluationEvidenceRequirement {
  required: boolean;
  kinds: EvaluationEvidenceKind[];
  minItems: number;
  note: string;
}

export interface MissingResultPolicy {
  uncertain: MissingResultAction;
  skipped: MissingResultAction;
  evaluator_error: MissingResultAction;
}

export interface RubricDimension {
  key: string;
  label: string;
  description: string;
  scale: EvaluationScale;
  thresholds: EvaluationThresholds;
  evidence: EvaluationEvidenceRequirement;
}

export interface EvaluationRubric {
  id: string;
  kind: EvaluationCatalogKind;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface EvaluationRubricRevision {
  id: string;
  rubricId: string;
  kind: EvaluationCatalogKind;
  revision: number;
  status: EvaluationRevisionStatus;
  note: string;
  summary: string;
  missingResultPolicy: MissingResultPolicy;
  digest: string;
  contentDigest: string;
  dimensionCount: number;
  createdAt: string;
  frozenAt: string | null;
  deprecatedAt: string | null;
}

export interface EvaluationRubricBundle {
  revision: EvaluationRubricRevision;
  dimensions: RubricDimension[];
}

export interface EvaluationRubricRevisionDraft {
  id: string;
  rubricId: string;
  kind: EvaluationCatalogKind;
  note: string;
  summary: string;
  missingResultPolicy: MissingResultPolicy;
  dimensions: RubricDimension[];
}

export interface EvaluationDatasetRevisionDraft {
  id: string;
  datasetId: string;
  kind: EvaluationCatalogKind;
  note: string;
  contentSummary: string;
  slices: string[];
  tags: string[];
  authorization: EvaluationAuthorization;
  sensitivity: SensitivityLevel;
  provenance: EvaluationProvenance;
  cases: EvaluationCase[];
}

export interface EvaluationRevisionUsage {
  id: string;
  targetKind: EvaluationTargetKind;
  revisionId: string;
  usageKind: string;
  usageRef: string;
  note: string;
  createdAt: string;
}

export interface EvaluationLifecycleEvent {
  id: string;
  targetKind: EvaluationTargetKind;
  revisionId: string;
  action: 'created' | 'derived' | 'frozen' | 'deprecated';
  /** 冻结/废弃动作始终记录为人工 actor；导入创建记为 imported。 */
  actor: 'user' | 'import' | 'system';
  reason: string;
  createdAt: string;
}

export interface CreateEvaluationDatasetInput {
  kind: EvaluationCatalogKind;
  title: string;
  description: string;
  note: string;
  contentSummary: string;
  slices: string[];
  tags: string[];
  authorization: EvaluationAuthorization;
  sensitivity: SensitivityLevel;
  provenance: EvaluationProvenance;
  cases: EvaluationCase[];
}

export interface CreateEvaluationRubricInput {
  kind: EvaluationCatalogKind;
  title: string;
  description: string;
  note: string;
  summary: string;
  missingResultPolicy: MissingResultPolicy;
  dimensions: RubricDimension[];
}

/* -------------------------------------------------------------------------- */
/* 基础校验                                                                     */
/* -------------------------------------------------------------------------- */

const HEX64 = /^[a-f0-9]{64}$/u;
const DATASET_ID = /^evalds_[a-f0-9]{32}$/u;
const DATASET_REVISION_ID = /^evaldsrev_[a-f0-9]{32}$/u;
const RUBRIC_ID = /^evalrub_[a-f0-9]{32}$/u;
const RUBRIC_REVISION_ID = /^evalrubrev_[a-f0-9]{32}$/u;
const USAGE_ID = /^evalusage_[a-f0-9]{32}$/u;
const EVENT_ID = /^evallevent_[a-f0-9]{32}$/u;
const CASE_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/u;
const SIMPLE_ID = /^[a-z][a-z0-9_-]{1,95}$/u;
const TAG = /^[a-z0-9][a-z0-9:_-]{0,47}$/u;
const SLICE = /^[a-z0-9][a-z0-9:_.-]{0,79}$/u;
const DIMENSION_KEY = /^[a-z][a-z0-9_]{1,31}$/u;
const DATE_ONLY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;
const MAX_CASES = 200;
const MAX_DIMENSIONS = 8;
const SHOT_REVIEW_DIMENSIONS = 4;

function issue(path: string, code: string, message: string): EvaluationFieldIssue {
  return { path, code, message };
}

export function evaluationIssue(
  path: string, code: string, message: string, extra: { caseId?: string; line?: number } = {},
): EvaluationFieldIssue {
  return { path, code, message, ...(extra.caseId ? { caseId: extra.caseId } : {}),
    ...(extra.line === undefined ? {} : { line: extra.line }) };
}

function invalid(path: string, message: string, code = 'EVALUATION_INPUT_INVALID'): never {
  throw new EvaluationError(400, code, message, [issue(path, code, message)]);
}

function object(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, '必须是对象。');
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) invalid(`${path}.${key}`, `不支持的字段 ${key}。`);
  }
  return input;
}

function required(input: Record<string, unknown>, key: string, path: string): unknown {
  if (!(key in input) || input[key] === undefined) invalid(`${path}.${key}`, `缺少字段 ${key}。`);
  return input[key];
}

function text(value: unknown, path: string, max: number, requiredField = true): string {
  if (typeof value !== 'string') invalid(path, '必须是文本。');
  const normalized = normalizeEvaluationText(value);
  const malformed = Array.from(normalized).some(char => {
    const point = char.codePointAt(0)!;
    return point >= 0xd800 && point <= 0xdfff;
  });
  if ((requiredField && !normalized) || Array.from(normalized).length > max || CONTROL.test(normalized) || malformed) {
    invalid(path, requiredField ? `文本为空、含控制字符或超过 ${max} 字。` : `文本含控制字符或超过 ${max} 字。`);
  }
  return normalized;
}

function optionalText(value: unknown, path: string, max: number): string {
  if (value === undefined || value === null) return '';
  return text(value, path, max, false);
}

function enumValue<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    invalid(path, `必须是 ${allowed.join(' / ')} 之一。`);
  }
  return value as T;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, '必须是布尔值。');
  return value;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    invalid(path, `必须是 ${min}..${max} 的整数。`);
  }
  return Number(value);
}

function finite(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(path, `必须是 ${min}..${max} 的有限数字。`);
  }
  return value;
}

function digestValue(value: unknown, path: string): string {
  if (typeof value !== 'string' || !HEX64.test(value)) invalid(path, '必须是 64 位小写十六进制摘要。');
  return value;
}

function isoDateTime(value: unknown, path: string): string {
  if (typeof value !== 'string') invalid(path, '必须是 ISO 时间戳。');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) invalid(path, '不是可解析的时间戳。');
  return new Date(time).toISOString();
}

function dateOnly(value: unknown, path: string): string {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) invalid(path, '必须是 YYYY-MM-DD。');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid(path, '日期不存在。');
  return value;
}

function idValue(value: unknown, path: string, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(path, `${label}格式不正确。`, 'EVALUATION_ID_INVALID');
  return value;
}

function stringList(
  value: unknown, path: string, pattern: RegExp, maxItems: number, label: string, allowEmpty = true,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems || (!allowEmpty && value.length === 0)) {
    invalid(path, `${label}必须是${allowEmpty ? '' : '非空'}数组，且不超过 ${maxItems} 项。`);
  }
  const output = value.map((item, index) => {
    if (typeof item !== 'string' || !pattern.test(item)) invalid(`${path}[${index}]`, `${label}项格式不正确。`);
    return item;
  });
  return [...new Set(output)].sort();
}

/** 中文名称、别名等不受 ASCII 标识符约束，但仍要规范化、去重并限制长度。 */
function textList(value: unknown, path: string, maxItems: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid(path, `${label}必须是不超过 ${maxItems} 项的数组。`);
  const output = value.map((item, index) => text(item, `${path}[${index}]`, maxLength));
  return [...new Set(output)].sort();
}

/** 换行、NFC 与行尾空格规范化；幂等，摘要计算前必须调用。 */
export function normalizeEvaluationText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .trim();
}

function parseAuthorization(value: unknown, path: string): EvaluationAuthorization {
  const input = object(value, path, ['status', 'basis', 'scope', 'grantedBy', 'grantedAt', 'expiresAt', 'restrictions']);
  const status = enumValue(required(input, 'status', path), `${path}.status`,
    ['granted', 'pending', 'denied'] as const);
  const grantedAt = dateOnly(required(input, 'grantedAt', path), `${path}.grantedAt`);
  const expiresAt = input.expiresAt === null || input.expiresAt === undefined
    ? null : dateOnly(input.expiresAt, `${path}.expiresAt`);
  if (expiresAt !== null && expiresAt < grantedAt) invalid(`${path}.expiresAt`, '失效日期不能早于授权日期。');
  const restrictions = stringList(input.restrictions ?? [], `${path}.restrictions`, TAG, 20, '限制');
  return {
    status,
    basis: text(required(input, 'basis', path), `${path}.basis`, 200),
    scope: text(required(input, 'scope', path), `${path}.scope`, 200),
    grantedBy: text(required(input, 'grantedBy', path), `${path}.grantedBy`, 80),
    grantedAt,
    expiresAt,
    restrictions,
  };
}

function assertUsableAuthorization(authorization: EvaluationAuthorization, path: string, sensitivity: SensitivityLevel): void {
  if (authorization.status !== 'granted') {
    invalid(`${path}.status`, '授权未通过，不得进入评测目录。', 'EVALUATION_AUTHORIZATION_DENIED');
  }
  if (sensitivity === 'restricted' && authorization.restrictions.length === 0) {
    invalid(`${path}.restrictions`, 'restricted 数据必须声明使用限制。');
  }
}

function parseSourceRefs(value: unknown, path: string, maxItems: number): EvaluationSourceRef[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid(path, `来源引用必须是不超过 ${maxItems} 项的数组。`);
  const refs = value.map((item, index) => {
    const refPath = `${path}[${index}]`;
    const input = object(item, refPath, ['refId', 'locator', 'digest', 'quote']);
    const ref: EvaluationSourceRef = {
      refId: text(required(input, 'refId', refPath), `${refPath}.refId`, 80),
      locator: text(required(input, 'locator', refPath), `${refPath}.locator`, 240),
      digest: digestValue(required(input, 'digest', refPath), `${refPath}.digest`),
    };
    if (input.quote !== undefined) {
      // 夹具禁止保存未经授权的作品全文；引用片段最多 240 字。
      text(input.quote, `${refPath}.quote`, 240, false);
    }
    return ref;
  });
  return refs.sort((a, b) => a.refId.localeCompare(b.refId));
}

function parseProvenance(value: unknown, path: string, maxRefs: number): EvaluationProvenance {
  const input = object(value, path, ['sourceKind', 'sourceRefs', 'generator', 'notes', 'createdAt']);
  return {
    sourceKind: enumValue(required(input, 'sourceKind', path), `${path}.sourceKind`,
      ['synthetic', 'internal', 'licensed', 'public_domain'] as const),
    sourceRefs: parseSourceRefs(required(input, 'sourceRefs', path), `${path}.sourceRefs`, maxRefs),
    generator: enumValue(required(input, 'generator', path), `${path}.generator`,
      ['human', 'synthetic_fixture', 'imported'] as const),
    notes: optionalText(input.notes, `${path}.notes`, 500),
    createdAt: isoDateTime(required(input, 'createdAt', path), `${path}.createdAt`),
  };
}

function parseVersionRefs(value: unknown, path: string, maxItems: number): EvaluationVersionRef[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid(path, `版本引用必须是不超过 ${maxItems} 项的数组。`);
  const refs = value.map((item, index) => {
    const refPath = `${path}[${index}]`;
    const input = object(item, refPath, ['kind', 'id', 'revisionId', 'digest']);
    const kind = enumValue(required(input, 'kind', refPath), `${refPath}.kind`,
      ['dataset_revision', 'rubric_revision', 'script_version', 'storyboard_revision', 'asset', 'media_asset'] as const);
    const idPattern = kind === 'dataset_revision' ? DATASET_REVISION_ID
      : kind === 'rubric_revision' ? RUBRIC_REVISION_ID : SIMPLE_ID;
    const id = idValue(required(input, 'id', refPath), `${refPath}.id`, idPattern, '版本引用 ID ');
    if ((kind === 'dataset_revision' || kind === 'rubric_revision') && input.revisionId !== null && input.revisionId !== undefined) {
      invalid(`${refPath}.revisionId`, 'revision 类引用的 ID 已是 revision，不得再填 revisionId。');
    }
    const revisionId = input.revisionId === null || input.revisionId === undefined
      ? null : idValue(input.revisionId, `${refPath}.revisionId`, SIMPLE_ID, '被引用 revision ');
    return {
      kind,
      id,
      revisionId,
      digest: digestValue(required(input, 'digest', refPath), `${refPath}.digest`),
    };
  });
  return refs.sort((a, b) => `${a.kind}\u0000${a.id}\u0000${a.revisionId ?? ''}`.localeCompare(
    `${b.kind}\u0000${b.id}\u0000${b.revisionId ?? ''}`));
}

function parseTags(value: unknown, path: string): string[] {
  return stringList(value ?? [], path, TAG, 32, '标签');
}

function parseSlices(value: unknown, path: string): string[] {
  return stringList(value ?? [], path, SLICE, 32, '切片');
}

/* -------------------------------------------------------------------------- */
/* 三类输入                                                                     */
/* -------------------------------------------------------------------------- */

function parseSegments(value: unknown, path: string): NovelBreakdownSegment[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) invalid(path, '章节片段必须是 1..20 项数组。');
  const segments = value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const input = object(item, itemPath, ['segmentId', 'order', 'text', 'chapterRef']);
    return {
      segmentId: text(required(input, 'segmentId', itemPath), `${itemPath}.segmentId`, 64),
      order: integer(required(input, 'order', itemPath), `${itemPath}.order`, 1, 20),
      text: text(required(input, 'text', itemPath), `${itemPath}.text`, 4000),
      chapterRef: input.chapterRef === null || input.chapterRef === undefined ? null
        : text(input.chapterRef, `${itemPath}.chapterRef`, 80, false),
    };
  });
  if (new Set(segments.map(segment => segment.segmentId)).size !== segments.length) invalid(path, '片段 ID 重复。');
  if (new Set(segments.map(segment => segment.order)).size !== segments.length) invalid(path, '片段顺序重复。');
  return segments.sort((a, b) => a.order - b.order);
}

function parseEntities(value: unknown, path: string): NovelBreakdownEntity[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) invalid(path, '实体必须是 1..50 项数组。');
  const entities = value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const input = object(item, itemPath, ['entityId', 'canonicalName', 'aliases', 'type']);
    return {
      entityId: text(required(input, 'entityId', itemPath), `${itemPath}.entityId`, 64),
      canonicalName: text(required(input, 'canonicalName', itemPath), `${itemPath}.canonicalName`, 80),
      aliases: textList(input.aliases ?? [], `${itemPath}.aliases`, 8, 40, '别名'),
      type: enumValue(required(input, 'type', itemPath), `${itemPath}.type`,
        ['character', 'location', 'item', 'organization', 'concept'] as const),
    };
  });
  if (new Set(entities.map(entity => entity.entityId)).size !== entities.length) invalid(path, '实体 ID 重复。');
  return entities.sort((a, b) => a.entityId.localeCompare(b.entityId));
}

function parseScope(value: unknown, path: string): NovelBreakdownScope {
  const input = object(value, path, ['time', 'space']);
  const timeInput = object(required(input, 'time', path), `${path}.time`, ['start', 'end', 'label']);
  const spaceInput = object(required(input, 'space', path), `${path}.space`, ['label', 'locations']);
  return {
    time: {
      start: timeInput.start === null || timeInput.start === undefined ? null
        : text(timeInput.start, `${path}.time.start`, 40, false),
      end: timeInput.end === null || timeInput.end === undefined ? null
        : text(timeInput.end, `${path}.time.end`, 40, false),
      label: text(required(timeInput, 'label', `${path}.time`), `${path}.time.label`, 80),
    },
    space: {
      label: text(required(spaceInput, 'label', `${path}.space`), `${path}.space.label`, 80),
      locations: textList(required(spaceInput, 'locations', `${path}.space`), `${path}.space.locations`, 10, 60, '地点'),
    },
  };
}

function parseNovelInput(value: unknown, path: string): NovelBreakdownCaseInput {
  const input = object(value, path, ['kind', 'segments', 'entities', 'sourceRefs', 'scope']);
  if (input.kind !== 'novel_breakdown') invalid(`${path}.kind`, '输入类型必须是 novel_breakdown。');
  const segments = parseSegments(required(input, 'segments', path), `${path}.segments`);
  const entities = parseEntities(required(input, 'entities', path), `${path}.entities`);
  const sourceRefs = parseSourceRefs(required(input, 'sourceRefs', path), `${path}.sourceRefs`, 20);
  const scope = parseScope(required(input, 'scope', path), `${path}.scope`);
  if (new Set(sourceRefs.map(ref => ref.refId)).size !== sourceRefs.length) invalid(`${path}.sourceRefs`, '来源引用 ID 重复。');
  return { kind: 'novel_breakdown', segments, entities, sourceRefs, scope };
}

function parseAssetMetadata(value: unknown, path: string): Record<string, string | number | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, '必须是对象。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length > 20) invalid(path, '资产元数据最多 20 个标量字段。');
  const output: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(input)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/u.test(key)) invalid(`${path}.${key}`, '元数据键格式不正确。');
    if (typeof item === 'string') output[key] = text(item, `${path}.${key}`, 200, false);
    else if (typeof item === 'number') output[key] = finite(item, `${path}.${key}`, -1_000_000, 1_000_000);
    else if (typeof item === 'boolean') output[key] = item;
    else invalid(`${path}.${key}`, '元数据只允许字符串、数字或布尔值，禁止嵌套对象。');
  }
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)));
}

function parseAssetInput(value: unknown, path: string): AssetRetrievalCaseInput {
  const input = object(value, path, ['kind', 'query', 'assets', 'fixedHits']);
  if (input.kind !== 'asset_retrieval') invalid(`${path}.kind`, '输入类型必须是 asset_retrieval。');
  const queryInput = object(required(input, 'query', path), `${path}.query`, ['text', 'filters', 'limit']);
  const filtersInput = object(required(queryInput, 'filters', `${path}.query`), `${path}.query.filters`, ['kinds', 'statuses']);
  const query: AssetRetrievalQuery = {
    text: text(required(queryInput, 'text', `${path}.query`), `${path}.query.text`, 500),
    filters: {
      kinds: stringList(filtersInput.kinds ?? [], `${path}.query.filters.kinds`, SIMPLE_ID, 10, '资产类型'),
      statuses: stringList(filtersInput.statuses ?? [], `${path}.query.filters.statuses`, SIMPLE_ID, 10, '资产状态'),
    },
    limit: integer(required(queryInput, 'limit', `${path}.query`), `${path}.query.limit`, 1, 20),
  };
  const rawAssets = required(input, 'assets', path);
  if (!Array.isArray(rawAssets) || rawAssets.length === 0 || rawAssets.length > 30) {
    invalid(`${path}.assets`, '资产必须是 1..30 项数组。');
  }
  const assets = rawAssets.map((item, index) => {
    const itemPath = `${path}.assets[${index}]`;
    const asset = object(item, itemPath, ['assetId', 'name', 'kind', 'status', 'summary', 'metadata']);
    return {
      assetId: idValue(required(asset, 'assetId', itemPath), `${itemPath}.assetId`, SIMPLE_ID, '资产 ID '),
      name: text(required(asset, 'name', itemPath), `${itemPath}.name`, 80),
      kind: text(required(asset, 'kind', itemPath), `${itemPath}.kind`, 40),
      status: text(required(asset, 'status', itemPath), `${itemPath}.status`, 40),
      summary: text(required(asset, 'summary', itemPath), `${itemPath}.summary`, 300),
      metadata: parseAssetMetadata(required(asset, 'metadata', itemPath), `${itemPath}.metadata`),
    };
  });
  if (new Set(assets.map(asset => asset.assetId)).size !== assets.length) invalid(`${path}.assets`, '资产 ID 重复。');
  const rawHits = required(input, 'fixedHits', path);
  if (!Array.isArray(rawHits) || rawHits.length > 30) invalid(`${path}.fixedHits`, '固定命中必须是不超过 30 项的数组。');
  const fixedHits = rawHits.map((item, index) => {
    const itemPath = `${path}.fixedHits[${index}]`;
    const hit = object(item, itemPath, ['assetId', 'score', 'rank']);
    const assetId = idValue(required(hit, 'assetId', itemPath), `${itemPath}.assetId`, SIMPLE_ID, '命中资产 ID ');
    if (!assets.some(asset => asset.assetId === assetId)) invalid(`${itemPath}.assetId`, '命中资产不在候选资产列表中。');
    return {
      assetId,
      score: finite(required(hit, 'score', itemPath), `${itemPath}.score`, 0, 1),
      rank: integer(required(hit, 'rank', itemPath), `${itemPath}.rank`, 1, 30),
    };
  });
  if (new Set(fixedHits.map(hit => hit.rank)).size !== fixedHits.length) invalid(`${path}.fixedHits`, '命中排名重复。');
  return {
    kind: 'asset_retrieval',
    query,
    assets: assets.sort((a, b) => a.assetId.localeCompare(b.assetId)),
    fixedHits: fixedHits.sort((a, b) => a.rank - b.rank),
  };
}

function parseShotInput(value: unknown, path: string): ShotReviewCaseInput {
  const input = object(value, path, ['kind', 'shot', 'mediaRefs', 'rubric', 'frameEvidence']);
  if (input.kind !== 'shot_review') invalid(`${path}.kind`, '输入类型必须是 shot_review。');
  const shotInput = object(required(input, 'shot', path), `${path}.shot`, ['shotId', 'description', 'durationSec', 'camera']);
  const shot: ShotDescriptor = {
    shotId: idValue(required(shotInput, 'shotId', `${path}.shot`), `${path}.shot.shotId`, SIMPLE_ID, '镜头 ID '),
    description: text(required(shotInput, 'description', `${path}.shot`), `${path}.shot.description`, 1000),
    durationSec: finite(required(shotInput, 'durationSec', `${path}.shot`), `${path}.shot.durationSec`, 0.1, 600),
    camera: text(required(shotInput, 'camera', `${path}.shot`), `${path}.shot.camera`, 200),
  };
  const rawMedia = required(input, 'mediaRefs', path);
  if (!Array.isArray(rawMedia) || rawMedia.length === 0 || rawMedia.length > 20) {
    invalid(`${path}.mediaRefs`, '媒体摘要引用必须是 1..20 项数组。');
  }
  const mediaRefs = rawMedia.map((item, index) => {
    const itemPath = `${path}.mediaRefs[${index}]`;
    const media = object(item, itemPath, ['refId', 'kind', 'digest', 'locator', 'note']);
    return {
      refId: text(required(media, 'refId', itemPath), `${itemPath}.refId`, 80),
      kind: enumValue(required(media, 'kind', itemPath), `${itemPath}.kind`, ['image', 'video', 'frame'] as const),
      digest: digestValue(required(media, 'digest', itemPath), `${itemPath}.digest`),
      locator: text(required(media, 'locator', itemPath), `${itemPath}.locator`, 240),
      note: optionalText(media.note, `${itemPath}.note`, 200),
    };
  });
  if (new Set(mediaRefs.map(ref => ref.refId)).size !== mediaRefs.length) invalid(`${path}.mediaRefs`, '媒体引用 ID 重复。');
  const rubricInput = object(required(input, 'rubric', path), `${path}.rubric`, ['rubricId', 'revisionId', 'digest']);
  const rubric = {
    rubricId: idValue(required(rubricInput, 'rubricId', `${path}.rubric`), `${path}.rubric.rubricId`,
      RUBRIC_ID, '量表 ID '),
    revisionId: idValue(required(rubricInput, 'revisionId', `${path}.rubric`), `${path}.rubric.revisionId`,
      RUBRIC_REVISION_ID, '量表 revision '),
    digest: digestValue(required(rubricInput, 'digest', `${path}.rubric`), `${path}.rubric.digest`),
  };
  const rawEvidence = required(input, 'frameEvidence', path);
  if (!Array.isArray(rawEvidence) || rawEvidence.length === 0 || rawEvidence.length > 20) {
    invalid(`${path}.frameEvidence`, '帧证据要求必须是 1..20 项数组。');
  }
  const frameEvidence = rawEvidence.map((item, index) => {
    const itemPath = `${path}.frameEvidence[${index}]`;
    const evidence = object(item, itemPath, ['requirementId', 'atSec', 'description']);
    return {
      requirementId: text(required(evidence, 'requirementId', itemPath), `${itemPath}.requirementId`, 64),
      atSec: finite(required(evidence, 'atSec', itemPath), `${itemPath}.atSec`, 0, 600),
      description: text(required(evidence, 'description', itemPath), `${itemPath}.description`, 300),
    };
  });
  if (new Set(frameEvidence.map(item => item.requirementId)).size !== frameEvidence.length) {
    invalid(`${path}.frameEvidence`, '帧证据要求 ID 重复。');
  }
  return {
    kind: 'shot_review',
    shot,
    mediaRefs: mediaRefs.sort((a, b) => a.refId.localeCompare(b.refId)),
    rubric,
    frameEvidence: frameEvidence.sort((a, b) => a.atSec - b.atSec || a.requirementId.localeCompare(b.requirementId)),
  };
}

export function parseEvaluationCaseInput(value: unknown, path: string, kind: EvaluationCatalogKind): EvaluationCaseInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, '输入必须是对象。');
  const rawKind = (value as Record<string, unknown>).kind;
  if (rawKind !== kind) invalid(`${path}.kind`, `输入类型必须是 ${kind}。`, 'EVALUATION_KIND_MISMATCH');
  if (kind === 'novel_breakdown') return parseNovelInput(value, path);
  if (kind === 'asset_retrieval') return parseAssetInput(value, path);
  return parseShotInput(value, path);
}

/* -------------------------------------------------------------------------- */
/* 期望结果                                                                     */
/* -------------------------------------------------------------------------- */

function parseNovelExpectation(value: unknown, path: string): NovelBreakdownExpectation {
  const input = object(value, path, ['kind', 'expectedEntities', 'expectedSourceRefCount']);
  if (input.kind !== 'novel_breakdown') invalid(`${path}.kind`, '期望类型必须是 novel_breakdown。');
  const raw = required(input, 'expectedEntities', path);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) invalid(`${path}.expectedEntities`, '期望实体必须是 1..50 项。');
  const expectedEntities = raw.map((item, index) => {
    const itemPath = `${path}.expectedEntities[${index}]`;
    const entity = object(item, itemPath, ['entityId', 'canonicalName', 'mentions']);
    return {
      entityId: text(required(entity, 'entityId', itemPath), `${itemPath}.entityId`, 64),
      canonicalName: text(required(entity, 'canonicalName', itemPath), `${itemPath}.canonicalName`, 80),
      mentions: integer(required(entity, 'mentions', itemPath), `${itemPath}.mentions`, 1, 500),
    };
  });
  if (new Set(expectedEntities.map(entity => entity.entityId)).size !== expectedEntities.length) {
    invalid(`${path}.expectedEntities`, '期望实体 ID 重复。');
  }
  return {
    kind: 'novel_breakdown',
    expectedEntities: expectedEntities.sort((a, b) => a.entityId.localeCompare(b.entityId)),
    expectedSourceRefCount: integer(required(input, 'expectedSourceRefCount', path), `${path}.expectedSourceRefCount`, 1, 500),
  };
}

function parseAssetExpectation(value: unknown, path: string): AssetRetrievalExpectation {
  const input = object(value, path, ['kind', 'result', 'expectedAssetId', 'minimumScore']);
  if (input.kind !== 'asset_retrieval') invalid(`${path}.kind`, '期望类型必须是 asset_retrieval。');
  const result = enumValue(required(input, 'result', path), `${path}.result`, ['unique', 'ambiguous', 'missing'] as const);
  const expectedAssetId = input.expectedAssetId === null || input.expectedAssetId === undefined
    ? null : idValue(input.expectedAssetId, `${path}.expectedAssetId`, SIMPLE_ID, '期望资产 ID ');
  if (result === 'unique' && !expectedAssetId) invalid(`${path}.expectedAssetId`, 'unique 结果必须声明期望资产。');
  if (result === 'missing' && expectedAssetId !== null) invalid(`${path}.expectedAssetId`, 'missing 结果不得声明期望资产。');
  const minimumScore = input.minimumScore === null || input.minimumScore === undefined
    ? null : finite(input.minimumScore, `${path}.minimumScore`, 0, 1);
  if (result === 'unique' && minimumScore === null) invalid(`${path}.minimumScore`, 'unique 结果必须声明最低分。');
  return { kind: 'asset_retrieval', result, expectedAssetId, minimumScore };
}

function parseShotExpectation(value: unknown, path: string): ShotReviewExpectation {
  const input = object(value, path, ['kind', 'dimensionExpectations']);
  if (input.kind !== 'shot_review') invalid(`${path}.kind`, '期望类型必须是 shot_review。');
  const raw = required(input, 'dimensionExpectations', path);
  if (!Array.isArray(raw) || raw.length !== SHOT_REVIEW_DIMENSIONS) {
    invalid(`${path}.dimensionExpectations`, '镜头审核期望必须覆盖四个维度。');
  }
  const dimensionExpectations = raw.map((item, index) => {
    const itemPath = `${path}.dimensionExpectations[${index}]`;
    const expectation = object(item, itemPath, ['dimensionKey', 'expected', 'rationale']);
    return {
      dimensionKey: idValue(required(expectation, 'dimensionKey', itemPath), `${itemPath}.dimensionKey`,
        DIMENSION_KEY, '维度 key '),
      expected: enumValue(required(expectation, 'expected', itemPath), `${itemPath}.expected`,
        ['pass', 'fail', 'uncertain'] as const),
      rationale: text(required(expectation, 'rationale', itemPath), `${itemPath}.rationale`, 300),
    };
  });
  if (new Set(dimensionExpectations.map(item => item.dimensionKey)).size !== dimensionExpectations.length) {
    invalid(`${path}.dimensionExpectations`, '维度 key 重复。');
  }
  return { kind: 'shot_review',
    dimensionExpectations: dimensionExpectations.sort((a, b) => a.dimensionKey.localeCompare(b.dimensionKey)) };
}

export function parseEvaluationExpectation(
  value: unknown, path: string, kind: EvaluationCatalogKind,
): EvaluationExpectation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, '期望必须是对象。');
  const rawKind = (value as Record<string, unknown>).kind;
  if (rawKind !== kind) invalid(`${path}.kind`, `期望类型必须是 ${kind}。`, 'EVALUATION_KIND_MISMATCH');
  if (kind === 'novel_breakdown') return parseNovelExpectation(value, path);
  if (kind === 'asset_retrieval') return parseAssetExpectation(value, path);
  return parseShotExpectation(value, path);
}

/* -------------------------------------------------------------------------- */
/* 样例                                                                         */
/* -------------------------------------------------------------------------- */

const CASE_KEYS = ['caseId', 'kind', 'title', 'intent', 'input', 'expectation', 'source', 'versionRefs',
  'contentSummary', 'authorization', 'sensitivity', 'tags', 'slices'] as const;
const CASE_KEYS_WITH_DIGEST = [...CASE_KEYS, 'contentDigest'] as const;

export function parseEvaluationCase(value: unknown, path: string, expectedKind?: EvaluationCatalogKind): EvaluationCase {
  const input = object(value, path, value && typeof value === 'object' && !Array.isArray(value)
    && 'contentDigest' in (value as Record<string, unknown>) ? CASE_KEYS_WITH_DIGEST : CASE_KEYS);
  const caseId = idValue(required(input, 'caseId', path), `${path}.caseId`, CASE_ID, '样例 ID ');
  const kind = enumValue(required(input, 'kind', path), `${path}.kind`, EVALUATION_CATALOG_KINDS);
  if (expectedKind && kind !== expectedKind) {
    invalid(`${path}.kind`, `样例类型必须是 ${expectedKind}。`, 'EVALUATION_KIND_MISMATCH');
  }
  const parsedInput = parseEvaluationCaseInput(required(input, 'input', path), `${path}.input`, kind);
  const expectation = parseEvaluationExpectation(required(input, 'expectation', path), `${path}.expectation`, kind);
  const sensitivity = enumValue(required(input, 'sensitivity', path), `${path}.sensitivity`,
    ['public', 'internal', 'confidential', 'restricted'] as const);
  const authorization = parseAuthorization(required(input, 'authorization', path), `${path}.authorization`);
  assertUsableAuthorization(authorization, `${path}.authorization`, sensitivity);
  const evaluationCase: EvaluationCase = {
    caseId,
    kind,
    title: text(required(input, 'title', path), `${path}.title`, 120),
    intent: text(required(input, 'intent', path), `${path}.intent`, 300),
    input: parsedInput,
    expectation,
    source: parseProvenance(required(input, 'source', path), `${path}.source`, 20),
    versionRefs: parseVersionRefs(required(input, 'versionRefs', path), `${path}.versionRefs`, 20),
    contentSummary: text(required(input, 'contentSummary', path), `${path}.contentSummary`, 240),
    authorization,
    sensitivity,
    tags: parseTags(input.tags, `${path}.tags`),
    slices: parseSlices(input.slices, `${path}.slices`),
  };
  const normalized = normalizeEvaluationCase(evaluationCase);
  if (normalized.input.kind === 'shot_review') {
    const shotInput = normalized.input;
    const rubricRef = normalized.versionRefs.find(ref => ref.kind === 'rubric_revision'
      && ref.id === shotInput.rubric.revisionId);
    if (!rubricRef) {
      invalid(`${path}.versionRefs`, '镜头审核必须引用所用四维量表的 revision。', 'EVALUATION_VERSION_REF_INVALID');
    }
    if (rubricRef.digest !== shotInput.rubric.digest) {
      invalid(`${path}.input.rubric.digest`, '量表引用摘要与 versionRefs 不一致。', 'EVALUATION_VERSION_REF_INVALID');
    }
  }
  if (input.contentDigest !== undefined) {
    const claimed = digestValue(input.contentDigest, `${path}.contentDigest`);
    if (claimed !== evaluationCaseDigest(normalized)) {
      invalid(`${path}.contentDigest`, '内容摘要与规范化内容不一致。');
    }
  }
  return normalized;
}

/** 排序、去重与文本规范化；相同语义的样例必须得到相同摘要。 */
export function normalizeEvaluationCase(value: EvaluationCase): EvaluationCase {
  const normalized: EvaluationCase = {
    ...value,
    title: normalizeEvaluationText(value.title),
    intent: normalizeEvaluationText(value.intent),
    contentSummary: normalizeEvaluationText(value.contentSummary),
    tags: [...new Set(value.tags.map(tag => normalizeEvaluationText(tag)))].sort(),
    slices: [...new Set(value.slices.map(slice => normalizeEvaluationText(slice)))].sort(),
    source: {
      ...value.source,
      notes: normalizeEvaluationText(value.source.notes),
      sourceRefs: value.source.sourceRefs.map(ref => ({
        refId: normalizeEvaluationText(ref.refId), locator: normalizeEvaluationText(ref.locator), digest: ref.digest,
      })).sort((a, b) => a.refId.localeCompare(b.refId)),
    },
    versionRefs: value.versionRefs.map(ref => ({ ...ref, id: normalizeEvaluationText(ref.id) }))
      .sort((a, b) => `${a.kind}\u0000${a.id}`.localeCompare(`${b.kind}\u0000${b.id}`)),
  };
  if (normalized.input.kind === 'novel_breakdown') {
    normalized.input = {
      ...normalized.input,
      segments: normalized.input.segments.map(segment => ({
        ...segment, text: normalizeEvaluationText(segment.text),
        chapterRef: segment.chapterRef === null ? null : normalizeEvaluationText(segment.chapterRef),
      })).sort((a, b) => a.order - b.order),
      entities: normalized.input.entities.map(entity => ({
        ...entity,
        canonicalName: normalizeEvaluationText(entity.canonicalName),
        aliases: [...new Set(entity.aliases.map(alias => normalizeEvaluationText(alias)))].sort(),
      })).sort((a, b) => a.entityId.localeCompare(b.entityId)),
      sourceRefs: normalized.input.sourceRefs.map(ref => ({ ...ref, locator: normalizeEvaluationText(ref.locator) }))
        .sort((a, b) => a.refId.localeCompare(b.refId)),
      scope: {
        time: { ...normalized.input.scope.time, label: normalizeEvaluationText(normalized.input.scope.time.label) },
        space: {
          label: normalizeEvaluationText(normalized.input.scope.space.label),
          locations: [...new Set(normalized.input.scope.space.locations.map(item => normalizeEvaluationText(item)))].sort(),
        },
      },
    };
  } else if (normalized.input.kind === 'asset_retrieval') {
    normalized.input = {
      ...normalized.input,
      query: {
        text: normalizeEvaluationText(normalized.input.query.text),
        filters: {
          kinds: [...normalized.input.query.filters.kinds].sort(),
          statuses: [...normalized.input.query.filters.statuses].sort(),
        },
        limit: normalized.input.query.limit,
      },
      assets: normalized.input.assets.map(asset => ({
        ...asset, name: normalizeEvaluationText(asset.name), summary: normalizeEvaluationText(asset.summary),
      })).sort((a, b) => a.assetId.localeCompare(b.assetId)),
      fixedHits: normalized.input.fixedHits.map(hit => ({ ...hit })).sort((a, b) => a.rank - b.rank),
    };
  } else {
    normalized.input = {
      ...normalized.input,
      shot: {
        ...normalized.input.shot,
        description: normalizeEvaluationText(normalized.input.shot.description),
        camera: normalizeEvaluationText(normalized.input.shot.camera),
      },
      mediaRefs: normalized.input.mediaRefs.map(ref => ({
        ...ref, locator: normalizeEvaluationText(ref.locator), note: normalizeEvaluationText(ref.note),
      })).sort((a, b) => a.refId.localeCompare(b.refId)),
      frameEvidence: normalized.input.frameEvidence.map(item => ({
        ...item, description: normalizeEvaluationText(item.description),
      })).sort((a, b) => a.atSec - b.atSec || a.requirementId.localeCompare(b.requirementId)),
    };
  }
  return normalized;
}

export function evaluationCaseInputDigest(value: EvaluationCase): string {
  const normalized = normalizeEvaluationCase(value);
  return canonicalDigest({ kind: normalized.kind, input: normalized.input });
}

export function evaluationCaseDigest(value: EvaluationCase): string {
  const normalized = normalizeEvaluationCase(value);
  return canonicalDigest({ kind: normalized.kind, input: normalized.input, expectation: normalized.expectation });
}

export function datasetContentDigest(kind: EvaluationCatalogKind, cases: readonly EvaluationCase[]): string {
  const normalizedCases = cases.map(caseItem => normalizeEvaluationCase(caseItem))
    .sort((a, b) => a.caseId.localeCompare(b.caseId));
  return canonicalDigest({ schemaVersion: EVALUATION_DATASET_SCHEMA_VERSION, kind, cases: normalizedCases });
}

export function datasetRevisionDigest(draft: EvaluationDatasetRevisionDraft, revision: number): string {
  const normalizedCases = draft.cases.map(caseItem => normalizeEvaluationCase(caseItem))
    .sort((a, b) => a.caseId.localeCompare(b.caseId));
  return canonicalDigest({
    schemaVersion: EVALUATION_DATASET_SCHEMA_VERSION,
    datasetId: draft.datasetId,
    kind: draft.kind,
    revision,
    note: normalizeEvaluationText(draft.note),
    contentSummary: normalizeEvaluationText(draft.contentSummary),
    slices: [...draft.slices].sort(),
    tags: [...draft.tags].sort(),
    authorization: draft.authorization,
    sensitivity: draft.sensitivity,
    provenance: draft.provenance,
    cases: normalizedCases,
  });
}

export function evaluationRubricContentDigest(
  kind: EvaluationCatalogKind, missingResultPolicy: MissingResultPolicy, dimensions: readonly RubricDimension[],
): string {
  const normalizedDimensions = [...dimensions].sort((a, b) => a.key.localeCompare(b.key));
  return canonicalDigest({ schemaVersion: EVALUATION_RUBRIC_SCHEMA_VERSION, kind, missingResultPolicy, dimensions: normalizedDimensions });
}

export function rubricRevisionDigest(draft: EvaluationRubricRevisionDraft, revision: number): string {
  const normalizedDimensions = [...draft.dimensions].sort((a, b) => a.key.localeCompare(b.key));
  return canonicalDigest({
    schemaVersion: EVALUATION_RUBRIC_SCHEMA_VERSION,
    rubricId: draft.rubricId,
    kind: draft.kind,
    revision,
    note: normalizeEvaluationText(draft.note),
    summary: normalizeEvaluationText(draft.summary),
    missingResultPolicy: draft.missingResultPolicy,
    dimensions: normalizedDimensions,
  });
}

/* -------------------------------------------------------------------------- */
/* 量表                                                                         */
/* -------------------------------------------------------------------------- */

function parseMissingResultPolicy(value: unknown, path: string): MissingResultPolicy {
  const input = object(value, path, ['uncertain', 'skipped', 'evaluator_error']);
  const actions = ['fail', 'exclude', 'review'] as const;
  return {
    uncertain: enumValue(required(input, 'uncertain', path), `${path}.uncertain`, actions),
    skipped: enumValue(required(input, 'skipped', path), `${path}.skipped`, actions),
    evaluator_error: enumValue(required(input, 'evaluator_error', path), `${path}.evaluator_error`, actions),
  };
}

function parseScale(value: unknown, path: string): EvaluationScale {
  const input = object(value, path, ['min', 'max', 'step']);
  const min = finite(required(input, 'min', path), `${path}.min`, -1000, 1000);
  const max = finite(required(input, 'max', path), `${path}.max`, -1000, 1000);
  const step = finite(required(input, 'step', path), `${path}.step`, 0.0001, 100);
  if (min >= max) invalid(`${path}.min`, '最小值必须小于最大值。');
  if (step > max - min) invalid(`${path}.step`, '步长必须小于取值范围。');
  const span = (max - min) / step;
  if (Math.abs(span - Math.round(span)) > 1e-9) invalid(`${path}.step`, '步长必须整除取值范围。');
  return { min, max, step };
}

function alignedToScale(value: number, scale: EvaluationScale): boolean {
  const offset = (value - scale.min) / scale.step;
  return Math.abs(offset - Math.round(offset)) <= 1e-9;
}

function parseThresholds(value: unknown, path: string, scale: EvaluationScale): EvaluationThresholds {
  const input = object(value, path, ['passAt', 'failAt']);
  const passAt = finite(required(input, 'passAt', path), `${path}.passAt`, scale.min, scale.max);
  const failAt = finite(required(input, 'failAt', path), `${path}.failAt`, scale.min, scale.max);
  if (!alignedToScale(passAt, scale)) invalid(`${path}.passAt`, '通过阈值未对齐刻度。');
  if (!alignedToScale(failAt, scale)) invalid(`${path}.failAt`, '不通过阈值未对齐刻度。');
  if (failAt >= passAt) invalid(`${path}.failAt`, '不通过阈值必须低于通过阈值。');
  if (passAt === scale.min) invalid(`${path}.passAt`, '通过阈值不能等于最小值。');
  if (failAt === scale.max) invalid(`${path}.failAt`, '不通过阈值不能等于最大值。');
  return { passAt, failAt };
}

function parseEvidence(value: unknown, path: string): EvaluationEvidenceRequirement {
  const input = object(value, path, ['required', 'kinds', 'minItems', 'note']);
  const requiredFlag = booleanValue(required(input, 'required', path), `${path}.required`);
  const kinds = required(input, 'kinds', path);
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.length > 5) invalid(`${path}.kinds`, '证据类型必须是 1..5 项。');
  const parsedKinds = kinds.map((item, index) => enumValue(item, `${path}.kinds[${index}]`,
    ['frame', 'transcript', 'asset_metadata', 'source_span', 'human_note'] as const));
  if (new Set(parsedKinds).size !== parsedKinds.length) invalid(`${path}.kinds`, '证据类型重复。');
  const minItems = integer(required(input, 'minItems', path), `${path}.minItems`, 0, 20);
  if ((requiredFlag && minItems === 0) || (!requiredFlag && minItems !== 0)) {
    invalid(`${path}.minItems`, 'required 与 minItems 必须一致。');
  }
  return { required: requiredFlag, kinds: parsedKinds.sort(), minItems, note: optionalText(input.note, `${path}.note`, 200) };
}

export function parseRubricDimension(value: unknown, path: string, kind: EvaluationCatalogKind): RubricDimension {
  const input = object(value, path, ['key', 'label', 'description', 'scale', 'thresholds', 'evidence']);
  const dimension: RubricDimension = {
    key: idValue(required(input, 'key', path), `${path}.key`, DIMENSION_KEY, '维度 key '),
    label: text(required(input, 'label', path), `${path}.label`, 80),
    description: text(required(input, 'description', path), `${path}.description`, 400),
    scale: parseScale(required(input, 'scale', path), `${path}.scale`),
    thresholds: { passAt: 0, failAt: 0 },
    evidence: parseEvidence(required(input, 'evidence', path), `${path}.evidence`),
  };
  dimension.thresholds = parseThresholds(required(input, 'thresholds', path), `${path}.thresholds`, dimension.scale);
  if (kind === 'shot_review' && dimension.evidence.required
    && !dimension.evidence.kinds.includes('frame')) {
    invalid(`${path}.evidence.kinds`, '镜头审核维度的必需证据必须包含帧证据。');
  }
  return dimension;
}

export function parseRubricRevisionContent(
  value: unknown, path: string, kind: EvaluationCatalogKind,
): { note: string; summary: string; missingResultPolicy: MissingResultPolicy; dimensions: RubricDimension[] } {
  const input = object(value, path, ['note', 'summary', 'missingResultPolicy', 'dimensions']);
  const missingResultPolicy = parseMissingResultPolicy(required(input, 'missingResultPolicy', path),
    `${path}.missingResultPolicy`);
  const raw = required(input, 'dimensions', path);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DIMENSIONS) {
    invalid(`${path}.dimensions`, `维度必须是 1..${MAX_DIMENSIONS} 项。`);
  }
  if (kind === 'shot_review' && raw.length !== SHOT_REVIEW_DIMENSIONS) {
    invalid(`${path}.dimensions`, '镜头审核量表必须恰好包含四个维度。');
  }
  const dimensions = raw.map((item, index) => parseRubricDimension(item, `${path}.dimensions[${index}]`, kind));
  if (new Set(dimensions.map(dimension => dimension.key)).size !== dimensions.length) {
    invalid(`${path}.dimensions`, '维度 key 重复。');
  }
  return {
    note: optionalText(input.note, `${path}.note`, 500),
    summary: optionalText(input.summary, `${path}.summary`, 300),
    missingResultPolicy,
    dimensions: dimensions.sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export function parseCreateEvaluationDataset(value: unknown): CreateEvaluationDatasetInput {
  const path = 'dataset';
  const input = object(value, path, ['kind', 'title', 'description', 'note', 'contentSummary', 'slices', 'tags',
    'authorization', 'sensitivity', 'provenance', 'cases']);
  const kind = enumValue(required(input, 'kind', path), `${path}.kind`, EVALUATION_CATALOG_KINDS);
  const sensitivity = enumValue(required(input, 'sensitivity', path), `${path}.sensitivity`,
    ['public', 'internal', 'confidential', 'restricted'] as const);
  const authorization = parseAuthorization(required(input, 'authorization', path), `${path}.authorization`);
  assertUsableAuthorization(authorization, `${path}.authorization`, sensitivity);
  const rawCases = input.cases ?? [];
  if (!Array.isArray(rawCases) || rawCases.length > MAX_CASES) invalid(`${path}.cases`, `样例必须是不超过 ${MAX_CASES} 项的数组。`);
  return {
    kind,
    title: text(required(input, 'title', path), `${path}.title`, 120),
    description: optionalText(input.description, `${path}.description`, 2000),
    note: optionalText(input.note, `${path}.note`, 500),
    contentSummary: optionalText(input.contentSummary, `${path}.contentSummary`, 240),
    slices: parseSlices(input.slices, `${path}.slices`),
    tags: parseTags(input.tags, `${path}.tags`),
    authorization,
    sensitivity,
    provenance: parseProvenance(required(input, 'provenance', path), `${path}.provenance`, 20),
    cases: rawCases.map((item, index) => parseEvaluationCase(item, `${path}.cases[${index}]`, kind)),
  };
}

export function parseCreateEvaluationRubric(value: unknown): CreateEvaluationRubricInput {
  const path = 'rubric';
  const input = object(value, path, ['kind', 'title', 'description', 'note', 'summary', 'missingResultPolicy', 'dimensions']);
  const kind = enumValue(required(input, 'kind', path), `${path}.kind`, EVALUATION_CATALOG_KINDS);
  const content = parseRubricRevisionContent({
    note: input.note, summary: input.summary,
    missingResultPolicy: required(input, 'missingResultPolicy', path),
    dimensions: input.dimensions ?? [],
  }, `${path}.content`, kind);
  return {
    kind,
    title: text(required(input, 'title', path), `${path}.title`, 120),
    description: optionalText(input.description, `${path}.description`, 2000),
    note: content.note,
    summary: content.summary,
    missingResultPolicy: content.missingResultPolicy,
    dimensions: content.dimensions,
  };
}

export function parseEvaluationCaseList(value: unknown, path: string, kind: EvaluationCatalogKind): EvaluationCase[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CASES) {
    invalid(path, `样例必须是非空且不超过 ${MAX_CASES} 项的数组。`);
  }
  return value.map((item, index) => parseEvaluationCase(item, `${path}[${index}]`, kind));
}

export function parseRubricDimensionList(value: unknown, path: string, kind: EvaluationCatalogKind): RubricDimension[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DIMENSIONS) {
    invalid(path, `维度必须是非空且不超过 ${MAX_DIMENSIONS} 项的数组。`);
  }
  return value.map((item, index) => parseRubricDimension(item, `${path}[${index}]`, kind));
}

/* -------------------------------------------------------------------------- */
/* 目录身份与请求体                                                              */
/* -------------------------------------------------------------------------- */

export function parseEvaluationDatasetId(value: string): string {
  if (!DATASET_ID.test(value)) throw new EvaluationError(400, 'EVALUATION_ID_INVALID', '数据集 ID 格式不正确。');
  return value;
}
export function parseEvaluationDatasetRevisionId(value: string): string {
  if (!DATASET_REVISION_ID.test(value)) throw new EvaluationError(400, 'EVALUATION_ID_INVALID', '数据集 revision ID 格式不正确。');
  return value;
}
export function parseEvaluationRubricId(value: string): string {
  if (!RUBRIC_ID.test(value)) throw new EvaluationError(400, 'EVALUATION_ID_INVALID', '量表 ID 格式不正确。');
  return value;
}
export function parseEvaluationRubricRevisionId(value: string): string {
  if (!RUBRIC_REVISION_ID.test(value)) throw new EvaluationError(400, 'EVALUATION_ID_INVALID', '量表 revision ID 格式不正确。');
  return value;
}
export function parseEvaluationUsageId(value: string): string {
  if (!USAGE_ID.test(value)) throw new EvaluationError(400, 'EVALUATION_ID_INVALID', '引用记录 ID 格式不正确。');
  return value;
}
export function parseEvaluationEventId(value: string): string {
  if (!EVENT_ID.test(value)) throw new EvaluationError(400, 'EVALUATION_ID_INVALID', '生命周期事件 ID 格式不正确。');
  return value;
}

export function evaluationId(prefix: 'evalds' | 'evaldsrev' | 'evalrub' | 'evalrubrev' | 'evalusage' | 'evallevent'): string {
  const suffix = canonicalDigest(`${Date.now()}:${Math.random()}:${process.pid}`).slice(0, 32);
  return `${prefix}_${suffix}`;
}

export interface ExpectedDigestBody {
  expectedDigest: string;
  reason: string;
}

export function parseExpectedDigestBody(value: unknown, path = 'body', extraKeys: readonly string[] = []): ExpectedDigestBody {
  const input = object(value, path, ['expectedDigest', 'reason', ...extraKeys]);
  return {
    expectedDigest: digestValue(required(input, 'expectedDigest', path), `${path}.expectedDigest`),
    reason: optionalText(input.reason, `${path}.reason`, 500),
  };
}

/** JSONL 导入的 line/caseId/path 错误；service 汇总后一次性抛出。 */
export function evaluationImportError(issues: EvaluationFieldIssue[]): never {
  throw new EvaluationError(400, 'EVALUATION_JSONL_INVALID', 'JSONL 导入校验失败，未写入任何数据。', issues);
}

export function asEvaluationError(error: unknown): EvaluationError | null {
  if (error instanceof EvaluationError) return error;
  if (error instanceof ProductionError) return null;
  if (error instanceof Error && error.name === 'EvaluationError') {
    const candidate = error as EvaluationError;
    if (typeof candidate.status === 'number' && typeof candidate.code === 'string') return candidate;
  }
  return null;
}

export const EVALUATION_AUTHORIZATION_DENIED = 'EVALUATION_AUTHORIZATION_DENIED';
export const EVALUATION_REVISION_IMMUTABLE = 'EVALUATION_REVISION_IMMUTABLE';
export const EVALUATION_REVISION_REFERENCED = 'EVALUATION_REVISION_REFERENCED';
export const EVALUATION_REVISION_NOT_BINDABLE = 'EVALUATION_REVISION_NOT_BINDABLE';
export const EVALUATION_REVISION_STALE = 'EVALUATION_REVISION_STALE';
