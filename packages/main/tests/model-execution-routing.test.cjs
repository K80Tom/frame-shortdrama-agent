 'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const { join, dirname, basename, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { deflateSync } = require('node:zlib');
const { readConfig } = require('../dist/config');
const { ModelConnections } = require('../dist/models/connections');
const { ModelPresetService } = require('../dist/models/presets/service');
const { ModelClient } = require('../dist/models/client');
const { createImageModelClient, createVideoModelClient } = require('../dist/models/media-runtime');
const { SeedanceVideoAutomationAdapter } = require('../dist/video-automation/adapter');
const { resolveProductionImageConnection } = require('../dist/production/executors/assets');
const base = readConfig({});
const service = new ModelPresetService();
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const asMedia = config => ({ executionBinding: config.modelExecution, endpoint: config.endpointUrl,
  model: config.defaultModel, authType: config.authType, apiKey: config.apiKey, timeoutMs: config.timeoutMs });
async function privateFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'lyra-execution-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('lyra-execution-'));
    await rm(directory, { recursive: true, force: true });
  });
  return join(directory, 'models.json');
}
async function selectedPreset(code, store = new ModelConnections(base)) {
  const profile = await store.createProfile({ presetCode: code, apiKey: 'test-only-never-real' });
  const role = profile.kind === 'text' ? 'general' : profile.kind;
  await store.assign(role, { profileId: profile.id, expectedRevision: store.public(role).revision });
  return { store, profile, role, config: store.resolve(role) };
}
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length); body.copy(output, 4);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}

function png() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 70, 110, 140, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
}

const IMAGE = png();

