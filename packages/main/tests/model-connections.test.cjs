const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, stat, writeFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { assertUnixMode } = require('./platform.cjs');
const { readConfig } = require('../dist/config');
const { ModelConnections, configForRole, parseModelRole } = require('../dist/models/connections');
const { ModelClient } = require('../dist/models/client');
const { createApp } = require('../dist/app');
const { BreakdownService } = require('../dist/breakdown/service');
const { InMemoryBreakdownRepository } = require('../dist/breakdown/repository');
const { MaasStageModelAdapter } = require('../dist/breakdown/model-adapter');
const { ExtractFactsStageRunner, SingleModelCallExtractFactsExecutor } = require('../dist/breakdown/execution');
const { NovelService } = require('../dist/novel/service');
const { InMemoryNovelRepository } = require('../dist/novel/repository');
const { StoryboardService } = require('../dist/breakdown/storyboard');

const base = readConfig({ LLM_BASE_URL: 'https://legacy.test/v1', LLM_API_KEY: 'legacy-test-only' });
const fields = (overrides = {}) => ({ endpoint: 'https://new.test/v1/chat/completions', model: 'GPT-5.6 Sol',
  authType: 'bearer', apiKey: 'new-test-only', maxOutputTokens: 4096, timeoutMs: 10000, ...overrides });
const update = (store, role, overrides = {}) => store.update(role, { expectedRevision: store.public(role).revision, ...fields(overrides) });
const completion = (text = 'OK') => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: text } }] }));
const message = { messages: [{ role: 'user', content: '原创测试' }], allowPaid: true };
const headers = { host: '127.0.0.1:8788', 'x-shortdrama-call': '1' };

test('four independent connections preserve legacy text only, never return secrets and freeze running snapshots', async () => {
  const store = new ModelConnections(base);
  assert.equal(store.public('breakdown').configured, true);
  assert.equal(store.public('general').configured, true);
  assert.equal(store.public('image').configured, false);
  assert.equal(store.public('video').configured, false);
  const old = store.resolve('breakdown');
  await update(store, 'breakdown', { model: 'kimi-k3' });
  assert.equal(old.apiKey, 'legacy-test-only');
  assert.equal(old.defaultModel, base.defaultModel);
  assert.equal(store.resolve('breakdown').defaultModel, 'kimi-k3');
  assert.equal(store.resolve('general').apiKey, base.apiKey);
  assert.equal(configForRole({ ...base, modelConnections: store }, 'breakdown'), store.resolve('breakdown'));
  const publicJson = JSON.stringify(store.list());
  for (const key of ['legacy-test-only', 'new-test-only', '"apiKey"']) assert.equal(publicJson.includes(key), false);
  assert.equal(store.public('image').execution, 'asset-generation');
});

test('private atomic storage survives restart, keeps blank keys, explicitly clears one role and writes mode 0600', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'model-connections-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'private', 'connections.json');
  const store = new ModelConnections(base, file);
  await Promise.all([update(store, 'breakdown', { model: 'kimi-k3' }), update(store, 'general')]);
  let restarted = new ModelConnections(readConfig({}), file);
  assert.equal(restarted.resolve('breakdown').defaultModel, 'kimi-k3');
  assert.equal(restarted.resolve('general').defaultModel, 'GPT-5.6 Sol');
  assertUnixMode((await stat(file)).mode, 0o600);
  assertUnixMode((await stat(join(dir, 'private'))).mode, 0o700);
  await update(restarted, 'general', { model: 'GPT-5.6 Terra', apiKey: '' });
  assert.equal(restarted.resolve('general').apiKey, 'new-test-only');
  await update(restarted, 'general', { apiKey: '', clearApiKey: true });
  restarted = new ModelConnections(base, file);
  assert.equal(restarted.public('general').hasApiKey, false, 'must not restore environment key after explicit clearing');
  assert.equal(restarted.public('breakdown').hasApiKey, true);
  assert.equal((await readFile(file, 'utf8')).includes('legacy-test-only'), false);
});

test('read-only Worker follows API atomic updates without racing first-file initialization', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'model-connections-worker-sync-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'private', 'connections.json');
  const worker = new ModelConnections(base, file);
  await worker.initialize({ readOnly: true });
  await assert.rejects(readFile(file, 'utf8'), error => error.code === 'ENOENT');

  const api = new ModelConnections(base, file);
  await api.initialize();
  assert.equal(worker.resolve('general').apiKey, 'legacy-test-only');
  await update(api, 'general', { model: 'worker-synced-model', apiKey: 'worker-synced-key' });
  const refreshed = worker.resolve('general');
  assert.equal(refreshed.defaultModel, 'worker-synced-model');
  assert.equal(refreshed.apiKey, 'worker-synced-key');
  assert.equal(refreshed.connectionRevision, api.public('general').revision);
});

