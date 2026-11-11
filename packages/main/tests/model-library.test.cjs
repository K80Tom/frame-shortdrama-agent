const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, stat, writeFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { assertUnixMode } = require('./platform.cjs');
const { readConfig } = require('../dist/config');
const { ModelConnections } = require('../dist/models/connections');
const { ModelClient } = require('../dist/models/client');
const { createApp } = require('../dist/app');
const { BreakdownService } = require('../dist/breakdown/service');
const { InMemoryBreakdownRepository } = require('../dist/breakdown/repository');
const { MaasStageModelAdapter } = require('../dist/breakdown/model-adapter');
const { NovelService } = require('../dist/novel/service');
const { StoryboardService } = require('../dist/breakdown/storyboard');

const base = readConfig({ LLM_BASE_URL: 'https://deepseek.test/v1', LLM_API_KEY: 'deepseek-test-only-key' });
const headers = { host: '127.0.0.1:8788', 'x-shortdrama-call': '1' };
const fields = (name, overrides = {}) => ({ name, kind: 'text', endpoint: 'https://compatible.test/v1/chat/completions',
  model: name, authType: 'bearer', apiKey: `${name}-test-only-key`, timeoutMs: 10000, maxOutputTokens: 4096, ...overrides });
const assign = (store, role, profileId) => store.assign(role, { expectedRevision: store.public(role).revision, profileId });
const editable = profile => ({ name: profile.name, kind: profile.kind, endpoint: profile.endpoint, model: profile.model,
  authType: profile.authType, apiKey: '', maxOutputTokens: profile.maxOutputTokens, timeoutMs: profile.timeoutMs, expectedRevision: profile.revision });
const completion = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] }));

test('four complete text profiles can be selected independently and route with their own endpoint and credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'model-library-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'connections.json');
  const store = new ModelConnections(base, file);
  const deepseek = await store.importEnvironment({});
  const kimi = await store.createProfile(fields('kimi-k3', { endpoint: 'https://kimi.test/v1/chat/completions' }));
  const sol = await store.createProfile(fields('GPT-5.6 Sol'));
  const terra = await store.createProfile({ ...fields('GPT-5.6 Terra', { apiKey: '' }), copyCredentialsFrom: { profileId: sol.id, revision: sol.revision } });
  assert.equal(store.list().profiles.length, 4);
  await assign(store, 'general', sol.id);
  const generalVersion = store.public('general').revision;
  const cases = [
    [deepseek, 'https://deepseek.test/v1/chat/completions', 'api-key', 'deepseek-test-only-key'],
    [kimi, 'https://kimi.test/v1/chat/completions', 'Authorization', 'Bearer kimi-k3-test-only-key'],
    [sol, 'https://compatible.test/v1/chat/completions', 'Authorization', 'Bearer GPT-5.6 Sol-test-only-key'],
    [terra, 'https://compatible.test/v1/chat/completions', 'Authorization', 'Bearer GPT-5.6 Sol-test-only-key'],
  ];
  for (const [profile, endpoint, auth, key] of cases) {
    await assign(store, 'breakdown', profile.id);
    const restored = new ModelConnections(readConfig({}), file);
    assert.equal(restored.public('breakdown').profileId, profile.id);
    assert.equal(restored.public('general').profileId, sol.id);
    assert.equal(restored.public('general').revision, generalVersion);
    await new ModelClient(restored.resolve('breakdown'), async (url, options) => {
      assert.equal(url, endpoint); assert.equal(options.headers[auth], key);
      assert.equal(JSON.parse(options.body).model, profile.model); return completion();
    }).call({ allowPaid: true, messages: [{ role: 'user', content: '原创测试' }] });
  }
  assert.equal(store.list().profiles.length, 4, 'switching must not replace or duplicate saved connections');
  const publicText = JSON.stringify(store.list());
  for (const key of ['deepseek-test-only-key', 'kimi-k3-test-only-key', 'GPT-5.6 Sol-test-only-key', '"apiKey"']) assert.equal(publicText.includes(key), false);
  assertUnixMode((await stat(file)).mode, 0o600);
});