test('every executable catalog preset persists its exact protocol and reaches only its matching mocked adapter', async t => {
  const presets = service.listPresets().presets;
  for (const preset of presets) {
    assert.ok(preset.executionBinding, preset.code);
    assert.equal(preset.executionBinding.providerId, preset.providerId);
    assert.deepEqual(preset.executionBinding.config, preset.config ?? {});
    if (preset.executionBinding.adapter === 'unavailable') continue;
    await t.test(preset.code, async () => {
      const file = await privateFile(t);
      const store = new ModelConnections(base, file);
      await store.initialize();
      const { profile, role } = await selectedPreset(preset.code, store);
      const disk = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(disk.schemaVersion, 3);
      assert.deepEqual(disk.profiles.find(p => p.id === profile.id).executionBinding, preset.executionBinding);
      const restarted = new ModelConnections(base, file);
      const config = restarted.resolve(role);
      assert.deepEqual(config.modelExecution, preset.executionBinding);
      const calls = [];
      const transport = async (url, init) => {
        calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
        if (preset.kind === 'text') return json({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
        if (preset.kind === 'image') return json({ data: [{ b64_json: IMAGE.toString('base64') }] });
        return json(init.method === 'POST' ? { id: 'task_test' } : {
          id: 'task_test', status: 'succeeded', content: { video_url: 'https://cdn.example.test/video.mp4' } });
      };
      if (preset.kind === 'text') {
        const result = await new ModelClient(config, transport).call({ messages: [{ role: 'user', content: 'test' }], allowPaid: true });
        assert.equal(result.text, 'ok');
        assert.equal(calls[0].body.max_tokens, preset.config.maxOutputTokens);
      } else if (preset.kind === 'image') {
        // Same conversion used by the production executor, not a separate test-only binding.
        const connection = resolveProductionImageConnection(config);
        assert.equal(connection.state, 'configured');
        assert.deepEqual(connection.clientConfig.executionBinding, preset.executionBinding);
        const result = await createImageModelClient({ ...connection.clientConfig, fetch: transport }).generateImage({ prompt: 'test' });
        assert.deepEqual(result.bytes, IMAGE);
        assert.equal(calls[0].body.size, `${preset.config.defaultWidth}x${preset.config.defaultHeight}`);
        assert.equal(calls[0].body.response_format, 'b64_json');
      } else {
        const adapter = new SeedanceVideoAutomationAdapter(() => config, transport);
        const health = await adapter.health();
        assert.equal(health.available, true);
        assert.equal(calls.length, 0, 'health must never spend');
        const run = { id: 'video_test', model: config.defaultModel, modelConnectionRevision: config.connectionRevision, prompt: 'test' };
        const submitted = await adapter.submit(run);
        assert.equal(submitted.state, 'submitted');
        const completed = await adapter.query({ ...run, providerTaskId: submitted.task.taskId });
        assert.equal(completed.done, true);
        assert.equal(calls[0].body.duration, preset.config.defaultDuration);
        assert.equal(calls[0].body.resolution, preset.config.defaultResolution);
        assert.equal(calls[0].body.ratio, preset.config.defaultAspectRatio);
        assert.deepEqual(calls[0].body.content, [{ type: 'text', text: 'test' }]);
        assert.equal(calls[1].init.method, 'GET');
        assert.equal(calls[1].url, `${preset.defaultBaseUrl}/task_test`);
        assert.equal(calls[1].body, null);
      }
      assert.equal(calls[0].url, preset.defaultBaseUrl);
      assert.equal(calls[0].body.model, preset.modelCode);
      assert.equal(calls[0].init.headers.Authorization, 'Bearer test-only-never-real');
      assert.equal(calls.length, preset.kind === 'video' ? 2 : 1);
    });
  }
});

test('frozen native capabilities validate before transport, while allowed overrides and first/last frames are serialized', async () => {
  const { config } = await selectedPreset('doubao-seedance-2-0');
  let requests = 0; let body;
  const client = createVideoModelClient({ ...asMedia(config), fetch: async (_url, init) => {
    requests++; body = JSON.parse(init.body); return json({ id: 'task_test' });
  } });
  for (const change of [{ duration: 3 }, { duration: 16 }, { duration: -1 }, { duration: 5.5 },
    { resolution: '8k' }, { ratio: '5:4' }, { generateAudio: 'yes' }, { watermark: null }]) {
    await assert.rejects(client.submit({ prompt: 'test', ...change }), error => error.code === 'INVALID_MEDIA_REQUEST');
  }
  assert.equal(requests, 0);
  await client.submit({ prompt: 'test', duration: 8, ratio: '9:16', resolution: '1080p',
    firstFrameUrl: 'https://cdn.example.test/first.png', lastFrameUrl: 'https://cdn.example.test/last.png' });
  assert.equal(body.duration, 8); assert.equal(body.ratio, '9:16'); assert.equal(body.resolution, '1080p');
  assert.deepEqual(body.content.slice(1).map(part => part.role), ['first_frame', 'last_frame']);
  const restricted = structuredClone(config.modelExecution);
  restricted.config.supportFirstFrame = false; restricted.config.supportLastFrame = false;
  restricted.config.supportedDurations = [5, 10];
  const restrictive = createVideoModelClient({ ...asMedia(config), executionBinding: restricted,
    fetch: async () => { throw new Error('must not call'); } });
  for (const change of [{ firstFrameUrl: 'https://cdn.example.test/first.png' },
    { lastFrameUrl: 'https://cdn.example.test/last.png' }, { duration: 8 }]) {
    await assert.rejects(restrictive.submit({ prompt: 'test', ...change }), error => error.code === 'INVALID_MEDIA_REQUEST');
  }
  const image = await selectedPreset('doubao-seedream-4-5');
  const imageClient = createImageModelClient({ ...asMedia(image.config), fetch: async () => { throw new Error('must not call'); } });
  for (const change of [{ size: '2000x1000' }, { size: '0K' }, { watermark: 'no' }]) {
    await assert.rejects(imageClient.generateImage({ prompt: 'test', ...change }), error => error.code === 'INVALID_MEDIA_REQUEST');
  }
});

test('adapter/protocol/provider mismatch, unavailable routes and missing credentials all fail before transport', async () => {
  const { config } = await selectedPreset('doubao-seedance-2-0');
  let requests = 0;
  const media = { ...asMedia(config), fetch: async () => { requests++; throw new Error('network'); } };
  for (const binding of [{ ...config.modelExecution, adapter: 'ark-image' },
    { ...config.modelExecution, protocol: 'openai-chat-v1' }, { ...config.modelExecution, providerId: 'openai' }]) {
    assert.throws(() => createVideoModelClient({ ...media, executionBinding: binding }), error => error.code === 'MODEL_EXECUTION_INVALID');
  }
  assert.throws(() => createImageModelClient(media), error => error.code === 'MODEL_EXECUTION_INVALID');
  assert.throws(() => createVideoModelClient({ ...media, apiKey: '' }), error => error.code === 'MEDIA_NOT_CONFIGURED');
  for (const preset of service.listPresets().presets.filter(p => p.executionBinding.adapter === 'unavailable')) {
    const create = preset.kind === 'image' ? createImageModelClient : createVideoModelClient;
    assert.throws(() => create({ ...media, endpoint: preset.defaultBaseUrl, model: preset.modelCode,
      executionBinding: preset.executionBinding }), error => error.code === 'MEDIA_PROTOCOL_UNSUPPORTED');
  }
  assert.equal(requests, 0);
});

test('v2 migration preserves credentials, IDs, revisions and assignment; read-only workers do not write', async t => {
  const file = await privateFile(t);
  const store = new ModelConnections(base, file);
  await store.initialize();
  await selectedPreset('doubao-seedance-2-0', store);
  const v2 = JSON.parse(await readFile(file, 'utf8'));
  v2.schemaVersion = 2;
  for (const profile of v2.profiles) delete profile.executionBinding;
  const original = JSON.stringify(v2);
  await writeFile(file, original);
  const worker = new ModelConnections(base, file);
  await worker.initialize({ readOnly: true });
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal(worker.resolve('video').modelExecution.adapter, 'ark-video');
  assert.equal(worker.resolve('video').modelExecution.config.defaultDuration, undefined);
  assert.equal(worker.resolve('video').modelExecution.config.defaultResolution, undefined);
  assert.equal(worker.resolve('video').modelExecution.config.defaultAspectRatio, undefined);
  assert.equal(worker.resolve('video').modelExecution.config.maxDuration, 15, 'known limits still block unsafe legacy inputs');
  assert.equal(worker.resolve('video').modelExecution.presetCode, undefined);
  const api = new ModelConnections(base, file);
  await api.initialize();
  const v3 = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(v3.schemaVersion, 3);
  assert.deepEqual(v3.assignments, v2.assignments);
  const strip = profile => { const { executionBinding, ...rest } = profile; return rest; };
  assert.deepEqual(v3.profiles.map(strip), v2.profiles);
  assert.equal(worker.resolve('video').modelExecution.protocol, 'ark-video-v1');
});

test('public metadata cannot mutate active binding and snapshots are deeply frozen', async () => {
  const { store, profile, config } = await selectedPreset('doubao-seedance-2-0');
  profile.executionBinding.config.maxDuration = 60;
  store.list().profiles.find(p => p.id === profile.id).executionBinding.config.supportedAspectRatios.push('5:4');
  assert.equal(store.resolve('video').modelExecution.config.maxDuration, 15);
  assert.equal(Object.isFrozen(config.modelExecution), true);
  assert.equal(Object.isFrozen(config.modelExecution.config), true);
  assert.equal(Object.isFrozen(config.modelExecution.config.supportedAspectRatios), true);
  assert.throws(() => { config.modelExecution.config.maxDuration = 60; }, TypeError);
  assert.throws(() => config.modelExecution.config.supportedAspectRatios.push('5:4'), TypeError);
});

test('corrupt v3 binding is rejected without rewriting the file or falling back to environment', async t => {
  const file = await privateFile(t);
  const store = new ModelConnections(base, file);
  await store.initialize();
  const { profile } = await selectedPreset('doubao-seedance-2-0', store);
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  const row = persisted.profiles.find(p => p.id === profile.id);
  row.executionBinding.protocol = 'openai-chat-v1';
  const corrupt = JSON.stringify(persisted);
  await writeFile(file, corrupt);
  assert.throws(() => new ModelConnections(base, file), error => error.code === 'MODEL_CONNECTION_STORE_INVALID');
  assert.equal(await readFile(file, 'utf8'), corrupt);
});

test('caller-supplied weaker execution metadata cannot replace the server-owned preset binding', async () => {
  const { store, profile } = await selectedPreset('doubao-seedance-2-0');
  const weaker = { ...profile.executionBinding, config: {} };
  const before = store.list();
  await assert.rejects(store.createProfile({ presetCode: 'sora-2', executionBinding: weaker }), error => error.code === 'MODEL_CONNECTION_INVALID');
  await assert.rejects(store.updateProfile(profile.id, { expectedRevision: profile.revision, executionBinding: weaker }), error => error.code === 'MODEL_CONNECTION_INVALID');
  assert.deepEqual(store.list(), before);
  const invalid = resolveProductionImageConnection({ ...base, endpointUrl: 'https://api.openai.com/v1/images/generations',
    defaultModel: 'gpt-image-1.5', apiKey: 'test-only', connectionRevision: 'test',
    modelExecution: service.requirePreset('gpt-image-1-5').executionBinding });
  assert.equal(invalid.state, 'missing', 'planning must reject a missing adapter before reserving generation costs');
});

test('copying credentials for the same preset identity preserves its frozen protocol and capabilities', async () => {
  const { store, profile } = await selectedPreset('doubao-seedance-2-0');
  const copy = await store.createProfile({ name: 'Preset copy', kind: profile.kind, endpoint: profile.endpoint,
    model: profile.model, authType: profile.authType, timeoutMs: profile.timeoutMs, maxOutputTokens: profile.maxOutputTokens,
    copyCredentialsFrom: { profileId: profile.id, revision: profile.revision } });
  assert.deepEqual(copy.executionBinding, profile.executionBinding);
  assert.notEqual(copy.id, profile.id);
  assert.equal(copy.hasApiKey, true);
  assert.equal(copy.apiKey, undefined);
});

test('a native model name on a foreign endpoint stays metadata-only and cannot poison restart of the library', async t => {
  const file = await privateFile(t);
  const store = new ModelConnections(base, file);
  await store.initialize();
  const profile = await store.createProfile({ name: 'Mismatched manual connection', kind: 'image',
    endpoint: 'https://api.openai.com/v1/images/generations', model: 'doubao-seedream-4-5-251128',
    authType: 'bearer', apiKey: 'test-only', timeoutMs: 180000, maxOutputTokens: 8192 });
  assert.equal(profile.executionBinding.adapter, 'unavailable');
  assert.equal(profile.execution, 'metadata-only');
  const restarted = new ModelConnections(base, file);
  const before = restarted.public('image');
  await assert.rejects(restarted.assign('image', { profileId: profile.id, expectedRevision: before.revision }),
    error => error.code === 'MEDIA_PROTOCOL_UNSUPPORTED');
  assert.deepEqual(restarted.public('image'), before);
});
