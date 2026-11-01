const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  buildEvidenceAliasCatalog,
  buildScriptSourceIndex,
  createPromptChunks,
  createScriptVersion,
  reconstructSource,
  sliceCodePoints,
  sourceRefForSpan,
  validatePromptChunks,
  validateScriptSourceIndex,
} = require('../dist/breakdown/source-index');

function version(rawText) {
  return createScriptVersion({
    id: 'script_test_v1',
    projectId: 'project_test',
    version: 1,
    rawText,
    createdAt: '2026-09-30T00:00:00.000Z',
  });
}

test('source index preserves every code point and emits code-point-safe SourceRefs', () => {
  const rawText = [
    '《😀夜戏》',
    '',
    '第十二场 医院走廊 夜 内',
    '林晚（停住）：你终于来了？',
    '顾沉：我知道。',
    '她握紧门把手。',
  ].join('\r\n') + '\r\n';
  const index = buildScriptSourceIndex(version(rawText));
  validateScriptSourceIndex(index);
  assert.equal(reconstructSource(index), rawText);

  assert.equal(index.spans[0].kind, 'titleCandidate');
  assert.equal(index.spans[1].kind, 'headingCandidate');
  const dialogue = index.spans.find(span => span.speakerCandidate === '林晚');
  assert.ok(dialogue);
  assert.equal(dialogue.kind, 'dialogueTurnCandidate');
  const ref = sourceRefForSpan(index, dialogue.id);
  assert.equal(ref.quote, '林晚（停住）：你终于来了？');
  assert.equal(sliceCodePoints(rawText, ref.start, ref.end), ref.quote);
  assert.equal(Array.from(rawText)[ref.start], '林');
});

test('column-aligned stage-play names become dialogue candidates without treating metadata as dialogue', () => {
  const rawText = [
    '《终身大事》结尾节选',
    '作者：胡适',
    '',
    '【结尾节选】',
    '李妈　　　　（从左边门出来）午饭摆好了。',
    '田先生　　　来，来，来。我们吃了饭再谈罢。',
    '田女　　　　我不要吃饭。',
  ].join('\n');
  const index = buildScriptSourceIndex(version(rawText));
  const speakers = index.spans
    .filter(span => span.kind === 'dialogueTurnCandidate')
    .map(span => span.speakerCandidate);
  assert.deepEqual(speakers, ['李妈', '田先生', '田女']);
  assert.equal(index.spans.some(span => span.speakerCandidate === '作者'), false);
});

test('the real legacy stage-play fixture remains lossless and keeps its aligned dialogue turns', () => {
  const rawText = readFileSync(join(__dirname, '..', 'examples', '终身大事-结尾节选.txt'), 'utf8');
  const index = buildScriptSourceIndex(version(rawText));
  const chunks = createPromptChunks(index, { targetEstimatedTokens: 180 });
  validateScriptSourceIndex(index);
  validatePromptChunks(index, chunks);
  assert.equal(reconstructSource(index), rawText);
  const speakers = new Set(index.spans
    .filter(span => span.kind === 'dialogueTurnCandidate')
    .map(span => span.speakerCandidate));
  for (const name of ['李妈', '田先生', '田太太', '田女']) assert.ok(speakers.has(name));
  assert.deepEqual(chunks.flatMap(chunk => chunk.primarySpanIds), index.spans.map(span => span.id));
});

test('prompt chunks keep primary ownership unique and use adaptive context only at soft boundaries', () => {
  const rawText = [
    '第1场 医院走廊 夜 内',
    '林晚：你终于来了。',
    '顾沉：我一直在等。',
    '她松开门把手。',
    '',
    '风从走廊尽头灌进来。',
    '林晚：别再跟着我。',
    '顾沉：我不会走。',
    '',
    '第2场 天台 夜 外',
    '风很大。',
    '林晚：现在就结束。',
  ].join('\n');
  const index = buildScriptSourceIndex(version(rawText));
  const chunks = createPromptChunks(index, { targetEstimatedTokens: 36 });
  validatePromptChunks(index, chunks);
  assert.ok(chunks.length >= 3);

  const primaryIds = chunks.flatMap(chunk => chunk.primarySpanIds);
  assert.deepEqual(primaryIds, index.spans.map(span => span.id));
  assert.equal(new Set(primaryIds).size, index.spans.length);
  assert.ok(chunks.some(chunk => chunk.contextSpanIds.length > 0));
  for (const chunk of chunks) {
    for (const spanId of chunk.contextSpanIds) assert.ok(!chunk.primarySpanIds.includes(spanId));
  }

  const secondHeading = index.spans.find(span => span.quote === '第2场 天台 夜 外');
  assert.ok(secondHeading);
  const headingChunk = chunks.find(chunk => chunk.primarySpanIds.includes(secondHeading.id));
  assert.ok(headingChunk);
  assert.equal(headingChunk.boundaryBefore, 'heading');
  assert.equal(headingChunk.contextSpanIds.includes(primaryIds[primaryIds.indexOf(secondHeading.id) - 1]), false);
});

test('an oversized dialogue remains an atomic primary span instead of being cut mid-line', () => {
  const rawText = `林晚：${'我不会离开。'.repeat(30)}`;
  const index = buildScriptSourceIndex(version(rawText));
  const dialogue = index.spans.find(span => span.kind === 'dialogueTurnCandidate');
  assert.ok(dialogue);
  const chunks = createPromptChunks(index, { targetEstimatedTokens: 20 });
  const owner = chunks.find(chunk => chunk.primarySpanIds.includes(dialogue.id));
  assert.ok(owner);
  assert.deepEqual(owner.primarySpanIds, [dialogue.id]);
  assert.deepEqual(owner.oversizedPrimarySpanIds, [dialogue.id]);
});

test('evidence aliases stay task-local and distinguish primary evidence from context-only spans', () => {
  const rawText = ['她抬头。', '', '他：别走。', '她没有回答。'].join('\n');
  const index = buildScriptSourceIndex(version(rawText));
  const chunks = createPromptChunks(index, { targetEstimatedTokens: 12 });
  const chunk = chunks.find(item => item.contextSpanIds.length > 0);
  assert.ok(chunk);
  const aliases = buildEvidenceAliasCatalog(index, chunk);
  assert.ok(aliases.some(alias => alias.alias === 'E001' && alias.role === 'primary'));
  assert.ok(aliases.some(alias => alias.alias === 'C001' && alias.role === 'context'));
  for (const alias of aliases) {
    assert.equal(sliceCodePoints(rawText, alias.sourceRef.start, alias.sourceRef.end), alias.sourceRef.quote);
  }
});
