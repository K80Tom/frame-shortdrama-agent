const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const { VideoAutomationService } = require('../dist/video-automation/service');
const { MemoryVideoAutomationRepository } = require('../dist/video-automation/repository');
const { MAX_VIDEO_UNKNOWN_RECONCILIATIONS, VideoAutomationError } = require('../dist/video-automation/contracts');
const { SeedanceVideoAutomationAdapter } = require('../dist/video-automation/adapter');

// Synthetic prompts and a fake provider only. These tests never load .env,
// connect to a real database, or submit a real model request.
const HEALTH = { available: true, code: 'VIDEO_READY', message: '离线视频模型',
  model: 'unit-video-model', connectionRevision: 'video-selection-1' };
const HEADERS = { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:5173', 'x-shortdrama-call': '1' };
const VIDEO_URL = 'https://cdn.example.test/synthetic-video.mp4?signature=synthetic';
const input = (clientRequestId = 'video-click-0001', changes = {}) => ({
  prompt: '原创测试镜头：雨夜灯塔，镜头缓缓推进。', ratio: '9:16', duration: 5, resolution: '720p',
  generateAudio: false, clientRequestId, expectedModelConnectionRevision: HEALTH.connectionRevision,
  allowPaid: true, ...changes,
});
const providerTask = (changes = {}) => ({ taskId: 'provider_task_1', status: 'queued', done: false,
  videoUrl: null, errorMessage: null, model: HEALTH.model, ...changes });
const successfulTask = (changes = {}) => providerTask({ status: 'succeeded', done: true, videoUrl: VIDEO_URL, ...changes });
const statusIs = status => error => error && error.status === status;
const REF_EXTERNAL = `asset_${'a'.repeat(32)}`;
const REF_LOCAL = `asset_${'b'.repeat(32)}`;

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

async function fixture(t, options = {}) {
  const repo = options.repo ?? new MemoryVideoAutomationRepository();
  let health = structuredClone(HEALTH);
  let time = new Date('2026-10-23T12:00:00.000Z');
  const submits = [];
  const queries = [];
  const adapter = {
    health: async () => structuredClone(health),
    submit: async run => {
      submits.push(structuredClone(run));
      return options.submit ? options.submit(run) : { state: 'submitted', task: providerTask() };
    },
    query: async run => {
      queries.push(structuredClone(run));
      return options.query ? options.query(run) : providerTask({ status: 'running' });
    },
  };
  const serviceOptions = { pollIntervalMs: 60_000, now: () => new Date(time) };
  const service = new VideoAutomationService(repo, adapter, serviceOptions);
  t.after(() => service.stop());
  return { service, repo, adapter, serviceOptions, submits, queries,
    setHealth: value => { health = structuredClone(value); },
    setTime: value => { time = new Date(value); },
    stored: run => repo.get(run.id),
  };
}

test('video create persists a queued run and five honest progress nodes without calling a provider', async t => {
  const f = await fixture(t);
  const run = await f.service.create(input());
  assert.equal(run.status, 'queued');
  assert.equal(run.model, HEALTH.model);
  assert.equal(run.modelConnectionRevision, HEALTH.connectionRevision);
  assert.equal(run.providerTaskId, null);
  assert.equal(run.result, null);
  assert.equal(run.nodes.length, 5);
  assert.equal(run.progress.total, 5);
  assert.ok(run.progress.completed < 5);
  assert.equal(new Set(run.nodes.map(node => node.key)).size, 5);
  assert.equal((await f.service.get(run.id)).id, run.id);
  assert.equal((await f.repo.list()).length, 1);
  assert.equal(f.submits.length, 0);
  assert.equal(f.queries.length, 0);
});

test('video input is strictly bounded and every invalid request has zero provider calls and writes', async t => {
  const f = await fixture(t);
  const missing = key => { const request = input(); delete request[key]; return request; };
  const invalid = [null, [], {}, input('x', { prompt: '' }), input('x', { prompt: 'x'.repeat(8001) }),
    input('x', { prompt: '\ud800' }), input('x', { prompt: 'bad\u0000text' }),
    input('x', { ratio: '1:1' }), input('x', { resolution: '4K' }), input('x', { duration: 3 }),
    input('x', { duration: 31 }), input('x', { duration: 5.5 }), input('x', { duration: '5' }),
    input('x', { generateAudio: 'false' }), input('x', { clientRequestId: '' }),
    input('x', { referenceAssetIds: 'not-an-array' }), input('x', { referenceAssetIds: ['asset_bad'] }),
    input('x', { referenceAssetIds: [REF_EXTERNAL, REF_EXTERNAL] }),
    input('x', { referenceAssetIds: Array.from({ length: 31 }, (_, index) => `asset_${index.toString(16).padStart(32, '0')}`) }),
    input('x', { endpoint: 'https://untrusted.example.test/tasks' }), input('x', { apiKey: 'caller-secret' }),
    input('x', { allowPaid: false }), missing('allowPaid'), missing('expectedModelConnectionRevision')];
  for (const request of invalid) await assert.rejects(f.service.create(request), statusIs(400));
  assert.equal((await f.repo.list()).length, 0);
  assert.equal(f.submits.length, 0);
  assert.equal(f.queries.length, 0);
});

test('video consent is bound to the selected model and is rechecked before dispatch', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.create(input('old', { expectedModelConnectionRevision: 'stale-selection' })), statusIs(409));
  assert.equal((await f.repo.list()).length, 0);
  const run = await f.service.create(input());
  f.setHealth({ ...HEALTH, model: 'changed-model', connectionRevision: 'video-selection-2' });
  await f.service.tick();
  const saved = await f.stored(run);
  assert.equal(saved.status, 'failed');
  assert.ok(saved.error);
  assert.equal(saved.model, HEALTH.model);
  assert.equal(saved.modelConnectionRevision, HEALTH.connectionRevision);
  assert.equal(f.submits.length, 0);
});

