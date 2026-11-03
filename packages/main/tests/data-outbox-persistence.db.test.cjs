const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');

if (!process.env.DATABASE_URL) {
  test('Data outbox PostgreSQL integration requires DATABASE_URL', { skip: 'Set DATABASE_URL before test:db.' }, () => {});
} else {
  const { readConfig } = require('../dist/config');
  const { readDatabaseConfig } = require('../dist/db/config');
  const { PostgresDatabase } = require('../dist/db/client');
  const { PostgresBreakdownRepository } = require('../dist/breakdown/repository');
  const { BreakdownService } = require('../dist/breakdown/service');
  const { compileProductionRun } = require('../dist/production/blueprint');
  const { productionId } = require('@lyra/shared');
  const { PostgresProductionRepository } = require('../dist/production/repository');
  const { DataOutbox } = require('../dist/data/outbox');
  const { PostgresDataOutboxRepository } = require('../dist/data/repository');
  const { createDataEvent } = require('../dist/data/event');
  const { migrateLegacyProductionOutbox } = require('../dist/data/legacy');

  const baseEvent = (suffix, overrides = {}) => createDataEvent({
    eventType: 'production.run.status_changed',
    aggregateType: 'production_run',
    aggregateId: `production_${randomBytes(16).toString('hex')}`,
    aggregateVersion: 1,
    occurredAt: '2026-11-03T00:00:00.000Z',
    recordedAt: '2026-11-03T00:00:01.000Z',
    correlationId: `test-${suffix}`,
    authoritativeRef: { kind: 'fixture', id: `fixture-${suffix}`, revisionId: null, digest: 'b'.repeat(64) },
    payload: { status: 'running' },
    ...overrides,
  });

  test('事务回滚、重复投递、版本冲突与事件不可变', async () => {
    const database = new PostgresDatabase(readDatabaseConfig());
    try {
      await database.verifyConnection();
      assert.equal(await database.hasMigrations(['024']), true, 'Run npm run db:migrate before test:db.');
      const outbox = new DataOutbox(database);
      const repository = new PostgresDataOutboxRepository(database);

      const rolledBack = baseEvent(`rollback-${randomUUID()}`, { aggregateId: `production_${'b'.repeat(32)}` });
      await assert.rejects(outbox.transaction(async tx => {
        await tx.append(rolledBack);
        throw new Error('force rollback');
      }), error => error.message === 'force rollback');
      assert.equal(await repository.getByEventId(rolledBack.eventId), null, '业务事务回滚不能留下孤立事件');

      const event = baseEvent(`repeat-${randomUUID()}`, { aggregateId: `production_${randomBytes(16).toString('hex')}` });
      const first = await outbox.transaction(tx => tx.append(event));
      const second = await outbox.transaction(tx => tx.append(event));
      assert.equal(first.outboxId, second.outboxId, '同一 eventId 重复提交只保留一份');
      const count = await database.query(
        'SELECT COUNT(*)::int AS count FROM data_outbox_events WHERE event_id=$1', [event.eventId],
      );
      assert.equal(count.rows[0].count, 1);

      const conflict = baseEvent(`conflict-${randomUUID()}`, {
        aggregateId: event.aggregateId, aggregateVersion: event.aggregateVersion,
        eventType: 'production.run.paused',
      });
      await assert.rejects(outbox.transaction(tx => tx.append(conflict)),
        error => error.code === 'DATA_OUTBOX_AGGREGATE_VERSION_CONFLICT');
      await assert.rejects(database.query(
        'UPDATE data_outbox_events SET payload_json=$2::jsonb WHERE event_id=$1',
        [event.eventId, JSON.stringify({ status: 'completed' })],
      ), error => error.code === '23514' && String(error.message).includes('DATA_OUTBOX_TRANSACTION_REQUIRED'));
      assert.equal((await repository.markPublished(first.outboxId, '2026-11-03T00:00:02.000Z')).status, 'published');
      assert.equal((await repository.listPending(10, '2026-11-03T00:00:03.000Z'))
        .some(item => item.outboxId === first.outboxId), false);
    } finally {
      await database.close();
    }
  });

  test('生产运行写入与统一 Outbox 同事务，失败时业务行也不落库', async () => {
    const database = new PostgresDatabase(readDatabaseConfig());
    let projectId;
    try {
      await database.verifyConnection();
      const breakdown = new BreakdownService(new PostgresBreakdownRepository(database),
        readConfig({ LLM_BASE_URL: 'https://model.test/openai', LLM_API_KEY: 'test-only-api-key' }));
      const project = await breakdown.createProject({ title: `outbox-db-test-${randomUUID()}` });
      projectId = project.id;
      const script = await breakdown.createScriptVersion(project.id, { rawText: '第1场 室内 夜\n林晚：开始。' });
      const now = '2026-11-03T00:00:00.000Z';
      const valid = compileProductionRun({
        projectId: project.id, scriptVersionId: script.id, ratio: '9:16', targetDurationSec: 60,
        visualStyle: 'outbox integration', qualityPreset: 'balanced', automationMode: 'auto',
        candidatePolicy: 'gacha', candidateLimit: 2, directorPolicy: 'auto', budgetMicros: 10_000_000, currency: 'CNY',
        allowPaid: true, clientRequestId: `outbox-db-${randomUUID()}`,
      }, now);
      const invalid = structuredClone(valid);
      invalid.outbox.push({
        id: productionId('pevent'), runId: invalid.id, sequence: 2,
        type: 'production.too.many.segments', payload: { offline: true }, createdAt: now,
      });
      const repository = new PostgresProductionRepository(database);
      await assert.rejects(repository.create(invalid),
        error => error.code === 'DATA_EVENT_INPUT_INVALID');
      const absent = await database.query('SELECT 1 FROM production_runs WHERE id=$1', [invalid.id]);
      assert.equal(absent.rowCount, 0, 'Outbox 失败必须回滚生产运行');

      const created = await repository.create(valid);
      const events = await database.query(
        'SELECT event_type, aggregate_id FROM data_outbox_events WHERE aggregate_id=$1', [created.id],
      );
      assert.equal(events.rowCount, 1);
      assert.equal(events.rows[0].event_type, 'production.run.created');
      const legacyRows = await database.query(
        'SELECT COUNT(*)::int AS count FROM production_outbox_events WHERE run_id=$1', [created.id],
      );
      assert.equal(legacyRows.rows[0].count, 0, '新写入不再双写旧 outbox');
    } finally {
      if (projectId) await database.query('DELETE FROM projects WHERE id=$1', [projectId]);
      await database.close();
    }
  });

  test('Legacy production_outbox 映射可重入、不重复、不丢失', async () => {
    const database = new PostgresDatabase(readDatabaseConfig());
    let projectId;
    try {
      await database.verifyConnection();
      const breakdown = new BreakdownService(new PostgresBreakdownRepository(database),
        readConfig({ LLM_BASE_URL: 'https://model.test/openai', LLM_API_KEY: 'test-only-api-key' }));
      const project = await breakdown.createProject({ title: `outbox-legacy-${randomUUID()}` });
      projectId = project.id;
      const script = await breakdown.createScriptVersion(project.id, { rawText: '第1场 室内 夜\n林晚：开始。' });
      const now = '2026-11-03T00:00:00.000Z';
      const run = compileProductionRun({
        projectId: project.id, scriptVersionId: script.id, ratio: '9:16', targetDurationSec: 60,
        visualStyle: 'legacy mapping', qualityPreset: 'balanced', automationMode: 'auto',
        candidatePolicy: 'gacha', candidateLimit: 2, directorPolicy: 'auto', budgetMicros: 10_000_000, currency: 'CNY',
        allowPaid: true, clientRequestId: `outbox-legacy-${randomUUID()}`,
      }, now);
      await new PostgresProductionRepository(database).create(run);
      const legacyId = productionId('pevent');
      const deliveredAt = '2026-11-03T00:00:02.000Z';
      await database.query(`INSERT INTO production_outbox_events
        (id,run_id,sequence,event_type,payload_json,created_at,delivered_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [legacyId, run.id, 99, 'production.run.created', JSON.stringify({ workflowVersion: 'ohao-production/1' }), now, deliveredAt]);

      // 共享测试库可能已有历史旧行；断言只核对“当前旧表行全部被映射”，
      // 不假设全局只有本用例插入的一行。
      const first = await migrateLegacyProductionOutbox(database);
      assert.equal(first.after, first.before, '当前所有旧表行都必须有对应映射');
      assert.ok(first.migrated >= 1, '本用例新增的旧行必须被迁移');
      const second = await migrateLegacyProductionOutbox(database);
      assert.equal(second.migrated, 0);
      assert.equal(second.skipped, second.before, '第二次执行必须全部跳过');
      assert.equal(second.after, second.before);
      const legacy = await database.query(`
        SELECT event_id, event_type, aggregate_id, aggregate_version, status, published_at
        FROM data_outbox_events WHERE legacy_source='production_outbox_events' AND legacy_event_id=$1
      `, [legacyId]);
      assert.equal(legacy.rowCount, 1);
      assert.equal(legacy.rows[0].aggregate_id, run.id);
      assert.equal(legacy.rows[0].aggregate_version, 99);
      assert.match(legacy.rows[0].event_id, /^evt_[a-f0-9]{32}$/u);
      assert.equal(legacy.rows[0].status, 'published', '旧事件 delivered_at 必须映射为已投递');
      assert.ok(legacy.rows[0].published_at);
    } finally {
      if (projectId) await database.query('DELETE FROM projects WHERE id=$1', [projectId]);
      await database.close();
    }
  });
}
