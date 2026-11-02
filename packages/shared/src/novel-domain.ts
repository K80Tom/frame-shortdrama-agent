import { createHash, randomUUID } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import Ajv from 'ajv';
import { validateAssetRecord, type AssetRecord } from './assets';
import { AnalysisSchema, EntityTypeSchema, OccurrenceSchema, type EntityType, type Occurrence, type NovelAnalysis } from './novel-analysis';

const Id = Type.String({ minLength: 1, maxLength: 100 });
const Nonempty = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: '\\S' });
const NullableId = Type.Union([Id, Type.Null()]);
export const NovelEvidenceSchema = Type.Object({
  documentId: Id, start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 1 }),
  quote: Nonempty(1000000),
}, { additionalProperties: false });
export const NovelItemSchema = Type.Object({
  id: Id,
  kind: Type.Union(['character', 'location', 'prop', 'dialogue'].map(value => Type.Literal(value))),
  label: Nonempty(20000), description: Type.String({ maxLength: 5000 }),
  sourceRefs: Type.Array(NovelEvidenceSchema, { minItems: 1, maxItems: 20 }),
  speakerId: NullableId,
  classification: Type.Union([Type.Literal('speech'), Type.Literal('thought'), Type.Literal('quotation'), Type.Literal('sound'), Type.Literal('uncertain'), Type.Null()]),
  entityType: Type.Optional(EntityTypeSchema), occurrence: Type.Optional(OccurrenceSchema),
  canonicalEntityId: Type.Optional(Id), aliases: Type.Optional(Type.Array(Nonempty(300), { maxItems: 30, uniqueItems: true })),
  uncertainty: Type.Union([Nonempty(2000), Type.Null()]),
  review: Type.Union([Type.Literal('unreviewed'), Type.Literal('confirmed')]),
  origin: Type.Union([Type.Literal('model'), Type.Literal('user'), Type.Literal('program')]),
}, { additionalProperties: false });
// PostgreSQL JSONB cannot retain NUL or lone UTF-16 surrogates. Under Ajv's
// Unicode regex mode, valid astral characters (including emoji) remain valid.
export const NovelAssetNoteSchema = Type.String({ maxLength: 2000, pattern: '^[^\\u0000\\uD800-\\uDFFF]*$' });
export const NovelAssetBindingSchema = Type.Object({
  itemId: Id,
  status: Type.Union([Type.Literal('linked'), Type.Literal('missing'), Type.Literal('needsReview')]),
  asset: Type.Union([Type.Object({
    id: Type.String(), kind: Type.Union([Type.Literal('character'), Type.Literal('location'), Type.Literal('prop')]),
    name: Type.String(), description: Type.String(), resourceUrl: Type.String(), createdAt: Type.String(),
  }, { additionalProperties: false }), Type.Null()]),
  note: NovelAssetNoteSchema,
}, { additionalProperties: false });
export const NovelContentSchema = Type.Object({
  items: Type.Array(NovelItemSchema, { maxItems: 2000 }),
  warnings: Type.Array(Nonempty(2000), { maxItems: 500 }),
  assetBindings: Type.Optional(Type.Array(NovelAssetBindingSchema, { maxItems: 2000 })),
  analysis: Type.Optional(AnalysisSchema),
}, { additionalProperties: false });

export type NovelEvidence = Static<typeof NovelEvidenceSchema>;
// Explicit unions retain precise public types across consumers of the schema.
export interface NovelItem {
  id: string; kind: 'character' | 'location' | 'prop' | 'dialogue'; label: string; description: string;
  sourceRefs: NovelEvidence[]; speakerId: string | null;
  classification: 'speech' | 'thought' | 'quotation' | 'sound' | 'uncertain' | null;
  entityType?: EntityType; occurrence?: Occurrence; canonicalEntityId?: string; aliases?: string[];
  uncertainty: string | null; review: 'unreviewed' | 'confirmed'; origin: 'model' | 'user' | 'program';
}
export interface NovelAssetBinding {
  itemId: string; status: 'linked' | 'missing' | 'needsReview'; asset: AssetRecord | null; note: string;
}
export interface NovelContent { items: NovelItem[]; warnings: string[]; assetBindings?: NovelAssetBinding[]; analysis?: NovelAnalysis }
export interface NovelChapter {
  id: string; documentId: string; order: number; title: string; start: number; end: number; latestRevisionId: string | null;
}
export interface NovelSource {
  id: string; title: string; rawText: string; contentSha256: string; sourceUrl: string | null;
  createdAt: string; chapters: NovelChapter[];
}
export interface NovelRevision {
  id: string; chapterId: string; parentRevisionId: string | null; createdBy: 'model' | 'user' | 'program';
  createdAt: string; content: NovelContent;
}
export interface NovelParagraph { id: string; start: number; end: number; text: string }