test('unconfigured video model refuses a new paid job before persistence or dispatch', async t => {
  const f = await fixture(t);
  f.setHealth({ available: false, code: 'VIDEO_MODEL_NOT_CONFIGURED', message: '未配置', model: null, connectionRevision: null });
  await assert.rejects(f.service.create(input()), statusIs(503));
  assert.equal((await f.repo.list()).length, 0);
  assert.equal(f.submits.length, 0);
});

test('client request IDs deduplicate concurrent clicks and reject a changed payload', async t => {
  const f = await fixture(t);
  const runs = await Promise.all([f.service.create(input()), f.service.create(input())]);
  assert.equal(runs[0].id, runs[1].id);
  assert.equal((await f.repo.list()).length, 1);
  for (const change of [{ prompt: '另一个原创镜头' }, { duration: 8 }, { ratio: '16:9' },
    { resolution: '1080p' }, { generateAudio: true }, { referenceAssetIds: [REF_EXTERNAL] }]) {
    await assert.rejects(f.service.create(input('video-click-0001', change)), statusIs(409));
  }
  assert.equal((await f.repo.getByClientRequestId('video-click-0001')).id, runs[0].id);
  assert.equal(f.submits.length, 0);
});

test('only one distinct active video job wins simultaneous creation', async t => {
  const f = await fixture(t);
  const attempts = await Promise.allSettled([f.service.create(input('click-a')), f.service.create(input('click-b'))]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = attempts.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
  assert.equal((await f.repo.list()).length, 1);
  assert.equal(f.submits.length, 0);
});

test('video repository snapshots are copied and stale compare-and-swap writes cannot overwrite progress', async t => {
  const f = await fixture(t);
  const run = await f.service.create(input());
  const first = await f.stored(run);
  const changed = await f.repo.replace({ ...first, status: 'submitting' }, first.version);
  assert.equal(changed.version, first.version + 1);
  first.prompt = 'caller mutation';
  const listed = await f.repo.list();
  listed[0].prompt = 'list mutation';
  assert.notEqual((await f.stored(run)).prompt, first.prompt);
  assert.notEqual((await f.stored(run)).prompt, listed[0].prompt);
  await assert.rejects(f.repo.replace({ ...first, status: 'failed' }, first.version), statusIs(409));
  assert.equal((await f.stored(run)).status, 'submitting');
});

test('two service instances claim one queued job before exactly one paid submit', async t => {
  let release;
  let entered;
  const inSubmit = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { submit: async () => { entered(); await gate; return { state: 'submitted', task: providerTask() }; } });
  const run = await f.service.create(input());
  const second = new VideoAutomationService(f.repo, f.adapter, f.serviceOptions);
  t.after(() => second.stop());
  const firstTick = f.service.tick();
  await inSubmit;
  assert.equal((await f.stored(run)).status, 'submitting');
  await second.tick().catch(() => undefined);
  release();
  await firstTick;
  assert.equal(f.submits.length, 1);
  assert.equal((await f.stored(run)).providerTaskId, 'provider_task_1');
});

