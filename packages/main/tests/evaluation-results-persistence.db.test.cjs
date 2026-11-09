const { test } = require('node:test');
const assert = require('node:assert/strict');

const hex = value => value.repeat(64);
const id = (prefix, char) => `${prefix}_${char.repeat(32)}`;

function fixtureResult(over = {}) {
  const base = {
    schemaVersion: 'lyra-evaluator-result/1',
    resultId: id('evalres', 'a'),
    locator: { runId: null, caseId: null, sampleIndex: null },
    subject: { kind: 'shot', id: 'shot-db-1', revisionId: null, digest: hex('b') },
    evaluator: { evaluatorId: 'rule-db', version: '1.0.0', digest: hex('c') },
    status: 'pass',
    inputSummary: 'db input',
    outputSummary: 'db output',
    confidence: 0.8,
    durationMs: 7,
    evidence: [{
      evidenceId: id('evidev', 'e'), source: 'production_quality', sourceDigest: hex('f'),
      locator: { entity: 'task-1', jsonPath: null, shotId: null, frameIndex: null, timecodeSec: null },
      availability: 'available', visibility: 'internal', note: 'n',
    }],
    metrics: [{ key: 'quality_check', layer: 'shot', value: 1, status: 'pass' }],
    error: null,
    legacy: { kind: 'quality_check', checkId: 'check-db-1', runId: 'run-db-1', level: 'shot', ruleVersion: 'rv/1' },
    occurredAt: '2026-11-04T00:00:00.000Z',
    recordedAt: '2026-11-04T00:00:01.000Z',
  };
  const merged = structuredClone(base);
  Object.assign(merged, over);
  return merged;
}

if (!process.env.DATABASE_URL) {
  test('EvaluationResults PostgreSQL integration requires DATABASE_URL', { skip: 'Set DATABASE_URL before test:db.' }, () => {});
} else {
  const { readDatabaseConfig } = require('../dist/db/config');
  const { PostgresDatabase } = require('../dist/db/client');
  const { PostgresEvaluationResultsRepository } = require('../dist/evaluation-results/postgres-repository');
  const { EvaluationResultsService } = require('../dist/evaluation-results/service');
  const { evaluationResultDigest, parseEvaluationResult } = require('@lyra/shared');

  test('PostgreSQL evaluation_results：追加、幂等、不可变与查询', async () => {
    const database = new PostgresDatabase(readDatabaseConfig());
    try {
      await database.verifyConnection();
      assert.equal(await database.hasMigrations(['025']), true, 'Run migrations before test:db.');
      const service = new EvaluationResultsService(new PostgresEvaluationResultsRepository(database));
      const first = fixtureResult();
      first.resultId = id('evalres', '1');
      first.resultDigest = evaluationResultDigest(first);
      const r1 = await service.record(first);
      assert.equal(r1.created, true);

      // 幂等重放：同一内容返回既有记录
      const replay = await service.record(fixtureResult({ resultId: id('evalres', '1') }));
      replay.resultDigest = evaluationResultDigest(replay);
      const r2 = await service.record(replay);
      assert.equal(r2.created, false);
      assert.equal(r2.result.resultId, r1.result.resultId);

      // 不同结果并存
      const second = fixtureResult({
        resultId: id('evalres', '2'),
        subject: { kind: 'shot', id: 'shot-db-2', revisionId: null, digest: hex('1') },
      });
      second.resultDigest = evaluationResultDigest(second);
      await service.record(second);

      const byDigest = await service.getByDigest(r1.result.resultDigest);
      assert.equal(byDigest.resultId, r1.result.resultId);
      // 往返解析：从 DB 读出的完整对象仍闭合
      assert.equal(parseEvaluationResult(byDigest).status, 'pass');
      const bySubject = await service.listBySubject('shot', 'shot-db-2');
      assert.equal(bySubject.length, 1);

      // 直接触碰表验证 append-only 触发器拒绝 UPDATE/DELETE
      await assert.rejects(
        database.query('UPDATE evaluation_results SET status = \'fail\' WHERE result_id = $1', [r1.result.resultId]),
        error => String(error.message).includes('EVALUATION_RESULTS_APPEND_ONLY'),
      );
      await assert.rejects(
        database.query('DELETE FROM evaluation_results WHERE result_id = $1', [r1.result.resultId]),
        error => String(error.message).includes('EVALUATION_RESULTS_APPEND_ONLY'),
      );
    } finally {
      await database.close();
    }
  });
}
