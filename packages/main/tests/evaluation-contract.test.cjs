const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  EvaluationError, MISSING_RESULT_SEMANTICS, datasetContentDigest, evaluationCaseDigest,
  normalizeEvaluationText, parseCreateEvaluationRubric, parseEvaluationCase, parseRubricDimension,
  parseCreateEvaluationDataset, evaluationRubricContentDigest,
} = require('@lyra/shared');
const { parseDatasetJsonl } = require('../dist/evaluation/jsonl');

const fixture = name => parseDatasetJsonl(readFileSync(join(__dirname, '../fixtures/evaluation', name), 'utf8'));
const caseOf = name => fixture(name).cases[0];
const clone = value => structuredClone(value);
const auth = { status: 'granted', basis: '合成夹具，无外部授权', scope: '仅离线测试', grantedBy: '测试',
  grantedAt: '2026-10-01', expiresAt: null, restrictions: [] };
const dimension = (key, over = {}) => ({ key, label: key, description: `${key} 描述`,
  scale: { min: 0, max: 4, step: 1 }, thresholds: { passAt: 3, failAt: 1 },
  evidence: { required: false, kinds: ['human_note'], minItems: 0, note: '' }, ...over });
const policy = { uncertain: 'review', skipped: 'exclude', evaluator_error: 'review' };

function assertCode(action, code, path) {
  assert.throws(action, error => {
    assert.ok(error instanceof EvaluationError, `expected EvaluationError, got ${error}`);
    assert.equal(error.code, code);
    assert.equal(error.status, 400);
    if (path) assert.ok(error.details.some(item => item.path.endsWith(path)), JSON.stringify(error.details));
    return true;
  });
}

test('每个量表必须显式声明 uncertain/skipped/evaluator_error 三态语义', () => {
  for (const action of ['fail', 'exclude', 'review']) {
    assert.equal(typeof MISSING_RESULT_SEMANTICS[action], 'string');
    assert.match(MISSING_RESULT_SEMANTICS[action], /./u);
  }
  for (const key of ['uncertain', 'skipped', 'evaluator_error']) {
    const missing = { ...policy };
    delete missing[key];
    assertCode(() => parseCreateEvaluationRubric({ kind: 'novel_breakdown', title: '量表', description: '',
      note: '', summary: '', missingResultPolicy: missing, dimensions: [dimension('clarity')] }),
    'EVALUATION_INPUT_INVALID', `missingResultPolicy.${key}`);
  }
  assertCode(() => parseCreateEvaluationRubric({ kind: 'novel_breakdown', title: '量表', description: '',
    note: '', summary: '', missingResultPolicy: { ...policy, uncertain: 'ignore' },
    dimensions: [dimension('clarity')] }),
  'EVALUATION_INPUT_INVALID', 'missingResultPolicy.uncertain');
});

test('非法阈值、错位刻度与镜头四维约束在边界被拒绝', () => {
  const base = { kind: 'shot_review', title: '镜头量表', description: '', note: '', summary: '',
    missingResultPolicy: policy };
  const dims = [dimension('composition'), dimension('continuity'), dimension('lighting'), dimension('camera_motion')];
  assert.equal(parseCreateEvaluationRubric({ ...base, dimensions: dims }).dimensions.length, 4);

  const failNotBelow = clone(dims);
  failNotBelow[0].thresholds = { passAt: 2, failAt: 2 };
  assertCode(() => parseCreateEvaluationRubric({ ...base, dimensions: failNotBelow }),
    'EVALUATION_INPUT_INVALID', 'thresholds.failAt');

  const passAtMin = clone(dims);
  passAtMin[0].thresholds = { passAt: 0, failAt: 0 };
  assertCode(() => parseCreateEvaluationRubric({ ...base, dimensions: passAtMin }),
    'EVALUATION_INPUT_INVALID', 'thresholds.failAt');

  const unaligned = clone(dims);
  unaligned[0].thresholds = { passAt: 2.5, failAt: 1 };
  assertCode(() => parseCreateEvaluationRubric({ ...base, dimensions: unaligned }),
    'EVALUATION_INPUT_INVALID', 'thresholds.passAt');

  assertCode(() => parseCreateEvaluationRubric({ ...base, dimensions: dims.slice(0, 3) }),
    'EVALUATION_INPUT_INVALID', 'dimensions');
  const noFrame = clone(dims);
  noFrame[1].evidence = { required: true, kinds: ['human_note'], minItems: 1, note: '' };
  assertCode(() => parseCreateEvaluationRubric({ ...base, dimensions: noFrame }),
    'EVALUATION_INPUT_INVALID', 'evidence.kinds');
});

