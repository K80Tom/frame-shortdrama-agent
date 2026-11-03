const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { EvaluationError } = require('@lyra/shared');
const { MemoryEvaluationRepository } = require('../dist/evaluation/repository');
const { EvaluationService } = require('../dist/evaluation/service');
const { parseDatasetJsonl, parseRubricJsonl } = require('../dist/evaluation/jsonl');

const fixtures = join(__dirname, '../fixtures/evaluation');
const datasetFixture = name => parseDatasetJsonl(readFileSync(join(fixtures, name), 'utf8'));
const rubricFixture = parseRubricJsonl(readFileSync(join(fixtures, 'shot-review-rubric.jsonl'), 'utf8'));

function clock(start = '2026-11-03T00:00:00.000Z') {
  let time = Date.parse(start);
  return () => { time += 1000; return new Date(time); };
}
function datasetBody(document) {
  return { kind: document.manifest.kind, title: document.manifest.title, description: document.manifest.description,
    note: document.manifest.note, contentSummary: document.manifest.contentSummary, slices: document.manifest.slices,
    tags: document.manifest.tags, authorization: document.manifest.authorization,
    sensitivity: document.manifest.sensitivity, provenance: document.manifest.provenance, cases: document.cases };
}
function rubricBody(document) {
  return { kind: document.manifest.kind, title: document.manifest.title, description: document.manifest.description,
    note: document.manifest.note, summary: document.manifest.summary,
    missingResultPolicy: document.manifest.missingResultPolicy, dimensions: document.dimensions };
}
async function rejects(action, code) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof EvaluationError, `expected EvaluationError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('冻结后追加内容失败；派生新草稿不改变旧版本；废弃只追加事件', async () => {
  const repository = new MemoryEvaluationRepository();
  const service = new EvaluationService(repository, { now: clock() });
  const document = datasetFixture('novel-breakdown.jsonl');
  const created = await service.createDataset(datasetBody(document));
  const frozen = await service.freezeDatasetRevision(created.revision.datasetId, created.revision.id,
    { expectedDigest: created.revision.digest, reason: '首版冻结' });
  assert.equal(frozen.revision.status, 'frozen');

  const extra = structuredClone(document.cases[0]);
  extra.caseId = 'case-novel-extra';
  extra.title = '冻结后追加';
  extra.input.segments[0].text = `${extra.input.segments[0].text}（派生草稿追加）`;
  await rejects(() => service.appendDatasetCases(frozen.revision.datasetId, frozen.revision.id,
    { expectedDigest: frozen.revision.digest, cases: [extra] }), 'EVALUATION_REVISION_IMMUTABLE');

  const derived = await service.createNextDatasetRevision(frozen.revision.datasetId,
    { baseRevisionId: frozen.revision.id, expectedDigest: frozen.revision.digest, reason: '派生新草稿' });
  assert.equal(derived.revision.revision, 2);
  assert.equal(derived.revision.status, 'draft');
  const old = await service.getDatasetRevision(frozen.revision.datasetId, frozen.revision.id);
  assert.equal(old.revision.digest, frozen.revision.digest);
  assert.deepEqual(old.cases, frozen.cases);

  const appended = await service.appendDatasetCases(derived.revision.datasetId, derived.revision.id,
    { expectedDigest: derived.revision.digest, cases: [extra] });
  assert.equal(appended.revision.caseCount, 3);
  const oldAgain = await service.getDatasetRevision(frozen.revision.datasetId, frozen.revision.id);
  assert.equal(oldAgain.revision.digest, frozen.revision.digest);
  assert.equal(oldAgain.cases.length, 2);

  await rejects(() => service.deprecateDatasetRevision(frozen.revision.datasetId, frozen.revision.id,
    { expectedDigest: 'f'.repeat(64), reason: '摘要错误' }), 'EVALUATION_REVISION_STALE');
  const deprecated = await service.deprecateDatasetRevision(frozen.revision.datasetId, frozen.revision.id,
    { expectedDigest: frozen.revision.digest, reason: '基线被替代' });
  assert.equal(deprecated.status, 'deprecated');
  assert.equal(deprecated.digest, frozen.revision.digest);
  assert.equal(deprecated.contentDigest, frozen.revision.contentDigest);
  const events = await repository.listLifecycleEvents('dataset', frozen.revision.id);
  assert.deepEqual(events.map(event => event.action), ['created', 'frozen', 'deprecated']);
  assert.equal(events.at(-1).reason, '基线被替代');
});

test('错误 expectedDigest 在追加、冻结与派生时均失败', async () => {
  const repository = new MemoryEvaluationRepository();
  const service = new EvaluationService(repository, { now: clock() });
  const document = datasetFixture('asset-retrieval.jsonl');
  const created = await service.createDataset(datasetBody(document));
  const wrong = '0'.repeat(64);
  await rejects(() => service.appendDatasetCases(created.revision.datasetId, created.revision.id,
    { expectedDigest: wrong, cases: [document.cases[0]] }), 'EVALUATION_REVISION_STALE');
  await rejects(() => service.freezeDatasetRevision(created.revision.datasetId, created.revision.id,
    { expectedDigest: wrong, reason: '冻结' }), 'EVALUATION_REVISION_STALE');
  const frozen = await service.freezeDatasetRevision(created.revision.datasetId, created.revision.id,
    { expectedDigest: created.revision.digest, reason: '冻结' });
  await rejects(() => service.createNextDatasetRevision(frozen.revision.datasetId,
    { baseRevisionId: frozen.revision.id, expectedDigest: wrong, reason: '派生' }), 'EVALUATION_REVISION_STALE');
  await rejects(() => service.deprecateDatasetRevision(frozen.revision.datasetId, frozen.revision.id,
    { expectedDigest: wrong, reason: '废弃' }), 'EVALUATION_REVISION_STALE');
});

test('被引用 revision 在 Repository 层同时拒绝内容写入；新评测不能绑定草稿或已废弃版本', async () => {
  const repository = new MemoryEvaluationRepository();
  const service = new EvaluationService(repository, { now: clock() });
  const document = datasetFixture('novel-breakdown.jsonl');
  const created = await service.createDataset(datasetBody(document));
  await rejects(() => service.recordUsage({ revisionKind: 'dataset', revisionId: created.revision.id,
    usageKind: 'evaluation_run', usageRef: 'run-draft' }), 'EVALUATION_REVISION_NOT_BINDABLE');

  const frozen = await service.freezeDatasetRevision(created.revision.datasetId, created.revision.id,
    { expectedDigest: created.revision.digest, reason: '冻结' });
  const usage = await service.recordUsage({ revisionKind: 'dataset', revisionId: frozen.revision.id,
    usageKind: 'evaluation_run', usageRef: 'run-001' });
  assert.equal(usage.usageRef, 'run-001');
  const duplicate = await service.recordUsage({ revisionKind: 'dataset', revisionId: frozen.revision.id,
    usageKind: 'evaluation_run', usageRef: 'run-001' });
  assert.equal(duplicate.id, usage.id);

  const extra = structuredClone(document.cases[0]);
  extra.caseId = 'case-novel-referenced';
  extra.title = '引用后追加';
  await rejects(() => repository.appendDatasetCases(frozen.revision.datasetId, frozen.revision.id,
    [extra], frozen.revision.digest, '2026-11-03T01:00:00.000Z'), 'EVALUATION_REVISION_REFERENCED');

  const deprecated = await service.deprecateDatasetRevision(frozen.revision.datasetId, frozen.revision.id,
    { expectedDigest: frozen.revision.digest, reason: '替代' });
  await rejects(() => service.recordUsage({ revisionKind: 'dataset', revisionId: deprecated.id,
    usageKind: 'evaluation_run', usageRef: 'run-002' }), 'EVALUATION_REVISION_NOT_BINDABLE');
});

test('并发从同一冻结基线派生不产生重号，所有草稿内容各自独立', async () => {
  const repository = new MemoryEvaluationRepository();
  const service = new EvaluationService(repository, { now: clock() });
  const document = datasetFixture('asset-retrieval.jsonl');
  const created = await service.createDataset(datasetBody(document));
  const frozen = await service.freezeDatasetRevision(created.revision.datasetId, created.revision.id,
    { expectedDigest: created.revision.digest, reason: '冻结' });
  const results = await Promise.all([
    service.createNextDatasetRevision(frozen.revision.datasetId,
      { baseRevisionId: frozen.revision.id, expectedDigest: frozen.revision.digest, reason: 'A' }),
    service.createNextDatasetRevision(frozen.revision.datasetId,
      { baseRevisionId: frozen.revision.id, expectedDigest: frozen.revision.digest, reason: 'B' }),
  ]);
  assert.equal(new Set(results.map(item => item.revision.revision)).size, 2);
  assert.deepEqual(await service.getDataset(frozen.revision.datasetId).then(result => result.revisions.length), 3);
});

test('量表冻结后禁止追加维度，派生后旧版本不变，空量表不能冻结', async () => {
  const repository = new MemoryEvaluationRepository();
  const service = new EvaluationService(repository, { now: clock() });
  const created = await service.createRubric(rubricBody(rubricFixture));
  const frozen = await service.freezeRubricRevision(created.revision.rubricId, created.revision.id,
    { expectedDigest: created.revision.digest, reason: '冻结量表' });
  assert.equal(frozen.revision.dimensionCount, 4);

  const extra = { ...structuredClone(rubricFixture.dimensions[0]), key: 'sound_design', label: '声音设计',
    description: '环境声与对白层次。' };
  await rejects(() => service.appendRubricDimensions(frozen.revision.rubricId, frozen.revision.id,
    { expectedDigest: frozen.revision.digest, dimensions: [extra] }), 'EVALUATION_REVISION_IMMUTABLE');
  await rejects(() => repository.appendRubricDimensions(frozen.revision.rubricId, frozen.revision.id,
    [extra], frozen.revision.digest, '2026-11-03T01:00:00.000Z'), 'EVALUATION_REVISION_IMMUTABLE');

  const derived = await service.createNextRubricRevision(frozen.revision.rubricId,
    { baseRevisionId: frozen.revision.id, expectedDigest: frozen.revision.digest, reason: '派生量表' });
  assert.equal(derived.revision.revision, 2);
  const old = await service.getRubricRevision(frozen.revision.rubricId, frozen.revision.id);
  assert.equal(old.revision.digest, frozen.revision.digest);
  assert.deepEqual(old.dimensions, frozen.dimensions);

  const emptyRepository = new MemoryEvaluationRepository();
  const emptyService = new EvaluationService(emptyRepository, { now: clock() });
  const empty = await emptyService.createDataset({ ...datasetBody(datasetFixture('asset-retrieval.jsonl')), cases: [] });
  assert.equal(empty.revision.caseCount, 0);
  await rejects(() => emptyService.freezeDatasetRevision(empty.revision.datasetId, empty.revision.id,
    { expectedDigest: empty.revision.digest, reason: '空数据集' }), 'EVALUATION_REVISION_EMPTY');
});

test('量表被引用后 Repository 拒绝追加维度；草稿不能绑定评测', async () => {
  const repository = new MemoryEvaluationRepository();
  const service = new EvaluationService(repository, { now: clock() });
  const created = await service.createRubric(rubricBody(rubricFixture));
  await rejects(() => service.recordUsage({ revisionKind: 'rubric', revisionId: created.revision.id,
    usageKind: 'evaluation_run', usageRef: 'run-rubric-draft' }), 'EVALUATION_REVISION_NOT_BINDABLE');
  const frozen = await service.freezeRubricRevision(created.revision.rubricId, created.revision.id,
    { expectedDigest: created.revision.digest, reason: '冻结' });
  await service.recordUsage({ revisionKind: 'rubric', revisionId: frozen.revision.id,
    usageKind: 'evaluation_run', usageRef: 'run-rubric-001' });
  const extra = { ...structuredClone(rubricFixture.dimensions[0]), key: 'sound_design', label: '声音设计' };
  await rejects(() => repository.appendRubricDimensions(frozen.revision.rubricId, frozen.revision.id,
    [extra], frozen.revision.digest, '2026-11-03T01:00:00.000Z'), 'EVALUATION_REVISION_REFERENCED');
});