export class NovelError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string,
    public readonly details: Record<string, unknown> = {}) { super(message); this.name = 'NovelError'; }
}

const ajv = new Ajv({ allErrors: false });
const validateContent = ajv.compile(NovelContentSchema);
const validateBindings = ajv.compile(Type.Array(NovelAssetBindingSchema, { maxItems: 2000 }));
const validateSourceInput = ajv.compile(Type.Object({
  title: Nonempty(300), rawText: Nonempty(1000000),
  sourceUrl: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Null()])),
}, { additionalProperties: false }));
const validateCorrection = ajv.compile(Type.Object({
  expectedRevisionId: Id, items: Type.Array(NovelItemSchema, { maxItems: 2000 }),
}, { additionalProperties: false }));

function fail(code: string, message: string, path?: string): never {
  throw new NovelError(400, code, message, path ? { path } : {});
}

/** Source is retained byte-for-byte; all offsets below are Unicode code points. */
export function buildNovelSource(input: { title: string; rawText: string; sourceUrl?: string | null }): NovelSource {
  if (!validateSourceInput(input)) fail('INVALID_NOVEL_SOURCE', '小说标题或正文格式无效。');
  if (input.sourceUrl) {
    let url: URL;
    try { url = new URL(input.sourceUrl); } catch { return fail('INVALID_SOURCE_URL', '来源必须是有效 HTTPS 链接。'); }
    if (url.protocol !== 'https:' || url.username || url.password) fail('INVALID_SOURCE_URL', '来源必须是无账号密码的 HTTPS 链接。');
  }
  const id = randomUUID();
  const headings: { title: string; start: number }[] = [];
  let start = 0;
  for (const line of input.rawText.split(/(?<=\n)|(?<=\r)(?!\n)/u)) {
    const text = line.replace(/[\r\n]+$/u, '');
    if (/^[\t \u3000]*第[〇零一二两三四五六七八九十百千万0-9０-９]+章[^\r\n]*$/u.test(text)) {
      if (text.trim().length > 300) fail('INVALID_CHAPTER_HEADING', '章节标题过长，请检查分章格式。');
      headings.push({ title: text.trim(), start });
    }
    start += Array.from(line).length;
  }
  if (headings.length === 0) fail('CHAPTER_HEADINGS_REQUIRED', '未找到“第 X 章”独立标题行，请先补充明确的章节边界。');
  if (headings.length > 2000) fail('TOO_MANY_CHAPTERS', '单份小说最多导入 2000 章，请分批导入。');
  return { id, title: input.title, rawText: input.rawText,
    contentSha256: createHash('sha256').update(input.rawText, 'utf8').digest('hex'),
    sourceUrl: input.sourceUrl ?? null, createdAt: new Date().toISOString(),
    chapters: headings.map((heading, index) => ({ id: randomUUID(), documentId: id,
      order: index + 1, title: heading.title, start: heading.start, end: headings[index + 1]?.start ?? start,
      latestRevisionId: null })),
  };
}

export function getChapter(source: NovelSource, chapterId: string): NovelChapter {
  const chapter = source.chapters.find(item => item.id === chapterId);
  if (!chapter) throw new NovelError(404, 'NOVEL_CHAPTER_NOT_FOUND', '找不到此小说章节。');
  return chapter;
}

function assertChapter(source: NovelSource, chapter: NovelChapter, sourceLength = Array.from(source.rawText).length): void {
  const stored = getChapter(source, chapter.id);
  if (chapter.documentId !== source.id || stored.start !== chapter.start || stored.end !== chapter.end
    || !Number.isSafeInteger(chapter.start) || !Number.isSafeInteger(chapter.end)
    || chapter.start < 0 || chapter.end <= chapter.start || chapter.end > sourceLength) {
    fail('INVALID_CHAPTER', '章节与固定原文不匹配。');
  }
}

