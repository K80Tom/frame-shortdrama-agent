import Ajv from "ajv";
import { Type, type Static } from "@sinclair/typebox";
import type { BreakdownRequirements } from "./contracts";
import { BreakdownError } from "./errors";
import { sliceCodePoints, type SourceRef } from "./source-index";

export const PLAN_CONTENT_SCHEMA_VERSION = "breakdown-plan-content/1";
export const PLAN_VALIDATOR_VERSION = "extract-facts-validator/1";
export const ENTITY_EDIT_VALIDATOR_VERSION = "entity-edit-validator/1";

const OpaqueId = Type.String({ minLength: 3, maxLength: 128, pattern: "^[a-z][a-z0-9_-]*$" });
const Nonblank = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const SourceRefSchema = Type.Object({
  scriptVersionId: OpaqueId,
  start: Type.Integer({ minimum: 0 }),
  end: Type.Integer({ minimum: 1 }),
  quote: Nonblank(200_000),
}, { additionalProperties: false });
const SourceRefs = Type.Array(SourceRefSchema, { minItems: 1, maxItems: 1_000 });
const SourcedTextSchema = Type.Object({
  value: Nonblank(20_000),
  origin: Type.Literal("source"),
  sourceRefs: SourceRefs,
  answerIds: Type.Array(OpaqueId, { maxItems: 0 }),
}, { additionalProperties: false });
const CandidateEntitySchema = Type.Object({
  tempId: OpaqueId,
  name: SourcedTextSchema,
  aliases: Type.Array(SourcedTextSchema, { maxItems: 128 }),
  description: Type.Union([Type.Null(), SourcedTextSchema]),
  sourceRefs: SourceRefs,
}, { additionalProperties: false });
const CandidateSceneSchema = Type.Object({
  tempId: OpaqueId,
  order: Type.Integer({ minimum: 1, maximum: 100_000 }),
  title: SourcedTextSchema,
  locationTempId: Type.Union([Type.Null(), OpaqueId]),
  characterTempIds: Type.Array(OpaqueId, { maxItems: 1_000, uniqueItems: true }),
  sourceRefs: SourceRefs,
  timeOfDay: Type.Union([Type.Null(), SourcedTextSchema]),
}, { additionalProperties: false });
const CandidateDialogueSchema = Type.Object({
  tempId: OpaqueId,
  sceneTempId: OpaqueId,
  speakerTempId: Type.Union([Type.Null(), OpaqueId]),
  speakerSourceRefs: Type.Array(SourceRefSchema, { maxItems: 1_000 }),
  speakerAnswerIds: Type.Array(OpaqueId, { maxItems: 0 }),
  sourceRef: SourceRefSchema,
}, { additionalProperties: false });

export const CreateExtractFactsCandidateSchema = Type.Object({
  synopsis: Type.Union([Type.Null(), SourcedTextSchema]),
  characters: Type.Array(CandidateEntitySchema, { maxItems: 2_000 }),
  locations: Type.Array(CandidateEntitySchema, { maxItems: 2_000 }),
  props: Type.Array(CandidateEntitySchema, { maxItems: 2_000 }),
  scenes: Type.Array(CandidateSceneSchema, { maxItems: 2_000 }),
  dialogues: Type.Array(CandidateDialogueSchema, { maxItems: 20_000 }),
}, { additionalProperties: false });

export type CreateExtractFactsCandidateRequest = Static<typeof CreateExtractFactsCandidateSchema>;
export type SourcedText = Static<typeof SourcedTextSchema>;

const PlanTextSchema = Type.Object({ ...SourcedTextSchema.properties,
  origin: Type.Union([Type.Literal("source"), Type.Literal("user")]),
}, { additionalProperties: false });
const PlanEntitySchema = Type.Object({
  id: OpaqueId, name: PlanTextSchema,
  aliases: Type.Array(PlanTextSchema, { maxItems: 128 }),
  description: Type.Union([Type.Null(), PlanTextSchema]), sourceRefs: SourceRefs,
}, { additionalProperties: false });
const EntityFieldSchema = Type.Union([Type.Literal("name"), Type.Literal("aliases"), Type.Literal("description")]);
const EntityManualLockSchema = Type.Object({
  targetType: Type.Literal("entity"), targetId: OpaqueId,
  fields: Type.Array(EntityFieldSchema, { minItems: 1, maxItems: 3, uniqueItems: true }),
  introducedInRevisionId: OpaqueId,
}, { additionalProperties: false });
export type PlanText = Static<typeof PlanTextSchema>;
export type PlanEntity = Static<typeof PlanEntitySchema>;
export type EntityManualLock = Static<typeof EntityManualLockSchema>;
export interface PlanScene extends Omit<Static<typeof CandidateSceneSchema>, "tempId" | "locationTempId" | "characterTempIds"> {
  id: string;
  locationId: string | null;
  characterIds: string[];
  shots: [];
}
export interface PlanDialogue extends Omit<Static<typeof CandidateDialogueSchema>, "tempId" | "sceneTempId" | "speakerTempId"> {
  id: string;
  sceneId: string;
  speakerId: string | null;
}
export interface ExtractFactsPlanContent {
  schemaVersion: typeof PLAN_CONTENT_SCHEMA_VERSION;
  synopsis: SourcedText | null;
  characters: PlanEntity[];
  locations: PlanEntity[];
  props: PlanEntity[];
  dialogues: PlanDialogue[];
  scenes: PlanScene[];
  assetRequirements: [];
  manualLocks: EntityManualLock[];
}

