const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { compareOfflineEvaluations: compare, offlineComparisonExitCode, offlineComparisonMarkdown } =
  require('../dist/evaluation/compare');

function fixture() {
  const sample = { caseId: 'case-a', metricId: 'quality', sampleIndex: 0, status: 'pass', value: 0.9,
    evidenceRefs: ['evidence:frame-001'], costMicros: 100, durationMs: 20 };
  return {
    schemaVersion: 'lyra-offline-comparison/1', cases: [{ caseId: 'case-a', slice: 'dialogue' }],
    policy: { version: 'policy-v1', samplesPerCase: 1, minimumSamples: 1, criticalCaseIds: [],
      metrics: [{ metricId: 'quality', direction: 'higher', absoluteThreshold: 0.8, maxRegression: 0.05 }] },
    baseline: { runId: 'run-baseline', snapshotDigest: 'a'.repeat(64), datasetDigest: 'd'.repeat(64), samples: [sample] },
    candidate: { runId: 'run-candidate', snapshotDigest: 'b'.repeat(64), datasetDigest: 'd'.repeat(64), samples: [structuredClone(sample)] },
  };
}

test('complete identical runs pass with frozen refs, policy/report digests and three group levels', () => {
  const input = fixture(), before = JSON.stringify(input);
  const report = compare(input);
  assert.equal(report.status, 'pass');
  assert.equal(offlineComparisonExitCode(report), 0);
  assert.deepEqual(report.groups.map(g => g.scope).sort(), ['aggregate', 'case', 'slice']);
  assert.equal(report.baseline.snapshotDigest, input.baseline.snapshotDigest);
  assert.match(report.policyDigest, /^[a-f0-9]{64}$/);
  assert.match(report.reportDigest, /^[a-f0-9]{64}$/);
  assert.equal(report.pairs[0].classification, 'unchanged');
  assert.deepEqual(report.pairs[0].candidate.evidenceRefs, ['evidence:frame-001']);
  assert.equal(report.groups[0].candidate.passDenominator, 1);
  assert.equal(report.groups[0].candidate.costMicros, 100);
  assert.equal(report.groups[0].candidate.durationMs, 20);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(compare(input), report);
});

for (const mode of ['missing-candidate', 'missing-both', 'new', 'uncertain', 'skipped', 'evaluator_error']) {
  test('incomplete evidence never passes: ' + mode, () => {
    const input = fixture();
    if (mode.startsWith('missing')) input.candidate.samples = [];
    if (mode === 'missing-both' || mode === 'new') input.baseline.samples = [];
    if (['uncertain', 'skipped', 'evaluator_error'].includes(mode)) {
      Object.assign(input.candidate.samples[0], { status: mode, value: null });
    }
    const report = compare(input);
    assert.equal(report.status, 'inconclusive');
    assert.equal(offlineComparisonExitCode(report), 3);
    const expected = mode.startsWith('missing') ? 'missing_candidate'
      : mode === 'new' ? 'new' : mode === 'evaluator_error' ? 'evaluator_error' : 'uncertain';
    assert.equal(report.pairs[0].classification, expected);
    const stats = report.groups[0].candidate;
    if (mode.startsWith('missing')) { assert.equal(stats.counts.missing, 1); assert.equal(stats.mean, null); }
    assert.equal(stats.passDenominator, 1);
  });
}

test('known regressions and absolute violations fail; repaired baseline failures are distinguished', () => {
  const input = fixture();
  input.candidate.samples[0].value = 0.85;
  assert.equal(compare(input).status, 'pass', 'exact maximum regression boundary must pass');
  input.candidate.samples[0].value = 0.84;
  let report = compare(input);
  assert.equal(report.status, 'fail');
  assert.equal(report.pairs[0].classification, 'regression');
  assert.equal(offlineComparisonExitCode(report), 1);
  input.candidate.samples[0].value = 0.79;
  input.policy.metrics[0].maxRegression = 1;
  assert.equal(compare(input).status, 'fail');
  Object.assign(input.baseline.samples[0], { status: 'fail', value: 0.5 });
  input.candidate.samples[0].value = 0.95;
  report = compare(input);
  assert.equal(report.status, 'pass');
  assert.equal(report.pairs[0].classification, 'fixed');
  input.candidate.samples[0].status = 'fail';
  assert.equal(compare(input).status, 'fail', 'explicit fail cannot be promoted by a good number');
});

test('critical cases enforce zero tolerance and cannot be hidden by better aggregate averages', () => {
  const input = fixture();
  input.policy.criticalCaseIds = ['case-a'];
  input.candidate.samples[0].value = 0.89;
  input.cases.push({ caseId: 'case-b', slice: 'dialogue' });
  input.baseline.samples.push({ ...input.baseline.samples[0], caseId: 'case-b', value: 0.1 });
  input.candidate.samples.push({ ...input.candidate.samples[0], caseId: 'case-b', value: 1 });
  const report = compare(input);
  assert.equal(report.status, 'fail');
  const aggregate = report.groups.find(g => g.scope === 'aggregate');
  assert.ok(aggregate.candidate.mean > aggregate.baseline.mean);
  assert.equal(aggregate.status, 'fail');
  assert.equal(report.groups.find(g => g.scope === 'case' && g.id === 'case-a').status, 'fail');
});