test('三类 Case 使用闭合字段集，未知字段、缺字段和类型错配均被拒绝', () => {
  const novel = caseOf('novel-breakdown.jsonl');
  const withUnknown = clone(novel);
  withUnknown.input.rawRecord = { anything: true };
  assertCode(() => parseEvaluationCase(withUnknown, 'case'), 'EVALUATION_INPUT_INVALID', 'case.input.rawRecord');

  const missingField = clone(novel);
  delete missingField.expectation;
  assertCode(() => parseEvaluationCase(missingField, 'case'), 'EVALUATION_INPUT_INVALID', 'case.expectation');

  const wrongKind = clone(novel);
  wrongKind.input.kind = 'asset_retrieval';
  assertCode(() => parseEvaluationCase(wrongKind, 'case', 'novel_breakdown'), 'EVALUATION_KIND_MISMATCH', 'case.input.kind');

  const unknownKind = clone(novel);
  unknownKind.kind = 'video_review';
  assertCode(() => parseEvaluationCase(unknownKind, 'case'), 'EVALUATION_INPUT_INVALID', 'case.kind');

  for (const file of ['novel-breakdown.jsonl', 'asset-retrieval.jsonl', 'shot-review.jsonl']) {
    const parsed = caseOf(file);
    assert.equal(parsed.input.kind, parsed.kind);
  }
});

test('授权缺失或被拒的数据不得进入目录，restricted 必须声明限制', () => {
  const source = caseOf('novel-breakdown.jsonl');
  const datasetBody = { kind: 'novel_breakdown', title: '数据集', description: '', note: '', contentSummary: '',
    slices: [], tags: [], authorization: { ...auth, status: 'pending' }, sensitivity: 'internal',
    provenance: source.source, cases: [source] };
  assertCode(() => parseCreateEvaluationDataset(datasetBody), 'EVALUATION_AUTHORIZATION_DENIED', 'dataset.authorization.status');

  const denied = clone(source);
  denied.authorization.status = 'denied';
  assertCode(() => parseEvaluationCase(denied, 'case'), 'EVALUATION_AUTHORIZATION_DENIED', 'case.authorization.status');

  const restricted = clone(source);
  restricted.sensitivity = 'restricted';
  assertCode(() => parseEvaluationCase(restricted, 'case'), 'EVALUATION_INPUT_INVALID', 'case.authorization.restrictions');
});

test('规范化幂等，内容摘要在 revision 号变化时保持稳定且不含生命周期状态', () => {
  const source = caseOf('novel-breakdown.jsonl');
  assert.equal(normalizeEvaluationText('  a\r\nb  \r\n'), 'a\nb');
  assert.equal(normalizeEvaluationText(normalizeEvaluationText('  a\r\nb  \r\n')), 'a\nb');

  const first = datasetContentDigest('novel_breakdown', [source]);
  const same = datasetContentDigest('novel_breakdown', [caseOf('novel-breakdown.jsonl')]);
  assert.equal(first, same);
  assert.equal(evaluationCaseDigest(source), evaluationCaseDigest(clone(source)));

  const changed = clone(source);
  changed.expectation.expectedSourceRefCount = 2;
  assert.notEqual(evaluationCaseDigest(changed), evaluationCaseDigest(source));

  const dims = [dimension('clarity')];
  assert.equal(evaluationRubricContentDigest('novel_breakdown', policy, dims),
    evaluationRubricContentDigest('novel_breakdown', { ...policy }, clone(dims)));
});

test('缺失结果策略必须能机器判定，而不是仅有文案', () => {
  const parsed = parseRubricDimension({ key: 'clarity', label: '清晰度', description: '描述',
    scale: { min: 0, max: 4, step: 1 }, thresholds: { passAt: 3, failAt: 1 },
    evidence: { required: false, kinds: ['human_note'], minItems: 0, note: '' } }, 'dimension', 'novel_breakdown');
  assert.equal(parsed.key, 'clarity');
  assert.equal(MISSING_RESULT_SEMANTICS[policy.uncertain], MISSING_RESULT_SEMANTICS.review);
  assert.notEqual(MISSING_RESULT_SEMANTICS.review, MISSING_RESULT_SEMANTICS.exclude);
});
