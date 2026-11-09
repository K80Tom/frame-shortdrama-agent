import { canonicalDigest } from '@lyra/shared';

type Status = 'pass' | 'fail' | 'uncertain' | 'skipped' | 'evaluator_error';
interface Sample {
  caseId: string; sampleIndex: number; metricId: string; status: Status; value: number | null;
  evidenceRefs: string[]; costMicros: number; durationMs: number;
}
interface MetricRule {
  metricId: string; direction: 'higher' | 'lower'; absoluteThreshold: number; maxRegression: number;
}
interface Run {
  runId: string; snapshotDigest: string; datasetDigest: string; samples: Sample[];
}
interface Input {
  schemaVersion: 'lyra-offline-comparison/1';
  cases: Array<{ caseId: string; slice: string }>;
  policy: { version: string; samplesPerCase: number; minimumSamples: number; criticalCaseIds: string[]; metrics: MetricRule[] };
  baseline: Run; candidate: Run;
}
type Classification = 'new' | 'fixed' | 'regression' | 'unchanged' | 'uncertain' | 'evaluator_error' | 'missing_candidate';
interface Pair {
  key: string; caseId: string; slice: string; metricId: string; sampleIndex: number;
  classification: Classification; baseline: Sample | null; candidate: Sample | null;
  failed: boolean; incomplete: boolean;
}

function invalid(): never { throw new TypeError('离线评测比较输入无效。'); }
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(record, key))) invalid();
  return record;
}
function list(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid();
  return value as unknown[];
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(value) || /[\r\n]/u.test(value)) invalid();
  return value;
}
function number(value: unknown, min = -1e9, max = 1e9, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
    || (integer && !Number.isSafeInteger(value))) invalid();
  return value;
}
function unique(values: string[]): string[] {
  if (new Set(values).size !== values.length) invalid();
  return [...values].sort();
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value) || value.length !== 64) invalid();
  return value;
}
function parseRun(value: unknown): Run {
  const run = object(value, ['runId', 'snapshotDigest', 'datasetDigest', 'samples']);
  const samples = list(run.samples, 0, 10_000).map(item => {
    const r = object(item, ['caseId', 'sampleIndex', 'metricId', 'status', 'value', 'evidenceRefs', 'costMicros', 'durationMs']);
    if (typeof r.status !== 'string' || !['pass', 'fail', 'uncertain', 'skipped', 'evaluator_error'].includes(r.status)) invalid();
    const status = r.status as Status;
    const value = status === 'pass' || status === 'fail' ? number(r.value) : r.value === null ? null : invalid();
    const evidenceRefs = unique(list(r.evidenceRefs, 0, 20).map(ref => {
      if (typeof ref !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}(?::[A-Za-z0-9][A-Za-z0-9_.-]{0,118})?$/u.test(ref)
        || /[\r\n]/u.test(ref)) invalid();
      return ref;
    }));
    if ((status === 'pass' || status === 'fail') && !evidenceRefs.length) invalid();
    return { caseId: id(r.caseId), sampleIndex: number(r.sampleIndex, 0, 99, true), metricId: id(r.metricId),
      status, value, evidenceRefs, costMicros: number(r.costMicros, 0, 1e9, true), durationMs: number(r.durationMs, 0) };
  });
  unique(samples.map(sampleKey));
  return { runId: id(run.runId), snapshotDigest: digest(run.snapshotDigest), datasetDigest: digest(run.datasetDigest), samples };
}
const sampleKey = (sample: Pick<Sample, 'caseId' | 'metricId' | 'sampleIndex'>): string =>
  sample.caseId + ':' + sample.metricId + ':' + sample.sampleIndex;

