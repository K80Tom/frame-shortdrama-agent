import type { NovelRevision, NovelSource, NovelChapter } from './novel-domain';

/** Chapter model input is measured in Unicode code points, matching stored chapter offsets. */
export const NOVEL_CHAPTER_CODE_POINT_LIMIT = 20_000;

export function novelChapterCodePoints(chapter: { start: number; end: number }): number {
  if (!Number.isSafeInteger(chapter.start) || !Number.isSafeInteger(chapter.end) || chapter.end < chapter.start) return Number.POSITIVE_INFINITY;
  return chapter.end - chapter.start;
}

export function novelChapterTooLong(chapter: { start: number; end: number }): boolean {
  return novelChapterCodePoints(chapter) > NOVEL_CHAPTER_CODE_POINT_LIMIT;
}

/** Same paragraph boundaries as chapterParagraphs, without validating the stored source. */
export function countNovelParagraphs(source: Pick<NovelSource, 'rawText'>, chapter: Pick<NovelChapter, 'start' | 'end'>): number {
  if (!Number.isSafeInteger(chapter.start) || !Number.isSafeInteger(chapter.end)
    || chapter.start < 0 || chapter.end <= chapter.start) return 0;
  const points = Array.from(source.rawText);
  if (chapter.end > points.length) return 0;
  let count = 0;
  for (const line of points.slice(chapter.start, chapter.end).join('').split(/(?<=\n)|(?<=\r)(?!\n)/u)) {
    if (line.replace(/[\r\n]+$/u, '').trim()) count += 1;
  }
  return count;
}

export interface NovelCheckpointGate {
  /** Newest extract, or complete scan, that can continue without repeating finished stages. */
  resumeRevisionId: string | null;
  completedStages: 'extract' | 'extract,scan' | null;
}

function lineage(revisions: readonly NovelRevision[], latestRevisionId: string | null): NovelRevision[] {
  const byId = new Map(revisions.map(revision => [revision.id, revision]));
  const chain: NovelRevision[] = [];
  const seen = new Set<string>();
  let id = latestRevisionId;
  while (id) {
    if (seen.has(id)) break;
    seen.add(id);
    const revision = byId.get(id);
    if (!revision) break;
    chain.push(revision);
    id = revision.parentRevisionId;
  }
  return chain;
}

function completedStages(revision: NovelRevision, paragraphCount: number): 'extract' | 'extract,scan' | null {
  if (revision.createdBy !== 'model') return null;
  const analysis = revision.content.analysis;
  if (!analysis || analysis.status === 'humanEdited') return null;
  if (revision.content.items.some(item => item.review !== 'unreviewed' || item.origin === 'user')) return null;
  const stages = analysis.calls.map(call => call.stage).join(',');
  if (stages === 'extract' && analysis.calls.length === 1) return 'extract';
  if (stages === 'extract,scan' && analysis.calls.length === 2
    && paragraphCount > 0 && analysis.paragraphCoverage.length === paragraphCount) return 'extract,scan';
  return null;
}

/** Walk from the chapter tip toward the root. Stop at the first human revision. */
export function novelCheckpointGate(revisions: readonly NovelRevision[], latestRevisionId: string | null, paragraphCount: number): NovelCheckpointGate {
  for (const revision of lineage(revisions, latestRevisionId)) {
    if (revision.createdBy !== 'model' || revision.content.analysis?.status === 'humanEdited') break;
    // A finished review stays put. Do not reach behind it and treat an older scan as unfinished work.
    if (revision.content.analysis?.status === 'reviewed' || revision.content.analysis?.status === 'needsReview') break;
    const stages = completedStages(revision, paragraphCount);
    if (stages) return { resumeRevisionId: revision.id, completedStages: stages };
  }
  return { resumeRevisionId: null, completedStages: null };
}

/** Why a resume id cannot be the next paid call. Null when it is the newest safe checkpoint. */
export function novelResumeRefusal(revisions: readonly NovelRevision[], latestRevisionId: string | null, resumeRevisionId: string, paragraphCount: number): string | null {
  const gate = novelCheckpointGate(revisions, latestRevisionId, paragraphCount);
  if (gate.resumeRevisionId === resumeRevisionId) return null;
  let sawHuman = false;
  for (const revision of lineage(revisions, latestRevisionId)) {
    if (revision.id === resumeRevisionId) {
      return sawHuman
        ? '检查点之后已有人工校对，不能从旧检查点继续；未调用模型。'
        : '只能继续本章最近的完整模型检查点，已完成阶段不会重做；未调用模型。';
    }
    if (revision.createdBy !== 'model' || revision.content.analysis?.status === 'humanEdited') sawHuman = true;
  }
  return '只能继续本章最近的完整模型检查点，已完成阶段不会重做；未调用模型。';
}