export function chapterParagraphs(source: NovelSource, chapter: NovelChapter): NovelParagraph[] {
  assertChapter(source, chapter);
  const result: NovelParagraph[] = [];
  let start = chapter.start;
  for (const line of Array.from(source.rawText).slice(chapter.start, chapter.end).join('').split(/(?<=\n)|(?<=\r)(?!\n)/u)) {
    const text = line.replace(/[\r\n]+$/u, '');
    if (text.trim()) result.push({ id: `p${String(result.length + 1).padStart(4, '0')}`, start,
      end: start + Array.from(text).length, text });
    start += Array.from(line).length;
  }
  return result;
}

const BASE_WARNING = '结构和原文位置检查不等于语义准确；人物、地点、道具是否完整及对白归属仍须人工校对。';
const QUOTE_SCOPE_WARNING = '程序只定位可识别的引号候选；未带引号的对白、特殊引号和复杂嵌套仍需人工检查与补录。';

/** Conservative quote candidates, never inferred speakers or declared dialogue. */
export function createReviewSeed(source: NovelSource, chapter: NovelChapter): NovelContent {
  assertChapter(source, chapter);
  const points = Array.from(source.rawText);
  const closers: Record<string, string> = { '“': '”', '「': '」', '『': '』', '"': '"' };
  const stack: { start: number; close: string }[] = [];
  const items: NovelItem[] = [];
  const warnings = [BASE_WARNING, QUOTE_SCOPE_WARNING];
  const add = (start: number, end: number, unclosed: boolean) => {
    while (start < end && /^\s$/u.test(points[start]!)) start++;
    while (end > start && /^\s$/u.test(points[end - 1]!)) end--;
    if (start === end) return;
    if (end - start > 20000) { warnings.push('有超长引号片段未生成条目，请对照原文人工补充。'); return; }
    const quote = points.slice(start, end).join('');
    items.push({ id: randomUUID(), kind: 'dialogue', label: quote, description: '程序识别的引号片段，尚未判断是对白、心理活动还是引用。',
      sourceRefs: [{ documentId: source.id, start, end, quote }], speakerId: null, classification: 'uncertain',
      uncertainty: unclosed ? '引号未闭合，范围及类型均待确认。' : '需要确认片段类型及说话人；引号不自动代表对白。',
      review: 'unreviewed', origin: 'program' });
  };
  for (let offset = chapter.start; offset < chapter.end; offset++) {
    const character = points[offset]!;
    if (stack.at(-1)?.close === character) {
      const opened = stack.pop()!;
      if (stack.length === 0) add(opened.start + 1, offset, false);
    } else if (closers[character]) {
      stack.push({ start: offset, close: closers[character]! });
    } else if (['”', '」', '』'].includes(character)) {
      if (!warnings.includes('存在未配对的结束引号，请人工检查原文。')) warnings.push('存在未配对的结束引号，请人工检查原文。');
    }
  }
  if (stack.length) {
    warnings.push('存在未闭合的引号；程序仅保留候选范围，不推断对白结束位置。');
    add(stack[0]!.start + 1, chapter.end, true);
  }
  if (chapter.order === 1 && points.slice(0, chapter.start).join('').trim()) warnings.push('首章标题之前存在前言或其他文本，未纳入本章拆解。');
  const content = { items, warnings };
  validateNovelContent(content, source, chapter);
  return content;
}

export function validateNovelContent(content: unknown, source: NovelSource, chapter: NovelChapter): asserts content is NovelContent {
  validateChapterContent(content, source, chapter, Array.from(source.rawText));
}

/** Batch reads of an entire book reuse its code-point index for evidence checks. */
export function novelContentValidatorForBook(source: NovelSource) {
  const points = Array.from(source.rawText);
  return (content: unknown, chapter: NovelChapter) => validateChapterContent(content, source, chapter, points);
}

