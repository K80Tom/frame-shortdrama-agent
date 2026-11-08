import { canonicalDigest } from './production';

/**
 * DataEventV1：统一事务 Outbox 的最小事件契约。
 *
 * payload 只允许一层标量/标量数组，禁止嵌套对象、媒体、全文、密钥、令牌、完整供应商响应。
 * 事件本身不可变；eventDigest 覆盖除数据库投递状态外的全部字段。
 */

export const DATA_EVENT_SCHEMA_VERSION = 'lyra.data.event/v1';
export const DATA_EVENT_SENSITIVITY_CEILING = 'internal' as const;
export const DATA_EVENT_MAX_PAYLOAD_BYTES = 4096;

export type DataAggregateType =
  | 'novel_chapter' | 'script' | 'asset' | 'production_run' | 'production_attempt'
  | 'external_operation' | 'quality_check' | 'delivery_artifact' | 'evaluation_run';

export const DATA_AGGREGATE_TYPES: readonly DataAggregateType[] = Object.freeze([
  'novel_chapter', 'script', 'asset', 'production_run', 'production_attempt',
  'external_operation', 'quality_check', 'delivery_artifact', 'evaluation_run',
]);

export interface DataEventFieldIssue {
  path: string;
  code: string;
  message: string;
}

export class DataEventContractError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: DataEventFieldIssue[] = [],
  ) {
    super(message);
    this.name = 'DataEventContractError';
    this.details = details;
  }
}

function invalid(path: string, message: string, code = 'DATA_EVENT_INPUT_INVALID'): never {
  throw new DataEventContractError(400, code, 'DataEventV1 契约校验失败。', [{ path, code, message }]);
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

function text(value: unknown, path: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim()) invalid(path, '必须是非空字符串。');
  if (value.length > max) invalid(path, `长度不能超过 ${max}。`);
  return value;
}

function safeId(value: unknown, path: string, label = 'ID', max = 160): string {
  const parsed = text(value, path, max);
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{2,159}$/u.test(parsed)) invalid(path, `${label} 格式不合法。`);
  return parsed;
}

function patternId(value: unknown, path: string, pattern: RegExp, label: string, max = 160): string {
  const parsed = text(value, path, max);
  if (!pattern.test(parsed)) invalid(path, `${label} 格式不合法。`);
  return parsed;
}

function digest(value: unknown, path: string): string {
  const parsed = text(value, path, 64);
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
  const parsed = text(value, path, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(parsed)
    || Number.isNaN(Date.parse(parsed))) invalid(path, '必须是 UTC ISO 8601 时间。');
  return new Date(parsed).toISOString();
}

function enumValue<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(path, `必须是 ${allowed.join(' / ')}。`);
  return value as T;
}

/* -------------------------------------------------------------------------- */
/* 敏感字段                                                                    */
/* -------------------------------------------------------------------------- */

/** 与 #48 数据治理契约保持一致；事件敏感级别上限为 internal。 */
export const DATA_EVENT_FORBIDDEN_KEYS: readonly string[] = Object.freeze([
  'rawText', 'quote', 'sourceIndex', 'promptSnapshot', 'content', 'mediaBytes', 'apiKey', 'token',
  'authorization', 'providerResponse', 'signedUrl', 'absolutePath', 'secret', 'password', 'credential',
  'headers', 'cookie', 'privateKey', 'binary', 'rawResponse',
]);

const NORMALIZED_FORBIDDEN = new Set(DATA_EVENT_FORBIDDEN_KEYS.map(normalizeKey));

function normalizeKey(key: string): string {
  return key.replace(/[_-]/gu, '').toLowerCase();
}

function assertSafeString(value: string, path: string): void {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/u.test(value)
    || /\bsk-[A-Za-z0-9_-]{16,}/u.test(value)
    || /data:(?:image|video|audio)\/[a-z0-9.+-]+;base64,/iu.test(value)
    || /(?:^|[/\\])Users[/\\][^/\\]+[/\\]/u.test(value)
    || /[?&](?:X-Amz-Signature|Signature|token)=/iu.test(value)) {
    invalid(path, '事件不得包含密钥、媒体二进制、签名 URL 或绝对路径。', 'DATA_EVENT_SENSITIVE_FIELD');
  }
}

function assertSafePayloadKey(key: string, path: string): void {
  if (NORMALIZED_FORBIDDEN.has(normalizeKey(key))) {
    invalid(path, 'payload 不得包含敏感字段。', 'DATA_EVENT_SENSITIVE_FIELD');
  }
}

/* -------------------------------------------------------------------------- */
/* Payload                                                                     */
/* -------------------------------------------------------------------------- */

export type DataEventScalar = string | number | boolean | null;
export type DataEventPayloadValue = DataEventScalar | readonly DataEventScalar[];
export interface DataEventPayload { readonly [key: string]: DataEventPayloadValue }

const PAYLOAD_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,63}$/u;

