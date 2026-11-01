const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { buildNovelSource, createReviewSeed } = require('@ohao/shared');
const { InMemoryNovelRepository } = require('../dist/novel/repository');

// Original synthetic prose, not copied from any published novel.
const rawText = '试读前言\r\n第一章 灯塔\r\n阿澄握着铜钥匙，站在灯塔外。😀\r\n“等雨停。”阿澄说。\r\n第二章 长廊\r\n夏禾把木匣放在长廊。\r\n“谁在那里？”她问。\r\n第三章 渡口\r\n阿澄在渡口接过纸船。\r\n“我也许认错了人。”\r\n';
function source() { return buildNovelSource({ title: '三章原创持久化测试', rawText, sourceUrl: 'https://example.com/original-fixture' }); }
function revision(document, chapter, parentRevisionId = null, createdBy = 'program') {
  return { id: randomUUID(), chapterId: chapter.id, parentRevisionId, createdBy,
    createdAt: new Date().toISOString(), content: createReviewSeed(document, chapter) };
}
function attempt(chapter, expectedRevisionId = null) {
  return { id: randomUUID(), chapterId: chapter.id, expectedRevisionId,
    model: 'test-only-text-model', startedAt: new Date().toISOString() };
}
const errorCode = code => error => error.code === code;

test('novel source preserves exact text, chapter ranges, and isolated returned values', async () => {
  const repository = new InMemoryNovelRepository();
  const input = source();
  const saved = await repository.createSource(input);
  assert.equal(saved.rawText, rawText);
  assert.equal(saved.chapters.length, 3);
  assert.deepEqual(await repository.listSources(), [{ id: saved.id, title: saved.title,
    createdAt: saved.createdAt, chapterCount: 3 }]);
  saved.title = 'returned value changed';
  input.rawText = 'input changed';
  const loaded = await repository.getChapterSource(saved.chapters[1].id);
  assert.equal(loaded.rawText, rawText);
  assert.equal(loaded.title, '三章原创持久化测试');
  loaded.chapters[0].latestRevisionId = 'not-persisted';
  assert.equal((await repository.getSource(saved.id)).chapters[0].latestRevisionId, null);
  assert.equal(await repository.getSource('missing'), null);
  assert.equal(await repository.getChapterSource('missing'), null);
});

test('novel source rejects mismatched hashes and broken boundaries without partial writes', async () => {
  const repository = new InMemoryNovelRepository();
  const input = source();
  await assert.rejects(repository.createSource({ ...input, rawText: `${rawText}改` }), errorCode('INVALID_NOVEL_RECORD'));
  const broken = structuredClone(input);
  broken.chapters[1].start++;
  await assert.rejects(repository.createSource(broken), errorCode('INVALID_NOVEL_RECORD'));
  broken.chapters[1].start--;
  broken.chapters[1].documentId = 'other';
  await assert.rejects(repository.createSource(broken), errorCode('INVALID_NOVEL_RECORD'));
  assert.deepEqual(await repository.listSources(), []);
});

test('novel source persistence also preserves standalone CR chapter separators', async () => {
  const repository = new InMemoryNovelRepository();
  const document = buildNovelSource({ title: 'CR 原创短例', rawText: '第一章 开门\r夏禾打开木门。\r第二章 回信\r“请进。”\r第三章 等候\r阿澄点头。' });
  const saved = await repository.createSource(document);
  assert.equal(saved.chapters.length, 3);
  assert.equal(saved.rawText, document.rawText);
  const second = await repository.saveRevision(revision(document, document.chapters[1]), null);
  assert.equal(second.content.items[0].sourceRefs[0].quote, '请进。');
});

test('three novel chapters save independently and proofreading appends immutable history', async () => {
  const repository = new InMemoryNovelRepository();
  const document = await repository.createSource(source());
  const initial = await Promise.all(document.chapters.map(chapter => repository.saveRevision(revision(document, chapter), null)));
  const original = structuredClone(initial[0]);
  const edit = revision(document, document.chapters[0], initial[0].id, 'user');
  edit.content.items[0].description = '人工校对：说话人仍待确认。';
  edit.content.items[0].origin = 'user';
  const saved = await repository.saveRevision(edit, initial[0].id);
  saved.content.items[0].label = 'caller mutation';
  edit.content.items[0].description = 'caller mutation';
  assert.deepEqual(await repository.getRevision(initial[0].id), original);
  assert.equal((await repository.getRevision(saved.id)).content.items[0].description, '人工校对：说话人仍待确认。');
  assert.deepEqual((await repository.listRevisions(document.chapters[0].id)).map(item => item.id), [initial[0].id, saved.id]);
  for (let index = 1; index < 3; index++) assert.deepEqual(await repository.listRevisions(document.chapters[index].id), [initial[index]]);
  assert.deepEqual((await repository.getSource(document.id)).chapters.map(chapter => chapter.latestRevisionId), [saved.id, initial[1].id, initial[2].id]);
});

