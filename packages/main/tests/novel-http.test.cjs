const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const { InMemoryNovelRepository } = require('../dist/novel/repository');
const { NovelService } = require('../dist/novel/service');

// Original test prose: these tests never download a published novel or call a model.
const RAW_TEXT = '第一章 灯塔\r\n阿澄握着铜钥匙，站在灯塔外。😀\r\n“等雨停。”阿澄说。\r\n第二章 长廊\r\n夏禾把木匣放在长廊。\r\n“谁在那里？”她问。\r\n第三章 渡口\r\n阿澄在渡口接过纸船。\r\n“也许是他。”\r\n';
const CONFIG = readConfig({ LLM_BASE_URL: 'https://model.test/novel', LLM_API_KEY: 'synthetic-test-key' });
const headers = { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:5173', 'x-shortdrama-call': '1' };
const body = response => JSON.parse(response.body);

function completion(content, finishReason = 'stop') {
  return new Response(JSON.stringify({ id: 'synthetic-novel-response', model: CONFIG.defaultModel,
    choices: [{ finish_reason: finishReason, message: { content } }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18,
      completion_tokens_details: { reasoning_tokens: 2 } },
  }), { headers: { 'Content-Type': 'application/json' } });
}
function modelOutput(requestBody) {
  const prompt = JSON.parse(requestBody.messages.find(message => message.role === 'user').content);
  assert.equal(prompt.operation, 'extractNovelChapter');
  assert.equal(prompt.chapterTitle, '第一章 灯塔');
  assert.equal(prompt.paragraphs.some(paragraph => paragraph.text.includes('第二章')), false);
  return {
    entities: [
      { tempId: 'c1', kind: 'character', label: '阿澄', description: '握着铜钥匙的人物。', evidenceParagraphIds: ['p0002'], uncertainty: null },
      { tempId: 'l1', kind: 'location', label: '灯塔外', description: '阿澄所在地点。', evidenceParagraphIds: ['p0002'], uncertainty: null },
      { tempId: 'p1', kind: 'prop', label: '铜钥匙', description: '阿澄握着的物品。', evidenceParagraphIds: ['p0002'], uncertainty: null },
    ],
    quotes: [{ quoteId: prompt.quoteCandidates[0].quoteId, speakerTempId: 'c1', classification: 'speech',
      attributionParagraphIds: ['p0003'], uncertainty: null }],
  };
}
async function setup(handler = async request => completion(JSON.stringify(modelOutput(request))), options = {}) {
  let calls = 0;
  const transport = async (url, request) => {
    calls++;
    assert.equal(url, 'https://model.test/novel/chat/completions');
    assert.equal(request.headers['api-key'], 'synthetic-test-key');
    assert.equal(request.headers.Authorization, undefined);
    const parsed = JSON.parse(request.body);
    assert.equal(parsed.stream, false);
    assert.equal(parsed.model, 'deepseek-v4.1-flash-1017');
    assert.equal(Object.hasOwn(parsed, 'reasoning_effort'), false);
    return handler(parsed);
  };
  const repository = new InMemoryNovelRepository();
  const service = new NovelService(repository, CONFIG, transport);
  const app = await createApp(CONFIG, transport, options.unavailable ? {} : { novelService: service });
  const request = (method, url, payload) => app.inject({ method, url, headers,
    ...(payload === undefined ? {} : { payload }) });
  return { app, request, calls: () => calls, repository };
}
async function create(request) {
  const response = await request('POST', '/api/novels', { title: '原创三章 API 验证', rawText: RAW_TEXT,
    sourceUrl: 'https://example.com/original-novel-test' });
  assert.equal(response.statusCode, 201, response.body);
  return body(response);
}
async function seed(request, chapterId) {
  const response = await request('POST', `/api/novel-chapters/${chapterId}/seed`, { expectedRevisionId: null });
  assert.equal(response.statusCode, 201, response.body);
  return body(response);
}
const history = async (request, chapterId) => body(await request('GET', `/api/novel-chapters/${chapterId}/revisions`)).revisions;
const attempts = async (request, chapterId) => body(await request('GET', `/api/novel-chapters/${chapterId}/attempts`)).attempts;
function correction(revision, description) {
  const items = structuredClone(revision.content.items);
  items[0].description = description;
  return { expectedRevisionId: revision.id, items };
}
function assertUsage(usage) {
  assert.deepEqual(usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18, reasoningTokens: 2 });
}

