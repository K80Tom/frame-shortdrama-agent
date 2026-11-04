const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  EvaluationRunContractError,
  EVALUATION_RUN_TRANSITIONS,
  EVALUATION_RUN_STATUS_SEMANTICS,
  canTransitionEvaluationRun,
  evaluationRunRequestDigest,
  evaluationSnapshotDigest,
  evaluationRunEventDigest,
  isEvaluationRunExecutionFinished,
  parseEvaluationCaseAttempt,
  parseEvaluationRun,
  parseEvaluationRunCreate,
  parseEvaluationRunEvent,
  parseEvaluationRunReplay,
  parseFrozenEvaluationSnapshot,
} = require('@lyra/shared');

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

function runFixture() {
  const snapshot = parseFrozenEvaluationSnapshot(snapshotFixture());
  return {
    runId: id('evalrun', 'f'),
    status: 'completed',
    snapshot,
    snapshotDigest: evaluationSnapshotDigest(snapshot),
    requestDigest: hex('9'),
    idempotencyKey: 'run-key-0001',
    version: 2,
    createdAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:01:00.000Z',
    startedAt: '2026-11-03T00:00:10.000Z',
    endedAt: '2026-11-03T00:00:50.000Z',
    replayedFromRunId: null,
  };
}

function assertCode(action, code, path) {
  assert.throws(action, error => {
    assert.ok(error instanceof EvaluationRunContractError);
    assert.equal(error.code, code);
    if (path) assert.ok(error.details.some(item => item.path.endsWith(path)), JSON.stringify(error.details));
    return true;
  });
}

test('冻结快照摘要稳定，且不包含 createdAt 或候选输入顺序', () => {
  const first = parseFrozenEvaluationSnapshot(snapshotFixture());
  const secondFixture = structuredClone(snapshotFixture());
  secondFixture.createdAt = '2026-12-01T00:00:00.000Z';
  secondFixture.candidates.reverse();
  const second = parseFrozenEvaluationSnapshot(secondFixture);
  assert.equal(evaluationSnapshotDigest(first), evaluationSnapshotDigest(second));
  assert.deepEqual(second.candidates.map(item => item.candidateId), ['candidate-a', 'candidate-b']);
  assert.equal(evaluationSnapshotDigest(first).length, 64);
});

test('快照缺字段、分片越界和非法摘要都在边界拒绝', () => {
  const missing = snapshotFixture();
  delete missing.workflow;
  assertCode(() => parseFrozenEvaluationSnapshot(missing), 'EVALUATION_RUN_INPUT_INVALID', 'workflow');
  const badShard = snapshotFixture();
  badShard.shards = { ...badShard.shards, shardIndex: 2 };
  assertCode(() => parseFrozenEvaluationSnapshot(badShard), 'EVALUATION_RUN_INPUT_INVALID', 'shards.shardIndex');
  const badDigest = snapshotFixture();
  badDigest.dataset.digest = 'not-a-digest';
  assertCode(() => parseFrozenEvaluationSnapshot(badDigest), 'EVALUATION_RUN_INPUT_INVALID', 'dataset.digest');
  const noCandidates = snapshotFixture();
  noCandidates.candidates = [];
  assertCode(() => parseFrozenEvaluationSnapshot(noCandidates), 'EVALUATION_RUN_INPUT_INVALID', 'candidates');
});

test('快照拒绝密钥、媒体、供应商原文和绝对路径', () => {
  const secret = snapshotFixture();
  secret.modelConnection.apiKey = 'sk-abcdefghijklmnopqrstuvwx';
  assertCode(() => parseFrozenEvaluationSnapshot(secret), 'EVALUATION_RUN_SENSITIVE_FIELD', 'apiKey');
  const response = snapshotFixture();
  response.provenance = { providerResponse: { text: 'raw' } };
  assertCode(() => parseFrozenEvaluationSnapshot(response), 'EVALUATION_RUN_SENSITIVE_FIELD', 'providerResponse');
  const path = snapshotFixture();
  path.code.version = '/Users/lqc/Downloads/project';
  assertCode(() => parseFrozenEvaluationSnapshot(path), 'EVALUATION_RUN_SENSITIVE_FIELD', 'code.version');
});

test('状态机严格，终态无出边，等待与失败不计为完成或通过', () => {
  assert.ok(canTransitionEvaluationRun('prepared', 'running'));
  assert.ok(canTransitionEvaluationRun('running', 'waiting_human'));
  assert.ok(canTransitionEvaluationRun('waiting_human', 'running'));
  assert.equal(canTransitionEvaluationRun('prepared', 'completed'), false);
  assert.equal(canTransitionEvaluationRun('waiting_external', 'completed'), false);
  assert.equal(canTransitionEvaluationRun('completed', 'running'), false);
  for (const terminal of ['completed', 'failed', 'cancelled']) {
    assert.deepEqual(EVALUATION_RUN_TRANSITIONS[terminal], []);
  }
  assert.match(EVALUATION_RUN_STATUS_SEMANTICS.completed, /不等于评测通过/u);
  assert.match(EVALUATION_RUN_STATUS_SEMANTICS.waiting_human, /不计入完成或通过/u);
  assert.equal(isEvaluationRunExecutionFinished('completed'), true);
  assert.equal(isEvaluationRunExecutionFinished('failed'), false);
  assert.equal(isEvaluationRunExecutionFinished('waiting_external'), false);
});