function parseScalar(value: unknown, path: string): DataEventScalar {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 512) invalid(path, '字符串长度不能超过 512。');
    assertSafeString(value, path);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) invalid(path, '数字必须是安全整数。');
    return value;
  }
  invalid(path, 'payload 只允许字符串、安全整数、布尔值或 null。');
}

function parsePayload(value: unknown, path: string): DataEventPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'payload 必须是对象。');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > 24) invalid(path, 'payload 字段不能超过 24 个。');
  const payload: Record<string, DataEventPayloadValue> = {};
  for (const key of keys) {
    if (!PAYLOAD_KEY_PATTERN.test(key)) invalid(`${path}.${key}`, 'payload 字段名必须是 camelCase。');
    assertSafePayloadKey(key, `${path}.${key}`);
    const item = record[key];
    if (Array.isArray(item)) {
      if (item.length > 16) invalid(`${path}.${key}`, 'payload 数组不能超过 16 项。');
      payload[key] = item.map((entry, index) => parseScalar(entry, `${path}.${key}[${index}]`));
    } else {
      payload[key] = parseScalar(item, `${path}.${key}`);
    }
  }
  if (new TextEncoder().encode(JSON.stringify(payload)).length > DATA_EVENT_MAX_PAYLOAD_BYTES) {
    invalid(path, `payload 不能超过 ${DATA_EVENT_MAX_PAYLOAD_BYTES} 字节。`, 'DATA_EVENT_PAYLOAD_TOO_LARGE');
  }
  return payload;
}

/* -------------------------------------------------------------------------- */
/* DataEventV1                                                                 */
/* -------------------------------------------------------------------------- */

export interface DataEventAuthorityRef {
  kind: string;
  id: string;
  revisionId: string | null;
  digest: string;
}

export interface DataEventV1 {
  eventId: string;
  eventType: string;
  schemaVersion: string;
  aggregateType: DataAggregateType;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  recordedAt: string;
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string;
  authoritativeRef: DataEventAuthorityRef;
  payload: DataEventPayload;
}

const EVENT_KEYS = ['eventId', 'eventType', 'schemaVersion', 'aggregateType', 'aggregateId',
  'aggregateVersion', 'occurredAt', 'recordedAt', 'correlationId', 'causationId', 'idempotencyKey',
  'authoritativeRef', 'payload'] as const;

function parseAuthorityRef(value: unknown, path: string): DataEventAuthorityRef {
  const record = object(value, path, ['kind', 'id', 'revisionId', 'digest']);
  return {
    kind: safeId(required(record, 'kind', path), `${path}.kind`, '权威来源类型', 64),
    id: safeId(required(record, 'id', path), `${path}.id`, '权威来源 ID'),
    revisionId: record.revisionId === null ? null : safeId(record.revisionId, `${path}.revisionId`, '权威 revision ID'),
    digest: digest(required(record, 'digest', path), `${path}.digest`),
  };
}

export function parseDataEventV1(value: unknown, path = 'event'): DataEventV1 {
  const record = object(value, path, EVENT_KEYS);
  const eventType = patternId(required(record, 'eventType', path), `${path}.eventType`,
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2}$/u, '事件类型', 96);
  const schemaVersion = patternId(required(record, 'schemaVersion', path), `${path}.schemaVersion`,
    /^lyra\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\/v[1-9][0-9]*$/u, 'schema 版本', 96);
  const aggregateVersion = integer(required(record, 'aggregateVersion', path), `${path}.aggregateVersion`,
    1, 2_147_483_647);
  const occurredAt = timestamp(required(record, 'occurredAt', path), `${path}.occurredAt`);
  const recordedAt = timestamp(required(record, 'recordedAt', path), `${path}.recordedAt`);
  if (occurredAt > recordedAt) invalid(`${path}.occurredAt`, '业务发生时间不能晚于记录时间。');
  const causationId = record.causationId === null ? null
    : patternId(record.causationId, `${path}.causationId`, /^evt_[a-f0-9]{32}$/u, 'causation event ID');
  return {
    eventId: patternId(required(record, 'eventId', path), `${path}.eventId`,
      /^evt_[a-f0-9]{32}$/u, '事件 ID'),
    eventType,
    schemaVersion,
    aggregateType: enumValue(required(record, 'aggregateType', path), `${path}.aggregateType`, DATA_AGGREGATE_TYPES),
    aggregateId: safeId(required(record, 'aggregateId', path), `${path}.aggregateId`, '聚合 ID'),
    aggregateVersion,
    occurredAt,
    recordedAt,
    correlationId: patternId(required(record, 'correlationId', path), `${path}.correlationId`,
      /^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/u, 'correlation ID'),
    causationId,
    idempotencyKey: patternId(required(record, 'idempotencyKey', path), `${path}.idempotencyKey`,
      /^[A-Za-z0-9][A-Za-z0-9:._-]{7,159}$/u, '幂等键'),
    authoritativeRef: parseAuthorityRef(required(record, 'authoritativeRef', path), `${path}.authoritativeRef`),
    payload: parsePayload(required(record, 'payload', path), `${path}.payload`),
  };
}

export function dataEventPayloadDigest(event: DataEventV1): string {
  return canonicalDigest(event.payload);
}