test('a failed durable claim cannot send a video request before persistence recovers', async t => {
  class ClaimFailsOnce extends MemoryVideoAutomationRepository {
    failOnce = true;
    async replace(run, expectedVersion) {
      if (this.failOnce && run.status === 'submitting') {
        this.failOnce = false;
        throw new Error('synthetic database write failure');
      }
      return super.replace(run, expectedVersion);
    }
  }
  const f = await fixture(t, { repo: new ClaimFailsOnce() });
  const run = await f.service.create(input());
  await f.service.tick().catch(() => undefined);
  assert.equal(f.submits.length, 0);
  assert.notEqual((await f.stored(run)).status, 'completed');
});

test('an adapter connection mismatch keeps the old task ID for reconciliation without resubmission', async t => {
  const f = await fixture(t, { query: async () => {
    throw new VideoAutomationError(409, 'VIDEO_QUERY_CONNECTION_CHANGED', '原连接已变更，不能安全查询。');
  } });
  const run = await f.service.create(input());
  await f.service.tick();
  await f.service.tick();
  const saved = await f.stored(run);
  assert.equal(saved.status, 'unknown');
  assert.equal(saved.providerTaskId, 'provider_task_1');
  assert.equal(saved.modelConnectionRevision, HEALTH.connectionRevision);
  assert.equal(saved.error.code, 'VIDEO_QUERY_CONNECTION_CHANGED');
  assert.equal(f.submits.length, 1);
  assert.equal(f.queries.length, 1);
});

test('a received provider ID survives a transient persistence failure and can be queried without another submit', async t => {
  class ProviderIdWriteFailsOnce extends MemoryVideoAutomationRepository {
    failOnce = true;
    async replace(run, expectedVersion) {
      if (this.failOnce && run.status === 'generating' && run.providerTaskId) {
        this.failOnce = false;
        throw new Error('synthetic failure after provider acceptance');
      }
      return super.replace(run, expectedVersion);
    }
  }
  const f = await fixture(t, { repo: new ProviderIdWriteFailsOnce(), query: async () => successfulTask() });
  const run = await f.service.create(input());
  await f.service.tick();
  const uncertain = await f.stored(run);
  assert.equal(uncertain.status, 'unknown');
  assert.equal(uncertain.providerTaskId, 'provider_task_1');
  await f.service.tick();
  assert.equal((await f.service.reconcile(run.id, {})).status, 'completed');
  assert.equal(f.submits.length, 1);
  assert.equal(f.queries.length, 1);
});

