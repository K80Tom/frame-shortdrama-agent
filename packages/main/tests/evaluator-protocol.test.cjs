const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  EVALUATION_RESULT_STATUSES, EVALUATION_RESULT_STATUS_SEMANTICS, EVALUATOR_PROTOCOL_VERSION,
  EvaluatorContractError, evaluationResultDigest, parseEvaluationResult, parseEvaluatorDefinition,
  summarizeMetric, fromQualityCheck, fromAssetProbeCase, fromNovelBreakdownCaseOutput,
} = require('@lyra/shared');
const {
  MemoryEvaluationResultsRepository,
} = require('../dist/evaluation-results/repository');
const { EvaluationResultsService } = require('../dist/evaluation-results/service');

const hex = value => value.repeat(64);
const id = (prefix, char) => `${prefix}_${char.repeat(32)}`;
const policy = { uncertain: 'review', skipped: 'exclude', evaluator_error: 'review' };

function buildResult(over = {}) {
  const base = {
    schemaVersion: EVALUATOR_PROTOCOL_VERSION,
    resultId: 'evalres_' + 'a'.repeat(32),
    locator: { runId: null, caseId: null, sampleIndex: null },
    subject: { kind: 'shot', id: 'shot-1', revisionId: null, digest: hex('b') },
    evaluator: { evaluatorId: 'rule-shot', version: '1.0.0', digest: hex('c') },
    status: 'pass',
    inputSummary: '输入摘要',
    outputSummary: '输出摘要',
    confidence: 0.9,
    durationMs: 12,
    evidence: [{
      evidenceId: 'evidev_' + 'e'.repeat(32), source: 'production_quality', sourceDigest: hex('f'),
      locator: { entity: 'task-1', jsonPath: null, shotId: 'shot-1', frameIndex: 3, timecodeSec: 1.5 },
      availability: 'available', visibility: 'internal', note: 'n',
    }],
    metrics: [{ key: 'quality_check', layer: 'shot', value: 1, status: 'pass' }],
    error: null,
    legacy: null,
    occurredAt: '2026-11-04T00:00:00.000Z',
    recordedAt: '2026-11-04T00:00:01.000Z',
  };
  const merged = structuredClone(base);
  Object.assign(merged, over);
  merged.resultDigest = evaluationResultDigest(merged);
  return merged;
}

test('五态闭合：状态集合与语义明确，evaluator_error 不是对象 fail', () => {
  assert.deepEqual(EVALUATION_RESULT_STATUSES,
    ['pass', 'fail', 'uncertain', 'skipped', 'evaluator_error']);
  assert.match(EVALUATION_RESULT_STATUS_SEMANTICS.evaluator_error, /不是对象失败/);
  assert.match(EVALUATION_RESULT_STATUS_SEMANTICS.uncertain, /不计通过也不计失败/);
});

test('解析成功的合法结果，并校验 resultDigest 自洽', () => {
  const parsed = parseEvaluationResult(buildResult());
  assert.equal(parsed.status, 'pass');
  assert.equal(parsed.metrics[0].value, 1);
  assert.equal(parsed.evidence[0].locator.frameIndex, 3);
});

test('resultDigest 被篡改时拒绝', () => {
  const bad = buildResult({ status: 'fail' });
  bad.resultDigest = hex('0');
  assert.throws(() => parseEvaluationResult(bad),
    error => error instanceof EvaluatorContractError && error.code === 'EVALUATOR_RESULT_DIGEST_MISMATCH');
});

test('evaluator_error 必须带结构化错误；其他状态不能带', () => {
  const withError = buildResult({
    status: 'evaluator_error',
    error: { category: 'timeout', code: 'T', message: '超时' },
    metrics: [],
  });
  assert.equal(parseEvaluationResult(withError).status, 'evaluator_error');
  const missingError = buildResult({ status: 'evaluator_error', metrics: [] });
  missingError.resultDigest = evaluationResultDigest(missingError);
  assert.throws(() => parseEvaluationResult(missingError),
    error => error instanceof EvaluatorContractError);
  const strayError = buildResult({
    error: { category: 'internal', code: 'X', message: 'x' },
  });
  strayError.resultDigest = evaluationResultDigest(strayError);
  assert.throws(() => parseEvaluationResult(strayError),
    error => error instanceof EvaluatorContractError);
});

test('未知/缺失不得当 0：有效状态指标必须带数值，无数值只能是非有效态', () => {
  const noValueValid = buildResult({
    metrics: [{ key: 'k', layer: 'shot', value: null, status: 'pass' }],
  });
  noValueValid.resultDigest = evaluationResultDigest(noValueValid);
  assert.throws(() => parseEvaluationResult(noValueValid));
  const valueButInvalid = buildResult({
    metrics: [{ key: 'k', layer: 'shot', value: 0.5, status: 'uncertain' }],
  });
  valueButInvalid.resultDigest = evaluationResultDigest(valueButInvalid);
  assert.throws(() => parseEvaluationResult(valueButInvalid));
});

