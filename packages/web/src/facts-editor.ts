export type SourceRef = { scriptVersionId: string; quote: string; start: number; end: number };
export type FactValue = { value: string; origin: 'source' | 'user' | 'design'; sourceRefs: SourceRef[]; answerIds: string[] };
export type FactEntity = { id: string; name: FactValue; aliases: FactValue[]; description: FactValue | null; sourceRefs: SourceRef[] };
export type EntityKind = 'character' | 'location' | 'prop';
export type EntityFields = { characters: FactEntity[]; locations: FactEntity[]; props: FactEntity[] };
export type EntityDraft = { name: string; aliases: string; description: string };
export type EntityDrafts = Record<string, EntityDraft>;
export type EntityEdit = { kind: EntityKind; entityId: string; name: string; aliases: string[]; description: string | null };
export type FactPlan = {
  id: string; projectId: string; scriptVersionId: string; runId: string; parentRevisionId: string | null;
  createdAt: string; createdBy: 'agent' | 'user'; reason: 'extract' | 'manualEdit';
  content: EntityFields & {
    synopsis: FactValue | null;
    scenes: Array<{ id: string; order: number; title: FactValue; sourceRefs: SourceRef[] }>;
    dialogues: Array<{ id: string; sceneId: string; speakerId: string | null; sourceRef: SourceRef }>;
    manualLocks: Array<{ targetType: string; targetId: string | null; fields: string[]; introducedInRevisionId: string }>;
  };
};

export const entityGroups = [
  { kind: 'character', key: 'characters', label: '人物', hint: '角色身份与人物说明' },
  { kind: 'location', key: 'locations', label: '场景 / 地点', hint: '故事发生的空间；不同于下方场次' },
  { kind: 'prop', key: 'props', label: '道具', hint: '剧情中出现或使用的物件' },
] as const;

export function entityDraftKey(kind: EntityKind, entityId: string): string {
  return `${kind}:${entityId}`;
}

export function draftForEntity(entity: FactEntity): EntityDraft {
  return { name: entity.name.value, aliases: entity.aliases.map(alias => alias.value).join('\n'), description: entity.description?.value ?? '' };
}

export function createEntityDrafts(content: EntityFields): EntityDrafts {
  return Object.fromEntries(entityGroups.flatMap(group => content[group.key].map(entity => [entityDraftKey(group.kind, entity.id), draftForEntity(entity)])));
}

export function parseAliases(value: string): string[] {
  return value.split(/\r?\n/u).map(alias => alias.trim()).filter(Boolean);
}

export function changedEntityFields(entity: FactEntity, draft: EntityDraft): Array<'name' | 'aliases' | 'description'> {
  const fields: Array<'name' | 'aliases' | 'description'> = [];
  const original = draftForEntity(entity);
  if (draft.name !== original.name && draft.name.trim() !== entity.name.value) fields.push('name');
  if (draft.aliases !== original.aliases && JSON.stringify(parseAliases(draft.aliases)) !== JSON.stringify(entity.aliases.map(alias => alias.value))) fields.push('aliases');
  if (draft.description !== original.description && (draft.description.trim() || null) !== (entity.description?.value ?? null)) fields.push('description');
  return fields;
}

export function buildEntityEdits(content: EntityFields, drafts: EntityDrafts): EntityEdit[] {
  return entityGroups.flatMap(group => content[group.key].flatMap(entity => {
    const draft = drafts[entityDraftKey(group.kind, entity.id)];
    if (!draft) return [];
    const changed = changedEntityFields(entity, draft);
    if (!changed.length) return [];
    return [{ kind: group.kind, entityId: entity.id,
      name: changed.includes('name') ? draft.name.trim() : entity.name.value,
      aliases: changed.includes('aliases') ? parseAliases(draft.aliases) : entity.aliases.map(alias => alias.value),
      description: changed.includes('description') ? draft.description.trim() || null : entity.description?.value ?? null }];
  }));
}

export function validateEntityDrafts(content: EntityFields, drafts: EntityDrafts): string[] {
  const errors: string[] = [];
  for (const group of entityGroups) {
    const names = new Set<string>();
    for (const entity of content[group.key]) {
      const draft = drafts[entityDraftKey(group.kind, entity.id)] ?? draftForEntity(entity);
      const name = draft.name.trim();
      const aliases = parseAliases(draft.aliases);
      if (!name) errors.push(`${group.label}「${entity.name.value}」的名称不能为空。`);
      if (name && names.has(name)) errors.push(`${group.label}名称「${name}」重复，请保留能区分身份的名称。`);
      names.add(name);
      if (new Set(aliases).size !== aliases.length) errors.push(`「${name || entity.name.value}」存在重复别名。`);
      if (aliases.length > 128) errors.push(`「${name || entity.name.value}」最多填写 128 个别名。`);
      if ([name, ...aliases, draft.description].some(value => Array.from(value).length > 20_000)) errors.push(`「${name || entity.name.value}」的单个字段不能超过 20,000 字。`);
    }
  }
  return errors;
}

export function entityEvidence(entity: FactEntity): Array<{ ref: SourceRef; labels: string[] }> {
  const entries = new Map<string, { ref: SourceRef; labels: string[] }>();
  const add = (refs: SourceRef[], label: string) => refs.forEach(ref => {
    const key = `${ref.scriptVersionId}:${ref.start}:${ref.end}`;
    const entry = entries.get(key);
    if (entry) { if (!entry.labels.includes(label)) entry.labels.push(label); }
    else entries.set(key, { ref, labels: [label] });
  });
  add(entity.sourceRefs, '实体依据');
  add(entity.name.sourceRefs, '名称');
  entity.aliases.forEach(alias => add(alias.sourceRefs, `别名「${alias.value}」`));
  if (entity.description) add(entity.description.sourceRefs, '说明');
  return [...entries.values()].sort((left, right) => left.ref.start - right.ref.start || left.ref.end - right.ref.end);
}

export function latestPlanForScript(plans: FactPlan[], scriptVersionId: string | null): FactPlan | null {
  return plans.filter(item => item.scriptVersionId === scriptVersionId).at(-1) ?? null;
}
