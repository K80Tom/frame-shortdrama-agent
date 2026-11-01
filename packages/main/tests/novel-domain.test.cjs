const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { buildNovelSource, chapterParagraphs, getChapter, createReviewSeed, validateNovelContent,
  applyNovelCorrections, supplementNovelQuotes, countNovelParagraphs } = require('@lyra/shared');
const { NovelExtractor } = require('../dist/novel/extractor.js');

// Original micro-fiction: no third-party novel text, credentials or real model calls.
const RAW = '前言😀\r\n第一章 灯塔\r\n林舟把铜钥匙放在桌上。\r\n林舟说：“门已经开了。”\r\n他想：「也许可以进去。」\r\n墙上刻着“北岸”。\r\n\r\n第２章 归途\r\n沈雨提着灯，走向旧桥。\r\n“等一等。”一个声音传来。\r\n第三章 未完\r\n风里有人喊：“回来\r\n';
const source = () => buildNovelSource({ title: '原创灯塔练习', rawText: RAW });
const chapter = (document) => document.chapters[0];
const evidence = (document, quote, after = 0) => {
  const points = Array.from(document.rawText);
  const whole = points.slice(after).join('');
  const jsOffset = whole.indexOf(quote);
  assert.notEqual(jsOffset, -1);
  const start = after + Array.from(whole.slice(0, jsOffset)).length;
  return { documentId: document.id, start, end: start + Array.from(quote).length, quote };
};
const entity = (document) => ({ id: 'char_1', kind: 'character', label: '林舟', description: '本章人物',
  sourceRefs: [evidence(document, '林舟把铜钥匙放在桌上。')], speakerId: null, classification: null,
  uncertainty: null, review: 'unreviewed', origin: 'model' });
const speech = (document) => ({ id: 'speech_1', kind: 'dialogue', label: '门已经开了。', description: '',
  sourceRefs: [evidence(document, '门已经开了。')], speakerId: 'char_1', classification: 'speech',
  uncertainty: null, review: 'unreviewed', origin: 'model' });
const revision = (document, items = [entity(document), speech(document)]) => ({ id: 'revision_1',
  chapterId: chapter(document).id, parentRevisionId: null, createdBy: 'model', createdAt: new Date().toISOString(),
  content: { items, warnings: [] } });

test('novel source preserves exact text/hash and splits Chinese/fullwidth chapters with code-point offsets', () => {
  const document = source();
  assert.equal(document.rawText, RAW);
  assert.equal(document.contentSha256, createHash('sha256').update(RAW).digest('hex'));
  assert.equal(document.chapters.length, 3);
  assert.equal(document.chapters[0].start, Array.from('前言😀\r\n').length);
  assert.notEqual(document.chapters[0].start, '前言😀\r\n'.length);
  assert.equal(document.chapters[0].end, document.chapters[1].start);
  assert.equal(document.chapters[2].end, Array.from(RAW).length);
  assert.deepEqual(document.chapters.map(item => item.title), ['第一章 灯塔', '第２章 归途', '第三章 未完']);
  assert.equal(getChapter(document, chapter(document).id), chapter(document));
  assert.throws(() => getChapter(document, 'missing'), { code: 'NOVEL_CHAPTER_NOT_FOUND' });
  const paragraphs = chapterParagraphs(document, chapter(document));
  for (const part of paragraphs) assert.equal(Array.from(RAW).slice(part.start, part.end).join(''), part.text);
  assert.equal(paragraphs.length, 5);
  assert.equal(document.chapters[0].latestRevisionId, null);
});

test('novel import rejects missing headings, invalid URLs and unknown input fields', () => {
  assert.throws(() => buildNovelSource({ title: '无标题', rawText: '林舟看向远方。' }), { code: 'CHAPTER_HEADINGS_REQUIRED' });
  assert.throws(() => buildNovelSource({ title: '错误来源', rawText: RAW, sourceUrl: 'http://example.test' }), { code: 'INVALID_SOURCE_URL' });
  assert.throws(() => buildNovelSource({ title: '错误来源', rawText: RAW, sourceUrl: 'https://user:pass@example.test' }), { code: 'INVALID_SOURCE_URL' });
  assert.throws(() => buildNovelSource({ title: '错误字段', rawText: RAW, script: true }), { code: 'INVALID_NOVEL_SOURCE' });
  assert.equal(buildNovelSource({ title: '单章', rawText: '第1章 雨\r雨落下。' }).chapters.length, 1);
});