function validateChapterContent(content: unknown, source: NovelSource, chapter: NovelChapter, points: string[]): void {
  assertChapter(source, chapter, points.length);
  if (!validateContent(content)) fail('INVALID_NOVEL_CONTENT', '小说拆解结构不符合约定。', validateContent.errors?.[0]?.instancePath);
  const parsed = content as NovelContent;
  const ids = new Set<string>();
  const characters = new Set(parsed.items.filter(item => item.kind === 'character').map(item => item.id));
  parsed.items.forEach((item, index) => {
    const path = `/items/${index}`;
    if (ids.has(item.id)) fail('DUPLICATE_NOVEL_ITEM', '同章条目标识不能重复。', path);
    ids.add(item.id);
    item.sourceRefs.forEach((ref, refIndex) => {
      if (ref.documentId !== source.id || !Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end)
        || ref.start < chapter.start || ref.end > chapter.end || ref.start >= ref.end
        || points.slice(ref.start, ref.end).join('') !== ref.quote) {
        fail('NOVEL_EVIDENCE_MISMATCH', '原文依据必须位于本章，且与指定码点范围逐字一致。', `${path}/sourceRefs/${refIndex}`);
      }
    });
    if (item.kind === 'dialogue') {
      if (item.classification === null) fail('NOVEL_CLASSIFICATION_REQUIRED', '引号或对白条目需要类型，无法判断时使用待确认。', path);
      if (item.label !== item.sourceRefs[0]!.quote) fail('NOVEL_DIALOGUE_CHANGED', '对白正文必须等于第一条原文依据，不能改写。', path);
      if (item.speakerId !== null && !characters.has(item.speakerId)) fail('NOVEL_SPEAKER_INVALID', '说话人必须引用本章人物，或保留未知。', path);
      if (item.review === 'confirmed' && ((item.classification === 'speech' || item.classification === 'thought') && item.speakerId === null)) {
        fail('NOVEL_UNCERTAIN_CONFIRMATION', '说话人或思考者未知时，不能标记为已确认。', path);
      }
    } else if (item.classification !== null || item.speakerId !== null) {
      fail('NOVEL_ENTITY_FIELDS_INVALID', '人物、地点和道具不能包含对白类型或说话人字段。', path);
    }
    if (item.entityType && (item.kind === 'dialogue'
      || (item.kind === 'character' && !['person', 'group', 'creature'].includes(item.entityType))
      || (item.kind === 'location' && item.entityType !== 'place')
      || (item.kind === 'prop' && !['object', 'material'].includes(item.entityType)))) {
      fail('NOVEL_ENTITY_TYPE_INVALID', '实体细分类与主类型不匹配。', path);
    }
    if (item.review === 'confirmed' && (item.classification === 'uncertain' || item.uncertainty !== null)) {
      fail('NOVEL_UNCERTAIN_CONFIRMATION', '仍有不确定项，请先解决或保留待校对。', path);
    }
  });
  validateNovelAssetBindings(parsed);
}

/** References are chapter-local, revision-owned snapshots, never novel facts or generated media. */
export function validateNovelAssetBindings(content: NovelContent): void {
  if (content.assetBindings === undefined) return;
  if (!validateBindings(content.assetBindings)) fail('INVALID_NOVEL_ASSET_BINDINGS', '资产引用结构不符合约定。');
  const items = new Map(content.items.map(item => [item.id, item]));
  const seen = new Set<string>();
  for (const [index, binding] of content.assetBindings.entries()) {
    const path = `/assetBindings/${index}`;
    if (seen.has(binding.itemId)) fail('DUPLICATE_NOVEL_ASSET_BINDING', '一个小说条目只能保存一条资产引用。', path);
    seen.add(binding.itemId);
    const item = items.get(binding.itemId);
    if (!item || item.kind === 'dialogue') fail('NOVEL_ASSET_ITEM_INVALID', '资产引用只能关联本章的人物、场景或道具。', path);
    if (binding.asset !== null) {
      try { validateAssetRecord(binding.asset); }
      catch { fail('INVALID_NOVEL_ASSET_SNAPSHOT', '资产引用快照无效，请重新选择已登记的资产。', `${path}/asset`); }
    }
    if (binding.status === 'missing' && binding.asset !== null) fail('INVALID_NOVEL_ASSET_BINDINGS', '待补资产不能同时保留有效资产引用。', path);
    if (binding.status === 'linked') {
      if (!binding.asset) fail('INVALID_NOVEL_ASSET_BINDINGS', '已关联状态必须保存资产快照。', path);
      if (binding.asset.kind !== item.kind) fail('NOVEL_ASSET_KIND_MISMATCH', '资产类型与小说条目不匹配。', path);
    }
    if (binding.status !== 'needsReview' && (item.review !== 'confirmed' || item.uncertainty !== null)) {
      fail('NOVEL_ASSET_ITEM_UNCONFIRMED', '请先校对确认小说条目，再关联资产或标记待补。', path);
    }
  }
}

