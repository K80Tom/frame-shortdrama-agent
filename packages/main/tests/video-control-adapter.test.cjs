const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');
const { readConfig } = require('../dist/config');
const { VideoAutomationService } = require('../dist/video-automation/service');
const { MemoryVideoAutomationRepository } = require('../dist/video-automation/repository');
const { SeedanceVideoAutomationAdapter } = require('../dist/video-automation/adapter');

const HEALTH = { available: true, code: 'VIDEO_READY', message: '离线视频模型',
  model: 'unit-video-model', connectionRevision: 'video-selection-1' };
const FIRST = `asset_${'a'.repeat(32)}`;
const LAST = `asset_${'b'.repeat(32)}`;

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const output = Buffer.alloc(data.length + 12); output.writeUInt32BE(data.length); body.copy(output, 4);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4); return output;
}
function png() {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 70, 110, 140, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
}

function input(changes = {}) {
  return { prompt: '原创测试镜头：雨夜灯塔。', ratio: '9:16', duration: 5, resolution: '720p',
    generateAudio: false, clientRequestId: 'control-frame-adapter-1',
    expectedModelConnectionRevision: HEALTH.connectionRevision, allowPaid: true, ...changes };
}

test('adapter sends an adopted first/last frame pair as provider roles without persisting URLs', async () => {
  const service = new VideoAutomationService(new MemoryVideoAutomationRepository(), {
    health: async () => structuredClone(HEALTH),
    submit: async () => ({ state: 'submitted', task: { taskId: 'provider_control_1', status: 'queued',
      done: false, videoUrl: null, errorMessage: null, model: HEALTH.model } }),
    query: async () => ({ taskId: 'provider_control_1', status: 'running', done: false,
      videoUrl: null, errorMessage: null, model: HEALTH.model }),
  }, { pollIntervalMs: 60_000 });
  const created = await service.create(input({ firstFrameAssetId: FIRST, lastFrameAssetId: LAST }));
  const stored = await service.repository.get(created.id);
  assert.equal(stored.firstFrameAssetId, FIRST);
  assert.equal(stored.lastFrameAssetId, LAST);
  assert.equal('firstFrameUrl' in stored, false);

  const config = { ...readConfig({}), endpointUrl: 'https://video.example.test/v1/tasks', defaultModel: HEALTH.model,
    connectionRevision: HEALTH.connectionRevision, apiKey: 'synthetic-control-key', authType: 'bearer' };
  const calls = [];
  const assets = {
    async get(id) { return { id, resourceUrl: id === FIRST
      ? 'https://cdn.example.test/first.png?sig=stable' : `/api/assets/${id}/content` }; },
    async content(id) { assert.equal(id, LAST); return { mimeType: 'image/png', bytes: png() }; },
  };
  const adapter = new SeedanceVideoAutomationAdapter(() => config, async (url, init) => {
    calls.push({ url, init }); return new Response(JSON.stringify({ id: 'provider_control_1', status: 'queued' }));
  }, assets);
  const submitted = await adapter.submit(stored);
  assert.equal(submitted.state, 'submitted'); assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  const first = body.content.find(item => item.role === 'first_frame');
  const last = body.content.find(item => item.role === 'last_frame');
  assert.equal(first.image_url.url, 'https://cdn.example.test/first.png?sig=stable');
  assert.equal(last.image_url.url, `data:image/png;base64,${png().toString('base64')}`);
  assert.equal(body.generate_audio, false);
  assert.doesNotMatch(JSON.stringify(stored), /first\.png|base64/);
  await service.stop();
});

test('adapter blocks a control frame when the asset library is unavailable', async () => {
  const config = { ...readConfig({}), endpointUrl: 'https://video.example.test/v1/tasks', defaultModel: HEALTH.model,
    connectionRevision: HEALTH.connectionRevision, apiKey: 'synthetic-control-key', authType: 'bearer' };
  let calls = 0;
  const adapter = new SeedanceVideoAutomationAdapter(() => config, async () => { calls++; return new Response('{}'); });
  const result = await adapter.submit({ id: 'video_run', clientRequestId: 'control-frame-2', prompt: '测试',
    ratio: '9:16', duration: 5, resolution: '720p', generateAudio: false, firstFrameAssetId: FIRST,
    model: HEALTH.model, modelConnectionRevision: HEALTH.connectionRevision, providerTaskId: null,
    result: null, error: null, errorNode: null, reconciliationAttempts: 0, version: 0,
    createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z' });
  assert.equal(result.state, 'blocked');
  assert.equal(result.code, 'VIDEO_CONTROL_FRAME_UNAVAILABLE');
  assert.equal(calls, 0);
});
