import { randomUUID } from 'node:crypto';

export type AssetKind = 'character' | 'location' | 'prop';
export interface AssetInput {
  kind: AssetKind;
  name: string;
  description: string;
  resourceUrl: string;
}
/** Immutable external registration or a server-owned, locally imported raster. */
export interface AssetRecord extends AssetInput {
  id: string;
  createdAt: string;
}

export function localAssetUrl(id: string): string { return `/api/assets/${id}/content`; }
export function isLocalAssetUrl(url: string): boolean { return /^\/api\/assets\/asset_[a-f0-9]{32}\/content$/u.test(url); }

export class AssetError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AssetError';
  }
}

const INPUT_KEYS = ['kind', 'name', 'description', 'resourceUrl'];
const RECORD_KEYS = [...INPUT_KEYS, 'id', 'createdAt'];

function objectWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every(key => keys.includes(key))
    && keys.every(key => Object.hasOwn(value, key));
}
function invalid(): never {
  throw new AssetError(400, 'INVALID_ASSET_INPUT', '资产信息无效：请填写类型、名称、说明和不含账号密码的 HTTPS 素材地址。');
}
function trimmed(value: unknown, max: number, required: boolean): string {
  if (typeof value !== 'string') return invalid();
  const text = value.trim();
  const points = Array.from(text);
  // JSON can contain lone UTF-16 surrogates. UTF-8 / PostgreSQL would replace
  // them, changing an immutable registration between validation and readback.
  const malformedUnicode = points.some(point => {
    const code = point.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff;
  });
  if ((required && !text) || points.length > max || text.includes('\0') || malformedUnicode) return invalid();
  return text;
}

export function parseAssetMetadata(input: Record<string, unknown>): Pick<AssetInput, 'kind' | 'name' | 'description'> {
  const kind = trimmed(input.kind, 20, true);
  if (kind !== 'character' && kind !== 'location' && kind !== 'prop') return invalid();
  return { kind, name: trimmed(input.name, 200, true), description: trimmed(input.description, 2000, false) };
}

/** Trim all strings; preserve the trimmed URL exactly (including signed queries). */
export function parseAssetInput(input: unknown): AssetInput {
  if (!objectWithKeys(input, INPUT_KEYS)) return invalid();
  const { kind, name, description } = parseAssetMetadata(input);
  const resourceUrl = trimmed(input.resourceUrl, 2000, true);
  let url: URL;
  try { url = new URL(resourceUrl); } catch { return invalid(); }
  // Reject parser repairs (backslash, control/space, omitted //) and any userinfo,
  // including an empty userinfo marker. This address is never fetched here.
  const authority = /^https:\/\/([^/?#]+)/iu.exec(resourceUrl)?.[1];
  if (!authority || authority.includes('@') || /[\s\u0000-\u001f\u007f\\]/u.test(resourceUrl)
    || url.protocol !== 'https:' || !url.hostname || url.username || url.password) return invalid();
  return { kind, name, description, resourceUrl };
}

export function createAssetRecord(input: unknown): AssetRecord {
  return { ...parseAssetInput(input), id: `asset_${randomUUID().replaceAll('-', '')}`, createdAt: new Date().toISOString() };
}

/** Repository boundary validation; callers cannot smuggle fields through TS casts. */
export function validateAssetRecord(input: unknown): asserts input is AssetRecord {
  if (!objectWithKeys(input, RECORD_KEYS) || typeof input.id !== 'string' || !/^asset_[a-f0-9]{32}$/u.test(input.id)
    || typeof input.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.createdAt)
    || !Number.isFinite(Date.parse(input.createdAt)) || new Date(input.createdAt).toISOString() !== input.createdAt) return invalid();
  const parsed = input.resourceUrl === localAssetUrl(input.id)
    ? { ...parseAssetMetadata(input), resourceUrl: input.resourceUrl }
    : parseAssetInput({ kind: input.kind, name: input.name, description: input.description, resourceUrl: input.resourceUrl });
  if (INPUT_KEYS.some(key => parsed[key as keyof AssetInput] !== input[key])) return invalid();
}