test('copying stored credentials is explicit, version checked and restricted to the same endpoint and auth type', async () => {
  const store = new ModelConnections(base);
  let sol = await store.createProfile(fields('GPT-5.6 Sol'));
  const copy = { profileId: sol.id, revision: sol.revision };
  for (const changes of [{ endpoint: 'https://other.test/v1/chat/completions' }, { authType: 'api-key' }, { apiKey: 'new-key' }, { clearApiKey: true }]) {
    await assert.rejects(store.createProfile({ ...fields('GPT-5.6 Terra', { apiKey: '' }), copyCredentialsFrom: copy, ...changes }), { code: 'MODEL_CONNECTION_INVALID' });
  }
  const original = sol;
  sol = await store.updateProfile(sol.id, { ...editable(sol), timeoutMs: 20000 });
  await assert.rejects(store.createProfile({ ...fields('GPT-5.6 Terra', { apiKey: '' }), copyCredentialsFrom: copy }), { code: 'MODEL_CONNECTION_CONFLICT' });
  let terra = await store.createProfile({ ...fields('GPT-5.6 Terra', { apiKey: '' }), copyCredentialsFrom: { profileId: sol.id, revision: sol.revision } });
  terra = await store.updateProfile(terra.id, { ...editable(terra), clearApiKey: true });
  await assign(store, 'breakdown', terra.id); await assign(store, 'general', sol.id);
  assert.equal(store.public('breakdown').hasApiKey, false);
  assert.equal(store.public('general').hasApiKey, true);
  await assert.rejects(store.updateProfile(sol.id, { ...editable(original), model: 'changed' }), { code: 'MODEL_CONNECTION_CONFLICT' });
});

test('v1 migration preserves all role snapshots, credentials and cleared fields without importing environment defaults', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'model-library-v1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'connections.json');
  const connection = (revision, changes = {}) => ({ endpoint: 'https://legacy.test/v1/chat/completions', model: 'legacy-model',
    authType: 'bearer', apiKey: 'legacy-test-key', maxOutputTokens: 4096, timeoutMs: 12000, revision, ...changes });
  const v1 = { schemaVersion: 1, connections: {
    breakdown: connection('old-breakdown'), general: connection('old-general', { apiKey: '' }),
    image: connection('old-image', { endpoint: 'https://image.test/generate', model: 'image-test' }),
    video: connection('old-video', { endpoint: '', model: '', apiKey: '', timeoutMs: 300000 }),
  } };
  await writeFile(file, JSON.stringify(v1));
  const store = new ModelConnections(base, file);
  assert.equal((await readFile(file, 'utf8')), JSON.stringify(v1), 'constructor does not overwrite before explicit initialization');
  await store.initialize();
  for (const role of ['breakdown', 'general', 'image', 'video']) {
    assert.equal(store.public(role).revision, v1.connections[role].revision);
    assert.equal(store.resolve(role).apiKey, v1.connections[role].apiKey);
    assert.equal(store.resolve(role).defaultModel, v1.connections[role].model);
    assert.equal(store.resolve(role).timeoutMs, v1.connections[role].timeoutMs);
  }
  assert.equal(store.list().profiles.some(p => p.model === base.defaultModel), false);
  const firstIds = store.list().profiles.map(p => p.id);
  const restored = new ModelConnections(base, file); await restored.initialize();
  assert.deepEqual(restored.list().profiles.map(p => p.id), firstIds);
  assert.equal(restored.public('general').configured, false);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).schemaVersion, 3);
  assertUnixMode((await stat(file)).mode, 0o600);
});

test('shared profile updates invalidate exactly the assigned roles while in-flight snapshots remain fixed', async () => {
  const store = new ModelConnections(base);
  let shared = await store.createProfile(fields('shared'));
  let other = await store.createProfile(fields('unselected'));
  await assign(store, 'breakdown', shared.id); await assign(store, 'general', shared.id);
  const old = store.resolve('breakdown'); const oldGeneral = store.public('general'); const oldBreakdown = store.public('breakdown');
  other = await store.updateProfile(other.id, { ...editable(other), apiKey: 'unrelated-test-key' });
  assert.equal(store.public('breakdown').revision, oldBreakdown.revision);
  assert.equal(store.public('general').revision, oldGeneral.revision);
  shared = await store.updateProfile(shared.id, { ...editable(shared), apiKey: 'replacement-test-key' });
  assert.notEqual(store.public('breakdown').revision, oldBreakdown.revision);
  assert.notEqual(store.public('general').revision, oldGeneral.revision);
  assert.equal(old.apiKey, 'shared-test-only-key');
  assert.equal(store.resolve('breakdown').apiKey, 'replacement-test-key');
  assert.equal(store.resolve('general').apiKey, 'replacement-test-key');
  assert.equal(old.callBudget, store.resolve('general').callBudget);
  await assign(store, 'breakdown', other.id);
  await store.updateProfile(shared.id, { ...editable(shared), clearApiKey: true });
  assert.equal(store.public('general').configured, false);
  assert.equal(store.public('breakdown').configured, true);
});

