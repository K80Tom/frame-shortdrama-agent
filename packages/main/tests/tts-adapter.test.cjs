const { test } = require('node:test');
const assert = require('node:assert/strict');
const { InMemoryPaidGenerationInterceptor } = require('../dist/budget/paid-generation');
const { TtsSynthesisAdapter } = require('../dist/production-media/audio/tts');

const WS = `ws_${'d'.repeat(32)}`;
const PROJECT = 'project-model-generation';
const VOICE_ID = 'voice_voice-1';

function voice(overrides = {}) {
  return {
    schemaVersion: 'lyra-audio-production/1', id: VOICE_ID, workspaceId: WS, projectId: PROJECT,
    displayName: '旁白', provider: 'openai-compatible', model: 'tts-1', modelRevision: 'r1',
    voiceReference: 'voice-1', language: 'zh-CN', attributes: { gender: null, age: null, style: [] },
    previewArtifactId: null,
    authorization: { subject: 'synthetic-narrator', type: 'synthetic', commercialUse: true,
      territories: ['CN'], channels: ['streaming'], validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: null, consentRecordRef: null, revokedAt: null, cloningConsent: false },
    scope: { workspaceWide: true, projectIds: [] }, reviewStatus: 'approved',
    contentDigest: 'a'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

function wav() {
  const bytes = Buffer.alloc(44);
  bytes.write('RIFF', 0, 'latin1'); bytes.write('WAVE', 8, 'latin1');
  bytes.write('fmt ', 12, 'latin1'); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(48000 * 4, 28);
  bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36, 'latin1');
  return bytes;
}

function config(fetch) {
  return { provider: 'openai-compatible', endpoint: 'https://tts.example.test/v1/audio/speech',
    model: 'tts-1', authType: 'bearer', apiKey: 'tts-secret', timeoutMs: 2_000, fetch };
}

function request(extra = {}) {
  return { workspaceId: WS, projectId: PROJECT, operationKey: 'tts:dialogue-1:take-1',
    clientRequestId: 'tts-request-1', text: '第一句对白', language: 'zh-CN', voice: voice(),
    commercialUse: true, format: 'wav', estimateMicros: 30_000, budgetLimitMicros: 100_000,
    currency: 'CNY', ...extra };
}

test('TTS refuses a real-person clone without consent before reserving or calling', async () => {
  let calls = 0;
  const ledger = new InMemoryPaidGenerationInterceptor();
  const adapter = new TtsSynthesisAdapter(config(async () => { calls += 1; return new Response(); }), ledger);
  const clone = voice({ authorization: { subject: 'real-person', type: 'licensed_real_person', commercialUse: true,
    territories: ['CN'], channels: ['streaming'], validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: null, consentRecordRef: null, revokedAt: null, cloningConsent: false } });
  await assert.rejects(adapter.synthesize(request({ voice: clone })),
    error => error.code === 'unauthorized_voice');
  assert.equal(calls, 0);
});

test('TTS reserves, synthesizes and commits with a decoded WAV', async () => {
  let calls = 0;
  const ledger = new InMemoryPaidGenerationInterceptor();
  const adapter = new TtsSynthesisAdapter(config(async (url, init) => {
    calls += 1;
    assert.equal(url, 'https://tts.example.test/v1/audio/speech');
    assert.equal(init.headers.authorization, 'Bearer tts-secret');
    const body = JSON.parse(init.body);
    assert.equal(body.input, '第一句对白');
    assert.equal(body.voice, 'voice-1');
    return new Response(JSON.stringify({ audio: wav().toString('base64'), duration_ms: 1_200 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }), ledger);
  const result = await adapter.synthesize(request());
  assert.equal(calls, 1);
  assert.equal(result.mimeType, 'audio/wav');
  assert.equal(result.durationMs, 1_200);
  assert.equal(result.sha256.length, 64);
  const settled = await ledger.reserve({ workspaceId: WS, operationKey: 'tts:dialogue-1:take-1',
    provider: 'openai-compatible', model: 'tts-1', estimateMicros: 30_000, budgetLimitMicros: 100_000,
    currency: 'CNY' });
  assert.equal(settled.status, 'committed');
});

test('TTS releases on 4xx and holds unknown on 5xx', async () => {
  const ledger = new InMemoryPaidGenerationInterceptor();
  const rejected = new TtsSynthesisAdapter(config(async () => new Response('{}', { status: 401 })), ledger);
  await assert.rejects(rejected.synthesize(request()), error => error.code === 'TTS_PROVIDER_REJECTED');
  const released = await ledger.reserve({ workspaceId: WS, operationKey: 'tts:dialogue-1:take-1',
    provider: 'openai-compatible', model: 'tts-1', estimateMicros: 30_000, budgetLimitMicros: 100_000,
    currency: 'CNY' });
  assert.equal(released.status, 'released');

  const uncertain = new TtsSynthesisAdapter(config(async () => new Response('{}', { status: 503 })), ledger);
  await assert.rejects(uncertain.synthesize(request({ operationKey: 'tts:dialogue-1:take-2',
    clientRequestId: 'tts-request-2' })), error => error.code === 'TTS_SUBMISSION_UNCERTAIN');
  const unknown = await ledger.reserve({ workspaceId: WS, operationKey: 'tts:dialogue-1:take-2',
    provider: 'openai-compatible', model: 'tts-1', estimateMicros: 30_000, budgetLimitMicros: 100_000,
    currency: 'CNY' });
  assert.equal(unknown.status, 'unknown');
});
