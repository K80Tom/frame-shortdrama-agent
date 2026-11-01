import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const editor = await server.ssrLoadModule('/src/novel-editor.ts');
const source = { id: 'novel', rawText: '序\n第一章\n小林😀说：“走吧。”\n第二章\n其他内容' };
const chapter = { id: 'chapter', documentId: 'novel', start: 2, end: 18 };
const quoteStart = Array.from(source.rawText).indexOf('走');
const ref = editor.evidenceFromRange(source, chapter, quoteStart, quoteStart + 3);
const personRef = editor.evidenceFromRange(source, chapter, 6, 8);
const person = { ...editor.newNovelItem('character', personRef, 'person'), label: '小林', review: 'confirmed' };
const dialogue = { ...editor.newNovelItem('dialogue', ref, 'dialogue'), classification: 'speech', speakerId: 'person', review: 'confirmed', origin: 'model' };

test('evidence converts textarea UTF-16 selection to document code points, including emoji', () => {
  const text = editor.chapterText(source, chapter);
  const start = text.indexOf('走');
  assert.deepEqual(editor.evidenceFromSelection(source, chapter, start, start + 3), ref);
  assert.equal(ref.quote, '走吧。');
  const emoji = text.indexOf('😀');
  assert.throws(() => editor.evidenceFromSelection(source, chapter, emoji, emoji + 1), /完整/);
  assert.throws(() => editor.evidenceFromRange(source, chapter, 0, 3), /本章/);
});

test('textarea selections after CRLF and CR map to exact original quotes without normalizing storage', () => {
  for (const newline of ['\r\n', '\r', '\n']) {
    const prefix = `前言😀${newline}`;
    const body = `第一章${newline}小林😀说：“走吧。”${newline}第二段`;
    const mixedSource = { id: 'mixed', rawText: `${prefix}${body}\r\n第二章\n结尾` };
    const mixedChapter = { documentId: 'mixed', start: Array.from(prefix).length, end: Array.from(prefix + body).length };
    const before = mixedSource.rawText;
    const mapped = editor.chapterTextarea(mixedSource, mixedChapter);
    assert.equal(mapped.text, body.replace(/\r\n?/g, '\n'));
    const start = mapped.text.indexOf('走');
    const evidence = editor.evidenceFromSelection(mixedSource, mixedChapter, start, start + 3);
    assert.equal(evidence.quote, '走吧。');
    assert.equal(evidence.start, Array.from(prefix + body.slice(0, body.indexOf('走'))).length);
    assert.deepEqual(editor.selectionForEvidence(mixedSource, mixedChapter, evidence), { start, end: start + 3 });
    const multiLine = editor.evidenceFromSelection(mixedSource, mixedChapter, 0, mapped.text.indexOf('小林') + 2);
    assert.equal(multiLine.quote, `第一章${newline}小林`);
    assert.deepEqual(editor.selectionForEvidence(mixedSource, mixedChapter, multiLine), { start: 0, end: mapped.text.indexOf('小林') + 2 });
    assert.equal(mixedSource.rawText, before);
  }
});

test('mixed newlines and emoji round-trip for every complete visible range in a nonzero-offset chapter', () => {
  const prefix = '序😀\r\n';
  const body = '第一章\r\n甲😀\r乙\n丙😺\r\n尾';
  const mixedSource = { id: 'mixed', rawText: `${prefix}${body}\n第二章` };
  const mixedChapter = { documentId: 'mixed', start: Array.from(prefix).length, end: Array.from(prefix + body).length };
  const mapped = editor.chapterTextarea(mixedSource, mixedChapter);
  for (let start = 0; start < mapped.text.length; start++) {
    for (let end = start + 1; end <= mapped.text.length; end++) {
      if (mapped.sourceAtDisplayOffset[start] === null || mapped.sourceAtDisplayOffset[end] === null || !mapped.text.slice(start, end).trim()) continue;
      const evidence = editor.evidenceFromSelection(mixedSource, mixedChapter, start, end);
      assert.equal(evidence.quote, Array.from(mixedSource.rawText).slice(evidence.start, evidence.end).join(''));
      assert.equal(evidence.quote.replace(/\r\n?/g, '\n'), mapped.text.slice(start, end));
      assert.deepEqual(editor.selectionForEvidence(mixedSource, mixedChapter, evidence), { start, end });
    }
  }
  const emoji = mapped.text.indexOf('😀');
  assert.throws(() => editor.evidenceFromSelection(mixedSource, mixedChapter, emoji, emoji + 1), /完整/);
  assert.throws(() => editor.evidenceFromSelection(mixedSource, mixedChapter, emoji + 1, emoji + 2), /完整/);
});