test('concurrent role selections conflict, no-op selection preserves revision, and unassignment never falls back', async () => {
  const store = new ModelConnections(base);
  const a = await store.createProfile(fields('a'));
  const b = await store.createProfile(fields('b'));
  const expectedRevision = store.public('breakdown').revision;
  const results = await Promise.allSettled([store.assign('breakdown', { expectedRevision, profileId: a.id }), store.assign('breakdown', { expectedRevision, profileId: b.id })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'MODEL_CONNECTION_CONFLICT');
  const before = store.public('breakdown'); await assign(store, 'breakdown', before.profileId);
  assert.equal(store.public('breakdown').revision, before.revision);
  await assign(store, 'breakdown', null);
  assert.equal(store.resolve('breakdown').apiKey, '');
  await assert.rejects(new ModelClient(store.resolve('breakdown'), () => assert.fail('must not use environment credentials')).call({ allowPaid: true, messages: [{ role: 'user', content: 'test' }] }), { code: 'MODEL_NOT_CONFIGURED' });
  assert.equal(store.public('general').configured, true);
});

test('text and media assignments are type checked; profile kind cannot silently change active consumers', async () => {
  const store = new ModelConnections(base);
  const text = await store.createProfile(fields('text-profile'));
  const image = await store.createProfile(fields('image-profile', { kind: 'image', endpoint: 'https://images.test/create' }));
  const video = await store.createProfile(fields('video-profile', { kind: 'video', endpoint: 'https://videos.test/create' }));
  for (const [role, profile] of [['image', text], ['video', text], ['general', image], ['breakdown', video], ['image', video]]) {
    await assert.rejects(assign(store, role, profile.id), { code: 'MODEL_PROFILE_INCOMPATIBLE' });
  }
  await assign(store, 'image', image.id); await assign(store, 'video', video.id);
  assert.equal(store.public('image').execution, 'asset-generation');
  await assign(store, 'general', text.id);
  await assert.rejects(store.updateProfile(text.id, { ...editable(text), kind: 'image' }), { code: 'MODEL_CONNECTION_INVALID' });
  assert.equal(store.public('general').profileId, text.id);
  await assert.rejects(assign(store, 'general', 'model_missing'), { code: 'MODEL_PROFILE_NOT_FOUND' });
});

test('explicit environment import is idempotent and never refills cleared keys or changes assignments', async () => {
  const store = new ModelConnections(base);
  const before = store.list().connections;
  let imported = await store.importEnvironment({});
  imported = await store.updateProfile(imported.id, { ...editable(imported), clearApiKey: true });
  const id = imported.id;
  imported = await store.importEnvironment({});
  assert.equal(imported.id, id); assert.equal(imported.hasApiKey, false);
  assert.equal(store.list().profiles.length, 1);
  assert.equal(store.public('general').profileId, before.find(c => c.role === 'general').profileId);
  await assert.rejects(new ModelConnections(readConfig({})).importEnvironment({}), { code: 'ENV_MODEL_NOT_CONFIGURED' });
});

test('invalid or corrupted libraries fail closed; failed writes do not mutate profile data or role choices', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'model-library-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'connections.json');
  const good = new ModelConnections(base, file); await good.initialize();
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  const invalid = structuredClone(persisted); invalid.assignments.general.profileId = 'model_missing';
  await writeFile(file, JSON.stringify(invalid));
  assert.throws(() => new ModelConnections(base, file), { code: 'MODEL_CONNECTION_STORE_INVALID' });
  assert.equal(await readFile(file, 'utf8'), JSON.stringify(invalid));
  const blocked = join(dir, 'future');
  const store = new ModelConnections(base, join(blocked, 'connections.json'));
  const before = store.list(); await writeFile(blocked, 'not a directory');
  await assert.rejects(store.createProfile(fields('new-model')), { code: 'MODEL_CONNECTION_SAVE_FAILED' });
  assert.deepEqual(store.list(), before);
});

