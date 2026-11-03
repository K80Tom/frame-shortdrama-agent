const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { EvaluationError } = require('@lyra/shared');
const { PostgresDatabase } = require('../dist/db/client');
const { PostgresEvaluationRepository } = require('../dist/evaluation/postgres-repository');
const { EvaluationService } = require('../dist/evaluation/service');

const fixtures = join(__dirname, '../fixtures/evaluation');
const read = name => readFileSync(join(fixtures, name), 'utf8');
let database;

function clock() {
  let time = Date.parse('2026-11-03T00:00:00.000Z');
  return () => { time += 1000; return new Date(time); };
}
function service(repository = new PostgresEvaluationRepository(database)) {
  return new EvaluationService(repository, { now: clock() });
}
async function rejects(action, code) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof EvaluationError, `expected EvaluationError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}
async function sqlError(action) {
  try {
    await action();
    assert.fail('expected SQL to be rejected');
  } catch (error) {
    return error;
  }
}

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error('test:db requires DATABASE_URL');
  database = new PostgresDatabase({ connectionString: process.env.DATABASE_URL });
  await database.verifyConnection();
});

beforeEach(async () => {
  await database.query(`TRUNCATE TABLE evaluation_lifecycle_events, evaluation_revision_usage,
    evaluation_cases, evaluation_dataset_revisions, evaluation_datasets,
    evaluation_rubric_dimensions, evaluation_rubric_revisions, evaluation_rubrics
    RESTART IDENTITY CASCADE`);
});

after(async () => { await database?.close(); });

test('022 迁移创建评测目录表与不可变 Trigger', async () => {
  const migrations = await database.query("SELECT version FROM schema_migrations WHERE version = '022'");
  assert.equal(migrations.rowCount, 1);
  const tables = await database.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'evaluation_%' ORDER BY table_name`);
  assert.deepEqual(tables.rows.map(row => row.table_name), [
    'evaluation_cases', 'evaluation_dataset_revisions', 'evaluation_datasets',
    'evaluation_lifecycle_events', 'evaluation_revision_usage', 'evaluation_rubric_dimensions',
    'evaluation_rubric_revisions', 'evaluation_rubrics']);
  const triggers = await database.query(`SELECT tgname FROM pg_trigger
    WHERE NOT tgisinternal AND tgname LIKE 'evaluation_%' ORDER BY tgname`);
  assert.deepEqual(triggers.rows.map(row => row.tgname), [
    'evaluation_case_guard_trigger', 'evaluation_dataset_revision_guard_trigger',
    'evaluation_lifecycle_append_only', 'evaluation_rubric_dimension_guard_trigger',
    'evaluation_rubric_revision_guard_trigger', 'evaluation_usage_append_only',
    'evaluation_usage_guard_trigger']);
});

test('三类离线夹具通过真实 PostgreSQL 迁移与契约', async () => {
  const evaluator = service();
  const rubric = await evaluator.importRubricJsonl({ jsonl: read('shot-review-rubric.jsonl') });
  assert.equal(rubric.revision.id, 'evalrubrev_22222222222222222222222222222222');
  const frozenRubric = await evaluator.freezeRubricRevision(rubric.revision.rubricId, rubric.revision.id,
    { expectedDigest: rubric.revision.digest, reason: '夹具冻结' });
  assert.equal(frozenRubric.revision.status, 'frozen');

  for (const file of ['novel-breakdown.jsonl', 'asset-retrieval.jsonl', 'shot-review.jsonl']) {
    const imported = await evaluator.importDatasetJsonl({ jsonl: read(file) });
    assert.equal(imported.revision.status, 'draft');
    assert.ok(imported.cases.length >= 1);
  }
  const datasets = await evaluator.listDatasets();
  assert.equal(datasets.items.length, 3);
  const shot = datasets.items.find(item => item.kind === 'shot_review');
  const shotBundle = await evaluator.getDatasetRevision(shot.id,
    (await evaluator.getDataset(shot.id)).revisions[0].id);
  assert.equal(shotBundle.cases[0].input.rubric.digest, frozenRubric.revision.digest);
});

test('冻结后被引用 revision 的 UPDATE/DELETE 在数据库层也被拒绝', async () => {
  const evaluator = service();
  const imported = await evaluator.importDatasetJsonl({ jsonl: read('asset-retrieval.jsonl') });
  const frozen = await evaluator.freezeDatasetRevision(imported.revision.datasetId, imported.revision.id,
    { expectedDigest: imported.revision.digest, reason: '冻结' });
  const update = await sqlError(() => database.query(
    "UPDATE evaluation_dataset_revisions SET note = 'direct attack' WHERE id = $1", [frozen.revision.id]));
  assert.match(update.message, /EVALUATION_REVISION_IMMUTABLE/u);
  const remove = await sqlError(() => database.query(
    'DELETE FROM evaluation_dataset_revisions WHERE id = $1', [frozen.revision.id]));
  assert.match(remove.message, /EVALUATION_REVISION_IMMUTABLE/u);
  const caseUpdate = await sqlError(() => database.query(
    "UPDATE evaluation_cases SET title = 'direct attack' WHERE revision_id = $1", [frozen.revision.id]));
  assert.match(caseUpdate.message, /EVALUATION_REVISION_IMMUTABLE/u);

  await evaluator.recordUsage({ revisionKind: 'dataset', revisionId: frozen.revision.id,
    usageKind: 'evaluation_run', usageRef: 'db-run-001' });
  const referenced = await sqlError(() => database.query(
    "UPDATE evaluation_dataset_revisions SET note = 'after usage' WHERE id = $1", [frozen.revision.id]));
  assert.match(referenced.message, /EVALUATION_REVISION_REFERENCED/u);
  const referencedDelete = await sqlError(() => database.query(
    'DELETE FROM evaluation_dataset_revisions WHERE id = $1', [frozen.revision.id]));
  assert.match(referencedDelete.message, /EVALUATION_REVISION_REFERENCED/u);
});