test('provider ID is retained across polling and terminal video output completes all nodes', async t => {
  let polls = 0;
  const f = await fixture(t, { query: async () => ++polls === 1 ? providerTask({ status: 'running' }) : successfulTask() });
  const run = await f.service.create(input());
  await f.service.tick();
  assert.equal((await f.stored(run)).status, 'generating');
  assert.equal((await f.stored(run)).providerTaskId, 'provider_task_1');
  await f.service.tick();
  assert.equal((await f.stored(run)).status, 'generating');
  await f.service.tick();
  const completed = await f.service.get(run.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result, { videoUrl: VIDEO_URL });
  assert.equal(completed.progress.completed, 5);
  assert.equal(completed.error, null);
  await f.service.tick();
  await f.service.reconcile(run.id, {});
  assert.equal(f.submits.length, 1);
  assert.equal(f.queries.length, 2);
  assert.ok(f.queries.every(query => query.providerTaskId === 'provider_task_1'));
});

test('a query response with the bare task id completes a run stored with a model-prefixed id', async t => {
  // The submit endpoint answers "model-prefix:task-id" while the query endpoint
  // answers with the bare task id. Both refer to the same provider task and
  // must reconcile instead of failing the taskId equality guard.
  const f = await fixture(t, {
    submit: async () => ({ state: 'submitted', task: providerTask({ taskId: 'doubao-seedance-2.5:cgt-20261030201948-96b94' }) }),
    query: async () => successfulTask({ taskId: 'cgt-20261030201948-96b94' }),
  });
  const run = await f.service.create(input());
  await f.service.tick();
  assert.equal((await f.stored(run)).status, 'generating');
  await f.service.tick();
  assert.equal((await f.stored(run)).status, 'completed');
  assert.equal((await f.stored(run)).providerTaskId, 'doubao-seedance-2.5:cgt-20261030201948-96b94');
  assert.deepEqual((await f.stored(run)).result, { videoUrl: VIDEO_URL });
  assert.equal(f.submits.length, 1);
  assert.equal(f.queries.length, 1);
});

test('a query response for a different task id is still rejected', async t => {
  const f = await fixture(t, { query: async () => successfulTask({ taskId: 'cgt-completely-different' }) });
  const run = await f.service.create(input());
  await f.service.tick();
  await f.service.tick();
  const saved = await f.stored(run);
  assert.equal(saved.status, 'unknown');
  assert.equal(saved.error.code, 'VIDEO_TASK_RESPONSE_INVALID');
  assert.equal(f.submits.length, 1);
});

test('a provider can return immediate terminal success without an extra poll', async t => {
  const f = await fixture(t, { submit: async () => ({ state: 'submitted', task: successfulTask() }) });
  const run = await f.service.create(input());
  await f.service.tick();
  assert.equal((await f.stored(run)).status, 'completed');
  assert.equal(f.submits.length, 1);
  assert.equal(f.queries.length, 0);
});

test('unknown submission and interrupted restart never authorize another paid submit', async t => {
  for (const submit of [async () => ({ state: 'unknown', code: 'VIDEO_SUBMISSION_UNCERTAIN', message: '结果未知' }),
    async () => { throw new Error('private-provider-secret'); }]) {
    const f = await fixture(t, { submit });
    const run = await f.service.create(input());
    await f.service.tick();
    assert.equal((await f.stored(run)).status, 'unknown');
    await f.service.tick();
    await f.service.reconcile(run.id, {});
    assert.equal((await f.service.create(input())).id, run.id);
    assert.equal(f.submits.length, 1);
    assert.equal(f.queries.length, 0);
    assert.doesNotMatch(JSON.stringify(await f.service.get(run.id)), /private-provider-secret/);
  }
  const f = await fixture(t);
  const run = await f.service.create(input());
  const queued = await f.stored(run);
  await f.repo.replace({ ...queued, status: 'submitting' }, queued.version);
  const restarted = new VideoAutomationService(f.repo, f.adapter, f.serviceOptions);
  t.after(() => restarted.stop());
  await restarted.start();
  assert.equal((await f.stored(run)).status, 'unknown');
  await restarted.tick();
  await restarted.reconcile(run.id, {});
  assert.equal(f.submits.length, 0);
  assert.equal(f.queries.length, 0);
});