test('same-version concurrent edits conflict, invalid input never changes stored revision or leaks secrets', async () => {
  const store = new ModelConnections(base);
  const payload = { expectedRevision: store.public('general').revision, ...fields() };
  const results = await Promise.allSettled([store.update('general', payload), store.update('general', payload)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'MODEL_CONNECTION_CONFLICT');
  for (const bad of [ { endpoint: 'http://localhost/chat/completions' }, { endpoint: 'https://secret@host.test/v1/chat/completions' },
    { endpoint: 'https://host.test/v1/chat/completions?key=secret' }, { endpoint: 'https://host.test/v1' },
    { model: 'bad\r\nheader' }, { apiKey: 'secret\r\nInjected: yes' }, { maxOutputTokens: 10 }, { timeoutMs: 0 },
    { authType: 'custom' }, { clearApiKey: true }, { unknown: 'secret' } ]) {
    const before = store.public('general');
    await assert.rejects(update(store, 'general', bad), error => error.code === 'MODEL_CONNECTION_INVALID' && !error.message.includes('secret'));
    assert.deepEqual(store.public('general'), before);
  }
  assert.throws(() => parseModelRole('other'), { code: 'MODEL_CONNECTION_INVALID' });
});

test('image and video keep distinct endpoints and keys across restart without enabling generation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'media-model-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'connections.json');
  const store = new ModelConnections(base, file);
  await update(store, 'image', { endpoint: 'https://image.test/v1/images/generations', model: 'image-test', apiKey: 'image-test-key' });
  await update(store, 'video', { endpoint: 'https://video.test/v1/videos', model: 'video-test', apiKey: 'video-test-key', timeoutMs: 300000 });
  const reloaded = new ModelConnections(base, file);
  assert.equal(reloaded.resolve('image').endpointUrl, 'https://image.test/v1/images/generations');
  assert.equal(reloaded.resolve('video').endpointUrl, 'https://video.test/v1/videos');
  assert.equal(reloaded.resolve('video').apiKey, 'video-test-key');
  assert.equal(reloaded.resolve('video').timeoutMs, 300000);
  assert.equal(reloaded.resolve('image').apiKey, 'image-test-key');
  assert.equal(reloaded.resolve('general').apiKey, base.apiKey);
  for (const role of ['image', 'video']) {
    assert.equal(reloaded.public(role).configured, true);
    assert.equal(reloaded.public(role).execution, role === 'image' ? 'asset-generation' : 'task-api-ready');
  }
});

test('corrupt or unwritable private storage fails closed with no runtime mutation or environment fallback', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'model-store-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'bad.json');
  await writeFile(file, '{ broken test-only secret');
  assert.throws(() => new ModelConnections(base, file), { code: 'MODEL_CONNECTION_STORE_INVALID' });
  const blockedParent = join(dir, 'future');
  const store = new ModelConnections(base, join(blockedParent, 'child.json'));
  const before = store.public('general');
  await writeFile(blockedParent, 'test-only non-directory');
  await assert.rejects(update(store, 'general'), { code: 'MODEL_CONNECTION_SAVE_FAILED' });
  assert.deepEqual(store.public('general'), before);
});

test('Bearer models preserve spaces, route to exact endpoint, clamp output budget and never send MAAS thinking', async () => {
  const store = new ModelConnections(base);
  await update(store, 'general');
  let calls = 0;
  const client = new ModelClient(store.resolve('general'), async (url, options) => {
    calls++;
    assert.equal(url, fields().endpoint);
    assert.equal(options.headers.Authorization, 'Bearer new-test-only');
    assert.equal(options.headers['api-key'], undefined);
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'GPT-5.6 Sol');
    assert.equal(body.thinking, undefined);
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.stream, false);
    return completion();
  });
  await client.call({ ...message, thinking: 'disabled', maxOutputTokens: 8192 });
  await assert.rejects(client.call({ ...message, model: base.defaultModel }), { code: 'UNKNOWN_MODEL' });
  await assert.rejects(client.call({ ...message, allowPaid: false }), { code: 'INVALID_REQUEST' });
  assert.equal(calls, 1);
});

test('all role snapshots share the process call budget even after a connection is changed', async () => {
  const store = new ModelConnections({ ...base, maxConcurrentCalls: 1 });
  let release;
  const first = new ModelClient(store.resolve('breakdown'), () => new Promise(resolve => { release = () => resolve(completion()); }));
  const pending = first.call(message);
  await update(store, 'general');
  let calls = 0;
  await assert.rejects(new ModelClient(store.resolve('general'), async () => { calls++; return completion(); }).call(message), { code: 'LOCAL_BUSY' });
  assert.equal(calls, 0);
  release(); await pending;
});

