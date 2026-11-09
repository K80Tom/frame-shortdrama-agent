const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { PersistentJobWorker, NonRetryableJobError } = require('../dist/jobs/worker');
const {
  DataDispatchJobPump,
  DataOutboxJobHandler,
  DATA_PROJECTION_JOB_KIND,
} = require('../dist/data/job-dispatcher');
const {
  AssetVectorProjectionJobHandler,
  ASSET_VECTOR_JOB_KIND,
} = require('../dist/assets/vector/job-projector');
const { buildAssetVectorText } = require('../dist/assets/vector/projection');

const workspaceId = `ws_${'1'.repeat(32)}`;
const userId = `usr_${'2'.repeat(32)}`;
const jobId = `job_${'3'.repeat(32)}`;
const eventId = `evt_${'4'.repeat(32)}`;
const assetId = `asset_${'5'.repeat(32)}`;
const now = '2026-11-08T00:00:00.000Z';

function job(kind = 'test.execute', payload = {}) {
  return {
    id: jobId, workspaceId, queueName: 'projection', kind,
    aggregateType: null, aggregateId: null, idempotencyKey: 'test-job-0001', payload,
    state: 'running', priority: 50, maxAttempts: 5, attemptCount: 1,
    availableAt: now, leaseOwner: 'worker-test', fencingToken: 1,
    leaseExpiresAt: '2026-11-08T00:01:00.000Z', heartbeatAt: now,
    lastError: null, version: 2, createdAt: now, updatedAt: now, completedAt: null,
  };
}

function lease(kind, payload = {}) {
  return { job: job(kind, payload), attemptId: `jobatt_${'6'.repeat(32)}`,
    attemptNumber: 1, workerId: 'worker-test', fencingToken: 1,
    leaseExpiresAt: '2026-11-08T00:01:00.000Z' };
}

test('persistent worker claims under system scope and handles the job under a resolved tenant scope', async () => {
  const calls = [];
  let pending = lease('test.execute');
  const repository = {
    async claim() { calls.push('claim'); const value = pending; pending = null; return value; },
    async heartbeat() { calls.push('heartbeat'); return job(); },
    async saveStep(input) { calls.push(`step:${input.stepKey}`); },
    async complete() { calls.push('complete'); return { ...job(), state: 'succeeded' }; },
    async fail() { throw new Error('not expected'); },
  };
  const scope = {
    runAsSystem(reason, work) { calls.push(`system:${reason}`); return work(); },
    runWithTenant(tenant, work) { calls.push(`tenant:${tenant.workspaceId}`); return work(); },
  };
  const resolver = { async resolve() { calls.push('resolve'); return {
    userId, workspaceId, role: 'owner', requestId: `worker:${jobId}`,
  }; } };
  const worker = new PersistentJobWorker(repository, resolver, [{
    queueName: 'projection', kind: 'test.execute', async handle(context) {
      await context.assertLease();
      await context.checkpoint('test.done', { ok: true });
      calls.push('handled');
    },
  }], { workerId: 'worker-test', leaseMs: 30_000, now: () => new Date(now), executionScope: scope });
  assert.equal(await worker.runOnce('projection'), true);
  assert.deepEqual(calls, [
    'system:jobs.claim', 'claim', 'resolve', `tenant:${workspaceId}`,
    'heartbeat', 'step:test.done', 'handled', 'complete',
  ]);
});

test('non-retryable worker failures become terminal queue failures', async () => {
  let failed;
  const repository = {
    async claim() { return lease('test.reject'); },
    async heartbeat() { return job(); }, async saveStep() {}, async complete() {},
    async fail(input) { failed = input; return { ...job(), state: 'failed' }; },
  };
  const resolver = { async resolve() { return { userId, workspaceId, role: 'owner', requestId: `worker:${jobId}` }; } };
  const worker = new PersistentJobWorker(repository, resolver, [{
    queueName: 'projection', kind: 'test.reject',
    async handle() { throw new NonRetryableJobError('invalid projection'); },
  }], { workerId: 'worker-test', leaseMs: 30_000, now: () => new Date(now) });
  assert.equal(await worker.runOnce('projection'), true);
  assert.equal(failed.retryable, false);
  assert.equal(failed.error, 'invalid projection');
});

test('dispatcher pump converts a pending outbox record into one durable projection job', async () => {
  const enqueued = [];
  const event = { eventId, eventType: 'production.run.status_changed', schemaVersion: 'lyra.data.event/v2',
    workspaceId, aggregateType: 'production_run', aggregateId: `production_${'7'.repeat(32)}`,
    aggregateVersion: 1, occurredAt: now, recordedAt: now, correlationId: 'correlation-0001',
    causationId: null, idempotencyKey: 'outbox-event-0001',
    authoritativeRef: { kind: 'production_run', id: `production_${'7'.repeat(32)}`, revisionId: null,
      digest: '8'.repeat(64) }, payload: { status: 'queued' } };
  const outbox = { async listPending() { return [{ outboxId: `outbox_${'9'.repeat(32)}`,
    workspaceId, event, attempts: 0 }]; } };
  const jobs = { async enqueue(tenant, input) { enqueued.push({ tenant, input }); return { job: job(), created: true }; },
    async requeueTerminal() { throw new Error('not expected'); } };
  const pump = new DataDispatchJobPump(outbox, jobs, { now: () => new Date(now) });
  assert.equal(await pump.runOnce(), 1);
  assert.equal(enqueued[0].tenant.workspaceId, workspaceId);
  assert.equal(enqueued[0].input.kind, DATA_PROJECTION_JOB_KIND);
  assert.equal(enqueued[0].input.idempotencyKey, `outbox:${eventId}`);
});

