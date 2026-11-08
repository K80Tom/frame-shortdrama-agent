const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { PostgresDatabase } = require('../dist/db/client');
const { PostgresJobQueueRepository } = require('../dist/jobs/repository');
const {
  PRODUCTION_MEDIA_OBJECT_QUEUE,
  PostgresProductionMediaObjectRepository,
  createProductionMediaObjectPayload,
} = require('../dist/production-media');

const connectionString = process.env.DATABASE_URL;
const token = () => randomBytes(16).toString('hex');
const iso = value => new Date(value).toISOString();

function projectionPayload(workspaceId, label) {
  const bytes = Buffer.from(label);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return createProductionMediaObjectPayload({ workspaceId }, {
    mediaId: `media_${sha256}`,
    provider: 'minio',
    bucket: 'lyra-media',
    sha256,
    sizeBytes: bytes.length,
    contentType: 'video/mp4',
  });
}

test('real PostgreSQL commits production media object, job and Outbox transitions atomically', {
  skip: connectionString ? false : 'DATABASE_URL is required',
}, async t => {
  const database = new PostgresDatabase({ connectionString });
  t.after(() => database.close());
  const suffix = token();
  const userId = `usr_${suffix}`;
  const workspaceId = `ws_${suffix}`;
  const createdAt = new Date().toISOString();
  await database.transaction(async client => {
    await client.query(`
      INSERT INTO users (id, subject, display_name, kind, status, created_at, updated_at)
      VALUES ($1, $2, 'Object projection DB test', 'human', 'active', $3, $3)
    `, [userId, `test:object:${suffix}`, createdAt]);
    await client.query(`
      INSERT INTO workspaces (id, slug, name, status, created_by_user_id, created_at, updated_at)
      VALUES ($1, $2, 'Object projection DB test', 'active', $3, $4, $4)
    `, [workspaceId, `object-${suffix}`, userId, createdAt]);
    await client.query(`
      INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
      VALUES ($1, $2, 'owner', 'active', $3, $3)
    `, [workspaceId, userId, createdAt]);
  });

  const jobs = new PostgresJobQueueRepository(database);
  const records = new PostgresProductionMediaObjectRepository(database, jobs);
  const base = Date.now() + 1_000;

  await t.test('enqueue is idempotent and creates all three durable facts together', async () => {
    const body = projectionPayload(workspaceId, `ready-${suffix}`);
    const first = await records.enqueue({ workspaceId }, body, iso(base));
    const duplicate = await records.enqueue({ workspaceId }, body, iso(base + 1));
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.id, first.job.id);
    assert.equal(duplicate.record.id, first.record.id);

    const state = await database.query(`
      SELECT jobs.state AS job_state, objects.status AS object_status, objects.job_id,
             objects.version AS object_version
      FROM jobs
      JOIN object_records objects
        ON objects.workspace_id = jobs.workspace_id AND objects.job_id = jobs.id
      WHERE jobs.workspace_id = $1 AND jobs.id = $2
    `, [workspaceId, first.job.id]);
    assert.deepEqual(state.rows[0], { job_state: 'queued', object_status: 'uploading',
      job_id: first.job.id, object_version: 1 });
    const queuedEvents = await database.query(`
      SELECT event_type, aggregate_version
      FROM data_outbox_events
      WHERE workspace_id = $1 AND aggregate_id = $2
      ORDER BY aggregate_version
    `, [workspaceId, body.objectId]);
    assert.deepEqual(queuedEvents.rows, [
      { event_type: 'delivery.object.queued', aggregate_version: 1 },
    ]);

    const claimed = await jobs.claim({ queueName: PRODUCTION_MEDIA_OBJECT_QUEUE,
      workerId: `object-worker-${suffix}`, leaseMs: 10_000, now: iso(base + 10) });
    assert.equal(claimed.job.id, first.job.id);
    const ready = await records.complete(claimed, {
      provider: body.provider,
      bucket: body.bucket,
      key: body.key,
      versionId: 'version-ready',
      etag: 'etag-ready',
      sha256: body.sha256,
      size: body.sizeBytes,
      contentType: body.contentType,
    }, iso(base + 20));
    assert.equal(ready.status, 'ready');
    assert.equal(ready.version, 2);

    const completed = await database.query(`
      SELECT jobs.state AS job_state, objects.status AS object_status,
             objects.version AS object_version, objects.verified_at IS NOT NULL AS verified
      FROM jobs
      JOIN object_records objects
        ON objects.workspace_id = jobs.workspace_id AND objects.job_id = jobs.id
      WHERE jobs.workspace_id = $1 AND jobs.id = $2
    `, [workspaceId, first.job.id]);
    assert.deepEqual(completed.rows[0], { job_state: 'succeeded', object_status: 'ready',
      object_version: 2, verified: true });
    const events = await database.query(`
      SELECT event_type, aggregate_version
      FROM data_outbox_events
      WHERE workspace_id = $1 AND aggregate_id = $2
      ORDER BY aggregate_version
    `, [workspaceId, body.objectId]);
    assert.deepEqual(events.rows, [
      { event_type: 'delivery.object.queued', aggregate_version: 1 },
      { event_type: 'delivery.object.ready', aggregate_version: 2 },
    ]);
  });

  await t.test('retry keeps uploading and terminal failure closes object and job together', async () => {
    const body = projectionPayload(workspaceId, `failed-${suffix}`);
    const queued = await records.enqueue({ workspaceId }, body, iso(base + 1_000));
    const firstLease = await jobs.claim({ queueName: PRODUCTION_MEDIA_OBJECT_QUEUE,
      workerId: `object-worker-${suffix}`, leaseMs: 10_000, now: iso(base + 1_010) });
    assert.equal(firstLease.job.id, queued.job.id);
    const retry = await records.fail(firstLease, 'OBJECT_STORAGE_UNAVAILABLE', true,
      iso(base + 2_000), iso(base + 1_020));
    assert.equal(retry.job.state, 'queued');
    assert.equal(retry.record.status, 'uploading');
    assert.equal(retry.record.version, 2);

    const secondLease = await jobs.claim({ queueName: PRODUCTION_MEDIA_OBJECT_QUEUE,
      workerId: `object-worker-${suffix}`, leaseMs: 10_000, now: iso(base + 2_000) });
    assert.equal(secondLease.job.id, queued.job.id);
    const failed = await records.fail(secondLease, 'OBJECT_CHECKSUM_MISMATCH', false,
      iso(base + 2_100), iso(base + 2_010));
    assert.equal(failed.job.state, 'failed');
    assert.equal(failed.record.status, 'failed');
    assert.equal(failed.record.version, 3);

    const finalState = await database.query(`
      SELECT jobs.state AS job_state, jobs.last_error AS job_error,
             objects.status AS object_status, objects.last_error AS object_error,
             objects.version AS object_version
      FROM jobs
      JOIN object_records objects
        ON objects.workspace_id = jobs.workspace_id AND objects.job_id = jobs.id
      WHERE jobs.workspace_id = $1 AND jobs.id = $2
    `, [workspaceId, queued.job.id]);
    assert.deepEqual(finalState.rows[0], { job_state: 'failed', job_error: 'OBJECT_CHECKSUM_MISMATCH',
      object_status: 'failed', object_error: 'OBJECT_CHECKSUM_MISMATCH', object_version: 3 });
    const events = await database.query(`
      SELECT event_type, aggregate_version
      FROM data_outbox_events
      WHERE workspace_id = $1 AND aggregate_id = $2
      ORDER BY aggregate_version
    `, [workspaceId, body.objectId]);
    assert.deepEqual(events.rows, [
      { event_type: 'delivery.object.queued', aggregate_version: 1 },
      { event_type: 'delivery.object.retry_scheduled', aggregate_version: 2 },
      { event_type: 'delivery.object.failed', aggregate_version: 3 },
    ]);
  });
});