test('定位嵌套约束：run 空则 case/sample 空；case 空则 sample 空', () => {
  const bad = buildResult({ locator: { runId: null, caseId: 'case-1', sampleIndex: null } });
  bad.resultDigest = evaluationResultDigest(bad);
  assert.throws(() => parseEvaluationResult(bad));
  const bad2 = buildResult({ locator: { runId: null, caseId: null, sampleIndex: 0 } });
  bad2.resultDigest = evaluationResultDigest(bad2);
  assert.throws(() => parseEvaluationResult(bad2));
});

test('未知字段被拒绝（闭合）', () => {
  const bad = buildResult();
  bad.unexpected = 1;
  assert.throws(() => parseEvaluationResult(bad));
});

test('评估器定义闭合解析：适配器语义四选一', () => {
  const def = parseEvaluatorDefinition({
    evaluatorId: 'rule-shot', adapterKind: 'rule_based',
    catalogKinds: ['shot_review'], minSampleSize: 5, description: '规则',
  });
  assert.equal(def.adapterKind, 'rule_based');
  assert.throws(() => parseEvaluatorDefinition({
    evaluatorId: 'x', adapterKind: 'magic', catalogKinds: [], minSampleSize: 1, description: 'd',
  }));
});

/* ---------------- 分层指标聚合 ---------------- */

test('缺失不计零：uncertain/skipped/error 不进数值 mean/p50/p95', () => {
  const summary = summarizeMetric('k', 'shot', [
    { value: 1, status: 'pass' },
    { value: 0, status: 'fail' },
    { value: null, status: 'uncertain' },
    { value: null, status: 'skipped' },
    { value: null, status: 'evaluator_error' },
  ], 1, policy);
  assert.equal(summary.total, 5);
  assert.equal(summary.valid, 2);
  assert.equal(summary.missing, 3);
  assert.equal(summary.uncertain, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.error, 1);
  assert.equal(summary.mean, 0.5);
  assert.equal(summary.p50, 0.5);
});

test('聚合顺序无关：乱序输入得到相同统计', () => {
  const a = [{ value: 0.2, status: 'fail' }, { value: 0.8, status: 'pass' },
    { value: 0.5, status: 'pass' }, { value: null, status: 'uncertain' }];
  const b = [...a].reverse();
  const sa = summarizeMetric('k', 'shot', a, 1, policy);
  const sb = summarizeMetric('k', 'shot', b, 1, policy);
  assert.equal(sa.mean, sb.mean);
  assert.equal(sa.p50, sb.p50);
  assert.equal(sa.p95, sb.p95);
  assert.equal(sa.variance, sb.variance);
  assert.deepEqual(
    [sa.valid, sa.missing, sa.total], [sb.valid, sb.missing, sb.total]);
});

test('低于 minSampleSize 只能 uncertain；达到后才可能 pass/fail', () => {
  const few = summarizeMetric('k', 'shot', [
    { value: 1, status: 'pass' }, { value: 1, status: 'pass' },
  ], 5, policy);
  assert.equal(few.valid, 2);
  assert.equal(few.effectiveStatus, 'uncertain');
  const enough = summarizeMetric('k', 'shot', [
    { value: 1, status: 'pass' }, { value: 1, status: 'pass' }, { value: 1, status: 'pass' },
    { value: 1, status: 'pass' }, { value: 1, status: 'pass' },
  ], 5, policy);
  assert.equal(enough.effectiveStatus, 'pass');
});

test('evaluator_error 独占且不被当作对象 fail', () => {
  const onlyError = summarizeMetric('k', 'shot', [
    { value: null, status: 'evaluator_error' },
  ], 1, { uncertain: 'exclude', skipped: 'exclude', evaluator_error: 'exclude' });
  assert.equal(onlyError.error, 1);
  assert.equal(onlyError.valid, 0);
  assert.equal(onlyError.effectiveStatus, 'evaluator_error');
});

test('coverage 与区间：valid/total 与 Wilson 区间', () => {
  const s = summarizeMetric('k', 'shot', [
    { value: 1, status: 'pass' }, { value: 1, status: 'pass' }, { value: 0, status: 'fail' },
  ], 1, policy);
  assert.equal(s.coverage, 1); // 3/3 都是有效判定（pass+fail）
  assert.ok(s.lowerBound !== null && s.upperBound !== null);
  assert.ok(s.lowerBound >= 0 && s.upperBound <= 1);
});

/* ---------------- 追加不可变与幂等（内存仓储） ---------------- */

test('结果追加式：同一 digest 重放返回既有记录且 created=false；不覆盖', async () => {
  const repo = new MemoryEvaluationResultsRepository();
  const service = new EvaluationResultsService(repo);
  const r1 = buildResult();
  const first = await service.record(r1);
  assert.equal(first.created, true);
  const second = await service.record(buildResult());
  assert.equal(second.created, false);
  assert.equal(second.result.resultId, first.result.resultId);
  assert.equal(second.result.resultDigest, first.result.resultDigest);
});