/** 覆盖事件全部业务字段；数据库的 publishedAt/attempts 等投递状态不进入摘要。 */
export function dataEventDigest(event: DataEventV1): string {
  return canonicalDigest({
    eventId: event.eventId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    correlationId: event.correlationId,
    causationId: event.causationId,
    idempotencyKey: event.idempotencyKey,
    authoritativeRef: event.authoritativeRef,
    payload: event.payload,
  });
}

export function assertDataEventDigest(event: DataEventV1, claimed: string): void {
  const expected = dataEventDigest(event);
  if (digest(claimed, 'eventDigest') !== expected) {
    invalid('eventDigest', '事件摘要与内容不一致。', 'DATA_EVENT_DIGEST_MISMATCH');
  }
}

/** 推荐的事件幂等键；同一聚合版本 + 事件类型只能产生一个事实。 */
export function dataEventIdempotencyKey(aggregateType: DataAggregateType, aggregateId: string,
  aggregateVersion: number, eventType: string): string {
  return `${aggregateType}:${aggregateId}:${aggregateVersion}:${eventType}`;
}

/* -------------------------------------------------------------------------- */
/* DataEventV2: tenant identity is part of the signed public contract          */
/* -------------------------------------------------------------------------- */

export const TENANT_DATA_EVENT_SCHEMA_VERSION = 'lyra.data.event/v2';
export const DATA_EVENT_LEGACY_WORKSPACE_ID = 'ws_00000000000000000000000000000000';

export interface DataEventV2 extends Omit<DataEventV1, 'schemaVersion'> {
  schemaVersion: typeof TENANT_DATA_EVENT_SCHEMA_VERSION;
  workspaceId: string;
}

export type TenantDataEvent = DataEventV1 | DataEventV2;

function tenantEventInvalid(path: string, message: string): never {
  throw new DataEventContractError(400, 'DATA_EVENT_INPUT_INVALID',
    'DataEventV2 契约校验失败。', [{ path, code: 'DATA_EVENT_INPUT_INVALID', message }]);
}

export function parseDataEventWorkspaceId(value: unknown, path = 'event.workspaceId'): string {
  if (typeof value !== 'string' || !/^ws_[a-f0-9]{32}$/u.test(value)) {
    return tenantEventInvalid(path, 'workspaceId 格式不合法。');
  }
  // The first-admin bootstrap may adopt the reserved workspace so immutable
  // V1 history does not need a checksum-breaking tenant rewrite. Membership
  // and workspace status, not a magic identifier, are the runtime authority.
  return value;
}

export function isDataEventV2(event: TenantDataEvent): event is DataEventV2 {
  return event.schemaVersion === TENANT_DATA_EVENT_SCHEMA_VERSION && 'workspaceId' in event;
}

export function workspaceIdOfDataEvent(event: TenantDataEvent): string {
  return isDataEventV2(event) ? event.workspaceId : DATA_EVENT_LEGACY_WORKSPACE_ID;
}

export function parseDataEventV2(value: unknown, path = 'event'): DataEventV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return tenantEventInvalid(path, '必须是对象。');
  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== TENANT_DATA_EVENT_SCHEMA_VERSION) {
    return tenantEventInvalid(`${path}.schemaVersion`, `必须是 ${TENANT_DATA_EVENT_SCHEMA_VERSION}。`);
  }
  const workspaceId = parseDataEventWorkspaceId(source.workspaceId, `${path}.workspaceId`);
  const { workspaceId: _workspaceId, ...v1Shape } = source;
  const parsed = parseDataEventV1(v1Shape, path);
  return { ...parsed, schemaVersion: TENANT_DATA_EVENT_SCHEMA_VERSION, workspaceId };
}

/** Selects a strict versioned parser without reinterpreting historical V1 payloads. */
export function parseTenantDataEvent(value: unknown, path = 'event'): TenantDataEvent {
  if (value && typeof value === 'object' && !Array.isArray(value)
    && (value as { schemaVersion?: unknown }).schemaVersion === TENANT_DATA_EVENT_SCHEMA_VERSION) {
    return parseDataEventV2(value, path);
  }
  return parseDataEventV1(value, path);
}

/** V1 digest remains byte-for-byte compatible; V2 signs workspaceId. */
export function tenantDataEventDigest(event: TenantDataEvent): string {
  if (!isDataEventV2(event)) return dataEventDigest(event);
  return canonicalDigest({
    eventId: event.eventId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    workspaceId: event.workspaceId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    correlationId: event.correlationId,
    causationId: event.causationId,
    idempotencyKey: event.idempotencyKey,
    authoritativeRef: event.authoritativeRef,
    payload: event.payload,
  });
}

export function assertSameTenantDataEvent(left: TenantDataEvent, right: TenantDataEvent): void {
  if (tenantDataEventDigest(left) !== tenantDataEventDigest(right)) {
    throw new DataEventContractError(409, 'DATA_OUTBOX_DUPLICATE_EVENT',
      '同一 eventId 对应了不同事件内容。');
  }
}