test('HTTP library create/import/select operations preserve local-only protections and make no upstream calls', async t => {
  const store = new ModelConnections(base);
  let calls = 0;
  const app = await createApp({ ...base, modelConnections: store }, async () => { calls++; return completion(); });
  t.after(() => app.close());
  const server = app.getHttpAdapter().getInstance();
  const post = (url, payload, customHeaders = headers) => server.inject({ method: 'POST', url, headers: customHeaders, payload });
  assert.equal((await post('/api/model-profiles', fields('HTTP'), { host: headers.host })).statusCode, 403);
  assert.equal((await post('/api/model-profiles', fields('HTTP'), { ...headers, origin: 'https://evil.test' })).statusCode, 403);
  const response = await post('/api/model-profiles', fields('HTTP'));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.includes('HTTP-test-only-key'), false);
  assert.equal(response.headers['cache-control'], 'no-store');
  const created = response.json().profile;
  const selected = await post('/api/model-assignments/general', { profileId: created.id, expectedRevision: store.public('general').revision });
  assert.equal(selected.statusCode, 200); assert.equal(selected.json().connections.find(c => c.role === 'general').model, 'HTTP');
  assert.equal((await post('/api/model-profiles/import-environment', {})).statusCode, 200);
  const list = await server.inject({ url: '/api/model-profiles', headers });
  assert.equal(list.statusCode, 200); assert.equal(list.body.includes('deepseek-test-only-key'), false);
  assert.equal(calls, 0);
  assert.equal((await post('/api/model-calls', { allowPaid: false, messages: [{ role: 'user', content: 'test' }] })).statusCode, 400);
  assert.equal(calls, 0);
});

test('switching a role invalidates only its old draft runs, not saved results or unrelated profile edits', async () => {
  const store = new ModelConnections(base);
  const a = await store.createProfile(fields('model-a'));
  const b = await store.createProfile(fields('model-b'));
  await assign(store, 'breakdown', a.id);
  const config = { ...base, modelConnections: store };
  const service = new BreakdownService(new InMemoryBreakdownRepository(), config);
  const project = await service.createProject({ title: '模型选择验收' });
  await service.createScriptVersion(project.id, { rawText: '第一场 小屋\n甲进入房间。' });
  const run = await service.createDraftRun(project.id, { maxModelCalls: 1, maxOutputTokens: 4096 });
  const adapter = new MaasStageModelAdapter(config, () => assert.fail('no paid call'));
  await store.updateProfile(b.id, { ...editable(b), timeoutMs: 20000 });
  assert.doesNotThrow(() => adapter.forRun(run.modelConfig));
  await assign(store, 'breakdown', b.id);
  assert.throws(() => adapter.forRun(run.modelConfig), { code: 'MODEL_CONFIGURATION_CHANGED' });
  assert.equal((await service.getRun(run.id)).modelConfig.model, 'model-a');
});

test('novel and storyboard reject stale model-choice consent before recording attempts or calling a provider', async () => {
  const store = new ModelConnections(base);
  const before = store.list().connections;
  const next = await store.createProfile(fields('new-selection'));
  await assign(store, 'breakdown', next.id); await assign(store, 'general', next.id);
  const config = { ...base, modelConnections: store };
  const never = () => assert.fail('stale model consent must fail before persistence or transport');
  const novel = new NovelService({ getChapterSource: never }, config, never);
  await assert.rejects(novel.extract('chapter', { expectedRevisionId: null, allowPaid: true,
    expectedModelConnectionRevision: before.find(c => c.role === 'breakdown').revision }), { code: 'MODEL_SELECTION_CHANGED' });
  const board = new StoryboardService({ query: never }, { getProject: never }, config, never);
  await assert.rejects(board.generate('project', before.find(c => c.role === 'general').revision), { code: 'MODEL_SELECTION_CHANGED' });
});