test('query failure retains provider ID and only explicit reconciliation queries it again', async t => {
  let queries = 0;
  const f = await fixture(t, { query: async () => {
    queries++;
    if (queries === 1) throw new Error('private-provider-response');
    return queries === 2 ? providerTask({ status: 'running' }) : successfulTask();
  } });
  const run = await f.service.create(input());
  await f.service.tick();
  await f.service.tick();
  assert.equal((await f.stored(run)).status, 'unknown');
  assert.equal((await f.stored(run)).providerTaskId, 'provider_task_1');
  await f.service.tick();
  assert.equal(queries, 1);
  const another = await f.service.create(input('another-explicit-click'));
  assert.equal((await f.service.reconcile(run.id, {})).status, 'unknown');
  assert.equal((await f.stored(another)).status, 'queued');
  assert.equal((await f.service.reconcile(run.id, {})).status, 'completed');
  assert.equal(f.submits.length, 1);
  assert.equal(queries, 3);
  assert.doesNotMatch(JSON.stringify(await f.service.get(run.id)), /private-provider-response/);
});

test('unknown provider reconciliation is durably bounded and then stops querying the original task', async t => {
  const f = await fixture(t, { query: async () => { throw new Error('synthetic provider timeout'); } });
  const run = await f.service.create(input('bounded-unknown-reconciliation'));
  await f.service.tick();
  await f.service.tick();
  for (let attempt = 1; attempt < MAX_VIDEO_UNKNOWN_RECONCILIATIONS; attempt++) {
    await f.service.reconcile(run.id, {});
  }
  const exhausted = await f.service.get(run.id);
  assert.equal(exhausted.status, 'unknown');
  assert.equal(exhausted.providerTaskId, 'provider_task_1');
  assert.equal(exhausted.reconciliationAttempts, MAX_VIDEO_UNKNOWN_RECONCILIATIONS);
  assert.equal(exhausted.error.code, 'VIDEO_RECONCILIATION_LIMIT_REACHED');
  assert.equal(f.queries.length, MAX_VIDEO_UNKNOWN_RECONCILIATIONS);
  await f.service.reconcile(run.id, {});
  assert.equal(f.queries.length, MAX_VIDEO_UNKNOWN_RECONCILIATIONS);
  assert.equal(f.submits.length, 1);
});

test('terminal failure, cancellation and expiry never become a completed video', async t => {
  for (const status of ['failed', 'cancelled', 'expired']) {
    const f = await fixture(t, { query: async () => providerTask({ status, done: true, errorMessage: '合成失败' }) });
    const run = await f.service.create(input());
    await f.service.tick();
    await f.service.tick();
    const saved = await f.service.get(run.id);
    assert.equal(saved.status, 'failed');
    assert.equal(saved.result, null);
    assert.ok(saved.progress.completed < 5);
    await f.service.tick();
    await f.service.reconcile(run.id, {});
    assert.equal(f.submits.length, 1);
    assert.equal(f.queries.length, 1);
  }
});

test('invalid task identity or video URL cannot complete or replace the accepted provider ID', async t => {
  const badResults = [successfulTask({ taskId: 'unrelated_task' }), successfulTask({ videoUrl: 'http://cdn.example.test/video.mp4' }),
    successfulTask({ videoUrl: 'javascript:alert(1)' }), successfulTask({ videoUrl: 'https://name:password@cdn.example.test/video.mp4' }),
    successfulTask({ videoUrl: null })];
  for (const result of badResults) {
    const f = await fixture(t, { query: async () => result });
    const run = await f.service.create(input());
    await f.service.tick();
    await f.service.tick();
    const saved = await f.stored(run);
    assert.equal(saved.status, 'unknown');
    assert.equal(saved.providerTaskId, 'provider_task_1');
    assert.equal(saved.result, null);
    await f.service.tick();
    assert.equal(f.submits.length, 1);
    assert.equal(f.queries.length, 1);
  }
});

