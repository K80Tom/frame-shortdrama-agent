import { copyBoundedProductionInput, type InputVersionRef, type ShotSpecV2 } from './shot-spec';

export const PRODUCTION_INPUT_SCHEMA_VERSION = 'lyra-production-input/1' as const;
export const PRODUCTION_INPUT_ERROR_CODES = ['REVISION_CONFLICT', 'REFERENCE_NOT_FOUND', 'REFERENCE_FORBIDDEN',
  'DIGEST_MISMATCH', 'SNAPSHOT_NOT_READY', 'SCHEMA_UNSUPPORTED', 'CAPABILITY_INCOMPATIBLE'] as const;
export type ProductionInputErrorCode = typeof PRODUCTION_INPUT_ERROR_CODES[number];
export interface ProductionInputFinding { code: ProductionInputErrorCode; referenceId: string | null }
export interface ProductionInputSnapshot {
  schemaVersion: typeof PRODUCTION_INPUT_SCHEMA_VERSION;
  id: string; workspaceId: string; projectId: string; episodeId: string; baseProjectRevision: string;
  state: 'draft' | 'validating' | 'ready' | 'frozen' | 'blocked';
  shots: Array<{ shotId: string; revisionId: string; contentDigest: string }>;
  script: InputVersionRef; plan: InputVersionRef; storyboard: InputVersionRef;
  assetPacks: InputVersionRef[]; directorScenes: InputVersionRef[]; controls: InputVersionRef[];
  methodPacks: InputVersionRef[]; promptPacks: InputVersionRef[];
  modelConnections: Array<{ role: 'breakdown' | 'general' | 'image' | 'video'; connection: InputVersionRef; capability: InputVersionRef }>;
  retrievalPolicy: InputVersionRef; qualityGates: InputVersionRef[];
  budgetPolicy: { version: InputVersionRef; limitMicros: number; currency: string; allowPaid: boolean };
  candidatePolicy: { mode: 'direct' | 'gacha'; limit: number };
  automationMode: 'auto' | 'checkpoints' | 'coDirector';
  findings: ProductionInputFinding[];
  createdBy: string; createdAt: string; reason: string;
  /** Hash of normalized frozen inputs, independent of validation state and audit metadata. */
  snapshotDigest: string;
}
export type ProductionInputSnapshotDraft = Omit<ProductionInputSnapshot, 'snapshotDigest'>;
/** Runtime input bundle, not a statement that today's permissions/capabilities still authorize a paid submission. */
export interface FrozenProductionInput { snapshot: ProductionInputSnapshot; shots: ShotSpecV2[] }
export interface AdoptProductionInput { expectedCurrentRevision: string | null; snapshotId: string }
export class ProductionInputContractError extends Error {
  readonly status = 400;
  readonly code = 'PRODUCTION_INPUT_INVALID';
  constructor() { super('生产输入快照契约无效。'); this.name = 'ProductionInputContractError'; }
}
function bad(): never { throw new ProductionInputContractError(); }
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad();
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== fields.length || fields.some(f => !Object.hasOwn(r, f))) bad(); return r;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || /[\r\n]/u.test(value) || !/^[A-Za-z][A-Za-z0-9_.:-]*$/u.test(value)) bad(); return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/u.test(value)) bad(); return value;
}
function choice<T extends string>(value: unknown, options: readonly T[]): T {
  if (!options.includes(value as T)) bad(); return value as T;
}
function list<T>(value: unknown, max: number, parse: (v: unknown) => T, key: (v: T) => string): T[] {
  if (!Array.isArray(value) || value.length > max) bad();
  const parsed = value.map(parse); if (new Set(parsed.map(key)).size !== parsed.length) bad(); return parsed;
}
function ref(value: unknown): InputVersionRef {
  const r = object(value, ['id', 'versionId', 'digest']); return { id: id(r.id), versionId: id(r.versionId), digest: digest(r.digest) };
}
function refs(value: unknown) { return list(value, 2000, ref, r => r.id); }
function parse(value: unknown, sealed: boolean): ProductionInputSnapshot {
  const fields = ['schemaVersion', 'id', 'workspaceId', 'projectId', 'episodeId', 'baseProjectRevision', 'state', 'shots',
    'script', 'plan', 'storyboard', 'assetPacks', 'directorScenes', 'controls', 'methodPacks', 'promptPacks',
    'modelConnections', 'retrievalPolicy', 'qualityGates', 'budgetPolicy', 'candidatePolicy', 'automationMode',
    'findings', 'createdBy', 'createdAt', 'reason'];
  const r = object(copyBoundedProductionInput(value), sealed ? [...fields, 'snapshotDigest'] : fields);
  if (r.schemaVersion !== PRODUCTION_INPUT_SCHEMA_VERSION || typeof r.workspaceId !== 'string'
    || r.workspaceId.length !== 35 || !/^ws_[a-f0-9]{32}$/u.test(r.workspaceId)) bad();
  if (typeof r.baseProjectRevision !== 'string' || r.baseProjectRevision.length > 19
    || !/^(0|[1-9][0-9]*)$/u.test(r.baseProjectRevision) || /[\r\n]/u.test(r.baseProjectRevision)
    || BigInt(r.baseProjectRevision) > 9223372036854775807n) bad();
  const state = choice(r.state, ['draft', 'validating', 'ready', 'frozen', 'blocked'] as const);
  const shots = list(r.shots, 2000, value => {
    const s = object(value, ['shotId', 'revisionId', 'contentDigest']);
    return { shotId: id(s.shotId), revisionId: id(s.revisionId), contentDigest: digest(s.contentDigest) };
  }, s => s.shotId);
  if (!shots.length || new Set(shots.map(s => s.revisionId)).size !== shots.length) bad();
  const findings = list(r.findings, 2000, value => {
    const f = object(value, ['code', 'referenceId']);
    return { code: choice(f.code, PRODUCTION_INPUT_ERROR_CODES), referenceId: f.referenceId === null ? null : id(f.referenceId) };
  }, f => JSON.stringify([f.code, f.referenceId]));
  if ((state === 'ready' || state === 'frozen') && findings.length || state === 'blocked' && !findings.length) bad();
  const budget = object(r.budgetPolicy, ['version', 'limitMicros', 'currency', 'allowPaid']);
  if (!Number.isSafeInteger(budget.limitMicros) || Number(budget.limitMicros) < 0 || Number(budget.limitMicros) > 1_000_000_000_000
    || typeof budget.currency !== 'string' || !/^[A-Z]{3}$/u.test(budget.currency) || budget.currency.length !== 3 || typeof budget.allowPaid !== 'boolean') bad();
  const policy = object(r.candidatePolicy, ['mode', 'limit']), mode = choice(policy.mode, ['direct', 'gacha'] as const);
  if (!Number.isInteger(policy.limit) || Number(policy.limit) > 4 || (mode === 'direct' ? policy.limit !== 1 : Number(policy.limit) < 2)) bad();
  if (typeof r.createdAt !== 'string' || r.createdAt.length !== 24 || !Number.isFinite(Date.parse(r.createdAt))
    || new Date(r.createdAt).toISOString() !== r.createdAt) bad();
  if (typeof r.reason !== 'string' || !r.reason.trim() || r.reason.length > 1000 || /[\x00-\x1f\x7f]/u.test(r.reason)
    || Array.from(r.reason).some(c => { const n = c.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; })) bad();
  return { schemaVersion: PRODUCTION_INPUT_SCHEMA_VERSION, id: id(r.id), workspaceId: r.workspaceId, projectId: id(r.projectId),
    episodeId: id(r.episodeId), baseProjectRevision: r.baseProjectRevision, state, shots,
    script: ref(r.script), plan: ref(r.plan), storyboard: ref(r.storyboard), assetPacks: refs(r.assetPacks), directorScenes: refs(r.directorScenes),
    controls: refs(r.controls), methodPacks: refs(r.methodPacks), promptPacks: refs(r.promptPacks),
    modelConnections: list(r.modelConnections, 4, value => {
      const m = object(value, ['role', 'connection', 'capability']);
      return { role: choice(m.role, ['breakdown', 'general', 'image', 'video'] as const), connection: ref(m.connection), capability: ref(m.capability) };
    }, m => m.role), retrievalPolicy: ref(r.retrievalPolicy), qualityGates: refs(r.qualityGates),
    budgetPolicy: { version: ref(budget.version), limitMicros: budget.limitMicros as number, currency: budget.currency, allowPaid: budget.allowPaid },
    candidatePolicy: { mode, limit: policy.limit as number }, automationMode: choice(r.automationMode, ['auto', 'checkpoints', 'coDirector'] as const),
    findings, createdBy: id(r.createdBy), createdAt: r.createdAt, reason: r.reason, snapshotDigest: sealed ? digest(r.snapshotDigest) : '0'.repeat(64) };
}
/** Structural only: a ready flag is not an authorization or validation certificate. */
export function parseProductionInputSnapshot(value: unknown): ProductionInputSnapshot {
  try { return parse(value, true); } catch { return bad(); }
}
export function parseProductionInputSnapshotDraft(value: unknown): ProductionInputSnapshotDraft {
  try { const { snapshotDigest: _, ...draft } = parse(value, false); return draft; } catch { return bad(); }
}
