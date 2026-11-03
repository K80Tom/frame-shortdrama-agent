const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EvaluationError, evaluationSnapshotDigest, parseFrozenEvaluationSnapshot } = require('@lyra/shared');
const { MemoryEvaluationRunRepository } = require('../dist/evaluation-run/repository');
const { EvaluationRunService } = require('../dist/evaluation-run/service');
const {
  DeterministicEvaluationLocalExecutor,
  EvaluationExecutionError,
  stableShardIndex,
  caseBelongsToShard,
} = require('../dist/evaluation-run/local-executor');
const { EvaluationRunRunner } = require('../dist/evaluation-run/runner');
const { EvaluationRunController } = require('../dist/evaluation-run/controller');

const hex = value => value.repeat(64);
const id = (prefix, char) => `${prefix}_${char.repeat(32)}`;
const snapshotFixture = (overrides = {}) => parseFrozenEvaluationSnapshot({
  schemaVersion: 'lyra-evaluation-snapshot/1',
  catalogKind: 'shot_review',
  dataset: { datasetId: id('evalds', 'a'), revisionId: id('evaldsrev', 'b'), digest: hex('b') },
  rubric: { rubricId: id('evalrub', 'c'), revisionId: id('evalrubrev', 'd'), digest: hex('d') },
  evaluator: { evaluatorId: 'evaluator-local', version: '1.0.0', digest: hex('e') },
  candidates: [{ candidateId: 'candidate-a', version: '1', digest: hex('1') }],
  modelConnection: { connectionId: 'connection-local', revisionId: 'connrev-1', provider: 'stub', model: 'deterministic', digest: hex('3') },
  prompt: { promptId: 'prompt-shot', version: '3', digest: hex('4') },
  workflow: { workflowId: 'workflow-shot', version: '2', digest: hex('5') },
  code: { version: '0.1.0', commit: 'abcdef1234567890abcdef1234567890abcdef12', digest: hex('6') },
  seed: 'seed-001',
  shards: { shardCount: 1, shardIndex: 0, concurrency: 4, timeoutMs: 120000, samplesPerCase: 2, ...overrides },
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

function catalogFor(ids) {
  return { listCases: async () => ids.map((caseId, index) => ({ caseId, inputDigest: hex(`${index + 1}`) })) };
}

async function outputMap(service, runId, planner = x => x) {
  const attempts = await service.listCaseAttempts(runId);
  const map = new Map();
  for (const attempt of attempts) {
    for (const sample of await service.listSampleAttempts(attempt.caseAttemptId)) {
      map.set(`${attempt.caseId}:${sample.sampleIndex}`, planner(sample));
    }
  }
  return map;
}

function assertion(action, code) {
  return assert.rejects(action, error => error instanceof EvaluationError && error.code === code);
}

test('确定性本地执行：相同快照、case、seed、sample 输出可复现且成本为 0', async () => {
  const service = makeService();
  const snapshot = snapshotFixture();
  const first = await service.create({ idempotencyKey: 'idem:local:0001', snapshot });
  const runner = new EvaluationRunRunner(service, new DeterministicEvaluationLocalExecutor(),
    catalogFor(['case-a', 'case-b', 'case-c']));
  const result = await runner.run(first.runId);
  assert.equal(result.status, 'completed');
  const attempts = await service.listCaseAttempts(first.runId);
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map(item => item.status), ['completed', 'completed', 'completed']);
  const firstOutputs = await outputMap(service, first.runId);
  assert.equal(firstOutputs.size, 6);
  for (const sample of firstOutputs.values()) {
    assert.equal(sample.costMicros, 0);
    assert.equal(sample.currency, 'CNY');
    assert.match(sample.outputDigest, /^[a-f0-9]{64}$/u);
  }

  const second = await service.create({ idempotencyKey: 'idem:local:0002', snapshot });
  const replayLike = await runner.run(second.runId);
  assert.equal(replayLike.status, 'completed');
  const secondOutputs = await outputMap(service, second.runId);
  const digests = values => new Map([...values].map(([key, value]) => [key, value.outputDigest]));
  assert.deepEqual([...digests(firstOutputs)], [...digests(secondOutputs)],
    '同快照同 case 的本地输出摘要必须可复现');
});

test('稳定分片与并发上限：只处理本 shard，且不超过配置并发', async () => {
  const service = makeService();
  const snapshot = snapshotFixture({ shardCount: 2, shardIndex: 0 });
  const cases = Array.from({ length: 10 }, (_, index) => `case-${String.fromCharCode(97 + index)}`);
  const expected = cases.filter(caseId => caseBelongsToShard(caseId, 2, 0));
  assert.ok(expected.length >= 2);
  const run = await service.create({ idempotencyKey: 'idem:shard:0001', snapshot });
  let active = 0;
  let maxActive = 0;
  const executor = {
    async execute(input) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 3));
      active -= 1;
      return {
        outputDigest: hex('a'), durationMs: 0, costMicros: 0, currency: 'CNY',
        output: { caseId: input.caseId },
      };
    },
  };
  const runner = new EvaluationRunRunner(service, executor, catalogFor(cases));
  const result = await runner.run(run.runId, { maxConcurrency: 2 });
  assert.equal(result.status, 'completed');
  const attempts = await service.listCaseAttempts(run.runId);
  assert.deepEqual(attempts.map(item => item.caseId).sort(), expected.sort());
  assert.equal(attempts.every(item => stableShardIndex(item.caseId, 2) === 0), true);
  assert.ok(maxActive <= 2, `active=${maxActive}`);
});

