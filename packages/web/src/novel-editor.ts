import type { NovelChapter, NovelEvidence, NovelItem, NovelRevision, NovelSource } from '@lyra/shared';
import { countNovelParagraphs } from '../../shared/src/novel-checkpoint.ts';

export type { NovelChapter, NovelEvidence, NovelItem, NovelRevision, NovelSource };
export type NovelKind = NovelItem['kind'];
export type NovelFilter = NovelKind | 'all';
export const novelKindLabels: Record<NovelKind, string> = { character: '人物', location: '场景 / 地点', prop: '道具', dialogue: '对白 / 引文' };

export function chapterText(source: NovelSource, chapter: NovelChapter): string {
  return Array.from(source.rawText).slice(chapter.start, chapter.end).join('');
}

export interface ChapterTextarea {
  /** Browser textareas expose LF-normalized UTF-16 text, unlike our immutable source. */
  text: string;
  /** Null marks the middle of an emoji surrogate pair, which is not a source boundary. */
  sourceAtDisplayOffset: Array<number | null>;
  /** Indexed by chapter-relative source code point; CRLF's internal boundary has no exact display position. */
  displayAtSourceOffset: Array<number | null>;
}

export function chapterTextarea(source: NovelSource, chapter: NovelChapter): ChapterTextarea {
  const points = Array.from(chapterText(source, chapter));
  const parts: string[] = [];
  const sourceAtDisplayOffset: Array<number | null> = [chapter.start];
  const displayAtSourceOffset: Array<number | null> = [0];
  let display = 0;
  for (let index = 0; index < points.length;) {
    const point = points[index]!;
    const width = point === '\r' && points[index + 1] === '\n' ? 2 : 1;
    const displayed = point === '\r' ? '\n' : point;
    parts.push(displayed);
    if (width === 2) displayAtSourceOffset[index + 1] = null;
    if (displayed.length === 2) sourceAtDisplayOffset[display + 1] = null;
    index += width;
    display += displayed.length;
    sourceAtDisplayOffset[display] = chapter.start + index;
    displayAtSourceOffset[index] = display;
  }
  return { text: parts.join(''), sourceAtDisplayOffset, displayAtSourceOffset };
}

/** All evidence uses document-wide Unicode code points, never textarea UTF-16 offsets. */
export function evidenceFromRange(source: NovelSource, chapter: NovelChapter, start: number, end: number): NovelEvidence {
  if (chapter.documentId !== source.id || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < chapter.start || end > chapter.end || end <= start) throw new Error('依据范围必须在本章内，且结束位置大于开始位置。');
  const quote = Array.from(source.rawText).slice(start, end).join('');
  if (!quote.trim()) throw new Error('不能只引用空白，请选择实际原文。');
  return { documentId: source.id, start, end, quote };
}

export function evidenceFromSelection(source: NovelSource, chapter: NovelChapter, start: number, end: number): NovelEvidence {
  const mapped = chapterTextarea(source, chapter);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > mapped.text.length || end <= start) {
    throw new Error('请完整选中一段本章原文。');
  }
  const sourceStart = mapped.sourceAtDisplayOffset[start];
  const sourceEnd = mapped.sourceAtDisplayOffset[end];
  if (sourceStart === null || sourceEnd === null || sourceStart === undefined || sourceEnd === undefined) {
    throw new Error('请完整选中一段本章原文。');
  }
  return evidenceFromRange(source, chapter, sourceStart, sourceEnd);
}

/** Reverse of selection mapping, with no silent widening of a saved evidence range. */
export function selectionForEvidence(source: NovelSource, chapter: NovelChapter, evidence: NovelEvidence): { start: number; end: number } {
  const expected = evidenceFromRange(source, chapter, evidence.start, evidence.end);
  if (evidence.documentId !== expected.documentId || evidence.quote !== expected.quote) throw new Error('原文依据与当前章节不匹配。');
  const mapped = chapterTextarea(source, chapter);
  const start = mapped.displayAtSourceOffset[evidence.start - chapter.start];
  const end = mapped.displayAtSourceOffset[evidence.end - chapter.start];
  if (start === null || end === null || start === undefined || end === undefined) {
    throw new Error('该依据边界位于 CRLF 换行内部，无法精确显示为选区。原文未变，请通过全文码点范围查看或更正边界。');
  }
  return { start, end };
}