test('数据库 Trigger 拒绝把草稿 revision 绑定为评测引用', async () => {
  const evaluator = service();
  const imported = await evaluator.importDatasetJsonl({ jsonl: read('novel-breakdown.jsonl') });
  const error = await sqlError(() => database.query(`INSERT INTO evaluation_revision_usage
    (id, dataset_revision_id, rubric_revision_id, usage_kind, usage_ref, note, created_at)
    VALUES ('evalusage_33333333333333333333333333333333', $1, NULL, 'evaluation_run', 'db-draft-run', '', now())`,
  [imported.revision.id]));
  assert.match(error.message, /EVALUATION_REVISION_NOT_BINDABLE/u);
});

test('并发派生在新事务内分配不重号，旧版本内容保持不变', async () => {
  const evaluator = service();
  const imported = await evaluator.importDatasetJsonl({ jsonl: read('asset-retrieval.jsonl') });
  const frozen = await evaluator.freezeDatasetRevision(imported.revision.datasetId, imported.revision.id,
    { expectedDigest: imported.revision.digest, reason: '冻结' });
  const results = await Promise.all([
    evaluator.createNextDatasetRevision(frozen.revision.datasetId,
      { baseRevisionId: frozen.revision.id, expectedDigest: frozen.revision.digest, reason: 'A' }),
    evaluator.createNextDatasetRevision(frozen.revision.datasetId,
      { baseRevisionId: frozen.revision.id, expectedDigest: frozen.revision.digest, reason: 'B' }),
  ]);
  assert.equal(new Set(results.map(item => item.revision.revision)).size, 2);
  assert.ok(results.every(item => item.revision.revision > 1));
  const old = await evaluator.getDatasetRevision(frozen.revision.datasetId, frozen.revision.id);
  assert.equal(old.revision.digest, frozen.revision.digest);
  assert.deepEqual(old.cases, frozen.cases);
});

test('错误 expectedDigest 与空数据集冻结在 PostgreSQL 层同样失败', async () => {
  const evaluator = service();
  const imported = await evaluator.importDatasetJsonl({ jsonl: read('novel-breakdown.jsonl') });
  await rejects(() => evaluator.freezeDatasetRevision(imported.revision.datasetId, imported.revision.id,
    { expectedDigest: 'f'.repeat(64), reason: '错误摘要' }), 'EVALUATION_REVISION_STALE');
  const empty = await evaluator.createDataset({ kind: 'asset_retrieval', title: '空数据集', description: '',
    note: '', contentSummary: '', slices: [], tags: [], authorization: imported.revision.authorization,
    sensitivity: 'internal', provenance: imported.revision.provenance, cases: [] });
  await rejects(() => evaluator.freezeDatasetRevision(empty.revision.datasetId, empty.revision.id,
    { expectedDigest: empty.revision.digest, reason: '空' }), 'EVALUATION_REVISION_EMPTY');
});

test('Repository 返回防御性拷贝，调用方修改不影响后续读取', async () => {
  const repository = new PostgresEvaluationRepository(database);
  const evaluator = service(repository);
  const imported = await evaluator.importDatasetJsonl({ jsonl: read('novel-breakdown.jsonl') });
  const bundle = await repository.getDatasetRevision(imported.revision.datasetId, imported.revision.id);
  bundle.cases[0].title = 'mutated outside';
  bundle.revision.note = 'mutated outside';
  const again = await repository.getDatasetRevision(imported.revision.datasetId, imported.revision.id);
  assert.notEqual(again.cases[0].title, 'mutated outside');
  assert.notEqual(again.revision.note, 'mutated outside');
  assert.equal(again.revision.digest, imported.revision.digest);
});

test('被引用量表 revision 的数据库层 UPDATE/DELETE 也被拒绝', async () => {
  const evaluator = service();
  const rubric = await evaluator.importRubricJsonl({ jsonl: read('shot-review-rubric.jsonl') });
  const frozen = await evaluator.freezeRubricRevision(rubric.revision.rubricId, rubric.revision.id,
    { expectedDigest: rubric.revision.digest, reason: '冻结' });
  await evaluator.recordUsage({ revisionKind: 'rubric', revisionId: frozen.revision.id,
    usageKind: 'evaluation_run', usageRef: 'db-rubric-run' });
  const update = await sqlError(() => database.query(
    "UPDATE evaluation_rubric_revisions SET summary = 'attack' WHERE id = $1", [frozen.revision.id]));
  assert.match(update.message, /EVALUATION_REVISION_REFERENCED/u);
  const remove = await sqlError(() => database.query(
    'DELETE FROM evaluation_rubric_revisions WHERE id = $1', [frozen.revision.id]));
  assert.match(remove.message, /EVALUATION_REVISION_REFERENCED/u);
});