test('program seed only proposes quote candidates, never invents people, speaker or dialogue class', () => {
  const document = source();
  const content = createReviewSeed(document, chapter(document));
  assert.equal(content.items.length, 3);
  for (const item of content.items) {
    assert.equal(item.kind, 'dialogue');
    assert.equal(item.classification, 'uncertain');
    assert.equal(item.origin, 'program');
    assert.equal(item.speakerId, null);
    assert.equal(item.review, 'unreviewed');
    assert.equal(item.label, item.sourceRefs[0].quote);
    assert.ok(item.uncertainty);
  }
  assert.ok(content.warnings.some(text => text.includes('前言')));
  const unclosed = createReviewSeed(document, document.chapters[2]);
  assert.equal(unclosed.items.length, 1);
  assert.equal(unclosed.items[0].label, '回来');
  assert.ok(unclosed.warnings.some(text => text.includes('未闭合')));
});

test('nested and ASCII quote candidates keep original content and do not duplicate inner quoted text', () => {
  const document = buildNovelSource({ title: '原创引号测试', rawText: '第一章 回声\n“他说「停下」。”\n"回家吧。"\n”\n' });
  const content = createReviewSeed(document, chapter(document));
  assert.deepEqual(content.items.map(item => item.label), ['他说「停下」。', '回家吧。']);
  assert.ok(content.warnings.some(text => text.includes('结束引号')));
});

test('novel evidence rejects cross-chapter, incorrect document, fabricated quote and UTF-16 offsets', () => {
  const document = source();
  for (const ref of [evidence(document, '沈雨提着灯，走向旧桥。'),
    { ...evidence(document, '林舟'), documentId: 'other' },
    { ...evidence(document, '林舟'), quote: '沈雨' },
    { ...evidence(document, '林舟'), start: RAW.indexOf('林舟'), end: RAW.indexOf('林舟') + 2 }]) {
    const item = { ...entity(document), sourceRefs: [ref] };
    assert.throws(() => validateNovelContent({ items: [item], warnings: [] }, document, chapter(document)), { code: 'NOVEL_EVIDENCE_MISMATCH' });
  }
});

test('novel content rejects rewritten dialogue, missing evidence, false confirmation and invalid speakers', () => {
  const document = source();
  const base = [entity(document), speech(document)];
  for (const [change, code] of [
    [{ label: '门现在开了。' }, 'NOVEL_DIALOGUE_CHANGED'],
    [{ sourceRefs: [] }, 'INVALID_NOVEL_CONTENT'],
    [{ speakerId: 'missing' }, 'NOVEL_SPEAKER_INVALID'],
    [{ speakerId: null, review: 'confirmed' }, 'NOVEL_UNCERTAIN_CONFIRMATION'],
    [{ classification: 'uncertain', review: 'confirmed' }, 'NOVEL_UNCERTAIN_CONFIRMATION'],
    [{ uncertainty: '人物身份待确认', review: 'confirmed' }, 'NOVEL_UNCERTAIN_CONFIRMATION'],
    [{ classification: null }, 'NOVEL_CLASSIFICATION_REQUIRED'],
  ]) {
    assert.throws(() => validateNovelContent({ items: [base[0], { ...base[1], ...change }], warnings: [] }, document, chapter(document)), { code });
  }
  assert.throws(() => validateNovelContent({ items: [base[0], base[0]], warnings: [] }, document, chapter(document)), { code: 'DUPLICATE_NOVEL_ITEM' });
  validateNovelContent({ items: [base[0], { ...base[1], classification: 'quotation', speakerId: null, review: 'confirmed' }], warnings: [] }, document, chapter(document));
});

test('manual corrections are immutable, preserve unchanged origins/IDs and mark actual edits as user', () => {
  const document = source();
  const base = revision(document);
  const before = structuredClone(base);
  const items = structuredClone(base.content.items);
  items[0].description = '校对后的说明';
  items[0].review = 'confirmed';
  items[1].origin = 'user'; // A caller cannot relabel an unchanged model result.
  const updated = applyNovelCorrections(base, document, chapter(document), { expectedRevisionId: base.id, items });
  assert.equal(updated.items[0].id, base.content.items[0].id);
  assert.equal(updated.items[0].origin, 'user');
  assert.equal(updated.items[0].review, 'confirmed');
  assert.equal(updated.items[1].origin, 'model');
  assert.deepEqual(base, before);
  items[0].description = '后续内存修改';
  assert.notEqual(updated.items[0].description, items[0].description);
  assert.throws(() => applyNovelCorrections(base, document, chapter(document), { expectedRevisionId: 'old', items }), { code: 'NOVEL_REVISION_CONFLICT' });
  assert.throws(() => applyNovelCorrections(base, document, document.chapters[1], { expectedRevisionId: base.id, items }), { code: 'NOVEL_REVISION_CHAPTER_MISMATCH' });
});

