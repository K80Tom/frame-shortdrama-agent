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
export const MAX_ENTITY_MERGE_CANDIDATES = 500;
export interface EntityMergeCandidateResult {
  candidates: EntityMergeCandidate[];
  truncated: boolean;
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOccurrences(left: EntityRegistryEntry['occurrences'][number],
  right: EntityRegistryEntry['occurrences'][number]): number {
  return compareText(left.chapterId, right.chapterId)
    || compareText(left.revisionId, right.revisionId)
    || compareText(left.itemId, right.itemId);
}

/**
 * Same names and alias overlaps stay separate entries. This only lists the
 * pairs a person should accept or reject, plus repeated items that already
 * share one identity inside a single chapter.
 */
export function proposeEntityMergeCandidates(entries: readonly EntityRegistryEntry[]): EntityMergeCandidateResult {
  const indexed = entries.map(entry => {
    const terms = [...entityTerms(entry)].sort(compareText);
    return { entry, normalizedName: normalizeEntityLabel(entry.name), terms, termSet: new Set(terms) };
  }).sort((left, right) => compareText(left.entry.id, right.entry.id)
    || compareText(left.entry.kind, right.entry.kind)
    || compareText(left.entry.entityType ?? '', right.entry.entityType ?? '')
    || compareText(left.entry.name, right.entry.name));
  const candidates: EntityMergeCandidate[] = [];
  let truncated = false;
  const append = (candidate: EntityMergeCandidate): boolean => {
    if (candidates.length >= MAX_ENTITY_MERGE_CANDIDATES) {
      truncated = true;
      return false;
    }
    candidates.push(candidate);
    return true;
  };

  duplicateCandidates:
  for (const { entry, terms } of indexed) {
    const byChapter = new Map<string, EntityRegistryEntry['occurrences']>();
    for (const occurrence of entry.occurrences) {
      const list = byChapter.get(occurrence.chapterId) ?? [];
      list.push(occurrence);
      byChapter.set(occurrence.chapterId, list);
    }
    for (const chapterId of [...byChapter.keys()].sort(compareText)) {
      const occurrences = byChapter.get(chapterId)!.slice().sort(compareOccurrences);
      if (occurrences.length < 2) continue;
      if (!append({
        id: `duplicate-chapter:${entry.id}:${chapterId}`,
        relation: 'duplicate-chapter',
        kind: entry.kind,
        entityIds: [entry.id],
        names: [entry.name],
        sharedTerms: terms,
        evidence: occurrences.map(occurrenceEvidence),
      })) break duplicateCandidates;
    }
  }

  if (!truncated) {
    const byKindAndTerm = new Map<string, typeof indexed>();
    for (const item of indexed) {
      for (const term of item.terms) {
        const key = JSON.stringify([item.entry.kind, term]);
        const bucket = byKindAndTerm.get(key) ?? [];
        bucket.push(item);
        byKindAndTerm.set(key, bucket);
      }
    }
    const seenPairs = new Set<string>();
    pairCandidates:
    for (const key of [...byKindAndTerm.keys()].sort(compareText)) {
      const bucket = byKindAndTerm.get(key)!;
      for (let leftIndex = 0; leftIndex < bucket.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < bucket.length; rightIndex += 1) {
          const left = bucket[leftIndex]!;
          const right = bucket[rightIndex]!;
          if (left.entry.id === right.entry.id) continue;
          if (left.entry.entityType && right.entry.entityType && left.entry.entityType !== right.entry.entityType) continue;
          const pairKey = JSON.stringify([left.entry.id, right.entry.id]);
          if (seenPairs.has(pairKey)) continue;
          seenPairs.add(pairKey);
          const shared = left.terms.filter(term => right.termSet.has(term));
          const namesEqual = left.normalizedName.length > 0 && left.normalizedName === right.normalizedName;
          const evidence = [left.entry, right.entry].flatMap(entry => {
            const occurrence = entry.occurrences.slice().sort(compareOccurrences)[0];
            return occurrence ? [occurrenceEvidence(occurrence)] : [];
          });
          if (!append({
            id: `${namesEqual ? 'shared-name' : 'shared-alias'}:${left.entry.id}:${right.entry.id}`,
            relation: namesEqual ? 'shared-name' : 'shared-alias',
            kind: left.entry.kind,
            entityIds: [left.entry.id, right.entry.id],
            names: [left.entry.name, right.entry.name],
            sharedTerms: shared,
            evidence,
          })) break pairCandidates;
        }
      }
    }
  }
  return { candidates: candidates.sort((left, right) => compareText(left.id, right.id)), truncated };
}