export function confirmationBlock(item: NovelItem): string | null {
  if (item.uncertainty?.trim()) return '仍有待确认说明，核实后先清空该说明。';
  if (!item.sourceRefs.length) return '请先补充原文依据。';
  if (!item.label.trim()) return '请先填写名称。';
  if (item.kind === 'dialogue') {
    if (!item.classification || item.classification === 'uncertain') return '请先确认这是对白、心理活动还是引用。';
    if (['speech', 'thought'].includes(item.classification) && !item.speakerId) return '请先确认说话人或心理活动所属人物；无法判断时保持待确认。';
  }
  return null;
}

export function isNovelItemPending(item: NovelItem): boolean {
  return item.review !== 'confirmed' || confirmationBlock(item) !== null;
}

export function filterNovelItems(items: NovelItem[], kind: NovelFilter, pendingOnly: boolean): NovelItem[] {
  return items.filter(item => (kind === 'all' || item.kind === kind) && (!pendingOnly || isNovelItemPending(item)));
}

/** A proofreading save must keep the visible entity selected, not jump to the first asset target. */
export function selectionAfterNovelSave(items: NovelItem[], preferredId: string, kind: NovelFilter, pendingOnly: boolean): string {
  const visible = filterNovelItems(items, kind, pendingOnly);
  return visible.find(item => item.id === preferredId)?.id ?? visible[0]?.id ?? '';
}

export function editNovelItem(item: NovelItem, patch: Partial<NovelItem>): NovelItem {
  const candidate = { ...item, ...patch, id: item.id, kind: item.kind };
  if (candidate.kind !== 'dialogue') { candidate.speakerId = null; candidate.classification = null; }
  else candidate.label = candidate.sourceRefs[0]?.quote ?? '';
  candidate.uncertainty = candidate.uncertainty?.trim() ? candidate.uncertainty : null;
  // Mere rendering or re-selecting the same value must not create a manual change.
  if (JSON.stringify(candidate) === JSON.stringify(item)) return item;
  candidate.origin = 'user';
  candidate.review = patch.review ?? 'unreviewed';
  if (candidate.review === 'confirmed' && confirmationBlock(candidate)) candidate.review = 'unreviewed';
  return candidate;
}

export function newNovelItem(kind: NovelKind, evidence: NovelEvidence, id: string): NovelItem {
  return {
    id, kind, label: kind === 'dialogue' ? evidence.quote : '', description: '', sourceRefs: [evidence], speakerId: null,
    classification: kind === 'dialogue' ? 'uncertain' : null, uncertainty: null, review: 'unreviewed', origin: 'user',
  };
}

export function removeNovelItem(items: NovelItem[], id: string): NovelItem[] {
  return items.filter(item => item.id !== id).map(item => item.speakerId === id
    ? editNovelItem(item, { speakerId: null, uncertainty: '原说话人条目已移除，请重新确认归属。' }) : item);
}

export function novelDraftChanged(base: NovelRevision, items: NovelItem[]): boolean {
  return JSON.stringify(base.content.items) !== JSON.stringify(items);
}