export interface PlanRevisionRecord {
  id: string;
  projectId: string;
  scriptVersionId: string;
  runId: string;
  sourceTaskId: string;
  /** Null for a manually submitted P0.3 candidate; set for a recorded stage execution. */
  attemptId: string | null;
  parentRevisionId: string | null;
  rebasedFromRevisionId: null;
  createdAt: string;
  createdBy: "agent" | "user";
  reason: "extract" | "manualEdit";
  scope: { kind: "project"; targetId: null };
  requirements: BreakdownRequirements;
  content: ExtractFactsPlanContent;
  status: "candidate";
  validatorVersion: typeof PLAN_VALIDATOR_VERSION | typeof ENTITY_EDIT_VALIDATOR_VERSION;
}

interface ScriptForPlanValidation { id: string; rawText: string }

const EntityEditSchema = Type.Object({
  kind: Type.Union([Type.Literal("character"), Type.Literal("location"), Type.Literal("prop")]),
  entityId: OpaqueId, name: Nonblank(20_000),
  aliases: Type.Array(Nonblank(20_000), { maxItems: 128 }),
  description: Type.Union([Type.Null(), Nonblank(20_000)]),
}, { additionalProperties: false });
export const CreateEntityEditsSchema = Type.Object({
  expectedActivePlanRevisionId: Type.Union([Type.Null(), OpaqueId]),
  edits: Type.Array(EntityEditSchema, { minItems: 1, maxItems: 6_000 }),
}, { additionalProperties: false });
export type CreateEntityEditsRequest = Static<typeof CreateEntityEditsSchema>;

const StoredContentSchema = Type.Object({
  schemaVersion: Type.Literal(PLAN_CONTENT_SCHEMA_VERSION),
  synopsis: Type.Union([Type.Null(), SourcedTextSchema]),
  characters: Type.Array(PlanEntitySchema, { maxItems: 2_000 }),
  locations: Type.Array(PlanEntitySchema, { maxItems: 2_000 }),
  props: Type.Array(PlanEntitySchema, { maxItems: 2_000 }),
  scenes: Type.Array(Type.Object({
    ...Type.Omit(CandidateSceneSchema, ["tempId", "locationTempId", "characterTempIds"]).properties,
    id: OpaqueId, locationId: Type.Union([Type.Null(), OpaqueId]),
    characterIds: Type.Array(OpaqueId, { maxItems: 1_000, uniqueItems: true }),
    shots: Type.Array(Type.Unknown(), { maxItems: 0 }),
  }, { additionalProperties: false }), { maxItems: 2_000 }),
  dialogues: Type.Array(Type.Object({
    ...Type.Omit(CandidateDialogueSchema, ["tempId", "sceneTempId", "speakerTempId"]).properties,
    id: OpaqueId, sceneId: OpaqueId, speakerId: Type.Union([Type.Null(), OpaqueId]),
  }, { additionalProperties: false }), { maxItems: 20_000 }),
  assetRequirements: Type.Array(Type.Unknown(), { maxItems: 0 }),
  manualLocks: Type.Array(EntityManualLockSchema, { maxItems: 18_000 }),
}, { additionalProperties: false });
const ajv = new Ajv({ allErrors: false });
const validateRequest = ajv.compile<CreateExtractFactsCandidateRequest>(CreateExtractFactsCandidateSchema);
const validateEntityEdits = ajv.compile<CreateEntityEditsRequest>(CreateEntityEditsSchema);
const validateStoredContent = ajv.compile<ExtractFactsPlanContent>(StoredContentSchema);