export function parseOfflineComparison(value: unknown): Input {
  const r = object(value, ['schemaVersion', 'cases', 'policy', 'baseline', 'candidate']);
  if (r.schemaVersion !== 'lyra-offline-comparison/1') invalid();
  const cases = list(r.cases, 1, 500).map(item => {
    const c = object(item, ['caseId', 'slice']);
    return { caseId: id(c.caseId), slice: id(c.slice) };
  }).sort((a, b) => a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0);
  unique(cases.map(c => c.caseId));
  const p = object(r.policy, ['version', 'samplesPerCase', 'minimumSamples', 'criticalCaseIds', 'metrics']);
  const samplesPerCase = number(p.samplesPerCase, 1, 100, true);
  const minimumSamples = number(p.minimumSamples, 1, samplesPerCase, true);
  const metrics = list(p.metrics, 1, 20).map(item => {
    const m = object(item, ['metricId', 'direction', 'absoluteThreshold', 'maxRegression']);
    if (m.direction !== 'higher' && m.direction !== 'lower') invalid();
    return { metricId: id(m.metricId), direction: m.direction, absoluteThreshold: number(m.absoluteThreshold),
      maxRegression: number(m.maxRegression, 0) } as MetricRule;
  }).sort((a, b) => a.metricId < b.metricId ? -1 : a.metricId > b.metricId ? 1 : 0);
  unique(metrics.map(m => m.metricId));
  if (cases.length * samplesPerCase * metrics.length > 10_000) invalid();
  const criticalCaseIds = unique(list(p.criticalCaseIds, 0, 500).map(id));
  if (criticalCaseIds.some(key => !cases.some(c => c.caseId === key))) invalid();
  const baseline = parseRun(r.baseline), candidate = parseRun(r.candidate);
  if (baseline.runId === candidate.runId || baseline.datasetDigest !== candidate.datasetDigest) invalid();
  for (const run of [baseline, candidate]) {
    if (run.samples.some(s => !cases.some(c => c.caseId === s.caseId)
      || !metrics.some(m => m.metricId === s.metricId) || s.sampleIndex >= samplesPerCase)) invalid();
  }
  return { schemaVersion: 'lyra-offline-comparison/1', cases,
    policy: { version: id(p.version), samplesPerCase, minimumSamples, criticalCaseIds, metrics }, baseline, candidate };
}

/** 分数统计只覆盖有效 pass/fail；成本与耗时覆盖所有已返回样本。 */
function statistics(samples: Array<Sample | null>) {
  const counts = { pass: 0, fail: 0, uncertain: 0, skipped: 0, evaluator_error: 0, missing: 0 };
  const values: number[] = [];
  let costMicros = 0, durationMs = 0;
  for (const sample of samples) {
    if (!sample) { counts.missing++; continue; }
    counts[sample.status]++;
    if (sample.value !== null) values.push(sample.value);
    costMicros += sample.costMicros; durationMs += sample.durationMs;
  }
  values.sort((a, b) => a - b);
  let mean = 0, m2 = 0;
  values.forEach((value, i) => { const delta = value - mean; mean += delta / (i + 1); m2 += delta * (value - mean); });
  const quantile = (q: number): number | null => {
    if (!values.length) return null;
    const p = (values.length - 1) * q, left = Math.floor(p);
    return values[left]! + (values[Math.ceil(p)]! - values[left]!) * (p - left);
  };
  return { expectedCount: samples.length, numericCount: values.length, counts,
    passNumerator: counts.pass, passDenominator: samples.length, costMicros, durationMs,
    mean: values.length ? mean : null, p50: quantile(0.5), p95: quantile(0.95),
    sampleVariance: values.length > 1 ? Math.max(0, m2 / (values.length - 1)) : null };
}

