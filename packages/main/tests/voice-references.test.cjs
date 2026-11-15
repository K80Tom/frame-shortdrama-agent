const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, realpath } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { VoiceReferenceService } = require('../dist/voice-references/service');
const { InMemoryVoiceReferenceRepository } = require('../dist/voice-references/repository');
const { AudioAssetStore } = require('../dist/production-media/audio/audio-store');
const { LocalObjectStorage } = require('../dist/infrastructure/object-storage/local');
const { LEGACY_WORKSPACE_ID } = require('../dist/tenancy/context');
const { VoiceReferencesController } = require('../dist/voice-references/controller');
require('reflect-metadata');

test('音色上传控制器挂载在 Web 使用的 /api 路径', () => {
  assert.equal(Reflect.getMetadata('path', VoiceReferencesController), 'api/voice-references');
});

const PROJECT = `project_${'a'.repeat(32)}`;
const SPEAKER = `character_${'b'.repeat(32)}`;
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(28)]);
function input() {
  return { speakerEntityId: SPEAKER, projectId: PROJECT, displayName: '林晚参考音色', language: 'zh-CN', format: 'wav',
    durationMs: 1000, audioBase64: WAV.toString('base64'),
    authorization: { subject: '测试说话人', type: 'synthetic', commercialUse: true, territories: ['CN'], channels: ['online-video'],
      validFrom: '2020-01-01T00:00:00.000Z', validUntil: null, consentRecordRef: null, revokedAt: null, cloningConsent: false } };
}

test('voice sample is content-addressed before object storage and local signing fails closed', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'lyra-voice-reference-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new LocalObjectStorage(directory);
  const service = new VoiceReferenceService(new AudioAssetStore(join(directory, 'samples')), storage);
  const profile = await service.create(input());
  assert.equal(profile.profile.reviewStatus, 'approved'); assert.equal(profile.profile.projectId, PROJECT);
  assert.equal(profile.reference.provider, 'local'); assert.match(profile.reference.key, new RegExp(`^voice-references/${PROJECT}/[a-f0-9]{64}\\.wav$`));
  const head = await storage.head({ workspaceId: LEGACY_WORKSPACE_ID }, profile.reference.key);
  assert.equal(head.size, WAV.length);
  await assert.rejects(service.sign(profile.reference), error => error.code === 'VOICE_SIGNING_UNAVAILABLE');
});

test('人物资产音色无需授权表单即可持久化并按项目读取，重复上传只替换当前项目关联', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'lyra-character-voice-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new VoiceReferenceService(new AudioAssetStore(join(directory, 'samples')), new LocalObjectStorage(directory));
  const repository = new InMemoryVoiceReferenceRepository();
  const assetId = `asset_${'c'.repeat(32)}`;
  service.configureAssets(repository, { get: async id => id === assetId
    ? { id, kind: 'character', name: '林晚', description: '', resourceUrl: '', createdAt: '2026-01-01T00:00:00.000Z' } : null });
  const { authorization, ...withoutAuthorization } = input();
  const first = await service.create({ ...withoutAuthorization, assetId });
  assert.equal(first.profile.authorization.type, 'synthetic');
  assert.equal((await service.list(PROJECT)).length, 1);
  assert.equal((await service.list(PROJECT))[0].assetId, assetId);
  const second = await service.create({ ...withoutAuthorization, assetId, displayName: '林晚新音色' });
  const items = await service.list(PROJECT);
  assert.equal(items.length, 1); assert.equal(items[0].binding.profile.id, second.profile.id);
  assert.equal(items[0].binding.profile.displayName, '林晚新音色');
  assert.deepEqual(await service.list(`project_${'d'.repeat(32)}`), []);
});
test('submission signing rechecks object integrity and returns only a short-lived HTTPS URL', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'lyra-voice-reference-signed-')));
  const storage = new LocalObjectStorage(directory);
  let changed = false;
  const signed = {
    provider: 's3', bucket: 'voices',
    async put(input) { return { ...await storage.put(input), provider: 's3', bucket: 'voices' }; },
    async head(scope, key, options) { const current = await storage.head(scope, key, options);
      return changed ? { ...current, sha256: '0'.repeat(64) } : current; },
    async createPresignedGet() { return { url: 'https://cdn.example.test/voice.wav?sig=short-lived' }; },
  };
  try {
    const service = new VoiceReferenceService(new AudioAssetStore(join(directory, 'samples')), signed);
    const profile = await service.create(input());
    const result = await service.sign(profile.reference);
    assert.match(result, /^https:/);
    changed = true;
    await assert.rejects(service.sign(profile.reference), error => error.code === 'VOICE_OBJECT_CHANGED');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
