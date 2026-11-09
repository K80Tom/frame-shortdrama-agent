const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVideoGenerationHandler, parseVideoGenerationPayload, downloadProviderVideo }
  = require('../dist/production/video-worker');
const { ProductionInputObjectVerifier } = require('../dist/production/input-object-verifier');
const { InMemoryModelGenerationAudit } = require('../dist/production/model-generation-audit');
const { DRIVER_MANAGED_PREFIX } = require('../dist/storage/driver');
const { OutboxTaskError } = require('../dist/production/outbox/contracts');

const WS = `ws_${'c'.repeat(32)}`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);
const PNG_LAST = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 3)]);
const FRAME = { objectId: `obj_${'a'.repeat(32)}`, versionId: `objver_${'b'.repeat(32)}`, checksum: 'f'.repeat(64) };

const LAST_FRAME = { objectId: `obj_${'a'.repeat(32)}`, versionId: `objver_${'e'.repeat(32)}`, checksum: '9'.repeat(64) };

function payload(extra = {}) {
  return { operationKey: 'video:seedance:shot-1', clientRequestId: 'video-seedance-1',
    provider: 'seedance', model: 'doubao-seedance-1-5-pro-251215', prompt: '雨夜旧桥',
    durationSeconds: 5, ratio: '9:16', resolution: '720p',
    estimateMicros: 100_000, budgetLimitMicros: 500_000, currency: 'CNY',
    firstFrame: FRAME, lastFrame: LAST_FRAME, ...extra };
}

function fakeAdapter({ taskId = 'cgt-12345678', states = ['succeeded'],
  videoUrl = 'https://cdn.example.test/v.mp4', submitCalls = [] } = {}) {
  let polls = 0;
  return {
    submitCalls,
    async submit(request) {
      submitCalls.push(request);
      return { provider: request.provider, taskId, model: request.model,
        operationKey: request.operationKey, reservationId: `pgbudget_${'r'.repeat(10)}`, status: 'submitted' };
    },
    async poll() {
      const state = states[Math.min(polls, states.length - 1)];
      polls += 1;
      return state === 'succeeded'
        ? { provider: 'seedance', taskId, state, videoUrl, lastFrameUrl: null, message: null }
        : { provider: 'seedance', taskId, state, videoUrl: null, message: null };
    },
  };
}

class MemoryDriver {
  constructor() { this.objects = new Map(); }
  get provider() { return 'memory'; }
  get managedPrefix() { return DRIVER_MANAGED_PREFIX; }
  async put(input) {
    const sha = require('node:crypto').createHash('sha256').update(input.body).digest('hex');
    this.objects.set(input.key, { body: input.body, sha256: sha, size: input.body.length });
    return { key: input.key, size: input.body.length, etag: null, sha256: sha, contentType: input.contentType ?? null };
  }
  async head(key) { return this.objects.has(key) ? { key, size: this.objects.get(key).size, etag: null, sha256: this.objects.get(key).sha256, contentType: null } : null; }
  async readRange() { throw new Error('unused'); }
  async delete(key) { this.objects.delete(key); }
  async list() { return []; }
}

function handlerDeps({ adapter, driver, audit, pollIntervalMs = 0, pollDeadlineMs, now,
  verifierCode = null, frames = new Map([[FRAME.versionId, PNG], [LAST_FRAME.versionId, PNG_LAST]]),
  states, download } = {}) {
  const verifier = { check: async () => verifierCode };
  return {
    adapters: { seedance: adapter ?? fakeAdapter({ states }) },
    verifier,
    loadFrameBytes: async frame => {
      const bytes = frames.get(frame.versionId);
      if (!bytes) throw new Error('frame bytes missing');
      return bytes;
    },
    driver: driver ?? new MemoryDriver(),
    audit: audit ?? new InMemoryModelGenerationAudit(),
    pollIntervalMs,
    ...(pollDeadlineMs !== undefined ? { pollDeadlineMs } : {}),
    sleep: async () => {},
    ...(now ? { now } : {}),
    download: download ?? (async () => Buffer.from('fake-video-bytes')),
  };
}

function task(payloadValue) {
  return { taskId: `iobx_${'0'.repeat(32)}`, workspaceId: WS, taskType: 'video.generate',
    aggregateType: null, aggregateId: null, idempotencyKey: 'video-seedance-1',
    payload: payloadValue, state: 'delivering', attempts: 0, maxAttempts: 5,
    availableAt: new Date().toISOString(), leaseOwner: null };
}

