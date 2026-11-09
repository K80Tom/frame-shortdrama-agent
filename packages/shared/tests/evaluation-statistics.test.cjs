const { test } = require('node:test');
const assert = require('node:assert/strict');
const { aggregateMetricSamples: aggregate } = require('../dist/evaluation-statistics');
const sample = (id, status = 'pass', value = 1) => ({ sampleId: id, status, value });
const options = (expectedCount, minimumSamples = 2) => ({ expectedCount, minimumSamples });

test('统计均值、线性分位数、无偏方差，输入顺序不影响结果', () => {
  const input = [sample('b', 'pass', 4), sample('a', 'pass', 1), sample('c', 'pass', 2)];
  const before = JSON.stringify(input);
  const result = aggregate(input, options(3));
  assert.equal(result.status, 'pass');
  assert.equal(result.mean, 7 / 3);
  assert.equal(result.p50, 2);
  assert.equal(result.p95, 3.8);
  assert.ok(Math.abs(result.sampleVariance - 7 / 3) < 1e-12);
  assert.equal(result.passRate, 1);
  assert.deepEqual(aggregate([...input].reverse(), options(3)), result);
  assert.equal(JSON.stringify(input), before);
});

test('未知、错误、跳过与缺失不作为 0 分，也不缩小分母', () => {
  const result = aggregate([sample('a'), sample('b', 'uncertain', null),
    sample('c', 'skipped', null), sample('d', 'evaluator_error', null)], options(5));
  assert.equal(result.status, 'evaluator_error');
  assert.equal(result.numericCount, 1);
  assert.equal(result.mean, 1);
  assert.equal(result.sampleVariance, null);
  assert.equal(result.missingCount, 1);
  assert.equal(result.passNumerator, 1);
  assert.equal(result.passDenominator, 5);
  assert.equal(result.passRate, 0.2);
  assert.deepEqual(result.counts, { pass: 1, fail: 0, uncertain: 1, skipped: 1, evaluator_error: 1 });
});

test('空集与单样本不能伪装为确定性通过', () => {
  const empty = aggregate([], options(0));
  for (const key of ['mean', 'p50', 'p95', 'sampleVariance', 'passRate']) assert.equal(empty[key], null);
  assert.equal(empty.status, 'uncertain');
  assert.equal(aggregate([sample('a')], options(1)).status, 'uncertain');
  assert.equal(aggregate([sample('a')], options(1, 1)).status, 'pass');
});

for (const [name, input, expected, status] of [
  ['missing', [sample('a'), sample('b')], 3, 'uncertain'],
  ['uncertain', [sample('a'), sample('b', 'uncertain', null)], 2, 'uncertain'],
  ['skipped mixed', [sample('a'), sample('b', 'skipped', null)], 2, 'uncertain'],
  ['all skipped', [sample('a', 'skipped', null)], 1, 'skipped'],
  ['failed object', [sample('a', 'fail', 0)], 1, 'fail'],
  ['evaluator error', [sample('a', 'evaluator_error', null)], 1, 'evaluator_error'],
  ['failure and error', [sample('a', 'fail', 0), sample('b', 'evaluator_error', null)], 2, 'fail'],
]) test(name, () => assert.equal(aggregate(input, options(expected)).status, status));

for (const value of [NaN, Infinity, -Infinity, 1e13, null, '1', undefined]) {
  test(`拒绝无效确定性分数 ${String(value)}`, () =>
    assert.throws(() => aggregate([{ sampleId: 'a', status: 'pass', value }], options(1)), TypeError));
}

test('拒绝重复身份、非法状态和伪造的不确定分数', () => {
  for (const input of [[sample('a'), sample('a')], [sample('a', 'success')],
    [sample('', 'pass')], [sample('a', 'uncertain', 0)], [sample('a', 'fail', null)]]) {
    assert.throws(() => aggregate(input, options(2)), TypeError);
  }
});

test('计划样本数必须是有界整数，不能少于已观测样本', () => {
  for (const opts of [options(-1), options(0), options(1.5), options(Infinity), options(100001),
    options(1, 0), options(1, 0.5), options(1, NaN), null]) {
    assert.throws(() => aggregate([sample('a')], opts), TypeError);
  }
});

test('零分和负数是有效观察值，不等于缺失', () => {
  const result = aggregate([sample('a', 'fail', 0), sample('b', 'pass', -2)], options(2));
  assert.equal(result.mean, -1);
  assert.equal(result.numericCount, 2);
  assert.equal(result.sampleVariance, 2);
});