test('locating saved evidence never silently widens CRLF-internal boundaries or accepts stale quotes', () => {
  const mixedSource = { id: 'mixed', rawText: '第一章\r\n甲😀\r\n乙' };
  const mixedChapter = { documentId: 'mixed', start: 0, end: Array.from(mixedSource.rawText).length };
  const insideNewline = editor.evidenceFromRange(mixedSource, mixedChapter, 4, 6);
  assert.equal(insideNewline.quote, '\n甲');
  assert.throws(() => editor.selectionForEvidence(mixedSource, mixedChapter, insideNewline), /CRLF/);
  const throughNewline = editor.evidenceFromRange(mixedSource, mixedChapter, 3, 6);
  const located = editor.selectionForEvidence(mixedSource, mixedChapter, throughNewline);
  assert.deepEqual(editor.evidenceFromSelection(mixedSource, mixedChapter, located.start, located.end), throughNewline);
  assert.throws(() => editor.selectionForEvidence(mixedSource, mixedChapter, { ...throughNewline, quote: '\n甲' }), /不匹配/);
});

test('uncertain attribution and classification can be saved unreviewed but cannot be confirmed', () => {
  for (const patch of [{ speakerId: null }, { uncertainty: '代称不清楚' }, { classification: 'uncertain' }, { classification: 'thought', speakerId: null }]) {
    const uncertain = editor.editNovelItem(dialogue, { ...patch, review: 'confirmed' });
    assert.equal(uncertain.review, 'unreviewed');
    assert.equal(editor.isNovelItemPending(uncertain), true);
    assert.deepEqual(editor.validateNovelDraft(source, chapter, [person, uncertain]), []);
  }
  assert.equal(editor.confirmationBlock({ ...dialogue, classification: 'quotation', speakerId: null }), null);
});

test('dialogue text is immutable except by changing the exact source evidence', () => {
  assert.equal(editor.editNovelItem(dialogue, { label: '任意改写' }), dialogue);
  const evidence = editor.evidenceFromRange(source, chapter, quoteStart, quoteStart + 2);
  const changed = editor.editNovelItem(dialogue, { sourceRefs: [evidence] });
  assert.equal(changed.label, '走吧');
  assert.equal(changed.origin, 'user');
  assert.equal(changed.review, 'unreviewed');
  assert.equal(dialogue.label, '走吧。');
});

test('removing a character clears dependent attribution and marks it for review without mutating history', () => {
  const remaining = editor.removeNovelItem([person, dialogue], person.id);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].speakerId, null);
  assert.equal(remaining[0].review, 'unreviewed');
  assert.match(remaining[0].uncertainty, /移除/);
  assert.equal(dialogue.speakerId, person.id);
});

test('filters include unresolved and unreviewed items; original immutable revision determines dirty state', () => {
  const pending = { ...dialogue, review: 'unreviewed' };
  const items = [person, pending];
  const base = { content: { items } };
  assert.equal(editor.novelDraftChanged(base, structuredClone(items)), false);
  assert.equal(editor.novelDraftChanged(base, [person]), true);
  assert.deepEqual(editor.filterNovelItems(items, 'dialogue', true), [pending]);
  assert.deepEqual(editor.filterNovelItems(items, 'character', true), []);
});