test('manual add/delete and exact evidence editing work, but deleting a referenced character is rejected', () => {
  const document = source();
  const base = revision(document);
  const prop = { ...entity(document), id: 'prop_new', kind: 'prop', label: '铜钥匙', sourceRefs: [evidence(document, '铜钥匙')] };
  const result = applyNovelCorrections(base, document, chapter(document), {
    expectedRevisionId: base.id, items: [base.content.items[0], prop],
  });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[1].origin, 'user');
  assert.ok(result.warnings.some(text => text.includes('未完整列出')));
  assert.throws(() => applyNovelCorrections(base, document, chapter(document), {
    expectedRevisionId: base.id, items: [base.content.items[1]],
  }), { code: 'NOVEL_SPEAKER_INVALID' });
});

test('quote supplementation preserves classified content and exposes missing quotes without claiming completeness', () => {
  const document = source();
  const content = supplementNovelQuotes(revision(document).content, document, chapter(document));
  assert.equal(content.items.filter(item => item.origin === 'program').length, 2);
  assert.equal(content.items.filter(item => item.label === '门已经开了。').length, 1);
  assert.ok(content.warnings.some(text => text.includes('语义准确')));
});

test('speaker context evidence cannot hide another omitted quote in the same paragraph', () => {
  const document = buildNovelSource({ title: '原创复句', rawText: '第一章 门\n林舟说：“打开门。”沈雨答：“我马上来。”' });
  const first = { ...speech(source()), label: '打开门。', sourceRefs: [evidence(document, '打开门。'),
    evidence(document, '林舟说：“打开门。”沈雨答：“我马上来。”')], speakerId: null, uncertainty: '说话人待确认' };
  const content = supplementNovelQuotes({ items: [first], warnings: [] }, document, chapter(document));
  assert.equal(content.items.length, 2);
  assert.equal(content.items[1].label, '我马上来。');
  assert.equal(content.items[1].origin, 'program');
});

const config = { port: 8788, provider: 'maas', baseUrl: 'https://model.example.test', apiKey: 'test-only-key',
  defaultModel: 'deepseek-v4.1-flash-1017', reasoningEffort: 'model-default', maxOutputTokens: 4096,
  timeoutMs: 1000, maxConcurrentCalls: 1 };
