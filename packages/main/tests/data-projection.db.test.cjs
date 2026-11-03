const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');

if (!process.env.DATABASE_URL) {
  test('Data projection PostgreSQL integration requires DATABASE_URL', { skip: 'Set DATABASE_URL before test:db.' }, () => {});
} else {
  const { readDatabaseConfig } = require('../dist/db/config');
  const { PostgresDatabase } = require('../dist/db/client');
  const { createDataEvent } = require('../dist/data/event');
  const { PostgresProjectionStore } = require('../dist/data/checkpoint');
  const { DataProjector } = require('../dist/data/projector');

  test('PostgreSQL 投影、处理记录与 checkpoint 同事务提交', async () => {
    const database = new PostgresDatabase(readDatabaseConfig());
    const consumer = `projector-db-${randomUUID().slice(0, 8)}`;
    try {
      await database.verifyConnection();
      assert.equal(await database.hasMigrations(['024']), true, 'Run npm run db:migrate before test:db.');
      const store = new PostgresProjectionStore(database);
      const projector = new DataProjector(consumer, store);
      const aggregateId = `production_${randomBytes(16).toString('hex')}`;
      const make = version => createDataEvent({
        eventType: 'production.run.status_changed',
        aggregateType: 'production_run', aggregateId, aggregateVersion: version,
        occurredAt: '2026-11-03T00:00:00.000Z', recordedAt: '2026-11-03T00:00:01.000Z',
        correlationId: `db-corr-${version}-${randomUUID().slice(0, 6)}`,
        authoritativeRef: { kind: 'fixture', id: aggregateId, revisionId: null, digest: 'b'.repeat(64) },
        payload: { status: 'running' },
      });
      const first = await projector.deliver(make(1));
      assert.equal(first.status, 'projected');
      const duplicate = await projector.deliver(make(1));
      assert.equal(duplicate.status, 'duplicate');
      const projections = await store.listProjections(consumer);
      assert.equal(projections.length, 1, '重复投递不能产生第二份投影');
      const checkpoint = await store.getCheckpoint(consumer);
      assert.equal(checkpoint.aggregateVersion, 1);
      const count = await database.query(
        'SELECT COUNT(*)::int AS count FROM data_consumer_records WHERE consumer_name=$1', [consumer],
      );
      assert.equal(count.rows[0].count, 1, '处理记录与投影同事务只写一次');
    } finally {
      await database.close();
    }
  });
}