test('settings HTTP requires local write intent, returns no secrets, and general calls cannot use media or breakdown config', async t => {
  const store = new ModelConnections(base);
  const routed = [];
  const app = await createApp({ ...base, modelConnections: store }, async (url, options) => {
    routed.push({ url, model: JSON.parse(options.body).model }); return completion();
  });
  t.after(() => app.close());
  const server = app.getHttpAdapter().getInstance();
  const invoke = (url, body, customHeaders = headers) => server.inject({ method: body ? 'POST' : 'GET', url, headers: customHeaders, ...(body ? { payload: body } : {}) });
  const initial = await invoke('/api/model-connections');
  assert.equal(initial.statusCode, 200); assert.equal(initial.headers['cache-control'], 'no-store');
  assert.equal(initial.body.includes('legacy-test-only'), false);
  const payload = { expectedRevision: store.public('general').revision, ...fields() };
  assert.equal((await invoke('/api/model-connections/general', payload, { host: headers.host })).statusCode, 403);
  assert.equal((await invoke('/api/model-connections/general', payload, { ...headers, origin: 'https://evil.test' })).statusCode, 403);
  const saved = await invoke('/api/model-connections/general', payload);
  assert.equal(saved.statusCode, 200); assert.equal(saved.body.includes('new-test-only'), false);
  assert.equal((await invoke('/api/models?role=general')).json().defaultModel, 'GPT-5.6 Sol');
  assert.equal((await invoke('/api/models?role=general')).json().maxOutputTokens, 4096);
  assert.equal((await invoke('/api/models?role=breakdown')).json().defaultModel, base.defaultModel);
  assert.equal((await invoke('/api/models?role=image')).statusCode, 400);
  assert.equal(routed.length, 0, 'saving config and reading catalog must not spend tokens');
  assert.equal((await invoke('/api/model-calls', message)).statusCode, 200);
  assert.deepEqual(routed, [{ url: fields().endpoint, model: 'GPT-5.6 Sol' }]);
});

test('draft runs snapshot only breakdown identity and changing its connection stops stale runs before an attempt', async () => {
  const store = new ModelConnections(base);
  await update(store, 'breakdown', { model: 'kimi-k3' });
  const config = { ...base, modelConnections: store };
  const repository = new InMemoryBreakdownRepository();
  const service = new BreakdownService(repository, config);
  const project = await service.createProject({ title: '独立拆解配置' });
  await service.createScriptVersion(project.id, { rawText: '第一场 小屋 夜\n阿甲进入房间。' });
  const run = await service.createDraftRun(project.id, { maxModelCalls: 1, maxOutputTokens: 4096 });
  assert.equal(run.modelConfig.model, 'kimi-k3');
  assert.equal(run.modelConfig.provider, 'openai-compatible');
  assert.equal(run.modelConfig.connectionRevision, store.public('breakdown').revision);
  assert.equal(JSON.stringify(run).includes('new-test-only'), false);
  const adapter = new MaasStageModelAdapter(config, async () => { throw new Error('must not call'); });
  const runner = new ExtractFactsStageRunner(repository, service, new SingleModelCallExtractFactsExecutor(), adapter);
  await update(store, 'general', { model: 'GPT-5.6 Terra' });
  assert.doesNotThrow(() => adapter.forRun(run.modelConfig));
  await update(store, 'breakdown', { model: 'kimi-k3', endpoint: 'https://other.test/v1/chat/completions' });
  await assert.rejects(runner.run(run.id), { code: 'MODEL_CONFIGURATION_CHANGED' });
  assert.equal((await service.getRun(run.id)).status, 'draft');
});

test('novel stages use a single breakdown snapshot while later requests use the newly saved model', async () => {
  const store = new ModelConnections(base);
  await update(store, 'breakdown', { model: 'kimi-k3' });
  await update(store, 'general', { model: 'GPT-5.6 Sol' });
  const calls = [];
  const service = new NovelService(new InMemoryNovelRepository(), { ...base, modelConnections: store }, async (url, options) => {
    const body = JSON.parse(options.body); calls.push(body.model);
    if (calls.length === 1) await update(store, 'breakdown', { model: 'replacement-text' });
    const stage = (calls.length - 1) % 3;
    const data = JSON.parse(body.messages[1].content);
    const output = stage === 0 ? { entities: [], quotes: [] } : stage === 1
      ? { entities: [], paragraphs: data.paragraphs.map(p => [p.id, []]) } : { issues: [] };
    return completion(JSON.stringify(output));
  });
  const source = await service.create({ title: '原创配置验收', rawText: '第一章\n甲走路。\n第二章\n乙回家。' });
  await service.extract(source.chapters[0].id, { expectedRevisionId: null, mode: 'reviewed', allowPaid: true });
  await service.extract(source.chapters[1].id, { expectedRevisionId: null, mode: 'reviewed', allowPaid: true });
  assert.deepEqual(calls, ['kimi-k3', 'kimi-k3', 'kimi-k3', 'replacement-text', 'replacement-text', 'replacement-text']);
  assert.equal((await service.attempts(source.chapters[0].id))[0].model, 'kimi-k3');
});

test('storyboard uses general configuration and never falls back to configured breakdown', async () => {
  const store = new ModelConnections(base);
  await update(store, 'general', { apiKey: '', clearApiKey: true });
  let writes = 0;
  const service = new StoryboardService({ query: () => { writes++; } }, {}, { ...base, modelConnections: store }, () => { throw new Error('must not call'); });
  await assert.rejects(service.generate('project'), { code: 'MODEL_NOT_CONFIGURED' });
  assert.equal(writes, 0);
});
