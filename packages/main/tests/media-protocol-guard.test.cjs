const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, dirname, basename } = require('node:path');
const { readConfig } = require('../dist/config');
const { ModelConnections } = require('../dist/models/connections');
const { MODEL_PRESETS } = require('../dist/models/presets/catalog');
const { DoubaoImageClient, SeedanceVideoClient } = require('../dist/models/media-client');
const base = readConfig({});
const unsupported = MODEL_PRESETS.filter(p => p.kind !== 'text' && p.providerId !== 'volcengine');
const isBlocked = error => error.code === 'MEDIA_PROTOCOL_UNSUPPORTED';
const config = preset => ({ endpoint: preset.defaultBaseUrl, model: preset.modelCode,
  authType: 'bearer', apiKey: 'test-only', timeoutMs: 300000 });

function edit(profile, overrides = {}) {
  return { expectedRevision: profile.revision, name: profile.name, kind: profile.kind,
    endpoint: profile.endpoint, model: profile.model, authType: profile.authType,
    maxOutputTokens: profile.maxOutputTokens, timeoutMs: profile.timeoutMs, ...overrides };
}

test('all unsupported catalog media presets remain metadata-only and cannot be assigned', async () => {
  const store = new ModelConnections(base);
  assert.ok(unsupported.length >= 5);
  for (const preset of unsupported) {
    const profile = await store.createProfile({ presetCode: preset.code, apiKey: 'test-only' });
    assert.equal(profile.execution, 'metadata-only', preset.code);
    assert.equal(profile.configured, false, preset.code);
    const before = store.public(preset.kind);
    await assert.rejects(store.assign(preset.kind, { profileId: profile.id, expectedRevision: before.revision }), isBlocked);
    assert.deepEqual(store.public(preset.kind), before, 'blocked assignment must not mutate role');
  }
});

test('direct adapter construction blocks foreign catalog protocols before submit or polling transport', () => {
  let requests = 0;
  for (const preset of unsupported) {
    for (const Client of [DoubaoImageClient, SeedanceVideoClient]) {
      for (const endpoint of [preset.defaultBaseUrl, 'https://custom.test/native-operation']) {
        assert.throws(() => new Client({ ...config(preset), endpoint, fetch: async () => { requests++; throw new Error('network'); } }), isBlocked);
      }
    }
  }
  assert.equal(requests, 0);
});

test('known foreign provider hosts cannot be disguised by renaming their model', async () => {
  const store = new ModelConnections(base);
  for (const preset of unsupported.filter(p => p.providerId !== 'jimeng')) {
    const before = store.public(preset.kind);
    await assert.rejects(store.update(preset.kind, { expectedRevision: before.revision,
      ...config(preset), model: 'renamed-model', maxOutputTokens: 8192 }), isBlocked);
    assert.deepEqual(store.public(preset.kind), before);
  }
});

test('editing a selected native profile to a foreign protocol is atomic and rejected', async () => {
  const store = new ModelConnections(base);
  const profile = await store.createProfile({ presetCode: 'doubao-seedance-2-0', apiKey: 'test-only' });
  await store.assign('video', { profileId: profile.id, expectedRevision: store.public('video').revision });
  const before = store.list();
  await assert.rejects(store.updateProfile(profile.id, edit(profile, {
    endpoint: 'https://api.openai.com/v1/videos', model: 'sora-2',
  })), error => error.code === 'MODEL_EXECUTION_INVALID');
  assert.deepEqual(store.list(), before);
  assert.equal(store.resolve('video').defaultModel, profile.model);
});

test('legacy assigned foreign profiles are retained for repair but cannot resolve or execute after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lyra-protocol-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('lyra-protocol-'));
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'models.json');
  const store = new ModelConnections(base, file);
  await store.initialize();
  const profile = await store.createProfile({ presetCode: 'doubao-seedance-2-0', apiKey: 'test-only' });
  await store.assign('video', { profileId: profile.id, expectedRevision: store.public('video').revision });
  const legacy = JSON.parse(await readFile(file, 'utf8'));
  legacy.schemaVersion = 2;
  for (const row of legacy.profiles) delete row.executionBinding;
  const saved = legacy.profiles.find(p => p.id === profile.id);
  saved.endpoint = 'https://api.openai.com/v1/videos'; saved.model = 'sora-2';
  await writeFile(file, JSON.stringify(legacy));
  const restarted = new ModelConnections(base, file);
  assert.equal(restarted.public('video').execution, 'metadata-only');
  assert.equal(restarted.public('video').configured, false);
  assert.throws(() => restarted.resolve('video'), isBlocked);
  assert.throws(() => store.resolve('video'), isBlocked, 'existing worker refresh must not retain stale cached credentials');
  await restarted.assign('video', { profileId: null, expectedRevision: restarted.public('video').revision });
  assert.equal(restarted.public('video').profileId, null, 'repair/unassign remains available');
});

test('native Ark presets still select the existing native adapters without contacting a provider', async () => {
  const store = new ModelConnections(base);
  for (const preset of MODEL_PRESETS.filter(p => p.kind !== 'text' && p.providerId === 'volcengine')) {
    const profile = await store.createProfile({ presetCode: preset.code, apiKey: 'test-only' });
    await store.assign(preset.kind, { profileId: profile.id, expectedRevision: store.public(preset.kind).revision });
    assert.equal(store.resolve(preset.kind).defaultModel, preset.modelCode);
    const Client = preset.kind === 'image' ? DoubaoImageClient : SeedanceVideoClient;
    assert.ok(new Client(config(preset)));
  }
});

test('HTTP rejects unsupported assignment and compatibility writes without leaking credentials or calling transport', async t => {
  const { createApp } = require('../dist/app');
  const store = new ModelConnections(base);
  let requests = 0;
  const app = await createApp({ ...base, modelConnections: store }, async () => { requests++; throw new Error('must not call'); });
  t.after(() => app.close());
  const server = app.getHttpAdapter().getInstance();
  const post = (url, payload) => server.inject({ method: 'POST', url,
    headers: { host: '127.0.0.1:8788', 'x-shortdrama-call': '1' }, payload });
  const created = await post('/api/model-profiles', { presetCode: 'sora-2', apiKey: 'private-test-secret' });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().profile.execution, 'metadata-only');
  assert.equal(created.body.includes('private-test-secret'), false);
  const revision = store.public('video').revision;
  const assignment = await post('/api/model-assignments/video', { profileId: created.json().profile.id, expectedRevision: revision });
  assert.equal(assignment.statusCode, 400);
  assert.equal(assignment.json().error.code, 'MEDIA_PROTOCOL_UNSUPPORTED');
  const compatibility = await post('/api/model-connections/video', { expectedRevision: revision,
    endpoint: 'https://api.openai.com/v1/videos', model: 'sora-2', authType: 'bearer',
    apiKey: 'private-test-secret', timeoutMs: 300000, maxOutputTokens: 8192 });
  assert.equal(compatibility.statusCode, 400);
  assert.equal(compatibility.json().error.code, 'MEDIA_PROTOCOL_UNSUPPORTED');
  assert.equal(compatibility.body.includes('private-test-secret'), false);
  assert.equal(store.public('video').revision, revision);
  assert.equal(requests, 0);
});