test('reconciliation accepts only an empty body and cannot turn a queued job into a paid submit', async t => {
  const f = await fixture(t);
  const run = await f.service.create(input());
  for (const body of [null, [], { allowPaid: true }, { providerTaskId: 'caller_task' }]) {
    await assert.rejects(f.service.reconcile(run.id, body), statusIs(400));
  }
  await f.service.reconcile(run.id, {});
  assert.equal(f.submits.length, 0);
  assert.equal(f.queries.length, 0);
});

test('video HTTP is local-only, no-store, asynchronous, and fails closed without migrated persistence', async t => {
  const f = await fixture(t);
  let networkCalls = 0;
  const transport = async () => { networkCalls++; throw new Error('real network forbidden'); };
  const app = await createApp(readConfig({}), transport, { videoAutomationService: f.service });
  t.after(() => app.close());
  for (const headers of [{ host: HEADERS.host }, { ...HEADERS, origin: 'https://external.example.test' },
    { ...HEADERS, host: 'external.example.test' }]) {
    const denied = await app.inject({ method: 'POST', url: '/api/video-automation-runs', headers, payload: input() });
    assert.equal(denied.statusCode, 403);
  }
  const response = await app.inject({ method: 'POST', url: '/api/video-automation-runs', headers: HEADERS, payload: input() });
  assert.ok([201, 202].includes(response.statusCode));
  assert.equal(response.headers['cache-control'], 'no-store');
  const run = response.json();
  assert.equal(run.status, 'queued');
  for (const url of ['/api/video-automation/status', '/api/video-automation-runs', `/api/video-automation-runs/${run.id}`]) {
    const read = await app.inject({ method: 'GET', url, headers: HEADERS });
    assert.equal(read.statusCode, 200);
    assert.equal(read.headers['cache-control'], 'no-store');
  }
  const invalid = await app.inject({ method: 'POST', url: `/api/video-automation-runs/${run.id}/reconcile`,
    headers: HEADERS, payload: { allowPaid: true } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(f.submits.length, 0);
  assert.equal(networkCalls, 0);

  const unavailable = await createApp(readConfig({}), transport);
  t.after(() => unavailable.close());
  const status = await unavailable.inject({ method: 'GET', url: '/api/video-automation/status', headers: HEADERS });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().available, false);
  const refused = await unavailable.inject({ method: 'POST', url: '/api/video-automation-runs', headers: HEADERS, payload: input() });
  assert.equal(refused.statusCode, 503);
  assert.equal(refused.headers['cache-control'], 'no-store');
  assert.equal(networkCalls, 0);
});

test('video migration declares persistent request identity, version checks and a single active slot', () => {
  const ddl = readFileSync(join(__dirname, '../migrations/014_video_automation_runs.sql'), 'utf8');
  assert.match(ddl, /CREATE TABLE\s+video_automation_runs/i);
  assert.match(ddl, /client_request_id[\s\S]*UNIQUE/i);
  assert.match(ddl, /version\s+INTEGER[\s\S]*CHECK\s*\(version\s*>=\s*0\)/i);
  assert.match(ddl, /CREATE UNIQUE INDEX[\s\S]*\(\(true\)\)[\s\S]*WHERE\s+status\s+IN\s*\([^)]*'queued'[^)]*'submitting'[^)]*'generating'/i);
  assert.doesNotMatch(ddl, /WHERE\s+status\s+IN\s*\([^)]*'unknown'/i);
});

