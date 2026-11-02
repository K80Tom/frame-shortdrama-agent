import { createHash } from 'node:crypto';
import type { NovelEvidence, NovelRevision, NovelSource } from './novel-domain';
import type { EntityType } from './novel-analysis';

export interface EntityRegistryEntry {
  id: string; kind: 'character' | 'location' | 'prop'; entityType: EntityType | null;
  name: string; aliases: string[];
  occurrences: { chapterId: string; revisionId: string; itemId: string; confirmed: boolean; sourceRefs: NovelEvidence[] }[];
}
export function canonicalId(sourceId: string, chapterId: string, itemId: string): string {
  return `entity_${createHash('sha256').update(JSON.stringify([sourceId, chapterId, itemId])).digest('hex').slice(0, 32)}`;
}

export type EntityMergeRelation = 'shared-name' | 'shared-alias' | 'duplicate-chapter';
export interface EntityMergeEvidence {
  chapterId: string; revisionId: string; itemId: string; quote: string;
}
/** A review hint only. Nothing here writes a canonical id or merges entries. */
export interface EntityMergeCandidate {
  id: string;
  relation: EntityMergeRelation;
  kind: EntityRegistryEntry['kind'];
  entityIds: string[];
  names: string[];
  sharedTerms: string[];
  evidence: EntityMergeEvidence[];
}

/** A derived, version-bound registry. No cross-chapter writes or name-only auto-merges. */
export function buildEntityRegistry(source: NovelSource, revisions: NovelRevision[]): EntityRegistryEntry[] {
  const chapterIds = new Set(source.chapters.map(chapter => chapter.id));
  const entries = new Map<string, EntityRegistryEntry>();
  for (const revision of revisions) {
    if (!chapterIds.has(revision.chapterId)) continue;
    for (const item of revision.content.items) {
      if (item.kind === 'dialogue') continue;
      const id = item.canonicalEntityId ?? canonicalId(source.id, revision.chapterId, item.id);
      const entityType = item.entityType ?? null;
      const old = entries.get(id);
      // Incompatible model identity proposals never contaminate an existing entry.
      if (old && (old.kind !== item.kind || (old.entityType && entityType && old.entityType !== entityType))) continue;
      const entry = old ?? { id, kind: item.kind, entityType, name: item.label, aliases: [], occurrences: [] };
      entry.entityType ??= entityType;
      entry.aliases = [...new Set([...entry.aliases, item.label, ...(item.aliases ?? [])])];
      entry.occurrences.push({ chapterId: revision.chapterId, revisionId: revision.id, itemId: item.id,
        confirmed: item.review === 'confirmed' && !item.uncertainty, sourceRefs: structuredClone(item.sourceRefs) });
      entries.set(id, entry);
    }
  }
  return [...entries.values()];
}

function normalizeEntityLabel(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s·•・　]+/gu, '');
}

function entityTerms(entry: EntityRegistryEntry): Set<string> {
  return new Set([entry.name, ...entry.aliases].map(normalizeEntityLabel).filter(term => term.length > 0));
}

function evidenceQuote(quote: string): string {
  const points = [...quote];
  return points.length <= 80 ? quote : `${points.slice(0, 79).join('')}…`;
}

function occurrenceEvidence(occurrence: EntityRegistryEntry['occurrences'][number]): EntityMergeEvidence {
  return { chapterId: occurrence.chapterId, revisionId: occurrence.revisionId, itemId: occurrence.itemId,
    quote: evidenceQuote(occurrence.sourceRefs[0]?.quote ?? '') };
}

/**
 * Same names and alias overlaps stay separate entries. This only lists the
 * pairs a person should accept or reject, plus repeated items that already
 * share one identity inside a single chapter.
 */
export function proposeEntityMergeCandidates(entries: readonly EntityRegistryEntry[]): EntityMergeCandidate[] {
  const candidates: EntityMergeCandidate[] = [];
  for (const entry of entries) {
    const byChapter = new Map<string, EntityRegistryEntry['occurrences']>();
    for (const occurrence of entry.occurrences) {
      const list = byChapter.get(occurrence.chapterId) ?? [];
      list.push(occurrence);
      byChapter.set(occurrence.chapterId, list);
    }
    for (const [chapterId, occurrences] of byChapter) {
      if (occurrences.length < 2) continue;
      candidates.push({
        id: `duplicate-chapter:${entry.id}:${chapterId}`,
        relation: 'duplicate-chapter',
        kind: entry.kind,
        entityIds: [entry.id],
        names: [entry.name],
        sharedTerms: [...entityTerms(entry)].sort((left, right) => left.localeCompare(right)),
        evidence: occurrences.map(occurrenceEvidence),
      });
    }
  }
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex]!;
      const right = entries[rightIndex]!;
      if (left.kind !== right.kind) continue;
      if (left.entityType && right.entityType && left.entityType !== right.entityType) continue;
      const shared = [...entityTerms(left)].filter(term => entityTerms(right).has(term))
        .sort((a, b) => a.localeCompare(b));
      if (shared.length === 0) continue;
      const ordered = [left, right].sort((a, b) => a.id.localeCompare(b.id));
      const namesEqual = normalizeEntityLabel(left.name).length > 0
        && normalizeEntityLabel(left.name) === normalizeEntityLabel(right.name);
      candidates.push({
        id: `${namesEqual ? 'shared-name' : 'shared-alias'}:${ordered[0]!.id}:${ordered[1]!.id}`,
        relation: namesEqual ? 'shared-name' : 'shared-alias',
        kind: left.kind,
        entityIds: [ordered[0]!.id, ordered[1]!.id],
        names: [ordered[0]!.name, ordered[1]!.name],
        sharedTerms: shared,
        evidence: [ordered[0]!, ordered[1]!].flatMap(entry => entry.occurrences.slice(0, 1).map(occurrenceEvidence)),
      });
    }
  }
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}