test('novel HTTP preserves three independent chapters, exact evidence, and immutable proofreading history', async () => {
  const { app, request, calls } = await setup();
  try {
    const document = await create(request);
    assert.equal(document.rawText, RAW_TEXT);
    assert.equal(document.chapters.length, 3);
    const listed = body(await request('GET', '/api/novels')).novels;
    assert.equal(listed[0].chapterCount, 3);
    const originals = [];
    const corrected = [];
    for (const chapter of document.chapters) {
      const initial = await seed(request, chapter.id);
      originals.push(initial);
      assert.equal(initial.createdBy, 'program');
      assert.equal(initial.content.items[0].classification, 'uncertain');
      assert.ok(initial.content.items[0].uncertainty);
      const quote = initial.content.items[0].sourceRefs[0];
      assert.equal(Array.from(RAW_TEXT).slice(quote.start, quote.end).join(''), quote.quote);
      const response = await request('POST', `/api/novel-revisions/${initial.id}/corrections`, correction(initial, `第 ${chapter.order} 章人工校对`));
      assert.equal(response.statusCode, 201, response.body);
      const saved = body(response);
      corrected.push(saved);
      assert.equal(saved.createdBy, 'user');
      assert.equal(saved.content.items[0].origin, 'user');
      assert.deepEqual(saved.content.items[0].sourceRefs, initial.content.items[0].sourceRefs);
      assert.deepEqual(await history(request, chapter.id), [initial, saved]);
    }
    const loaded = body(await request('GET', `/api/novels/${document.id}`));
    assert.deepEqual(loaded.chapters.map(chapter => chapter.latestRevisionId), corrected.map(revision => revision.id));
    assert.equal(loaded.rawText, RAW_TEXT);
    const stale = await request('POST', `/api/novel-revisions/${originals[0].id}/corrections`, correction(originals[0], '旧页面的修改'));
    assert.equal(stale.statusCode, 409);
    assert.equal(body(stale).error.code, 'NOVEL_REVISION_CONFLICT');
    const crossChapter = correction(corrected[0], '错误跨章证据');
    crossChapter.items[0].sourceRefs = structuredClone(corrected[1].content.items[0].sourceRefs);
    crossChapter.items[0].label = crossChapter.items[0].sourceRefs[0].quote;
    const rejected = await request('POST', `/api/novel-revisions/${corrected[0].id}/corrections`, crossChapter);
    assert.equal(rejected.statusCode, 400);
    assert.equal(body(rejected).error.code, 'NOVEL_EVIDENCE_MISMATCH');
    assert.deepEqual(await history(request, document.chapters[0].id), [originals[0], corrected[0]]);
    assert.equal(calls(), 0, 'import, seed, proofreading, and reread are free local operations');
  } finally { await app.close(); }
});

test('novel HTTP requires paid opt-in before a single bounded model call and persists successful evidence', async () => {
  const { app, request, calls } = await setup();
  try {
    const document = await create(request);
    const chapter = document.chapters[0];
    for (const allowPaid of [undefined, false]) {
      const response = await request('POST', `/api/novel-chapters/${chapter.id}/extract`,
        { expectedRevisionId: null, ...(allowPaid === undefined ? {} : { allowPaid }) });
      assert.equal(response.statusCode, 400);
      assert.equal(body(response).error.code, 'PAID_CONFIRMATION_REQUIRED');
    }
    assert.equal(calls(), 0);
    assert.deepEqual(await attempts(request, chapter.id), []);
    const result = await request('POST', `/api/novel-chapters/${chapter.id}/extract`, { expectedRevisionId: null, allowPaid: true });
    assert.equal(result.statusCode, 201, result.body);
    assert.equal(calls(), 1);
    const revision = body(result);
    assert.deepEqual(revision.content.items.map(item => item.kind), ['character', 'location', 'prop', 'dialogue']);
    for (const item of revision.content.items) {
      assert.equal(item.review, 'unreviewed');
      for (const ref of item.sourceRefs) assert.equal(Array.from(RAW_TEXT).slice(ref.start, ref.end).join(''), ref.quote);
    }
    assert.equal(revision.content.items[3].speakerId, revision.content.items[0].id);
    const [logged] = await attempts(request, chapter.id);
    assert.equal(logged.status, 'succeeded');
    assert.equal(logged.revisionId, revision.id);
    assertUsage(logged.usage);
    assert.deepEqual(await history(request, document.chapters[1].id), []);
  } finally { await app.close(); }
});

test('novel routes fail clearly with 503 when persistent service is absent', async () => {
  const { app, request, calls } = await setup(undefined, { unavailable: true });
  try {
    for (const [method, url, payload] of [
      ['GET', '/api/novels'], ['POST', '/api/novels', { title: '未保存', rawText: RAW_TEXT }],
      ['POST', '/api/novel-chapters/missing/extract', { expectedRevisionId: null, allowPaid: true }],
    ]) {
      const response = await request(method, url, payload);
      assert.equal(response.statusCode, 503);
      assert.equal(body(response).error.code, 'NOVEL_PERSISTENCE_UNAVAILABLE');
    }
    assert.equal(calls(), 0);
  } finally { await app.close(); }
});