test('运行契约校验终态时间、快照摘要与 replay 来源', () => {
  const run = runFixture();
  const parsed = parseEvaluationRun(run);
  assert.equal(parsed.status, 'completed');
  const badDigest = { ...run, snapshotDigest: hex('a') };
  assertCode(() => parseEvaluationRun(badDigest), 'EVALUATION_RUN_SNAPSHOT_DIGEST_MISMATCH', 'snapshotDigest');
  const noEnd = { ...run, endedAt: null };
  assertCode(() => parseEvaluationRun(noEnd), 'EVALUATION_RUN_INPUT_INVALID', 'endedAt');
  const selfReplay = { ...run, replayedFromRunId: run.runId };
  assertCode(() => parseEvaluationRun(selfReplay), 'EVALUATION_RUN_INPUT_INVALID', 'replayedFromRunId');
  const replay = parseEvaluationRunReplay({ sourceRunId: id('evalrun', 'e'), idempotencyKey: 'replay-key-001' });
  assert.equal(replay.sourceRunId, id('evalrun', 'e'));
});

test('同一幂等键只有在快照摘要一致时才是同一请求', () => {
  const request = parseEvaluationRunCreate({ idempotencyKey: 'run-key-0001', snapshot: snapshotFixture() });
  const same = parseEvaluationRunCreate({ idempotencyKey: 'run-key-0001', snapshot: snapshotFixture() });
  assert.equal(evaluationRunRequestDigest(request), evaluationRunRequestDigest(same));
  const other = parseEvaluationRunCreate({ idempotencyKey: 'run-key-0002', snapshot: snapshotFixture() });
  assert.notEqual(evaluationRunRequestDigest(request), evaluationRunRequestDigest(other));
  const changed = snapshotFixture();
  changed.seed = 'seed-002';
  const different = parseEvaluationRunCreate({ idempotencyKey: 'run-key-0001', snapshot: changed });
  assert.notEqual(evaluationRunRequestDigest(request), evaluationRunRequestDigest(different));
});

test('case/sample attempt 保存独立输出摘要、成本、耗时与错误', () => {
  const caseAttemptId = id('evalattempt', 'a');
  const sample = {
    sampleAttemptId: id('evalsample', 'b'),
    caseAttemptId,
    sampleIndex: 0,
    status: 'completed',
    outputDigest: hex('c'),
    durationMs: 120,
    costMicros: 0,
    currency: 'CNY',
    error: null,
  };
  const attempt = parseEvaluationCaseAttempt({
    caseAttemptId, runId: id('evalrun', 'f'), caseId: 'case-shot-001', shardIndex: 0, attemptNumber: 1,
    status: 'completed', startedAt: '2026-11-03T00:00:10.000Z', endedAt: '2026-11-03T00:00:12.000Z',
    error: null, samples: [sample],
  });
  assert.equal(attempt.samples[0].costMicros, 0);
  assert.equal(attempt.samples[0].outputDigest, hex('c'));
  const missingOutput = { ...sample, outputDigest: null };
  assertCode(() => parseEvaluationCaseAttempt({
    caseAttemptId, runId: id('evalrun', 'f'), caseId: 'case-shot-001', shardIndex: 0, attemptNumber: 1,
    status: 'completed', startedAt: '2026-11-03T00:00:10.000Z', endedAt: '2026-11-03T00:00:12.000Z',
    error: null, samples: [missingOutput],
  }), 'EVALUATION_RUN_INPUT_INVALID', 'samples[0].outputDigest');
});

test('运行事件序列与摘要可复算', () => {
  const event = parseEvaluationRunEvent({
    eventId: id('evalrunevt', 'a'), runId: id('evalrun', 'f'), sequence: 1, eventType: 'started',
    occurredAt: '2026-11-03T00:00:10.000Z', payload: { status: 'running' },
  });
  assert.equal(event.eventType, 'started');
  assert.equal(evaluationRunEventDigest(event).length, 64);
  const changed = { ...event, payload: { ...event.payload, status: 'completed' } };
  assert.notEqual(evaluationRunEventDigest(event), evaluationRunEventDigest(changed));
  assertCode(() => parseEvaluationRunEvent({
    ...event, sequence: 0,
  }), 'EVALUATION_RUN_INPUT_INVALID', 'sequence');
});