const modelOutput = (document) => {
  const paragraphs = chapterParagraphs(document, chapter(document));
  return { entities: [
    { tempId: '人物一', kind: 'character', label: '林舟', description: '本章人物',
      evidenceParagraphIds: [paragraphs[1].id], uncertainty: null },
  ], quotes: [
    { quoteId: 'q0001', speakerTempId: '人物一', classification: 'speech', attributionParagraphIds: [paragraphs[2].id], uncertainty: null },
  ] };
};
const response = (output, finish = 'stop') => new Response(JSON.stringify({ model: config.defaultModel,
  choices: [{ message: { content: typeof output === 'string' ? output : JSON.stringify(output) }, finish_reason: finish }],
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('novel extractor makes exactly one bounded Pi/model call, maps evidence and keeps omissions pending', async () => {
  const document = source();
  let calls = 0;
  const extractor = new NovelExtractor(config, async (url, request) => {
    calls++;
    assert.equal(url, `${config.baseUrl}/chat/completions`);
    const body = JSON.parse(request.body);
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.stream, false);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
    assert.ok(body.messages[0].content.includes('不改写为剧本'));
    assert.ok(body.messages[0].content.includes('完整 JSON Schema'));
    assert.ok(!body.messages[1].content.includes('沈雨'));
    const context = JSON.parse(body.messages[1].content);
    assert.equal(context.quoteCandidates.length, 3);
    assert.equal(context.quoteCandidates[0].quoteId, 'q0001');
    return response(modelOutput(document));
  });
  const result = await extractor.extract(document, chapter(document));
  assert.equal(calls, 1);
  assert.equal(result.reportedModel, config.defaultModel);
  assert.equal(result.usage.totalTokens, 150);
  assert.equal(result.content.items.length, 4);
  assert.equal(result.content.items[1].speakerId, result.content.items[0].id);
  assert.notEqual(result.content.items[0].id, '人物一');
  assert.ok(result.content.items.every(item => item.review === 'unreviewed'));
  validateNovelContent(result.content, document, chapter(document));
});

test('novel extractor rejects unconfigured and oversized chapters before transport', async () => {
  const document = source();
  let calls = 0;
  const transport = async () => { calls++; throw new Error('should not be called'); };
  await assert.rejects(new NovelExtractor({ ...config, apiKey: '' }, transport).extract(document, chapter(document)), { code: 'MODEL_NOT_CONFIGURED' });
  const oversized = buildNovelSource({ title: '长章', rawText: `第一章 雨\n${'雨'.repeat(20000)}` });
  await assert.rejects(new NovelExtractor(config, transport).extract(oversized, chapter(oversized)), { code: 'NOVEL_CHAPTER_TOO_LARGE' });
  assert.equal(calls, 0);
});

test('novel extractor never retries truncated, non-JSON, invalid-schema or fabricated-evidence output', async () => {
  const document = source();
  const invalidEvidence = modelOutput(document);
  invalidEvidence.entities[0].evidenceParagraphIds[0] = '不存在的原文';
  for (const [output, finish, code] of [
    [modelOutput(document), 'length', 'NOVEL_OUTPUT_INCOMPLETE'],
    ['```json\n{}\n```', 'stop', 'NOVEL_OUTPUT_NOT_JSON'],
    [{ items: [{ privateMessage: 'not for browser' }] }, 'stop', 'NOVEL_OUTPUT_SCHEMA_INVALID'],
    [invalidEvidence, 'stop', 'NOVEL_OUTPUT_EVIDENCE_INVALID'],
  ]) {
    let calls = 0;
    await assert.rejects(new NovelExtractor(config, async () => { calls++; return response(output, finish); }).extract(document, chapter(document)), error => {
      assert.equal(error.code, code);
      assert.equal(error.details.usage.totalTokens, 150);
      assert.ok(!JSON.stringify(error).includes('privateMessage'));
      assert.ok(!JSON.stringify(error).includes('不存在的原文'));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('model unknown speaker remains visibly uncertain, and duplicate/unknown quote ids are rejected', async () => {
  const document = source();
  const output = modelOutput(document);
  output.quotes[0].speakerTempId = null;
  const result = await new NovelExtractor(config, async () => response(output)).extract(document, chapter(document));
  assert.ok(result.content.items[1].uncertainty);
  assert.equal(result.content.items[1].speakerId, null);
  const duplicate = modelOutput(document);
  duplicate.quotes.push({ ...duplicate.quotes[0] });
  await assert.rejects(new NovelExtractor(config, async () => response(duplicate)).extract(document, chapter(document)), { code: 'NOVEL_OUTPUT_DUPLICATE_QUOTE' });
  const unknown = modelOutput(document);
  unknown.quotes[0].quoteId = 'q9999';
  await assert.rejects(new NovelExtractor(config, async () => response(unknown)).extract(document, chapter(document)), { code: 'NOVEL_OUTPUT_QUOTE_INVALID' });
});

test('compact response avoids repeated text and requires speaker attribution evidence', async () => {
  const document = source();
  const output = modelOutput(document);
  assert.ok(!JSON.stringify(output).includes('门已经开了。'));
  output.quotes[0].attributionParagraphIds = [];
  const result = await new NovelExtractor(config, async () => response(output)).extract(document, chapter(document));
  assert.equal(result.content.items[1].label, '门已经开了。');
  assert.equal(result.content.items[1].speakerId, null);
  assert.ok(result.content.items[1].uncertainty.includes('归属依据'));
  assert.ok(result.content.warnings.some(text => text.includes('未带引号')));
});

test('resume gate paragraph count matches the paragraphs sent to the model', () => {
  const document = source();
  for (const item of document.chapters) assert.equal(countNovelParagraphs(document, item), chapterParagraphs(document, item).length);
  const emoji = buildNovelSource({ title: '码点', rawText: `前言😀\r\n第一章 灯\r\n${'林舟😀\r\n'.repeat(3)}第二章 完\n尾` });
  for (const item of emoji.chapters) assert.equal(countNovelParagraphs(emoji, item), chapterParagraphs(emoji, item).length);
});

test('novel thinking rejection makes no fallback request', async () => {
  const document = source();
  let calls = 0;
  const extractor = new NovelExtractor(config, async (_, request) => {
    calls++;
    assert.deepEqual(JSON.parse(request.body).thinking, { type: 'disabled' });
    return new Response('unsupported thinking', { status: 400 });
  });
  await assert.rejects(extractor.extract(document, chapter(document)), { code: 'UPSTREAM_ERROR' });
  assert.equal(calls, 1);
});