test('real video adapter health is local-only and cached queries keep the exact authorized endpoint and credentials', async t => {
  const f = await fixture(t);
  const run = await f.stored(await f.service.create(input()));
  const endpoint = 'https://video-first.example.test/v1/tasks';
  const oldSecret = 'synthetic-old-video-key';
  let config = { ...readConfig({}), endpointUrl: endpoint, defaultModel: HEALTH.model,
    connectionRevision: HEALTH.connectionRevision, apiKey: oldSecret, authType: 'api-key' };
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(init.method === 'POST'
      ? { id: 'provider_task_1', status: 'queued' }
      : { id: 'provider_task_1', status: 'succeeded', content: { video_url: VIDEO_URL } }));
  };
  const adapter = new SeedanceVideoAutomationAdapter(() => config, transport);
  assert.equal((await adapter.health()).available, true);
  assert.equal(calls.length, 0);
  const submitted = await adapter.submit(run);
  assert.equal(submitted.state, 'submitted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, endpoint);
  const request = JSON.parse(calls[0].init.body);
  assert.equal(request.model, HEALTH.model);
  assert.equal(request.content[0].text, run.prompt);
  assert.equal(request.ratio, run.ratio);
  assert.equal(request.duration, run.duration);
  assert.equal(request.resolution, run.resolution);
  assert.equal(request.generate_audio, run.generateAudio);
  config = { ...config, endpointUrl: 'https://video-second.example.test/v2/tasks',
    defaultModel: 'different-model', connectionRevision: 'different-selection', apiKey: 'synthetic-new-key' };
  const accepted = { ...run, status: 'generating', providerTaskId: 'provider_task_1' };
  assert.equal((await adapter.query(accepted)).status, 'succeeded');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `${endpoint}/provider_task_1`);
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].init.headers['api-key'], oldSecret);
  assert.equal(calls[1].init.redirect, 'error');
  const restarted = new SeedanceVideoAutomationAdapter(() => config, transport);
  await assert.rejects(restarted.query(accepted), error => error.code === 'VIDEO_QUERY_CONNECTION_CHANGED');
  assert.equal(calls.length, 2);
  const blocked = await restarted.submit(run);
  assert.equal(blocked.state, 'blocked');
  assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(await f.service.get(run.id)), /synthetic-old-video-key|video-first\.example/);
});

test('real video adapter rejects an invalid request before any paid submit', async t => {
  const f = await fixture(t);
  const run = await f.stored(await f.service.create(input()));
  let calls = 0;
  const config = { ...readConfig({}), endpointUrl: 'https://video.example.test/v1/tasks', defaultModel: HEALTH.model,
    connectionRevision: HEALTH.connectionRevision, apiKey: 'synthetic-secret-must-not-leak', authType: 'bearer' };
  const adapter = new SeedanceVideoAutomationAdapter(() => config, async () => { calls++; throw new Error('must not call'); });
  const result = await adapter.submit({ ...run, duration: 2 });
  assert.equal(result.state, 'blocked');
  assert.equal(result.code, 'VIDEO_REFERENCE_ASSET_INVALID');
  assert.equal(calls, 0);
});