export function validateNovelDraft(source: NovelSource, chapter: NovelChapter, items: NovelItem[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const characters = new Set(items.filter(item => item.kind === 'character').map(item => item.id));
  if (items.length > 2000) errors.push('单章最多保存 2000 个条目。');
  for (const [index, item] of items.entries()) {
    const name = `第 ${index + 1} 项「${item.label.slice(0, 20) || '未命名'}」`;
    if (!item.id || item.id.length > 100 || ids.has(item.id)) errors.push(`${name}的标识无效或重复。`);
    ids.add(item.id);
    if (!item.label.trim() || item.label.length > 20000) errors.push(`${name}请填写名称或有效的原文对白。`);
    if (item.description.length > 5000) errors.push(`${name}的说明不可超过 5000 字符。`);
    if (item.uncertainty && item.uncertainty.length > 2000) errors.push(`${name}的待确认说明不可超过 2000 字符。`);
    if (!item.sourceRefs.length || item.sourceRefs.length > 20) errors.push(`${name}需有 1–20 处原文依据。`);
    for (const ref of item.sourceRefs) {
      try {
        const expected = evidenceFromRange(source, chapter, ref.start, ref.end);
        if (ref.documentId !== expected.documentId || ref.quote !== expected.quote) throw new Error();
      } catch { errors.push(`${name}的原文依据不匹配或超出本章。`); }
    }
    if (item.kind === 'dialogue') {
      if (!item.classification) errors.push(`${name}请标明文本类型；无法判断时选择待确认。`);
      if (item.label !== item.sourceRefs[0]?.quote) errors.push(`${name}的对白不能改写，请更正原文范围。`);
      if (item.speakerId && !characters.has(item.speakerId)) errors.push(`${name}的人物不在本章人物列表中。`);
    } else if (item.speakerId || item.classification) errors.push(`${name}不是对白，不能设置说话人或对白类型。`);
    const block = confirmationBlock(item);
    if (item.review === 'confirmed' && block) errors.push(`${name}不能标为已确认：${block}`);
  }
  return [...new Set(errors)];
}

export type NovelExtractIntent = 'fresh' | 'resume' | 'restart';

export function novelParagraphCount(source: NovelSource, chapter: NovelChapter): number {
  return countNovelParagraphs(source, chapter);
}

/** Paid extract buttons. A saved checkpoint continues; a fresh run must say so. */
export function novelExtractActions(input: {
  tooLong: boolean; mode: 'single' | 'reviewed'; checkpointId: string | null; hasRevision: boolean;
}): { blocked: boolean; primaryLabel: string; primaryIntent: NovelExtractIntent; restartLabel: string | null } {
  const freshLabel = input.hasRevision ? '重新提取本章（新版本）' : '提取本章人物、场景、道具与对白';
  if (input.tooLong) return { blocked: true, primaryLabel: freshLabel, primaryIntent: 'fresh', restartLabel: null };
  if (input.checkpointId && input.mode === 'reviewed') {
    return { blocked: false, primaryLabel: '从检查点继续', primaryIntent: 'resume', restartLabel: '放弃检查点并重新提取' };
  }
  return { blocked: false, primaryLabel: freshLabel, primaryIntent: input.checkpointId ? 'restart' : 'fresh', restartLabel: null };
}

/** Body for one paid chapter extract. Omits restart confirmation when no checkpoint exists. */
export function novelExtractPayload(input: {
  expectedRevisionId: string | null; mode: 'single' | 'reviewed';
  checkpointId: string | null; intent: NovelExtractIntent;
}): Record<string, unknown> {
  if (input.checkpointId && input.intent === 'fresh') throw new Error('已有检查点时必须明确继续或放弃。');
  if (input.intent === 'resume') {
    if (input.mode !== 'reviewed' || !input.checkpointId) throw new Error('没有可继续的多阶段检查点。');
    return { expectedRevisionId: input.expectedRevisionId, allowPaid: true, mode: 'reviewed', resumeRevisionId: input.checkpointId };
  }
  return { expectedRevisionId: input.expectedRevisionId, allowPaid: true, mode: input.mode,
    ...(input.intent === 'restart' ? { confirmRestart: true } : {}) };
}

/** A late request must never replace the state of a later chapter or an unmounted editor. */
export function createNovelRequestGate() {
  let epoch = 0;
  return {
    begin() { const token = ++epoch; return () => token === epoch; },
    invalidate() { epoch += 1; },
  };
}