export function parseCreateEntityEdits(value: unknown): CreateEntityEditsRequest {
  if (!validateEntityEdits(value)) {
    throw new BreakdownError(400, "INVALID_ENTITY_EDITS_REQUEST", "实体校对请求不符合约定，请检查名称、别名和说明。");
  }
  return structuredClone(value);
}

/** A local user correction, never a model call or an in-place rewrite. */
export function materializeEntityEdits(base: ExtractFactsPlanContent, edits: CreateEntityEditsRequest["edits"], context: {
  script: ScriptForPlanValidation; revisionId: string;
}): ExtractFactsPlanContent {
  parseCreateEntityEdits({ expectedActivePlanRevisionId: null, edits });
  validateStoredPlanContent(base, context.script);
  const content = structuredClone(base);
  const groups = { character: content.characters, location: content.locations, prop: content.props };
  const seen = new Set<string>();
  let changed = false;
  for (const edit of edits) {
    if (seen.has(edit.entityId)) invalid("同一实体不能在一次校对中重复提交。");
    seen.add(edit.entityId);
    const entity = groups[edit.kind].find((entry) => entry.id === edit.entityId);
    if (!entity) invalid("要校对的实体不存在或类型不匹配。");
    const fields: EntityManualLock["fields"] = [];
    const name = edit.name === entity.name.value ? edit.name : edit.name.trim();
    const aliases = edit.aliases.map((alias) => entity.aliases.some((existing) => existing.value === alias) ? alias : alias.trim());
    const description = edit.description === (entity.description?.value ?? null)
      ? edit.description : edit.description?.trim() ?? null;
    if (new Set(aliases).size !== aliases.length) invalid("别名不能重复。");
    const userText = (value: string, previous?: PlanText | null): PlanText => ({
      value, origin: "user", sourceRefs: cloneRefs(previous?.sourceRefs ?? entity.sourceRefs), answerIds: [],
    });
    if (name !== entity.name.value) {
      entity.name = userText(name, entity.name);
      fields.push("name");
    }
    if (JSON.stringify(aliases) !== JSON.stringify(entity.aliases.map((alias) => alias.value))) {
      entity.aliases = aliases.map((value) => entity.aliases.find((alias) => alias.value === value) ?? userText(value));
      fields.push("aliases");
    }
    if (description !== (entity.description?.value ?? null)) {
      entity.description = description === null ? null : userText(description, entity.description);
      fields.push("description");
    }
    if (fields.length > 0) {
      changed = true;
      // Retain protection for earlier edits, but give newly edited fields their new revision provenance.
      content.manualLocks = content.manualLocks.flatMap((lock) => {
        if (lock.targetId !== entity.id) return [lock];
        const remaining = lock.fields.filter((field) => !fields.includes(field));
        return remaining.length ? [{ ...lock, fields: remaining }] : [];
      });
      content.manualLocks.push({ targetType: "entity", targetId: entity.id, fields,
        introducedInRevisionId: context.revisionId });
    }
  }
  if (!changed) throw new BreakdownError(422, "ENTITY_EDITS_UNCHANGED", "没有实际修改，无需创建新版本。");
  validateStoredPlanContent(content, context.script);
  return content;
}

export function parseCreateExtractFactsCandidate(value: unknown): CreateExtractFactsCandidateRequest {
  if (!validateRequest(value)) {
    throw new BreakdownError(400, "INVALID_CANDIDATE_PLAN_REQUEST", "候选事实请求不符合约定。");
  }
  return structuredClone(value) as CreateExtractFactsCandidateRequest;
}

