/** Browser-safe public DTO/parser. No database, model, filesystem or hashing dependency. */
export const SHOT_SPEC_SCHEMA_VERSION = 'lyra-shot-spec/2' as const;
export interface InputVersionRef { id: string; versionId: string; digest: string }
export interface ShotSourceRef { scriptVersionId: string; start: number; end: number; quote: string }
export interface ShotDialogue { id: string; speakerEntityId: string | null; text: string; tone: string | null; sourceRef: ShotSourceRef }
export interface ShotAction { id: string; origin: 'source' | 'user' | 'design'; text: string; sourceRefs: ShotSourceRef[] }
export interface ShotAssetPack {
  entityId: string; kind: 'character' | 'location' | 'prop'; pack: InputVersionRef;
  media: Array<{ role: string; objectId: string; objectVersionId: string; checksum: string }>;
}
export type ShotControlKind = 'first_frame' | 'last_frame' | 'pose' | 'depth' | 'mask' | 'edge' | 'director_scene';
export interface ShotControl {
  kind: ShotControlKind; artifact: InputVersionRef;
  /** Private object metadata ID, never a signed URL or local path. Scene JSON may live in PostgreSQL. */
  objectId: string | null;
  timeMs: number | null;
}
export interface ShotContinuityState { entityId: string; field: string; value: string }
export interface ShotTimelineCue {
  id: string; kind: 'dialogue' | 'sfx' | 'music' | 'subtitle'; startMs: number; endMs: number;
  dialogueId: string | null; entityId: string | null; text: string; asset: InputVersionRef | null;
}
export interface ShotSpecV2 {
  schemaVersion: typeof SHOT_SPEC_SCHEMA_VERSION;
  revisionId: string; workspaceId: string; projectId: string; episodeId: string; scriptVersionId: string;
  planRevisionId: string; storyboardRevisionId: string; shotId: string; sceneId: string; order: number;
  durationMs: number; ratio: '9:16' | '16:9'; shotSize: string;
  /** null means unknown, not a validated camera/3D control. */
  camera: { description: string | null; movement: string; focalLengthMm: number | null; composition: string | null };
  dialogue: ShotDialogue[]; actions: ShotAction[]; assetPacks: ShotAssetPack[]; controls: ShotControl[];
  visualStyle: string; negativeConstraints: string[];
  continuity: { before: ShotContinuityState[]; after: ShotContinuityState[] };
  timeline: ShotTimelineCue[];
  generation: { methodPackRevisions: InputVersionRef[]; promptPackRevision: InputVersionRef;
    modelCapabilityRevision: InputVersionRef; candidatePolicy: { mode: 'direct' | 'gacha'; limit: number } };
  sourceRefs: ShotSourceRef[];
  source: { kind: 'user' | 'generated' | 'migration'; actor: string; sourceRevisionId: string | null };
  createdAt: string;
  /** Canonical production content only; immutable version identity/audit metadata are stored separately. */
  contentDigest: string;
}
export type ShotSpecV2Draft = Omit<ShotSpecV2, 'contentDigest'>;
export class ShotSpecError extends Error {
  readonly status = 400;
  readonly code = 'SHOT_SPEC_INVALID';
  constructor() { super('镜头输入契约无效。'); this.name = 'ShotSpecError'; }
}
function invalid(): never { throw new ShotSpecError(); }