test('malformed model JSON keeps token usage, saves no revision, and is never automatically retried', async () => {
  const { app, request, calls } = await setup(async () => completion('private-synthetic-malformed-output'));
  try {
    const document = await create(request);
    const chapter = document.chapters[0];
    const response = await request('POST', `/api/novel-chapters/${chapter.id}/extract`, { expectedRevisionId: null, allowPaid: true });
    assert.equal(response.statusCode, 422);
    assert.equal(body(response).error.code, 'NOVEL_OUTPUT_NOT_JSON');
    assert.equal(response.body.includes('private-synthetic-malformed-output'), false);
    assert.equal(response.body.includes('synthetic-test-key'), false);
    assert.equal(calls(), 1);
    assert.deepEqual(await history(request, chapter.id), []);
    const [logged] = await attempts(request, chapter.id);
    assert.equal(logged.status, 'failed');
    assert.equal(logged.errorCode, 'NOVEL_OUTPUT_NOT_JSON');
    assertUsage(logged.usage);
  } finally { await app.close(); }
});

test('empty model text still records billed usage from a ModelError and never retries', async () => {
  const { app, request, calls } = await setup(async () => completion(''));
  try {
    const document = await create(request);
    const chapter = document.chapters[0];
    const response = await request('POST', `/api/novel-chapters/${chapter.id}/extract`, { expectedRevisionId: null, allowPaid: true });
    assert.equal(response.statusCode, 502);
    assert.equal(body(response).error.code, 'EMPTY_OUTPUT');
    assert.equal(calls(), 1);
    const [logged] = await attempts(request, chapter.id);
    assert.equal(logged.status, 'failed');
    assert.equal(logged.errorCode, 'EMPTY_OUTPUT');
    assertUsage(logged.usage);
    assert.deepEqual(await history(request, chapter.id), []);
  } finally { await app.close(); }
});

test('unknown network outcome persists its lock and refuses a later paid submission', async () => {
  const { app, request, calls } = await setup(async () => { throw new Error('private-synthetic-network-detail'); });
  try {
    const document = await create(request);
    const chapter = document.chapters[0];
    const payload = { expectedRevisionId: null, allowPaid: true };
    const failed = await request('POST', `/api/novel-chapters/${chapter.id}/extract`, payload);
    assert.equal(failed.statusCode, 502);
    assert.equal(body(failed).error.code, 'PROXY_UNAVAILABLE');
    assert.equal(failed.body.includes('private-synthetic-network-detail'), false);
    assert.equal((await attempts(request, chapter.id))[0].status, 'unknown');
    const repeated = await request('POST', `/api/novel-chapters/${chapter.id}/extract`, payload);
    assert.equal(repeated.statusCode, 409);
    assert.equal(body(repeated).error.code, 'NOVEL_ATTEMPT_PENDING');
    assert.equal(calls(), 1);
    assert.equal((await attempts(request, chapter.id)).length, 1);
  } finally { await app.close(); }
});

test('a delayed fake model cannot replace concurrent human proofreading over HTTP', async () => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const { app, request, calls } = await setup(async parsed => {
    entered();
    await gate;
    return completion(JSON.stringify(modelOutput(parsed)));
  });
  let pending;
  try {
    const document = await create(request);
    const chapter = document.chapters[0];
    const initial = await seed(request, chapter.id);
    pending = request('POST', `/api/novel-chapters/${chapter.id}/extract`, { expectedRevisionId: initial.id, allowPaid: true });
    // Fastify injection is thenable: attach before waiting for its fake transport.
    pending = Promise.resolve(pending);
    await within(started, 5000);
    assert.equal((await attempts(request, chapter.id))[0].status, 'submitted');
    const edited = await request('POST', `/api/novel-revisions/${initial.id}/corrections`, correction(initial, '模型等待期间保存的人工校对'));
    assert.equal(edited.statusCode, 201, edited.body);
    release();
    const late = await pending;
    assert.equal(late.statusCode, 409);
    assert.equal(body(late).error.code, 'NOVEL_REVISION_CONFLICT');
    assert.equal(calls(), 1);
    assert.deepEqual(await history(request, chapter.id), [initial, body(edited)]);
    const source = body(await request('GET', `/api/novels/${document.id}`));
    assert.equal(source.chapters[0].latestRevisionId, body(edited).id);
    const [logged] = await attempts(request, chapter.id);
    assert.equal(logged.status, 'failed');
    assert.equal(logged.errorCode, 'NOVEL_REVISION_CONFLICT');
    assertUsage(logged.usage);
    assert.equal(logged.revisionId, null);
  } finally { release(); await pending?.catch(() => undefined); await app.close(); }
});

async function within(promise, milliseconds) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Fake model transport did not start')), milliseconds);
    })]);
  } finally { clearTimeout(timeout); }
}