function quoteCovered(candidate: NovelItem, items: NovelItem[]): boolean {
  const target = candidate.sourceRefs[0]!;
  // Additional references can establish a speaker, not quote-body coverage.
  const ranges = items.filter(item => item.kind === 'dialogue').map(item => item.sourceRefs[0]!)
    .filter(ref => ref.end > target.start && ref.start < target.end).sort((a, b) => a.start - b.start);
  let end = target.start;
  for (const range of ranges) {
    if (range.start > end) return false;
    end = Math.max(end, range.end);
    if (end >= target.end) return true;
  }
  return false;
}

/** Model omissions remain visible as program-created uncertain candidates. */
export function supplementNovelQuotes(content: NovelContent, source: NovelSource, chapter: NovelChapter): NovelContent {
  validateNovelContent(content, source, chapter);
  const seed = createReviewSeed(source, chapter);
  const missing = seed.items.filter(item => !quoteCovered(item, content.items));
  const orderedItems = [...content.items.filter(item => item.kind !== 'dialogue'),
    ...[...content.items.filter(item => item.kind === 'dialogue'), ...missing].sort((a, b) => a.sourceRefs[0]!.start - b.sourceRefs[0]!.start)];
  const result = { ...(content.assetBindings === undefined ? {} : { assetBindings: structuredClone(content.assetBindings) }),
    ...(content.analysis ? { analysis: structuredClone(content.analysis) } : {}),
    items: orderedItems, warnings: [...new Set([...seed.warnings, ...content.warnings,
    ...(missing.length ? [`模型未完整覆盖 ${missing.length} 个引号片段，已作为待确认候选补入。`] : [])])] };
  validateNovelContent(result, source, chapter);
  return result;
}

export function applyNovelCorrections(revision: NovelRevision, source: NovelSource, chapter: NovelChapter,
  input: unknown): NovelContent {
  if (!validateCorrection(input)) fail('INVALID_NOVEL_CORRECTIONS', '校对请求格式不正确。', validateCorrection.errors?.[0]?.instancePath);
  const corrections = input as { expectedRevisionId: string; items: NovelItem[] };
  if (corrections.expectedRevisionId !== revision.id) throw new NovelError(409, 'NOVEL_REVISION_CONFLICT', '校对基准已变化，请重新读取最新版本。');
  if (revision.chapterId !== chapter.id) fail('NOVEL_REVISION_CHAPTER_MISMATCH', '不能把其他章节的校对结果保存到本章。');
  const previous = new Map(revision.content.items.map(item => [item.id, item]));
  const comparable = (item: NovelItem) => JSON.stringify({ id: item.id, kind: item.kind, label: item.label,
    description: item.description, sourceRefs: item.sourceRefs.map(ref => ({ documentId: ref.documentId,
      start: ref.start, end: ref.end, quote: ref.quote })), speakerId: item.speakerId,
    classification: item.classification, uncertainty: item.uncertainty, review: item.review,
    entityType: item.entityType, occurrence: item.occurrence, canonicalEntityId: item.canonicalEntityId, aliases: item.aliases });
  const items = corrections.items.map(item => {
    const old = previous.get(item.id);
    return { ...structuredClone(item), origin: old && comparable(old) === comparable(item) ? old.origin : 'user' as const };
  });
  const assetBindings = revision.content.assetBindings?.flatMap(binding => {
    const item = items.find(value => value.id === binding.itemId);
    const old = previous.get(binding.itemId);
    // A removed entity (or one reclassified as quoted text) no longer owns an asset requirement.
    if (!item || item.kind === 'dialogue') return [];
    const unchanged = old && comparable(old) === comparable(item) && item.review === 'confirmed';
    return [{ ...structuredClone(binding), status: unchanged ? binding.status : 'needsReview' as const }];
  });
  const seed = createReviewSeed(source, chapter);
  const missing = seed.items.filter(item => !quoteCovered(item, items));
  const content = { items, ...(assetBindings === undefined ? {} : { assetBindings }),
    ...(revision.content.analysis ? { analysis: { ...structuredClone(revision.content.analysis), status: 'humanEdited' as const } } : {}), warnings: [...seed.warnings,
    ...(missing.length ? [`当前校对版本未完整列出 ${missing.length} 个引号片段，请确认是否有意排除；不能据此宣称对白完整。`] : [])] };
  validateNovelContent(content, source, chapter);
  return content;
}