// Bound/copy before inspecting fields: do not invoke getters, toJSON or code
// hidden in active objects; errors (including Proxy traps) never expose input.
function inertCopy(value: unknown): unknown {
  let nodes = 0, chars = 0;
  const active = new Set<object>();
  function copy(v: unknown, depth: number): unknown {
    if (++nodes > 50_000 || depth > 24) invalid();
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') { chars += v.length; if (chars > 1_000_000) invalid(); return v; }
    if (typeof v === 'number') { if (!Number.isFinite(v)) invalid(); return v; }
    if (!v || typeof v !== 'object' || active.has(v)) invalid();
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid();
    const arrayLength = array ? Object.getOwnPropertyDescriptor(v, 'length')?.value as unknown : null;
    if (array && (!Number.isSafeInteger(arrayLength) || Number(arrayLength) < 0 || Number(arrayLength) > 50_000)) invalid();
    active.add(v);
    const out: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    const keys = Reflect.ownKeys(v);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor', 'toJSON'].includes(key)) invalid();
      chars += key.length; if (chars > 1_000_000) invalid();
      const property = Object.getOwnPropertyDescriptor(v, key);
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) invalid();
      if (array) {
        if (key !== String((out as unknown[]).length)) invalid();
        (out as unknown[]).push(copy(property.value, depth + 1));
      } else (out as Record<string, unknown>)[key] = copy(property.value, depth + 1);
    }
    if (array && (out as unknown[]).length !== arrayLength) invalid();
    active.delete(v); return out;
  }
  return copy(value, 0);
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== fields.length || fields.some(key => !Object.hasOwn(r, key))) invalid();
  return r;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(); return value;
}
function text(value: unknown, max: number, blank = false): string {
  if (typeof value !== 'string' || value.length > max || (!blank && !value.trim())
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)
    || Array.from(value).some(c => { const n = c.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; })) invalid();
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || /[\r\n]/u.test(value) || !/^[A-Za-z][A-Za-z0-9_.:-]*$/u.test(value)) invalid();
  return value;
}
function nullableId(value: unknown): string | null { return value === null ? null : id(value); }
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid(); return value as number;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/u.test(value)) invalid(); return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) invalid(); return value as T;
}
function unique<T>(values: T[], key: (value: T) => string): T[] {
  if (new Set(values.map(key)).size !== values.length) invalid(); return values;
}
function versionRef(value: unknown): InputVersionRef {
  const v = object(value, ['id', 'versionId', 'digest']);
  return { id: id(v.id), versionId: id(v.versionId), digest: digest(v.digest) };
}
function sourceRef(value: unknown, scriptVersionId: string): ShotSourceRef {
  const r = object(value, ['scriptVersionId', 'start', 'end', 'quote']);
  const start = integer(r.start, 0, 100_000_000), end = integer(r.end, start + 1, 100_000_000);
  const quote = text(r.quote, 200_000);
  if (r.scriptVersionId !== scriptVersionId || Array.from(quote).length !== end - start) invalid();
  return { scriptVersionId, start, end, quote };
}
function parse(value: unknown, sealed: boolean): ShotSpecV2 {
  const fields = ['schemaVersion', 'revisionId', 'workspaceId', 'projectId', 'episodeId', 'scriptVersionId', 'planRevisionId',
    'storyboardRevisionId', 'shotId', 'sceneId', 'order', 'durationMs', 'ratio', 'shotSize', 'camera', 'dialogue',
    'actions', 'assetPacks', 'controls', 'visualStyle', 'negativeConstraints', 'continuity', 'timeline', 'generation', 'sourceRefs', 'source', 'createdAt'];
  const r = object(inertCopy(value), sealed ? [...fields, 'contentDigest'] : fields);
  if (r.schemaVersion !== SHOT_SPEC_SCHEMA_VERSION || typeof r.workspaceId !== 'string'
    || r.workspaceId.length !== 35 || !/^ws_[a-f0-9]{32}$/u.test(r.workspaceId)) invalid();
  const scriptVersionId = id(r.scriptVersionId), durationMs = integer(r.durationMs, 100, 60_000);
  const camera = object(r.camera, ['description', 'movement', 'focalLengthMm', 'composition']);
  if (camera.focalLengthMm !== null && (typeof camera.focalLengthMm !== 'number' || camera.focalLengthMm <= 0 || camera.focalLengthMm > 2000)) invalid();
  const dialogue = unique(array(r.dialogue, 200).map(value => {
    const d = object(value, ['id', 'speakerEntityId', 'text', 'tone', 'sourceRef']);
    const ref = sourceRef(d.sourceRef, scriptVersionId), valueText = text(d.text, 200_000);
    if (valueText !== ref.quote) invalid();
    return { id: id(d.id), speakerEntityId: nullableId(d.speakerEntityId), text: valueText,
      tone: d.tone === null ? null : text(d.tone, 1000), sourceRef: ref };
  }), d => d.id);
  const actions = unique(array(r.actions, 200).map(value => {
    const a = object(value, ['id', 'origin', 'text', 'sourceRefs']);
    const refs = array(a.sourceRefs, 200).map(ref => sourceRef(ref, scriptVersionId));
    const origin = choice(a.origin, ['source', 'user', 'design'] as const), valueText = text(a.text, 20_000);
    if (origin === 'source' && (refs.length !== 1 || refs[0]!.quote !== valueText)) invalid();
    return { id: id(a.id), origin, text: valueText, sourceRefs: refs };
  }), a => a.id);
  const assetPacks = unique(array(r.assetPacks, 1000).map(value => {
    const a = object(value, ['entityId', 'kind', 'pack', 'media']);
    const media = unique(array(a.media, 100).map(item => {
      const m = object(item, ['role', 'objectId', 'objectVersionId', 'checksum']);
      return { role: id(m.role), objectId: id(m.objectId), objectVersionId: id(m.objectVersionId), checksum: digest(m.checksum) };
    }), m => m.role);
    return { entityId: id(a.entityId), kind: choice(a.kind, ['character', 'location', 'prop'] as const), pack: versionRef(a.pack), media };
  }), a => a.entityId);
  const controls = unique(array(r.controls, 200).map(value => {
    const c = object(value, ['kind', 'artifact', 'objectId', 'timeMs']);
    const kind = choice(c.kind, ['first_frame', 'last_frame', 'pose', 'depth', 'mask', 'edge', 'director_scene'] as const);
    const objectId = nullableId(c.objectId), timeMs = c.timeMs === null ? null : integer(c.timeMs, 0, durationMs);
    if (kind !== 'director_scene' && objectId === null
      || kind === 'director_scene' && timeMs !== null
      || kind === 'first_frame' && timeMs !== 0
      || kind === 'last_frame' && timeMs !== durationMs) invalid();
    return { kind, artifact: versionRef(c.artifact), objectId, timeMs };
  }), c => JSON.stringify([c.kind, c.timeMs]));
  const state = (value: unknown): ShotContinuityState[] => unique(array(value, 1000).map(item => {
    const s = object(item, ['entityId', 'field', 'value']);
    return { entityId: id(s.entityId), field: id(s.field), value: text(s.value, 4000) };
  }), s => JSON.stringify([s.entityId, s.field]));
  const continuity = object(r.continuity, ['before', 'after']);
  const timeline = unique(array(r.timeline, 2000).map(value => {
    const c = object(value, ['id', 'kind', 'startMs', 'endMs', 'dialogueId', 'entityId', 'text', 'asset']);
    const startMs = integer(c.startMs, 0, durationMs - 1), endMs = integer(c.endMs, startMs + 1, durationMs);
    const kind = choice(c.kind, ['dialogue', 'sfx', 'music', 'subtitle'] as const);
    const dialogueId = nullableId(c.dialogueId), entityId = nullableId(c.entityId);
    const line = dialogue.find(d => d.id === dialogueId);
    if (dialogueId !== null && !line || kind === 'dialogue' && !line
      || (kind === 'sfx' || kind === 'music') && dialogueId !== null
      || kind === 'dialogue' && line?.speakerEntityId !== entityId) invalid();
    return { id: id(c.id), kind, startMs, endMs, dialogueId, entityId,
      text: text(c.text, 20_000, true), asset: c.asset === null ? null : versionRef(c.asset) };
  }), c => c.id);
  const source = object(r.source, ['kind', 'actor', 'sourceRevisionId']);
  const generation = object(r.generation, ['methodPackRevisions', 'promptPackRevision', 'modelCapabilityRevision', 'candidatePolicy']);
  const policy = object(generation.candidatePolicy, ['mode', 'limit']);
  const mode = choice(policy.mode, ['direct', 'gacha'] as const), limit = integer(policy.limit, 1, 4);
  if (mode === 'direct' ? limit !== 1 : limit < 2) invalid();
  const createdAt = text(r.createdAt, 24);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(createdAt)
    || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) invalid();
  return { schemaVersion: SHOT_SPEC_SCHEMA_VERSION, revisionId: id(r.revisionId), workspaceId: r.workspaceId,
    projectId: id(r.projectId), episodeId: id(r.episodeId), scriptVersionId, planRevisionId: id(r.planRevisionId), storyboardRevisionId: id(r.storyboardRevisionId),
    shotId: id(r.shotId), sceneId: id(r.sceneId), order: integer(r.order, 1, 2000), durationMs,
    ratio: choice(r.ratio, ['9:16', '16:9'] as const), shotSize: text(r.shotSize, 100),
    camera: { description: camera.description === null ? null : text(camera.description, 2000), movement: text(camera.movement, 200),
      focalLengthMm: camera.focalLengthMm as number | null, composition: camera.composition === null ? null : text(camera.composition, 2000) },
    dialogue, actions, assetPacks, controls, visualStyle: text(r.visualStyle, 1000),
    negativeConstraints: unique(array(r.negativeConstraints, 100).map(v => text(v, 2000)), v => v),
    continuity: { before: state(continuity.before), after: state(continuity.after) }, timeline,
    generation: { methodPackRevisions: unique(array(generation.methodPackRevisions, 100).map(versionRef), r => r.id),
      promptPackRevision: versionRef(generation.promptPackRevision), modelCapabilityRevision: versionRef(generation.modelCapabilityRevision), candidatePolicy: { mode, limit } },
    sourceRefs: array(r.sourceRefs, 200).map(ref => sourceRef(ref, scriptVersionId)),
    source: { kind: choice(source.kind, ['user', 'generated', 'migration'] as const), actor: id(source.actor), sourceRevisionId: nullableId(source.sourceRevisionId) },
    createdAt, contentDigest: sealed ? digest(r.contentDigest) : '0'.repeat(64) };
}
/** Shape validation only. Main must verify digest and authorize every referenced immutable version. */
export function parseShotSpecV2(value: unknown): ShotSpecV2 {
  try { return parse(value, true); } catch { return invalid(); }
}
export function parseShotSpecV2Draft(value: unknown): ShotSpecV2Draft {
  try { const { contentDigest: _digest, ...draft } = parse(value, false); return draft; } catch { return invalid(); }
}
