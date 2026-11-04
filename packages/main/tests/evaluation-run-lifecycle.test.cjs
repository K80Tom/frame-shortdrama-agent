const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EvaluationError, evaluationSnapshotDigest, parseFrozenEvaluationSnapshot } = require('@lyra/shared');
const { MemoryEvaluationRunRepository } = require('../dist/evaluation-run/repository');
const { EvaluationRunService } = require('../dist/evaluation-run/service');

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

function makeService() {
  return new EvaluationRunService(new MemoryEvaluationRunRepository(), {
    now: (() => {
      let tick = 0;
      return () => new Date(Date.UTC(2026, 10, 3, 0, 0, tick++));
    })(),
  });
}

function codeOf(action) {
  return assert.rejects(action, error => {
    assert.ok(error instanceof EvaluationError, error?.stack || String(error));
    return true;
  });
}

test('同一幂等键同请求返回同一运行，不同请求报冲突', async () => {
  const service = makeService();
  const first = await service.create({ idempotencyKey: 'run-key-0001', snapshot: snapshotFixture() });
  const second = await service.create({ idempotencyKey: 'run-key-0001', snapshot: snapshotFixture() });
  assert.equal(first.runId, second.runId);
  assert.equal(first.snapshotDigest, second.snapshotDigest);
  assert.equal(first.status, 'prepared');

  const changed = snapshotFixture();
  changed.seed = 'seed-002';
  await codeOf(service.create({ idempotencyKey: 'run-key-0001', snapshot: changed }));
});

test('创建时快照摘要稳定，且运行版本从 1 开始', async () => {
  const service = makeService();
  const first = await service.create({ idempotencyKey: 'run-key-0002', snapshot: snapshotFixture() });
  const reversed = snapshotFixture();
  reversed.candidates.reverse();
  const second = await service.create({ idempotencyKey: 'run-key-0003', snapshot: reversed });
  assert.equal(evaluationSnapshotDigest(parseFrozenEvaluationSnapshot(snapshotFixture())), first.snapshotDigest);
  assert.equal(second.snapshotDigest, first.snapshotDigest);
  assert.equal(first.version, 1);
  assert.equal((await service.listEvents(first.runId)).length, 1);
});

test('CAS 版本错误不写入，终态不可再迁移', async () => {
  const service = makeService();
  const run = await service.create({ idempotencyKey: 'run-key-0004', snapshot: snapshotFixture() });
  await codeOf(service.transition(run.runId, { expectedVersion: 2, status: 'running' }));
  const running = await service.transition(run.runId, { expectedVersion: 1, status: 'running' });
  assert.equal(running.status, 'running');
  assert.equal(running.version, 2);
  const completed = await service.transition(run.runId, { expectedVersion: 2, status: 'completed' });
  assert.equal(completed.status, 'completed');
  assert.ok(completed.endedAt);
  await codeOf(service.transition(run.runId, { expectedVersion: 3, status: 'running' }));
  await codeOf(service.beginCase(run.runId, 'case-1', 0, 1));
});

test('case 与 sample 独立持久化，终态 attempt 只读', async () => {
  const service = makeService();
  const run = await service.create({ idempotencyKey: 'run-key-0005', snapshot: snapshotFixture() });
  await service.transition(run.runId, { expectedVersion: 1, status: 'running' });
  const attempt = await service.beginCase(run.runId, 'case-1', 0, 1);
  const sample = await service.recordSample(run.runId, attempt.caseAttemptId, 0, hex('a'), 12, 0, 'CNY');
  assert.equal(sample.costMicros, 0);
  assert.equal((await service.listSampleAttempts(attempt.caseAttemptId)).length, 1);
  const finished = await service.finishCase(attempt.caseAttemptId, run.runId, 'completed');
  assert.equal(finished.status, 'completed');
  await codeOf(service.finishCase(attempt.caseAttemptId, run.runId, 'failed', {
    category: 'execution', code: 'X', message: 'late',
  }));
  const attempts = await service.listCaseAttempts(run.runId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, 'completed');
});

test('Replay 创建新运行并保留旧运行及冻结快照', async () => {
  const service = makeService();
  const source = await service.create({ idempotencyKey: 'run-key-0006', snapshot: snapshotFixture() });
  await service.transition(source.runId, { expectedVersion: 1, status: 'running' });
  const terminal = await service.transition(source.runId, { expectedVersion: 2, status: 'completed' });
  const replay = await service.replay(source.runId, { idempotencyKey: 'run-key-0007' });
  assert.notEqual(replay.runId, source.runId);
  assert.equal(replay.replayedFromRunId, source.runId);
  assert.equal(replay.snapshotDigest, terminal.snapshotDigest);
  assert.equal(replay.status, 'prepared');
  const original = await service.get(source.runId);
  assert.equal(original.status, 'completed');
  assert.equal(original.version, 3);
  const replayAgain = await service.replay(source.runId, { idempotencyKey: 'run-key-0007' });
  assert.equal(replayAgain.runId, replay.runId);
});

test('终态运行不可重放', async () => {
  const service = makeService();
  const source = await service.create({ idempotencyKey: 'run-key-0008', snapshot: snapshotFixture() });
  await codeOf(service.replay(source.runId, { idempotencyKey: 'run-key-0009' }));
});
