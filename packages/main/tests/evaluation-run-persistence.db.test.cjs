const { test } = require('node:test');
const assert = require('node:assert/strict');

const hex = value => value.repeat(64);
const id = (prefix, char) => `${prefix}_${char.repeat(32)}`;
const snapshotFixture = () => ({
  schemaVersion: 'lyra-evaluation-snapshot/1',
  catalogKind: 'shot_review',
  dataset: { datasetId: id('evalds', 'a'), revisionId: id('evaldsrev', 'b'), digest: hex('b') },
  rubric: { rubricId: id('evalrub', 'c'), revisionId: id('evalrubrev', 'd'), digest: hex('d') },
  evaluator: { evaluatorId: 'evaluator-local', version: '1.0.0', digest: hex('e') },
  candidates: [
    { candidateId: 'candidate-b', version: '1', digest: hex('1') },
    { candidateId: 'candidate-a', version: '1', digest: hex('2') },
  ],
  modelConnection: { connectionId: 'connection-local', revisionId: 'connrev-1', provider: 'stub', model: 'deterministic', digest: hex('3') },
  prompt: { promptId: 'prompt-shot', version: '3', digest: hex('4') },
  workflow: { workflowId: 'workflow-shot', version: '2', digest: hex('5') },
  code: { version: '0.1.0', commit: 'abcdef1234567890abcdef1234567890abcdef12', digest: hex('6') },
  seed: 'seed-001',
  shards: { shardCount: 2, shardIndex: 0, concurrency: 4, timeoutMs: 120000, samplesPerCase: 2 },
  createdAt: '2026-11-03T00:00:00.000Z',
});

if (!process.env.DATABASE_URL) {
  test('EvaluationRun PostgreSQL integration requires DATABASE_URL', { skip: 'Set DATABASE_URL before test:db.' }, () => {});
} else {
  const { readDatabaseConfig } = require('../dist/db/config');
  const { PostgresDatabase } = require('../dist/db/client');
  const { PostgresEvaluationRunRepository } = require('../dist/evaluation-run/postgres-repository');
  const { EvaluationRunService } = require('../dist/evaluation-run/service');
  const { evaluationSnapshotDigest, parseFrozenEvaluationSnapshot } = require('@lyra/shared');
  const { randomUUID } = require('node:crypto');

  test('PostgreSQL EvaluationRun：幂等、CAS、终态不可变与独立 attempt', async () => {
    const database = new PostgresDatabase(readDatabaseConfig());
    try {
      await database.verifyConnection();
      assert.equal(await database.hasMigrations(['023']), true, 'Run npm run db:migrate before test:db.');
      const service = new EvaluationRunService(new PostgresEvaluationRunRepository(database));
      const key = `eval-run-db-${randomUUID()}`;
      const created = await service.create({ idempotencyKey: key, snapshot: snapshotFixture() });
      const repeated = await service.create({ idempotencyKey: key, snapshot: snapshotFixture() });
      assert.equal(repeated.runId, created.runId);
      assert.equal(created.version, 1);
      assert.equal(created.snapshotDigest, evaluationSnapshotDigest(parseFrozenEvaluationSnapshot(snapshotFixture())));
      assert.equal((await service.listEvents(created.runId)).length, 1);

      const changed = snapshotFixture();
      changed.seed = 'seed-002';
      await assert.rejects(service.create({ idempotencyKey: key, snapshot: changed }),
        error => error.code === 'EVALUATION_RUN_IDEMPOTENCY_CONFLICT');

      await assert.rejects(service.transition(created.runId, { expectedVersion: 2, status: 'running' }),
        error => error.code === 'EVALUATION_RUN_VERSION_CONFLICT');
      const running = await service.transition(created.runId, { expectedVersion: 1, status: 'running' });
      assert.equal(running.version, 2);

      const attempt = await service.beginCase(created.runId, 'case-1', 0, 1);
      const sample = await service.recordSample(created.runId, attempt.caseAttemptId, 0, hex('a'), 10, 0, 'CNY');
      assert.equal(sample.costMicros, 0);
      const finished = await service.finishCase(attempt.caseAttemptId, created.runId, 'completed');
      assert.equal(finished.status, 'completed');
      await assert.rejects(service.finishCase(attempt.caseAttemptId, created.runId, 'failed', {
        category: 'execution', code: 'X', message: 'late',
      }), error => error.code === 'EVALUATION_RUN_CASE_ATTEMPT_IMMUTABLE');

      const completed = await service.transition(created.runId, { expectedVersion: 2, status: 'completed' });
      assert.equal(completed.status, 'completed');
      await assert.rejects(service.transition(created.runId, { expectedVersion: 3, status: 'running' }),
        error => error.code === 'EVALUATION_RUN_TERMINAL_IMMUTABLE');
      await assert.rejects(service.beginCase(created.runId, 'case-2', 0, 1),
        error => error.code === 'EVALUATION_RUN_TERMINAL_IMMUTABLE');

      await assert.rejects(database.query(
        'UPDATE evaluation_runs SET status = $2 WHERE run_id = $1', [created.runId, 'running'],
      ), error => error.code === '23514' && String(error.message).includes('EVALUATION_RUN_TERMINAL_IMMUTABLE'));
      await assert.rejects(database.query(
        'UPDATE evaluation_case_attempts SET status = $2 WHERE case_attempt_id = $1',
        [attempt.caseAttemptId, 'failed'],
      ), error => error.code === '23514' && String(error.message).includes('EVALUATION_RUN_CASE_ATTEMPT_IMMUTABLE'));

      const replay = await service.replay(created.runId, { idempotencyKey: `eval-run-replay-${randomUUID()}` });
      assert.notEqual(replay.runId, created.runId);
      assert.equal(replay.replayedFromRunId, created.runId);
      assert.equal(replay.snapshotDigest, completed.snapshotDigest);
      assert.equal((await service.get(created.runId)).status, 'completed');

      const fks = await database.query(`
        SELECT tc.table_name, ccu.table_name AS referenced
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name LIKE 'evaluation_%'
      `);
      assert.equal(fks.rows.some(row => row.referenced.startsWith('production_')), false,
        'EvaluationRun 不得与生产表建立外键');
    } finally {
      await database.close();
    }
  });
}
