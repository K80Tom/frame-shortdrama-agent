/** #42 的离线指标聚合基础；不代表评估器协议或质量算法已完成。 */
export const EVALUATION_STATISTICS_VERSION = 'lyra-evaluation-statistics/1';
export type MetricSampleStatus = 'pass' | 'fail' | 'uncertain' | 'skipped' | 'evaluator_error';
export interface MetricSample {
  sampleId: string;
  status: MetricSampleStatus;
  /** 只有 pass/fail 有有效数值；缺失结果不得填 0。 */
  value: number | null;
}
export interface MetricStatistics {
  schemaVersion: typeof EVALUATION_STATISTICS_VERSION;
  status: MetricSampleStatus;
  expectedCount: number;
  observedCount: number;
  missingCount: number;
  numericCount: number;
  counts: Record<MetricSampleStatus, number>;
  passNumerator: number;
  /** 分母包含未知、错误、跳过和缺失，不能只用成功样本。 */
  passDenominator: number;
  passRate: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  /** 无偏样本方差；单样本不能估算方差。 */
  sampleVariance: number | null;
}
const STATUSES: readonly MetricSampleStatus[] = ['pass', 'fail', 'uncertain', 'skipped', 'evaluator_error'];
function invalid(): never {
  // 不把不受信输入或评估器原始错误复制到错误信息。
  throw new TypeError('评测统计输入无效。');
}
function count(value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > 100_000) invalid();
}
/**
 * 调用方按冻结 run/case/sample/metric 分组后调用；sampleId 在本组内唯一。
 * expectedCount 来自冻结计划，不能用已返回的样本数代替。
 * 函数无 IO、无网络、无付费调用，也不修改输入。
 */
export function aggregateMetricSamples(
  samples: readonly MetricSample[],
  options: { expectedCount: number; minimumSamples: number },
): MetricStatistics {
  if (!options || !Array.isArray(samples)) invalid();
  count(options.expectedCount, 0);
  count(options.minimumSamples, 1);
  if (samples.length > options.expectedCount) invalid();
  const counts: Record<MetricSampleStatus, number> = {
    pass: 0, fail: 0, uncertain: 0, skipped: 0, evaluator_error: 0,
  };
  const ids = new Set<string>();
  const values: number[] = [];
  for (const sample of samples as readonly MetricSample[]) {
    if (!sample || typeof sample.sampleId !== 'string' || !sample.sampleId.trim()
      || sample.sampleId.length > 200 || ids.has(sample.sampleId)
      || !STATUSES.includes(sample.status)) invalid();
    ids.add(sample.sampleId);
    counts[sample.status] += 1;
    if (sample.status === 'pass' || sample.status === 'fail') {
      // 有界数值防止均值/方差溢出。非确定性状态不允许携带伪造分数。
      if (typeof sample.value !== 'number' || !Number.isFinite(sample.value)
        || Math.abs(sample.value) > 1e12) invalid();
      values.push(sample.value);
    } else if (sample.value !== null) invalid();
  }
  values.sort((a, b) => a - b);
  const n = values.length;
  // Welford 算法避免平方和减均值平方造成严重消减误差。
  let mean = 0;
  let m2 = 0;
  values.forEach((value, index) => {
    const delta = value - mean;
    mean += delta / (index + 1);
    m2 += delta * (value - mean);
  });
  const quantile = (q: number): number | null => {
    if (!n) return null;
    const position = (n - 1) * q;
    const left = Math.floor(position);
    return values[left]! + (values[Math.ceil(position)]! - values[left]!) * (position - left);
  };
  const missingCount = options.expectedCount - samples.length;
  // 明确失败优先；错误与样本不足始终不能产生 pass。
  let status: MetricSampleStatus = 'uncertain';
  if (counts.fail) status = 'fail';
  else if (counts.evaluator_error) status = 'evaluator_error';
  else if (samples.length > 0 && counts.skipped === options.expectedCount) status = 'skipped';
  else if (!missingCount && !counts.uncertain && !counts.skipped
    && n >= options.minimumSamples) status = 'pass';
  return {
    schemaVersion: EVALUATION_STATISTICS_VERSION, status,
    expectedCount: options.expectedCount, observedCount: samples.length, missingCount,
    numericCount: n, counts, passNumerator: counts.pass, passDenominator: options.expectedCount,
    passRate: options.expectedCount ? counts.pass / options.expectedCount : null,
    mean: n ? mean : null, p50: quantile(0.5), p95: quantile(0.95),
    sampleVariance: n > 1 ? Math.max(0, m2 / (n - 1)) : null,
  };
}