test('real video adapter treats network and malformed successful-submit responses as uncertain without retry', async t => {
  const f = await fixture(t);
  const run = await f.stored(await f.service.create(input()));
  const secret = 'synthetic-secret-must-not-leak';
  const config = { ...readConfig({}), endpointUrl: 'https://video.example.test/v1/tasks', defaultModel: HEALTH.model,
    connectionRevision: HEALTH.connectionRevision, apiKey: secret, authType: 'bearer' };
  for (const response of [async () => { throw new Error(secret); },
    async () => new Response('not JSON'),
    async () => new Response(JSON.stringify({ id: 'provider_task_1', status: 'succeeded' }))]) {
    let calls = 0;
    const adapter = new SeedanceVideoAutomationAdapter(() => config, async () => { calls++; return response(); });
    const result = await adapter.submit(run);
    assert.equal(result.state, 'unknown');
    assert.equal(result.code, 'VIDEO_SUBMISSION_UNCERTAIN');
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  let queryCalls = 0;
  const missingStatus = new SeedanceVideoAutomationAdapter(() => config, async () => {
    queryCalls++;
    return new Response(JSON.stringify({ id: 'provider_task_1' }));
  });
  await assert.rejects(missingStatus.query({ ...run, providerTaskId: 'provider_task_1' }),
    error => error.code === 'INVALID_MEDIA_RESPONSE');
  assert.equal(queryCalls, 1);
});

test('real video adapter resolves ordered HTTPS and local assets before Seedance submission', async t => {
  const f = await fixture(t);
  const stored = await f.stored(await f.service.create(input('video-with-references', {
    referenceAssetIds: [REF_EXTERNAL, REF_LOCAL], generateAudio: true,
  })));
  const config = { ...readConfig({}), endpointUrl: 'https://video.example.test/v1/tasks', defaultModel: HEALTH.model,
    connectionRevision: HEALTH.connectionRevision, apiKey: 'synthetic-reference-key', authType: 'bearer' };
  const calls = [];
  const assets = {
    async get(id) { return { id, resourceUrl: id === REF_EXTERNAL
      ? 'https://cdn.example.test/character.png?sig=stable' : `/api/assets/${id}/content` }; },
    async content(id) { assert.equal(id, REF_LOCAL); return { mimeType: 'image/png', bytes: png() }; },
  };
  const adapter = new SeedanceVideoAutomationAdapter(() => config, async (url, init) => {
    calls.push({ url, init }); return new Response(JSON.stringify({ id: 'provider_reference_task' }));
  }, assets);
  const result = await adapter.submit(stored);
  assert.equal(result.state, 'submitted'); assert.equal(calls.length, 1);
  const request = JSON.parse(calls[0].init.body);
  const references = request.content.filter(item => item.role === 'reference_image').map(item => item.image_url.url);
  assert.equal(references[0], 'https://cdn.example.test/character.png?sig=stable');
  assert.equal(references[1], `data:image/png;base64,${png().toString('base64')}`);
  assert.equal(request.generate_audio, true);

  let blockedCalls = 0;
  const disconnected = new SeedanceVideoAutomationAdapter(() => config, async () => { blockedCalls++; return new Response(); });
  const blocked = await disconnected.submit(stored);
  assert.equal(blocked.state, 'blocked'); assert.equal(blocked.code, 'VIDEO_REFERENCE_ASSETS_UNAVAILABLE');
  assert.equal(blockedCalls, 0);
});

test('native Seedance creation may return only an ID; the service persists it and queries the final result', async t => {
  // The official create endpoint promises an id, while status belongs to the query response:
  // https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh
  const config = { ...readConfig({}), endpointUrl: 'https://video.example.test/v1/tasks', defaultModel: HEALTH.model,
    connectionRevision: HEALTH.connectionRevision, apiKey: 'synthetic-unit-key', authType: 'bearer' };
  const calls = [];
  const adapter = new SeedanceVideoAutomationAdapter(() => config, async (url, init) => {
    calls.push({ url, method: init.method });
    return new Response(JSON.stringify(init.method === 'POST' ? { id: 'native_task_1' }
      : { id: 'native_task_1', status: 'succeeded', content: { video_url: VIDEO_URL } }));
  });
  const repo = new MemoryVideoAutomationRepository();
  const service = new VideoAutomationService(repo, adapter);
  t.after(() => service.stop());
  const run = await service.create(input());
  await service.tick();
  const submitted = await service.get(run.id);
  assert.equal(submitted.status, 'generating');
  assert.equal(submitted.providerTaskId, 'native_task_1');
  await service.tick();
  assert.equal((await service.get(run.id)).status, 'completed');
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
  assert.equal(calls[1].url, `${config.endpointUrl}/native_task_1`);
});
