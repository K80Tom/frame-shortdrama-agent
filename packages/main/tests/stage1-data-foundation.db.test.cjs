const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { PostgresDatabase } = require('../dist/db/client');
const { DataOutbox } = require('../dist/data/outbox');
const { PostgresDataOutboxRepository } = require('../dist/data/repository');
const { PostgresProjectionStore } = require('../dist/data/checkpoint');
const { DataProjector } = require('../dist/data/projector');
const { createDataEventV2, tenantDataEventDigest } = require('../dist/data/tenant-event');
const { JobQueueError } = require('../dist/jobs/contracts');
const { PostgresJobQueueRepository } = require('../dist/jobs/repository');

const connectionString = process.env.DATABASE_URL;
const token = () => randomBytes(16).toString('hex');
const iso = value => new Date(value).toISOString();

test('real PostgreSQL persists V2 tenant events and fences reclaimed jobs', {
  skip: connectionString ? false : 'DATABASE_URL is required',
}, async t => {
  const database = new PostgresDatabase({ connectionString });
  t.after(() => database.close());
  const suffix = token();
  const userId = `usr_${suffix}`;
  const workspaceId = `ws_${suffix}`;
  const now = new Date().toISOString();
  await database.transaction(async client => {
    await client.query(`
      INSERT INTO users (id, subject, display_name, kind, status, created_at, updated_at)
      VALUES ($1, $2, 'Stage 1 DB test', 'human', 'active', $3, $3)
    `, [userId, `test:${suffix}`, now]);
    await client.query(`
      INSERT INTO workspaces (id, slug, name, status, created_by_user_id, created_at, updated_at)
      VALUES ($1, $2, 'Stage 1 DB test', 'active', $3, $4, $4)
    `, [workspaceId, `test-${suffix}`, userId, now]);
    await client.query(`
      INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
      VALUES ($1, $2, 'owner', 'active', $3, $3)
    `, [workspaceId, userId, now]);
  });

  const event = createDataEventV2({
    workspaceId,
    eventType: 'production.run.status_changed',
    aggregateType: 'production_run',
    aggregateId: `production_${token()}`,
    aggregateVersion: 1,
    occurredAt: now,
    recordedAt: now,
    correlationId: `stage1:${suffix}`,
    authoritativeRef: {
      kind: 'production_run',
      id: `production_${token()}`,
      revisionId: null,
      digest: 'd'.repeat(64),
    },
    payload: { status: 'queued' },
  });
  const outbox = new DataOutbox(database);
  const stored = await outbox.transaction(tx => tx.append(event));
  assert.equal(stored.workspaceId, workspaceId);
  assert.equal(stored.eventDigest, tenantDataEventDigest(event));
  const loaded = await new PostgresDataOutboxRepository(database).getByEventId(event.eventId);
  assert.equal(loaded.workspaceId, workspaceId);
  assert.equal(loaded.event.workspaceId, workspaceId);

  const consumer = `stage1-db-${suffix}`;
  const store = new PostgresProjectionStore(database);
  assert.equal((await new DataProjector(consumer, store).deliver(loaded.event)).status, 'projected');
  assert.equal((await store.listProjections(consumer))[0].workspaceId, workspaceId);

  const jobs = new PostgresJobQueueRepository(database);
  const base = Date.parse(now) + 1_000;
  const queued = await jobs.enqueue({ workspaceId }, {
    queueName: 'model',
    kind: 'assistant.reply',
    aggregateType: 'assistant_session',
    aggregateId: `assistant_${suffix}`,
    idempotencyKey: `stage1-db-job:${suffix}`,
    payload: { sessionId: `assistant_${suffix}` },
    availableAt: iso(base),
  });
  assert.equal(queued.created, true);
  const first = await jobs.claim({ queueName: 'model', workerId: `worker-a-${suffix}`,
    leaseMs: 1_000, now: iso(base) });
  assert.equal(first.fencingToken, 1);
  await jobs.heartbeat({ workspaceId, jobId: first.job.id, workerId: first.workerId,
    fencingToken: first.fencingToken, leaseMs: 1_000, now: iso(base + 500) });
  const second = await jobs.claim({ queueName: 'model', workerId: `worker-b-${suffix}`,
    leaseMs: 1_000, now: iso(base + 1_501) });
  assert.equal(second.fencingToken, 2);
  await assert.rejects(jobs.complete({ workspaceId, jobId: first.job.id, workerId: first.workerId,
    fencingToken: first.fencingToken, now: iso(base + 1_600) }), error => {
    assert.ok(error instanceof JobQueueError);
    assert.equal(error.code, 'JOB_LEASE_LOST');
    return true;
  });
  const complete = await jobs.complete({ workspaceId, jobId: second.job.id, workerId: second.workerId,
    fencingToken: second.fencingToken, now: iso(base + 1_600) });
  assert.equal(complete.state, 'succeeded');
});
