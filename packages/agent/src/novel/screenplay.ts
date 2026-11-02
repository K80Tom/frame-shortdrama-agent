import { createHash } from 'node:crypto';
import { NovelError, type NovelSource, type NovelChapter, type NovelRevision,
  type NovelAdaptationSource, type NovelAdaptationPreview } from '@lyra/shared';

/** Page directions keep the author's prose. Only anchored, attributed speech becomes a speaker line. */
function sceneLines(points: string[], chapter: NovelChapter, revision: NovelRevision): string[] {
  const { items } = revision.content;
  if (revision.content.analysis?.status === 'partial' || revision.createdBy === 'program') {
    throw new NovelError(409, 'NOVEL_ADAPTATION_INCOMPLETE', chapter.title + ' 需要完成拆解或保存人工校对才能转为剧本。');
  }
  const lines = ['第' + chapter.order + '场 ' + chapter.title];
  const speakers = new Map(items.filter(item => item.kind === 'character').map(item => [item.id, item.label]));
  for (const [kind, label] of [['character', '人物'], ['location', '地点'], ['prop', '道具']] as const) {
    const names = items.filter(item => item.kind === kind && !item.uncertainty
      && (!item.occurrence || item.occurrence === 'present')).map(item => item.label);
    if (names.length) lines.push('本章' + label + '　' + [...new Set(names)].join('、'));
  }
  const directions = (start: number, end: number) => {
    for (const part of points.slice(start, end).join('').split(/\r\n|\r|\n/u)) {
      if (part.trim()) lines.push('△ ' + part.trim());
    }
  };
  // The first physical line is the source chapter heading, already printed above.
  let cursor = chapter.start;
  while (cursor < chapter.end && points[cursor] !== '\r' && points[cursor] !== '\n') cursor++;
  const dialogue = items.filter(item => item.kind === 'dialogue')
    .sort((a, b) => a.sourceRefs[0]!.start - b.sourceRefs[0]!.start);
  let coveredUntil = -1;
  for (const [index, item] of dialogue.entries()) {
    const { start, end, quote } = item.sourceRefs[0]!;
    // Conflicting or overlapping readings stay in the original passage for review.
    const overlaps = start < coveredUntil || (dialogue[index + 1]?.sourceRefs[0]?.start ?? Infinity) < end;
    coveredUntil = Math.max(coveredUntil, end);
    if (overlaps || start < cursor || end > chapter.end || item.classification !== 'speech'
      || item.uncertainty || !item.speakerId || !speakers.has(item.speakerId)) continue;
    const closing: Record<string, string> = { '“': '”', '「': '」', '『': '』', '"': '"' };
    const surrounded = start > cursor && closing[points[start - 1]!] === points[end] && end < chapter.end;
    directions(cursor, start - (surrounded ? 1 : 0));
    lines.push(speakers.get(item.speakerId) + '：' + quote);
    cursor = end + (surrounded ? 1 : 0);
  }
  directions(cursor, chapter.end);
  return lines;
}

export function buildNovelScreenplay(source: NovelSource, selected: { chapter: NovelChapter; revision: NovelRevision }[]): NovelAdaptationPreview {
  const points = Array.from(source.rawText);
  const chapters = selected.map(({ chapter, revision }) => ({ chapterId: chapter.id, revisionId: revision.id }));
  const origin: NovelAdaptationSource = { kind: 'novelAdaptation', format: 'chapter-script/1',
    documentId: source.id, documentSha256: source.contentSha256, title: source.title,
    url: '#/novel/' + encodeURIComponent(source.id), chapters };
  const label = selected.length === 1 ? selected[0]!.chapter.title : '第' + selected[0]!.chapter.order + '至' + selected.at(-1)!.chapter.order + '章';
  const title = Array.from(source.title + ' · ' + label).slice(0, 160).join('');
  const rawText = ['《' + title + '》', ...selected.map(({ chapter, revision }) => sceneLines(points, chapter, revision).join('\n'))].join('\n\n');
  if (Buffer.byteLength(rawText) > 2 * 1024 * 1024) throw new NovelError(413, 'NOVEL_ADAPTATION_TOO_LARGE', '剧本超出 2 MiB，请按章转换。');
  return { title, rawText, source: origin, digest: createHash('sha256').update(JSON.stringify([origin, rawText])).digest('hex') };
}