/** 只读离线导入：不运行模型、不查数据库、不改变 candidate 或生产状态。 */
export function compareOfflineEvaluations(value: unknown) {
  const input = parseOfflineComparison(value);
  const base = new Map(input.baseline.samples.map(s => [sampleKey(s), s]));
  const candidate = new Map(input.candidate.samples.map(s => [sampleKey(s), s]));
  const pairs: Pair[] = [];
  for (const c of input.cases) for (const rule of input.policy.metrics) {
    for (let sampleIndex = 0; sampleIndex < input.policy.samplesPerCase; sampleIndex++) {
      const key = sampleKey({ caseId: c.caseId, metricId: rule.metricId, sampleIndex });
      const b = base.get(key) ?? null, n = candidate.get(key) ?? null;
      const sign = rule.direction === 'higher' ? 1 : -1;
      const valid = (s: Sample | null): s is Sample & { value: number } =>
        s !== null && s.value !== null && (s.status === 'pass' || s.status === 'fail');
      const absoluteFailed = valid(n) && sign * n.value < sign * rule.absoluteThreshold;
      const allowedDrop = input.policy.criticalCaseIds.includes(c.caseId) ? 0 : rule.maxRegression;
      const regression = valid(b) && valid(n) && sign * n.value < sign * b.value - allowedDrop;
      const failed = n?.status === 'fail' || absoluteFailed || regression;
      const incomplete = !valid(b) || !valid(n);
      let classification: Classification = 'unchanged';
      if (!n) classification = 'missing_candidate';
      else if (b?.status === 'evaluator_error' || n.status === 'evaluator_error') classification = 'evaluator_error';
      else if (!b) classification = 'new';
      else if (incomplete) classification = 'uncertain';
      else if (regression || (b.status === 'pass' && failed)) classification = 'regression';
      else if (b.status === 'fail' && !failed) classification = 'fixed';
      pairs.push({ key, ...c, metricId: rule.metricId, sampleIndex, classification, baseline: b, candidate: n, failed, incomplete });
    }
  }
  const grouped = new Map<string, { scope: 'case' | 'slice' | 'aggregate'; id: string; metricId: string; rows: Pair[] }>();
  for (const row of pairs) for (const [scope, groupId] of [
    ['case', row.caseId], ['slice', row.slice], ['aggregate', 'all'],
  ] as const) {
    const key = scope + ':' + groupId + ':' + row.metricId;
    const group = grouped.get(key) ?? { scope, id: groupId, metricId: row.metricId, rows: [] };
    group.rows.push(row); grouped.set(key, group);
  }
  const groups = [...grouped.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, group]) => {
    const baseline = statistics(group.rows.map(r => r.baseline)), candidateStats = statistics(group.rows.map(r => r.candidate));
    const lowSamples = baseline.numericCount < input.policy.minimumSamples || candidateStats.numericCount < input.policy.minimumSamples;
    const warnings = [];
    if (lowSamples) warnings.push('INSUFFICIENT_SAMPLES');
    if (Math.min(baseline.numericCount, candidateStats.numericCount) < 5) warnings.push('LOW_SAMPLE_CONFIDENCE');
    const status = group.rows.some(r => r.failed) ? 'fail'
      : lowSamples || group.rows.some(r => r.incomplete) ? 'inconclusive' : 'pass';
    return { scope: group.scope, id: group.id, metricId: group.metricId, status, warnings,
      baseline, candidate: candidateStats, sampleKeys: group.rows.map(r => r.key) };
  });
  const status = groups.some(g => g.status === 'fail') ? 'fail'
    : groups.some(g => g.status === 'inconclusive') ? 'inconclusive' : 'pass';
  const report = {
    schemaVersion: 'lyra-offline-comparison-report/1', status,
    datasetDigest: input.baseline.datasetDigest,
    baseline: { runId: input.baseline.runId, snapshotDigest: input.baseline.snapshotDigest },
    candidate: { runId: input.candidate.runId, snapshotDigest: input.candidate.snapshotDigest },
    plan: input.cases, policy: input.policy, policyDigest: canonicalDigest(input.policy),
    warnings: ['DESCRIPTIVE_STATISTICS_ARE_NOT_CONFIDENCE_INTERVALS'],
    pairs, groups,
  };
  return { ...report, reportDigest: canonicalDigest(report) };
}

export function offlineComparisonExitCode(report: ReturnType<typeof compareOfflineEvaluations>): number {
  return report.status === 'pass' ? 0 : report.status === 'fail' ? 1 : 3;
}

export function offlineComparisonMarkdown(report: ReturnType<typeof compareOfflineEvaluations>): string {
  return ['# 离线评测比较', '', '状态：' + report.status,
    '基线：' + report.baseline.runId + ' / ' + report.baseline.snapshotDigest,
    '候选：' + report.candidate.runId + ' / ' + report.candidate.snapshotDigest,
    '策略：' + report.policy.version + ' / ' + report.policyDigest,
    '报告摘要：' + report.reportDigest,
    '', '描述性统计不是置信区间；缺失、错误和样本不足不能通过。', '',
    '| 层级 | ID | 指标 | 状态 | 基线均值 | 候选均值 | 候选样本数 | 成本 micros | 延迟 ms | 警告 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.groups.map(g => '| ' + [g.scope, g.id, g.metricId, g.status,
      g.baseline.mean ?? 'unknown', g.candidate.mean ?? 'unknown', g.candidate.numericCount,
      g.candidate.costMicros, g.candidate.durationMs, g.warnings.join(',')].join(' | ') + ' |'),
    '', '| 样本 | 分类 | 基线证据 | 候选证据 |', '| --- | --- | --- | --- |',
    ...report.pairs.map(p => '| ' + [p.key, p.classification,
      p.baseline?.evidenceRefs.join(',') || 'unknown', p.candidate?.evidenceRefs.join(',') || 'unknown'].join(' | ') + ' |'), '',
  ].join('\n');
}
