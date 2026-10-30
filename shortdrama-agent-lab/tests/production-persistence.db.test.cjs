const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

if (!process.env.DATABASE_URL) {
  test('production PostgreSQL integration requires DATABASE_URL', { skip: 'Set DATABASE_URL before test:db.' }, () => {});
} else {
  const { readConfig } = require('../dist/config');
  const { readDatabaseConfig } = require('../dist/db/config');
  const { PostgresDatabase } = require('../dist/db/client');
  const { PostgresBreakdownRepository } = require('../dist/breakdown/repository');
  const { BreakdownService } = require('../dist/breakdown/service');
  const { compileProductionRun } = require('../dist/production/blueprint');
  const { productionId } = require('../dist/production/contracts');
  const { PostgresProductionRepository } = require('../dist/production/repository');

  test('PostgreSQL production aggregate persists CAS state and outbox atomically', async () => {
    const database = new PostgresDatabase(readDatabaseConfig());
    let projectId;
    try {
      await database.verifyConnection();
      assert.equal(await database.hasMigrations(['015', '016']), true, 'Run npm run db:migrate before test:db.');
      const breakdown = new BreakdownService(new PostgresBreakdownRepository(database),
        readConfig({ LLM_BASE_URL: 'https://model.test/openai', LLM_API_KEY: 'test-only-api-key' }));
      const project = await breakdown.createProject({ title: `production-db-test-${randomUUID()}` });
      projectId = project.id;
      const script = await breakdown.createScriptVersion(project.id, { rawText: '第1场 室内 夜\n林晚：开始。' });
      const now = '2026-10-23T12:00:00.000Z';
      const run = compileProductionRun({
        projectId: project.id, scriptVersionId: script.id, ratio: '9:16', targetDurationSec: 60,
        visualStyle: '离线数据库集成测试', qualityPreset: 'balanced', automationMode: 'auto',
        candidatePolicy: 'gacha', candidateLimit: 2, directorPolicy: 'auto', budgetMicros: 10_000_000, currency: 'CNY',
        allowPaid: true, clientRequestId: `production-db-${randomUUID()}`,
      }, now);
      const repository = new PostgresProductionRepository(database);
      const created = await repository.create(run);
      assert.deepEqual(await repository.get(created.id), created);
      assert.equal((await repository.getByClientRequestId(created.clientRequestId)).id, created.id);
      assert.equal((await repository.create(run)).id, created.id, 'exact create replay must reuse the durable run');

      const changed = structuredClone(created);
      changed.status = 'running'; changed.updatedAt = '2026-10-23T12:00:01.000Z';
      changed.outbox.push({ id: productionId('pevent'), runId: changed.id, sequence: 2,
        type: 'production.db_test.updated', payload: { offline: true }, createdAt: changed.updatedAt });
      const saved = await repository.replace(changed, created.version);
      assert.equal(saved.version, 1); assert.equal(saved.status, 'running');
      assert.equal((await repository.list()).some(item => item.id === saved.id && item.version === 1), true);
      const rows = await database.query(`SELECT r.version, r.status, r.run_json->>'version' AS json_version,
        COUNT(e.id)::int AS events FROM production_runs r
        LEFT JOIN production_outbox_events e ON e.run_id=r.id WHERE r.id=$1 GROUP BY r.id`, [saved.id]);
      assert.deepEqual(rows.rows[0], { version: 1, status: 'running', json_version: '1', events: 2 });
      await assert.rejects(repository.replace(created, created.version), error => error.code === 'PRODUCTION_RUN_CONFLICT');
      const tampered = structuredClone(saved); tampered.visualStyle = '篡改冻结输入';
      await assert.rejects(repository.replace(tampered, saved.version), error => error.code === 'PRODUCTION_RUN_CONFLICT');
    } finally {
      if (projectId) await database.query('DELETE FROM projects WHERE id=$1', [projectId]);
      await database.close();
    }
  });
}