test('超时与取消：sample 记录失败/取消，运行终态不悬挂', async () => {
  const service = makeService();
  const snapshot = snapshotFixture({ timeoutMs: 1000, shardCount: 1, shardIndex: 0 });
  const slow = {
    execute: input => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({
        outputDigest: hex('b'), durationMs: 0, costMicros: 0, currency: 'CNY', output: { caseId: input.caseId },
      }), 1200);
      input.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new EvaluationExecutionError('timeout', 'EVALUATION_RUN_TIMEOUT', 'aborted'));
      }, { once: true });
    }),
  };
  const run = await service.create({ idempotencyKey: 'idem:timeout:0001', snapshot });
  const runner = new EvaluationRunRunner(service, slow, catalogFor(['case-a']));
  const timed = await runner.run(run.runId);
  assert.equal(timed.status, 'completed');
  const timedAttempt = (await service.listCaseAttempts(run.runId))[0];
  assert.equal(timedAttempt.status, 'failed');
  const timedSamples = await service.listSampleAttempts(timedAttempt.caseAttemptId);
  assert.equal(timedSamples[0].status, 'failed');
  assert.equal(timedSamples[0].error.category, 'timeout');

  const cancelledRun = await service.create({ idempotencyKey: 'idem:cancel:0001', snapshot });
  const controller = new AbortController();
  const quickSlow = {
    execute: input => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({
        outputDigest: hex('c'), durationMs: 0, costMicros: 0, currency: 'CNY', output: {},
      }), 40);
      input.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new EvaluationExecutionError('cancelled', 'EVALUATION_RUN_CANCELLED', 'aborted'));
      }, { once: true });
    }),
  };
  const cancelRunner = new EvaluationRunRunner(service, quickSlow, catalogFor(['case-a']));
  const promise = cancelRunner.run(cancelledRun.runId, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const cancelled = await promise;
  assert.equal(cancelled.status, 'cancelled');
  const cancelledAttempt = (await service.listCaseAttempts(cancelledRun.runId))[0];
  assert.equal(cancelledAttempt.status, 'cancelled');
  assert.equal(cancelledAttempt.samples[0]?.status ?? (await service.listSampleAttempts(cancelledAttempt.caseAttemptId))[0].status,
    'cancelled');
});

test('中断恢复：旧 attempt 不被覆盖，已完成 sample 保留，新 attempt 从下一序号继续', async () => {
  const service = makeService();
  const snapshot = snapshotFixture();
  const run = await service.create({ idempotencyKey: 'idem:recover:0001', snapshot });
  const interrupted = await service.beginCase(run.runId, 'case-a', 0, 1);
  await service.recordSample(run.runId, interrupted.caseAttemptId, 0, hex('d'), 0, 0, 'CNY');
  const runner = new EvaluationRunRunner(service, new DeterministicEvaluationLocalExecutor(), catalogFor(['case-a']));
  assert.equal(await runner.recover(run.runId), 1);
  const recoveredAttempt = (await service.listCaseAttempts(run.runId))[0];
  assert.equal(recoveredAttempt.status, 'interrupted');
  assert.equal(recoveredAttempt.error.code, 'EVALUATION_RUN_INTERRUPTED');
  assert.equal((await service.listSampleAttempts(recoveredAttempt.caseAttemptId)).length, 1,
    '中断不能删除已持久化 sample');

  const finished = await runner.run(run.runId);
  assert.equal(finished.status, 'completed');
  const attempts = await service.listCaseAttempts(run.runId);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].status, 'interrupted');
  assert.equal(attempts[0].attemptNumber, 1);
  assert.equal(attempts[1].status, 'completed');
  assert.equal(attempts[1].attemptNumber, 2);
  assert.equal((await service.listSampleAttempts(attempts[0].caseAttemptId)).length, 1);
  assert.equal((await service.listSampleAttempts(attempts[1].caseAttemptId)).length, 2);
});