test('dispatcher safely requeues an existing terminal projection job with a stable reconciliation key', async () => {
  const requeues = [];
  const event = { eventId, aggregateType: 'production_run', aggregateId: `production_${'7'.repeat(32)}` };
  const outbox = { async listPending() { return [{outboxId: `outbox_${'9'.repeat(32)}`,
    workspaceId, event, attempts: 0}]; }, async markPublished() { throw new Error('not expected'); } };
  const terminal = {...job(DATA_PROJECTION_JOB_KIND, {eventId}), state: 'dead_letter', version: 7,
    completedAt: now};
  const jobs = { async enqueue() { return {job: terminal, created: false}; },
    async requeueTerminal(input) { requeues.push(input); return {job: {...terminal, state: 'queued'}, requeued: true}; } };
  const pump = new DataDispatchJobPump(outbox, jobs, {now: () => new Date(now)});
  assert.equal(await pump.runOnce(), 1);
  assert.equal(requeues.length, 1);
  assert.equal(requeues[0].expectedVersion, 7);
  assert.equal(requeues[0].recoveryKey, `outbox:${eventId}:terminal-v7`);
});

test('outbox projection handler publishes only after an idempotent projection and fenced lease check', async () => {
  const calls = [];
  const stored = { outboxId: `outbox_${'9'.repeat(32)}`, workspaceId,
    event: { eventId, aggregateVersion: 1 }, attempts: 0 };
  const outbox = {
    async getByEventId() { return stored; },
    async markPublished() { calls.push('published'); return stored; },
    async markFailure() { calls.push('failed'); return stored; },
  };
  const handler = new DataOutboxJobHandler(outbox, {
    async deliver() { calls.push('projected'); return { status: 'projected' }; },
  }, { now: () => new Date(now) });
  await handler.handle({ lease: lease(DATA_PROJECTION_JOB_KIND, { eventId }), signal: new AbortController().signal,
    async assertLease() { calls.push('fenced'); },
    async checkpoint() { calls.push('checkpoint'); } });
  assert.deepEqual(calls, ['projected', 'fenced', 'published', 'checkpoint']);
});

test('Milvus v2 projection job verifies source version, checkpoints and publishes fenced metadata', async () => {
  const asset = { id: assetId, kind: 'character', name: '林晚', description: '灰色西装的女总裁',
    resourceUrl: 'https://media.example.test/asset.png', createdAt: now };
  const sourceVersion = createHash('sha256').update(buildAssetVectorText(asset), 'utf8').digest('hex');
  const state = { workspace_id: workspaceId, source_id: assetId, source_version: sourceVersion,
    status: 'queued', indexed_version: null, job_id: jobId, fencing_token: 0,
    id: asset.id, kind: asset.kind, name: asset.name, description: asset.description,
    resource_url: asset.resourceUrl, created_at: asset.createdAt };
  const database = {
    async transaction(work) { return work({ query: async sql => {
      if (sql.includes('SELECT state.workspace_id')) return { rows: [{ ...state }] };
      if (sql.includes("SET status = 'indexing'")) return { rows: [{ ...state, status: 'indexing', fencing_token: 1 }] };
      throw new Error(`unexpected SQL: ${sql}`);
    } }); },
    async query(sql) {
      if (sql.includes("SET status = 'indexed'")) return { rows: [{ source_id: assetId }] };
      if (sql.includes("SET status = 'failed'")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const upserts = []; const checkpoints = [];
  const handler = new AssetVectorProjectionJobHandler(database, {
    collection: 'lyra_asset_vectors_v2', embeddingModel: 'embedding-v1',
    embedding: { async embedText() { return [0.2, 0.8]; } },
    store: { async upsert(scope, record) { upserts.push({ scope, record }); } },
    now: () => new Date(now),
  });
  await handler.handle({
    lease: lease(ASSET_VECTOR_JOB_KIND, { assetId, sourceVersion, collection: 'lyra_asset_vectors_v2' }),
    signal: new AbortController().signal,
    async assertLease() {}, async checkpoint(step) { checkpoints.push(step); },
  });
  assert.equal(upserts[0].scope.workspaceId, workspaceId);
  assert.equal(upserts[0].record.sourceVersion, sourceVersion);
  assert.deepEqual(checkpoints, ['vector.source_loaded', 'vector.embedded',
    'vector.milvus_upserted', 'vector.projection_committed']);
});

test('031 migration fences vector projection metadata writes', () => {
  const sql = readFileSync(join(__dirname, '../migrations/031_vector_projection_fencing.sql'), 'utf8');
  assert.match(sql, /ALTER TABLE vector_projection_states/u);
  assert.match(sql, /fencing_token bigint NOT NULL DEFAULT 0/u);
  assert.match(sql, /ADD PRIMARY KEY \(consumer_name, workspace_id\)/u);
});

test('first-admin bootstrap requires the complete Stage 1 migration baseline', () => {
  const source = readFileSync(join(__dirname, '../src/auth/bootstrap-admin.ts'), 'utf8');
  assert.match(source, /hasMigrations\(\['025', '028', '030', '031', '042'\]\)/u);
});