test('saving corrections preserves the selected non-first entity for the next asset action', () => {
  const book = { ...person, id: 'book', kind: 'prop', label: '书籍' };
  const items = [person, book, dialogue];
  const before = structuredClone(items);
  assert.equal(editor.selectionAfterNovelSave(items, book.id, 'all', false), book.id);
  assert.equal(editor.selectionAfterNovelSave(items, book.id, 'prop', false), book.id);
  assert.deepEqual(items, before);
});

test('save selection respects pending-only and type filters, falling back only to visible items', () => {
  const book = { ...person, id: 'book', kind: 'prop', label: '书籍' };
  const key = { ...person, id: 'key', kind: 'prop', label: '钥匙', review: 'unreviewed' };
  const items = [person, book, key];
  // Confirming the book removes it from the pending-only view: it cannot remain a hidden asset target.
  assert.equal(editor.selectionAfterNovelSave(items, book.id, 'prop', true), key.id);
  assert.equal(editor.selectionAfterNovelSave(items, key.id, 'prop', true), key.id);
  assert.equal(editor.selectionAfterNovelSave(items, book.id, 'character', false), person.id);
  assert.equal(editor.selectionAfterNovelSave(items, 'removed-item', 'prop', false), book.id);
  assert.equal(editor.selectionAfterNovelSave(items, book.id, 'character', true), '');
  assert.equal(editor.selectionAfterNovelSave([], book.id, 'all', false), '');
});

test('validation rejects forged source evidence, dangling speakers, and confirmed ambiguity', () => {
  const forged = { ...dialogue, sourceRefs: [{ ...ref, quote: '别的句子' }] };
  assert.match(editor.validateNovelDraft(source, chapter, [person, forged]).join(' '), /原文依据/);
  assert.match(editor.validateNovelDraft(source, chapter, [dialogue]).join(' '), /人物/);
  assert.match(editor.validateNovelDraft(source, chapter, [{ ...dialogue, speakerId: null }]).join(' '), /不能标为已确认/);
});

test('late requests cannot overwrite a newer chapter load or an unmounted page', () => {
  const gate = editor.createNovelRequestGate();
  const first = gate.begin();
  assert.equal(first(), true);
  const second = gate.begin();
  assert.equal(first(), false);
  assert.equal(second(), true);
  gate.invalidate();
  assert.equal(second(), false);
});

test('dialogue editor renders verbatim read-only text, classification, attribution, and source evidence', async () => {
  const { ItemEditor } = await server.ssrLoadModule('/src/NovelBreakdown.tsx');
  const html = renderToStaticMarkup(createElement(ItemEditor, {
    item: dialogue, source, chapter, items: [person, dialogue], selection: null, disabled: false,
    onChange() {}, onLocate() {}, onDelete() {},
  }));
  assert.match(html, /textarea[^>]*readOnly=""[^>]*>走吧。/);
  assert.match(html, /心理活动/);
  assert.match(html, /未知 \/ 不适用/);
  assert.match(html, /定位原文/);
  assert.match(html, /全文码点范围/);
  assert.match(html, /我已对照原文确认此项/);
});

test('historical editor has no writable evidence controls and the import page makes the no-adaptation boundary explicit', async () => {
  const { ItemEditor, default: NovelBreakdown } = await server.ssrLoadModule('/src/NovelBreakdown.tsx');
  const html = renderToStaticMarkup(createElement(ItemEditor, {
    item: person, source, chapter, items: [person], selection: null, disabled: true,
    onChange() {}, onLocate() {}, onDelete() {},
  }));
  assert.match(html, /value="小林"[^>]*disabled=""|disabled=""[^>]*value="小林"/);
  assert.doesNotMatch(html, /补充或更正依据/);
  assert.match(html, /定位原文/);
  const page = renderToStaticMarkup(createElement(NovelBreakdown));
  assert.match(page, /小说逐章拆解/);
  assert.match(page, /不改编剧本/);
  assert.match(page, /没有预置或凭空补写的小说正文/);
});