export function materializeExtractFactsCandidate(input: CreateExtractFactsCandidateRequest, context: {
  script: ScriptForPlanValidation;
  nextId: (prefix: string) => string;
}): ExtractFactsPlanContent {
  if (!validateRequest(input)) invalid("候选事实结构无效。");
  const tempIds = new Set<string>();
  for (const entry of [...input.characters, ...input.locations, ...input.props, ...input.scenes, ...input.dialogues]) {
    if (tempIds.has(entry.tempId)) invalid("临时 ID 必须在候选内唯一。");
    tempIds.add(entry.tempId);
  }

  const characterIds = allocate(input.characters, "character", context.nextId);
  const locationIds = allocate(input.locations, "location", context.nextId);
  const propIds = allocate(input.props, "prop", context.nextId);
  const sceneIds = allocate(input.scenes, "scene", context.nextId);
  const dialogueIds = allocate(input.dialogues, "dialogue", context.nextId);

  validateSceneOrder(input.scenes.map((scene) => scene.order));
  validateCandidateSourceRefs(input, context.script);

  const scenes = [...input.scenes].sort((left, right) => left.order - right.order).map((scene): PlanScene => {
    const locationId = scene.locationTempId === null ? null : locationIds.get(scene.locationTempId);
    if (scene.locationTempId !== null && !locationId) invalid("场次引用了不存在的地点。");
    const mappedCharacters = scene.characterTempIds.map((tempId) => {
      const id = characterIds.get(tempId);
      if (!id) invalid("场次引用了不存在的人物。");
      return id;
    });
    return {
      id: required(sceneIds.get(scene.tempId)), order: scene.order, title: cloneSourced(scene.title),
      locationId: locationId ?? null, characterIds: mappedCharacters,
      sourceRefs: cloneRefs(scene.sourceRefs), timeOfDay: scene.timeOfDay ? cloneSourced(scene.timeOfDay) : null,
      shots: [],
    };
  });

  const candidateScenes = new Map(input.scenes.map((scene) => [scene.tempId, scene]));
  const dialogues = input.dialogues.map((dialogue): PlanDialogue => {
    const scene = candidateScenes.get(dialogue.sceneTempId);
    const sceneId = sceneIds.get(dialogue.sceneTempId);
    if (!scene || !sceneId) invalid("对白引用了不存在的场次。");
    const speakerId = dialogue.speakerTempId === null ? null : characterIds.get(dialogue.speakerTempId);
    if (dialogue.speakerTempId !== null && !speakerId) invalid("对白引用了不存在的人物。");
    if (dialogue.speakerTempId !== null) {
      if (!scene.characterTempIds.includes(dialogue.speakerTempId)) invalid("对白说话人不在所属场次人物列表中。");
      if (dialogue.speakerSourceRefs.length === 0) invalid("已确认的对白说话人必须有原文依据。");
    } else if (dialogue.speakerSourceRefs.length > 0) {
      invalid("说话人未知时不能保存已确认的说话人依据。");
    }
    if (!scene.sourceRefs.some((ref) => contains(ref, dialogue.sourceRef))) {
      invalid("对白原文必须位于所属场次的原文范围内。");
    }
    return {
      id: required(dialogueIds.get(dialogue.tempId)), sceneId, speakerId: speakerId ?? null,
      speakerSourceRefs: cloneRefs(dialogue.speakerSourceRefs), speakerAnswerIds: [],
      sourceRef: { ...dialogue.sourceRef },
    };
  });
  validateDialogueOrder(dialogues, scenes);

  return {
    schemaVersion: PLAN_CONTENT_SCHEMA_VERSION,
    synopsis: input.synopsis ? cloneSourced(input.synopsis) : null,
    characters: input.characters.map((entity) => materializeEntity(entity, required(characterIds.get(entity.tempId)))),
    locations: input.locations.map((entity) => materializeEntity(entity, required(locationIds.get(entity.tempId)))),
    props: input.props.map((entity) => materializeEntity(entity, required(propIds.get(entity.tempId)))),
    dialogues,
    scenes,
    assetRequirements: [],
    manualLocks: [],
  };
}

export function validateStoredPlanContent(content: ExtractFactsPlanContent, script: ScriptForPlanValidation): void {
  if (!validateStoredContent(content)) invalid("已保存的候选计划结构无效。");
  const ids = new Set<string>();
  for (const item of [...content.characters, ...content.locations, ...content.props, ...content.scenes, ...content.dialogues]) {
    if (ids.has(item.id)) invalid("候选计划稳定 ID 重复。");
    ids.add(item.id);
  }
  const entityIds = new Set([...content.characters, ...content.locations, ...content.props].map((entity) => entity.id));
  const lockedFields = new Set<string>();
  for (const lock of content.manualLocks) {
    if (!entityIds.has(lock.targetId)) invalid("人工保护引用了不存在的实体。");
    for (const field of lock.fields) {
      const key = `${lock.targetId}:${field}`;
      if (lockedFields.has(key)) invalid("同一实体字段的人工保护重复。");
      lockedFields.add(key);
    }
  }
  for (const entity of [...content.characters, ...content.locations, ...content.props]) {
    for (const [field, values] of [["name", [entity.name]], ["aliases", entity.aliases],
      ["description", entity.description ? [entity.description] : []]] as const) {
      if (values.some((value) => value.origin === "user") && !lockedFields.has(`${entity.id}:${field}`)) {
        invalid("人工修改字段缺少保护记录。");
      }
    }
  }
  // Reuse the original reference/relationship rules, without weakening the source-only model contract.
  const sourceEntity = ({ id, ...entry }: PlanEntity): Static<typeof CandidateEntitySchema> => ({
    tempId: id, ...entry,
    name: { ...entry.name, origin: "source" },
    aliases: entry.aliases.map((alias) => ({ ...alias, origin: "source" })),
    description: entry.description ? { ...entry.description, origin: "source" } : null,
  });
  const candidate: CreateExtractFactsCandidateRequest = {
    synopsis: content.synopsis,
    characters: content.characters.map(sourceEntity),
    locations: content.locations.map(sourceEntity),
    props: content.props.map(sourceEntity),
    scenes: content.scenes.map(({ id, locationId, characterIds, shots, ...entry }) => ({
      tempId: id, locationTempId: locationId, characterTempIds: characterIds, ...entry,
    })),
    dialogues: content.dialogues.map(({ id, sceneId, speakerId, ...entry }) => ({
      tempId: id, sceneTempId: sceneId, speakerTempId: speakerId, ...entry,
    })),
  };
  if (!validateRequest(candidate)) invalid("已保存的候选计划结构无效。");
  let ordinal = 0;
  materializeExtractFactsCandidate(candidate, { script, nextId: (_prefix) => `validated_${++ordinal}` });
}

