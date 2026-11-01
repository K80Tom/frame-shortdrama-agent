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