test('concurrent chapter saves accept exactly one and stale or cross-chapter parents cannot overwrite it', async () => {
  const repository = new InMemoryNovelRepository();
  const document = await repository.createSource(source());
  const first = document.chapters[0];
  const competing = [revision(document, first), revision(document, first)];
  const results = await Promise.allSettled(competing.map(value => repository.saveRevision(value, null)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'NOVEL_REVISION_CONFLICT');
  const current = results.find(result => result.status === 'fulfilled').value;
  await assert.rejects(repository.saveRevision(revision(document, first), current.id), errorCode('NOVEL_REVISION_CONFLICT'));
  await assert.rejects(repository.saveRevision(revision(document, document.chapters[1], current.id), current.id), errorCode('NOVEL_REVISION_CONFLICT'));
  await assert.rejects(repository.saveRevision(revision(document, first), null), errorCode('NOVEL_REVISION_CONFLICT'));
  assert.equal((await repository.listRevisions(first.id)).length, 1);
});

test('stored novel content requires exact in-chapter evidence, including non-BMP offsets', async () => {
  const repository = new InMemoryNovelRepository();
  const document = await repository.createSource(source());
  const first = revision(document, document.chapters[0]);
  const second = revision(document, document.chapters[1]);
  first.content.items[0].sourceRefs = structuredClone(second.content.items[0].sourceRefs);
  first.content.items[0].label = first.content.items[0].sourceRefs[0].quote;
  await assert.rejects(repository.saveRevision(first, null), errorCode('NOVEL_EVIDENCE_MISMATCH'));
  const wrongQuote = revision(document, document.chapters[0]);
  wrongQuote.content.items[0].sourceRefs[0].quote += '改写';
  await assert.rejects(repository.saveRevision(wrongQuote, null), errorCode('NOVEL_EVIDENCE_MISMATCH'));
  const valid = await repository.saveRevision(revision(document, document.chapters[0]), null);
  const evidence = valid.content.items[0].sourceRefs[0];
  assert.equal(Array.from(rawText).slice(evidence.start, evidence.end).join(''), evidence.quote);
});

test('in-flight calls do not lock proofreading; late model saves conflict and retain usage', async () => {
  const repository = new InMemoryNovelRepository();
  const document = await repository.createSource(source());
  const chapter = document.chapters[0];
  const input = attempt(chapter);
  await repository.beginAttempt(input);
  assert.equal((await repository.listAttempts(chapter.id))[0].status, 'submitted');
  await assert.rejects(repository.beginAttempt(attempt(chapter)), errorCode('NOVEL_ATTEMPT_PENDING'));
  const manual = await repository.saveRevision(revision(document, chapter, null, 'user'), null);
  await assert.rejects(repository.saveRevision(revision(document, chapter, null, 'model'), null), errorCode('NOVEL_REVISION_CONFLICT'));
  const finish = { status: 'failed', errorCode: 'NOVEL_REVISION_CONFLICT',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, reasoningTokens: null },
    endedAt: new Date().toISOString(), revisionId: null };
  await repository.finishAttempt(input.id, finish);
  finish.usage.inputTokens = 999;
  const [logged] = await repository.listAttempts(chapter.id);
  assert.equal(logged.usage.inputTokens, 100);
  assert.equal(logged.errorCode, 'NOVEL_REVISION_CONFLICT');
  logged.usage.inputTokens = 666;
  assert.equal((await repository.listAttempts(chapter.id))[0].usage.inputTokens, 100);
  await assert.rejects(repository.finishAttempt(input.id, finish), errorCode('NOVEL_ATTEMPT_FINISHED'));
  await repository.beginAttempt(attempt(chapter, manual.id));
});

test('unknown call blocks only its own chapter and cannot silently be reset by another finish', async () => {
  const repository = new InMemoryNovelRepository();
  const document = await repository.createSource(source());
  const input = attempt(document.chapters[0]);
  await repository.beginAttempt(input);
  await repository.finishAttempt(input.id, { status: 'unknown', errorCode: 'UPSTREAM_TIMEOUT', usage: null,
    endedAt: new Date().toISOString(), revisionId: null });
  await assert.rejects(repository.beginAttempt(attempt(document.chapters[0])), errorCode('NOVEL_ATTEMPT_PENDING'));
  await repository.beginAttempt(attempt(document.chapters[1]));
  await repository.saveRevision(revision(document, document.chapters[0], null, 'user'), null);
  assert.equal((await repository.listAttempts(document.chapters[0].id))[0].status, 'unknown');
});

test('ledger refuses raw response usage and results pointing to another chapter', async () => {
  const repository = new InMemoryNovelRepository();
  const document = await repository.createSource(source());
  const input = attempt(document.chapters[0]);
  await repository.beginAttempt(input);
  const other = await repository.saveRevision(revision(document, document.chapters[1]), null);
  const finish = { status: 'failed', errorCode: 'MODEL_ERROR', usage: { body: 'private upstream body' },
    endedAt: new Date().toISOString(), revisionId: null };
  await assert.rejects(repository.finishAttempt(input.id, finish), errorCode('INVALID_NOVEL_RECORD'));
  await assert.rejects(repository.finishAttempt(input.id, { ...finish, status: 'succeeded', errorCode: null,
    usage: null, revisionId: other.id }), errorCode('INVALID_NOVEL_RECORD'));
  assert.equal((await repository.listAttempts(document.chapters[0].id))[0].status, 'submitted');
});