test('lower-is-better thresholds work for latency/cost-style metrics', () => {
  const input = fixture();
  Object.assign(input.policy.metrics[0], { direction: 'lower', absoluteThreshold: 100, maxRegression: 5 });
  input.baseline.samples[0].value = 80;
  input.candidate.samples[0].value = 84;
  assert.equal(compare(input).status, 'pass');
  input.candidate.samples[0].value = 86;
  assert.equal(compare(input).status, 'fail');
  input.candidate.samples[0].value = 101;
  input.policy.metrics[0].maxRegression = 100;
  assert.equal(compare(input).status, 'fail');
});

test('descriptive distributions keep sample count, quantiles, variance, costs and confidence warnings', () => {
  const input = fixture();
  Object.assign(input.policy, { samplesPerCase: 3, minimumSamples: 3 });
  input.policy.metrics[0].absoluteThreshold = 0;
  for (const run of [input.baseline, input.candidate]) {
    run.samples = [0.7, 0.8, 0.9].map((value, sampleIndex) => ({
      ...run.samples[0], value, sampleIndex, costMicros: 100 + sampleIndex * 10, durationMs: sampleIndex + 1,
    }));
  }
  const report = compare(input), g = report.groups[0];
  assert.equal(report.status, 'pass');
  assert.ok(Math.abs(g.candidate.mean - 0.8) < 1e-12);
  assert.equal(g.candidate.p50, 0.8);
  assert.ok(Math.abs(g.candidate.p95 - 0.89) < 1e-12);
  assert.ok(Math.abs(g.candidate.sampleVariance - 0.01) < 1e-12);
  assert.equal(g.candidate.numericCount, 3);
  assert.equal(g.candidate.costMicros, 330);
  assert.equal(g.candidate.durationMs, 6);
  assert.ok(g.warnings.includes('LOW_SAMPLE_CONFIDENCE'));
  input.candidate.samples.pop();
  const missing = compare(input);
  assert.equal(missing.status, 'inconclusive');
  assert.ok(missing.groups[0].warnings.includes('INSUFFICIENT_SAMPLES'));
  assert.equal(missing.groups[0].candidate.passDenominator, 3);
});

test('policy changes alter digests and shuffled inputs keep deterministic reports', () => {
  const input = fixture();
  input.cases.push({ caseId: 'case-b', slice: 'other' });
  for (const run of [input.baseline, input.candidate]) run.samples.push({ ...run.samples[0], caseId: 'case-b' });
  const report = compare(input);
  input.cases.reverse();
  for (const run of [input.baseline, input.candidate]) run.samples.reverse();
  assert.deepEqual(compare(input), report);
  input.policy.metrics[0].maxRegression = 0;
  assert.notEqual(compare(input).policyDigest, report.policyDigest);
  assert.notEqual(compare(input).reportDigest, report.reportDigest);
  const markdown = offlineComparisonMarkdown(report);
  for (const marker of ['case-a', 'dialogue', 'quality', 'evidence:frame-001', report.policyDigest]) assert.ok(markdown.includes(marker));
});

test('strict contracts reject extra fields, duplicates, incompatible runs and malformed values', () => {
  const changes = [
    i => { i.schemaVersion = 'unknown'; },
    i => { i.password = 'private'; },
    i => { i.policy.minimumSamples = 0; },
    i => { i.policy.minimumSamples = 2; },
    i => { i.candidate.runId = i.baseline.runId; },
    i => { i.candidate.datasetDigest = 'f'.repeat(64); },
    i => { i.candidate.samples.push(i.candidate.samples[0]); },
    i => { i.cases.push(i.cases[0]); },
    i => { i.candidate.samples[0].sampleIndex = 1; },
    i => { i.candidate.samples[0].caseId = 'unplanned'; },
    i => { i.candidate.samples[0].metricId = 'unplanned'; },
    i => { i.candidate.samples[0].value = Infinity; },
    i => { i.candidate.samples[0].costMicros = -1; },
    i => { i.candidate.samples[0].status = 'unknown'; },
    i => { i.candidate.samples[0].status = {}; },
    i => { i.candidate.samples[0].status = 'uncertain'; },
    i => { i.candidate.samples[0].evidenceRefs = ['https://user:pass@vendor.invalid/?key=secret']; },
    i => { i.candidate.samples[0].evidenceRefs = []; },
    i => { i.cases[0].slice = '<script>'; },
    i => { i.policy.criticalCaseIds = ['unknown']; },
  ];
  for (const change of changes) {
    const input = fixture(); change(input);
    assert.throws(() => compare(input), error => error instanceof TypeError && error.message === '离线评测比较输入无效。');
  }
});

test('real offline CLI returns 0/1/3/2 and exports JSON/Markdown without leaking invalid input', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lyra-eval-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'input.json');
  const script = join(__dirname, '../scripts/evaluation-gate.mjs');
  const invoke = (format = 'json') => spawnSync(process.execPath, [script, path, format], { encoding: 'utf8', timeout: 10000 });
  const input = fixture();
  await writeFile(path, JSON.stringify(input));
  let result = invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'pass');
  result = invoke('markdown');
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('# 离线评测比较'));
  input.candidate.samples[0].value = 0.1;
  await writeFile(path, JSON.stringify(input));
  assert.equal(invoke().status, 1);
  input.candidate.samples = [];
  await writeFile(path, JSON.stringify(input));
  assert.equal(invoke().status, 3);
  await writeFile(path, 'private-token invalid JSON');
  result = invoke();
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes('private-token'), false);
  assert.equal(result.stderr.includes(path), false);
  assert.equal(invoke('html').status, 2);
  await writeFile(path, ' '.repeat(8 * 1024 * 1024 + 1));
  assert.equal(invoke().status, 2);
});