test('happy path: verifies frames, submits once, stores output and completes the audit', async () => {
  const driver = new MemoryDriver();
  const audit = new InMemoryModelGenerationAudit();
  const adapter = fakeAdapter({ states: ['pending', 'succeeded'] });
  const handler = createVideoGenerationHandler(handlerDeps({ adapter, driver, audit }));
  const result = await handler.execute({ task: task(payload()), signal: new AbortController().signal });
  assert.equal(result.provider, 'seedance');
  assert.equal(result.providerTaskId, 'cgt-12345678');
  assert.match(String(result.outputKey), /^\.lyra-driver\/outputs\/ws_/u);
  assert.equal(driver.objects.size, 1);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].status, 'completed');
  assert.equal(adapter.submitCalls.length, 1);
  assert.match(String(adapter.submitCalls[0].firstFrameUrl), /^data:image\/png;base64,/u);
  assert.equal(adapter.submitCalls[0].generateAudio, false);
});

test('input verification failure blocks submit and never touches budget or storage', async () => {
  const driver = new MemoryDriver();
  const audit = new InMemoryModelGenerationAudit();
  const adapter = fakeAdapter();
  const handler = createVideoGenerationHandler(handlerDeps({ adapter, driver, audit, verifierCode: 'DIGEST_MISMATCH' }));
  await assert.rejects(handler.execute({ task: task(payload()), signal: new AbortController().signal }),
    error => error instanceof OutboxTaskError && /DIGEST_MISMATCH/u.test(error.message));
  assert.equal(adapter.submitCalls.length, 0);
  assert.equal(driver.objects.size, 0);
  assert.equal(audit.rows.length, 0);
});

test('resume: existing provider task id polls again instead of resubmitting', async () => {
  const audit = new InMemoryModelGenerationAudit();
  await audit.recordSubmitted(WS, { callId: 'mgcall_previous01', operationKey: 'video:seedance:shot-1',
    provider: 'seedance', model: 'doubao-seedance-1-5-pro-251215', promptDigest: 'a'.repeat(64),
    reservationId: null, providerTaskId: 'cgt-12345678' });
  const adapter = fakeAdapter();
  const handler = createVideoGenerationHandler(handlerDeps({ adapter, audit }));
  const result = await handler.execute({ task: task(payload()), signal: new AbortController().signal });
  assert.equal(adapter.submitCalls.length, 0);
  assert.equal(result.providerTaskId, 'cgt-12345678');
  const completed = audit.rows.find(row => row.callId === 'mgcall_previous01');
  assert.equal(completed.status, 'completed');
});

test('poll deadline exceeded throws retryable timeout and keeps the ledger submitted', async () => {
  const audit = new InMemoryModelGenerationAudit();
  const adapter = fakeAdapter({ states: ['pending'] });
  let clock = 0;
  const handler = createVideoGenerationHandler(handlerDeps({
    adapter, audit, pollDeadlineMs: 5, pollIntervalMs: 1, now: () => { clock += 10; return clock; },
  }));
  await assert.rejects(handler.execute({ task: task(payload()), signal: new AbortController().signal }),
    error => /VIDEO_GENERATION_POLL_TIMEOUT/u.test(String(error.message)));
  assert.equal(audit.rows[0].status, 'submitted');
});

test('provider terminal failure records failed in the ledger', async () => {
  const audit = new InMemoryModelGenerationAudit();
  const adapter = { async submit() { return { provider: 'seedance', taskId: 'cgt-12345678',
    model: 'm', operationKey: 'video:seedance:shot-1', reservationId: null, status: 'submitted' }; },
  async poll() { return { provider: 'seedance', taskId: 'cgt-12345678', state: 'failed',
    videoUrl: null, message: '供应商拒绝' }; } };
  const handler = createVideoGenerationHandler(handlerDeps({ adapter, audit }));
  await assert.rejects(handler.execute({ task: task(payload()), signal: new AbortController().signal }),
    error => /VIDEO_GENERATION_FAILED/u.test(String(error.message)));
  assert.equal(audit.rows[0].status, 'failed');
  assert.equal(audit.rows[0].errorCode, 'VIDEO_GENERATION_FAILED');
});

test('payload validation rejects unknown providers and audio requests', () => {
  assert.throws(() => parseVideoGenerationPayload(payload({ provider: 'sora' })),
    error => error instanceof OutboxTaskError);
  assert.throws(() => parseVideoGenerationPayload(payload({ generateAudio: true })),
    error => error instanceof OutboxTaskError);
});

test('download guard rejects non-https or private targets', async () => {
  await assert.rejects(downloadProviderVideo('http://cdn.example.test/v.mp4', 1024));
  await assert.rejects(downloadProviderVideo('https://127.0.0.1/v.mp4', 1024));
});