function materializeEntity(entity: Static<typeof CandidateEntitySchema>, id: string): PlanEntity {
  return {
    id, name: cloneSourced(entity.name), aliases: entity.aliases.map(cloneSourced),
    description: entity.description ? cloneSourced(entity.description) : null,
    sourceRefs: cloneRefs(entity.sourceRefs),
  };
}

function validateCandidateSourceRefs(input: CreateExtractFactsCandidateRequest, script: ScriptForPlanValidation): void {
  const refs: SourceRef[] = [];
  const addValue = (value: SourcedText | null) => { if (value) refs.push(...value.sourceRefs); };
  addValue(input.synopsis);
  for (const entity of [...input.characters, ...input.locations, ...input.props]) {
    addValue(entity.name); entity.aliases.forEach(addValue); addValue(entity.description); refs.push(...entity.sourceRefs);
  }
  for (const scene of input.scenes) {
    addValue(scene.title); addValue(scene.timeOfDay); refs.push(...scene.sourceRefs);
  }
  for (const dialogue of input.dialogues) refs.push(dialogue.sourceRef, ...dialogue.speakerSourceRefs);
  for (const ref of refs) {
    if (ref.scriptVersionId !== script.id || ref.end <= ref.start) invalid("原文引用没有绑定当前剧本版本或范围无效。");
    let quote: string;
    try { quote = sliceCodePoints(script.rawText, ref.start, ref.end); }
    catch { invalid("原文引用超出剧本范围。"); }
    if (quote! !== ref.quote) invalid("原文引用的 quote 与 Unicode 码点范围不一致。");
  }
}

function validateSceneOrder(orders: number[]): void {
  const sorted = [...orders].sort((a, b) => a - b);
  if (sorted.some((order, index) => order !== index + 1)) invalid("场次 order 必须从 1 开始且连续唯一。");
}

function validateDialogueOrder(dialogues: PlanDialogue[], scenes: PlanScene[]): void {
  const sceneOrder = new Map(scenes.map((scene) => [scene.id, scene.order]));
  let previous: [number, number] | null = null;
  for (const dialogue of dialogues) {
    const current: [number, number] = [required(sceneOrder.get(dialogue.sceneId)), dialogue.sourceRef.start];
    if (previous && (current[0] < previous[0] || (current[0] === previous[0] && current[1] <= previous[1]))) {
      invalid("对白必须按场次和原文顺序排列，且不能重复起点。");
    }
    previous = current;
  }
}

function allocate<T extends { tempId: string }>(items: T[], prefix: string, nextId: (prefix: string) => string): Map<string, string> {
  return new Map(items.map((item) => [item.tempId, nextId(prefix)]));
}
function cloneSourced(value: SourcedText): SourcedText { return { ...value, sourceRefs: cloneRefs(value.sourceRefs), answerIds: [] }; }
function cloneRefs(refs: SourceRef[]): SourceRef[] { return refs.map((ref) => ({ ...ref })); }
function contains(outer: SourceRef, inner: SourceRef): boolean {
  return outer.scriptVersionId === inner.scriptVersionId && outer.start <= inner.start && outer.end >= inner.end;
}
function required<T>(value: T | undefined): T { if (value === undefined) throw new Error("internal candidate mapping error"); return value; }
function invalid(message: string): never { throw new BreakdownError(422, "CANDIDATE_PLAN_INVALID", message); }