test('不同结果可并存，按 run/subject/evaluator 查询', async () => {
  const repo = new MemoryEvaluationResultsRepository();
  const service = new EvaluationResultsService(repo);
  const runResult = buildResult({
    locator: { runId: 'evalrun_' + 'a'.repeat(32), caseId: 'case-1', sampleIndex: null },
    subject: { kind: 'shot', id: 'shot-9', revisionId: null, digest: hex('d') },
  });
  await service.record(runResult);
  const byRun = await service.listByRun('evalrun_' + 'a'.repeat(32));
  assert.equal(byRun.length, 1);
  const bySubject = await service.listBySubject('shot', 'shot-9');
  assert.equal(bySubject.length, 1);
});

/* ---------------- 旧结果适配器：无损与 round-trip ---------------- */

const qualityCheck = {
  id: 'check-1', runId: 'run-1', taskId: 'task-1', level: 'shot',
  result: 'pass', ruleVersion: 'video-technical/1',
  summary: '技术通过', issues: ['warning x'], createdAt: '2026-11-04T00:00:00.000Z',
};

const adaptCtx = {
  locator: { runId: null, caseId: null, sampleIndex: null },
  subject: { kind: 'shot', id: 'shot-1', revisionId: null, digest: hex('a') },
  evaluator: { evaluatorId: 'qc', version: 'video-technical/1', digest: hex('e') },
  occurredAt: '2026-11-04T00:00:00.000Z',
  recordedAt: '2026-11-04T00:00:01.000Z',
  confidence: null, durationMs: 5, inputSummary: 'qc',
};

test('QualityCheck 适配：result→status，level→layer，旧字段全部进入 legacy/evidence，可往返', () => {
  const r = fromQualityCheck(qualityCheck, adaptCtx);
  assert.equal(r.status, 'pass');
  assert.equal(r.metrics[0].layer, 'shot');
  assert.equal(r.legacy.kind, 'quality_check');
  assert.equal(r.legacy.checkId, 'check-1');
  assert.equal(r.legacy.ruleVersion, 'video-technical/1');
  // round-trip：经 parse 后所有旧字段仍可读出
  const parsed = parseEvaluationResult(r);
  assert.equal(parsed.legacy.checkId, 'check-1');
  assert.equal(parsed.outputSummary, '技术通过；issues: warning x');
});

test('AssetProbeCase 适配：pass 布尔→pass/fail，fixtureVersion 保留', () => {
  const r = fromAssetProbeCase('probe-1', 'asset-retrieval-probe/1',
    { caseKey: 'k1', expected: 'unique', pass: false }, adaptCtx);
  assert.equal(r.status, 'fail');
  assert.equal(r.legacy.kind, 'asset_probe');
  assert.equal(r.legacy.fixtureVersion, 'asset-retrieval-probe/1');
  assert.equal(r.metrics[0].value, 0);
  const parsed = parseEvaluationResult(r);
  assert.equal(parsed.legacy.caseKey, 'k1');
});

test('NovelBreakdown case 适配：完全未命中=fail，部分=uncertain，全中=pass', () => {
  const full = fromNovelBreakdownCaseOutput('evaldsrev_' + '1'.repeat(32), 'case-1',
    { expectedEntityCount: 2, matchedEntityCount: 2, expectedSourceRefCount: 1, matchedSourceRefCount: 1 },
    adaptCtx);
  assert.equal(full.status, 'pass');
  const partial = fromNovelBreakdownCaseOutput('evaldsrev_' + '1'.repeat(32), 'case-1',
    { expectedEntityCount: 2, matchedEntityCount: 1, expectedSourceRefCount: 1, matchedSourceRefCount: 1 },
    adaptCtx);
  assert.equal(partial.status, 'uncertain');
  const none = fromNovelBreakdownCaseOutput('evaldsrev_' + '1'.repeat(32), 'case-1',
    { expectedEntityCount: 2, matchedEntityCount: 0, expectedSourceRefCount: 1, matchedSourceRefCount: 0 },
    adaptCtx);
  assert.equal(none.status, 'fail');
  assert.equal(parseEvaluationResult(full).legacy.kind, 'novel_breakdown_case');
});

test('service.summarize：对一组结果按 key/layer 聚合，缺失保留原始状态', async () => {
  const repo = new MemoryEvaluationResultsRepository();
  const service = new EvaluationResultsService(repo);
  const results = [
    buildResult({ resultId: id('evalres', '1'), metrics: [{ key: 'k', layer: 'shot', value: 1, status: 'pass' }] }),
    buildResult({ resultId: id('evalres', '2'), subject: { kind: 'shot', id: 'shot-2', revisionId: null, digest: hex('1') },
      metrics: [{ key: 'k', layer: 'shot', value: 0, status: 'fail' }] }),
    buildResult({ resultId: id('evalres', '3'), subject: { kind: 'shot', id: 'shot-3', revisionId: null, digest: hex('2') },
      status: 'uncertain', metrics: [] }),
  ];
  for (const r of results) await service.record(r);
  const s = service.summarize(results, 'k', 'shot', 1, policy);
  assert.equal(s.total, 3);
  assert.equal(s.valid, 2);
  assert.equal(s.uncertain, 1);
  assert.equal(s.effectiveStatus, 'fail');
});