test('单 case 失败不影响其他 case 的结果保存', async () => {
  const service = makeService();
  const snapshot = snapshotFixture();
  const run = await service.create({ idempotencyKey: 'idem:partial:0001', snapshot });
  const executor = {
    async execute(input) {
      if (input.caseId === 'case-b') {
        throw new EvaluationExecutionError('execution', 'CASE_BROKEN', 'case-b 故意失败。');
      }
      return { outputDigest: hex('e'), durationMs: 0, costMicros: 0, currency: 'CNY', output: {} };
    },
  };
  const runner = new EvaluationRunRunner(service, executor, catalogFor(['case-a', 'case-b', 'case-c']));
  const result = await runner.run(run.runId);
  assert.equal(result.status, 'completed', 'case 失败不阻断批次结束');
  const attempts = await service.listCaseAttempts(run.runId);
  const byCase = new Map();
  for (const attempt of attempts) byCase.set(attempt.caseId, [...(byCase.get(attempt.caseId) ?? []), attempt]);
  assert.equal(byCase.get('case-a')[0].status, 'completed');
  assert.equal(byCase.get('case-b')[0].status, 'failed');
  assert.equal(byCase.get('case-b')[0].error.code, 'CASE_BROKEN');
  assert.equal(byCase.get('case-c')[0].status, 'completed');
  const failedSamples = await service.listSampleAttempts(byCase.get('case-b')[0].caseAttemptId);
  assert.equal(failedSamples[0].status, 'failed');
  assert.equal(failedSamples[0].error.category, 'execution');
});

test('Replay 使用冻结快照创建新运行，旧运行与输出不被覆盖', async () => {
  const service = makeService();
  const snapshot = snapshotFixture();
  const source = await service.create({ idempotencyKey: 'idem:replay:source', snapshot });
  const runner = new EvaluationRunRunner(service, new DeterministicEvaluationLocalExecutor(),
    catalogFor(['case-a']));
  const sourceDone = await runner.run(source.runId);
  assert.equal(sourceDone.status, 'completed');
  const replayed = await service.replay(source.runId, { idempotencyKey: 'idem:replay:target' });
  assert.notEqual(replayed.runId, source.runId);
  assert.equal(replayed.replayedFromRunId, source.runId);
  assert.equal(replayed.snapshotDigest, source.snapshotDigest);
  assert.equal(evaluationSnapshotDigest(replayed.snapshot), source.snapshotDigest);
  const replayDone = await runner.run(replayed.runId);
  assert.equal(replayDone.status, 'completed');
  assert.equal((await service.get(source.runId)).status, 'completed', '旧运行不被覆盖');
  const sourceOutputs = await outputMap(service, source.runId);
  const replayOutputs = await outputMap(service, replayed.runId);
  assert.deepEqual([...sourceOutputs].map(([key, value]) => [key, value.outputDigest]),
    [...replayOutputs].map(([key, value]) => [key, value.outputDigest]),
    'Replay 的输出摘要应与原运行一致');
});

test('控制器只暴露运行入口，不创建生产任务', async () => {
  const service = makeService();
  const runner = new EvaluationRunRunner(service, new DeterministicEvaluationLocalExecutor(), catalogFor(['case-a']));
  const controller = new EvaluationRunController(service, runner, catalogFor(['case-a']));
  const snapshot = snapshotFixture();
  const run = await controller.create({ idempotencyKey: 'idem:controller:01', snapshot });
  assert.equal((await controller.get(run.runId)).status, 'prepared');
  assert.equal((await controller.start(run.runId)).status, 'completed');
  assert.equal((await controller.listCaseAttempts(run.runId)).length, 1);
  assert.equal(await controller.recover(run.runId), 0);
  const replay = await controller.replay(run.runId, { idempotencyKey: 'idem:controller:02' });
  assert.equal(replay.replayedFromRunId, run.runId);
});
