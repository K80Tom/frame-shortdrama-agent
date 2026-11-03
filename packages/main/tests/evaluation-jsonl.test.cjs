const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { EvaluationError } = require('@lyra/shared');
const { MemoryEvaluationRepository } = require('../dist/evaluation/repository');
const { EvaluationService } = require('../dist/evaluation/service');
const { parseDatasetJsonl, parseRubricJsonl } = require('../dist/evaluation/jsonl');

const fixtures = join(__dirname, '../fixtures/evaluation');
const read = name => readFileSync(join(fixtures, name), 'utf8');
const records = name => read(name).trim().split('\n').map(line => JSON.parse(line));
const text = items => `${items.map(item => JSON.stringify(item)).join('\n')}\n`;
function clock() {
  let time = Date.parse('2026-11-03T00:00:00.000Z');
  return () => { time += 1000; return new Date(time); };
}
async function rejects(action, code, expected = {}) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof EvaluationError, `expected EvaluationError, got ${error}`);
    assert.equal(error.code, code);
    for (const [key, value] of Object.entries(expected)) {
      if (key === 'line' || key === 'caseId' || key === 'path' || key === 'detailCode') {
        const detailKey = key === 'detailCode' ? 'code' : key;
        assert.ok(error.details.some(item => item[detailKey] === value), JSON.stringify(error.details));
      }
    }
    return true;
  });
}

test('三类离线夹具通过契约解析，且不含媒体二进制、密钥或完整供应商响应', () => {
  const novel = parseDatasetJsonl(read('novel-breakdown.jsonl'));
  const asset = parseDatasetJsonl(read('asset-retrieval.jsonl'));
  const shot = parseDatasetJsonl(read('shot-review.jsonl'));
  const rubric = parseRubricJsonl(read('shot-review-rubric.jsonl'));
  assert.equal(novel.cases.length, 2);
  assert.equal(asset.cases.length, 1);
  assert.equal(shot.cases.length, 1);
  assert.equal(rubric.dimensions.length, 4);
  assert.equal(shot.cases[0].input.rubric.revisionId, 'evalrubrev_22222222222222222222222222222222');
  for (const raw of [read('novel-breakdown.jsonl'), read('asset-retrieval.jsonl'), read('shot-review.jsonl')]) {
    assert.doesNotMatch(raw, /base64|data:(image|video)|sk-[a-zA-Z0-9]|apiKey|providerResponse/iu);
  }
  assert.ok(novel.cases.every(item => item.input.segments.every(segment => segment.text.length <= 4000)));
});

test('导出再导入时规范化内容与 contentDigest 一致', async () => {
  const source = new EvaluationService(new MemoryEvaluationRepository(), { now: clock() });
  const imported = await source.importDatasetJsonl({ jsonl: read('novel-breakdown.jsonl') });
  const exported = await source.exportDatasetRevision(imported.revision.datasetId, imported.revision.id);
  assert.equal(exported.contentDigest, imported.revision.contentDigest);
  const destination = new EvaluationService(new MemoryEvaluationRepository(), { now: clock() });
  const again = await destination.importDatasetJsonl({ jsonl: exported.jsonl });
  assert.equal(again.revision.contentDigest, imported.revision.contentDigest);
  assert.equal(again.revision.digest, imported.revision.digest);
  assert.deepEqual(again.cases, imported.cases);

  const rubricSource = new EvaluationService(new MemoryEvaluationRepository(), { now: clock() });
  const rubricImported = await rubricSource.importRubricJsonl({ jsonl: read('shot-review-rubric.jsonl') });
  const rubricExported = await rubricSource.exportRubricRevision(rubricImported.revision.rubricId,
    rubricImported.revision.id);
  const rubricTarget = new EvaluationService(new MemoryEvaluationRepository(), { now: clock() });
  const rubricAgain = await rubricTarget.importRubricJsonl({ jsonl: rubricExported.jsonl });
  assert.equal(rubricAgain.revision.contentDigest, rubricImported.revision.contentDigest);
  assert.equal(rubricAgain.revision.digest, rubricImported.revision.digest);
  assert.deepEqual(rubricAgain.dimensions, rubricImported.dimensions);
});

test('导入已有数据集必须带 expectedDigest，并派生新 revision 而不是覆盖历史', async () => {
  const repository = new MemoryEvaluationRepository();
  const service = new EvaluationService(repository, { now: clock() });
  const first = await service.importDatasetJsonl({ jsonl: read('asset-retrieval.jsonl') });
  await rejects(() => service.importDatasetJsonl({ jsonl: read('asset-retrieval.jsonl') }),
    'EVALUATION_EXPECTED_DIGEST_REQUIRED');
  await rejects(() => service.importDatasetJsonl({ jsonl: read('asset-retrieval.jsonl'),
    expectedDigest: 'f'.repeat(64) }), 'EVALUATION_REVISION_STALE');
  const second = await service.importDatasetJsonl({ jsonl: read('asset-retrieval.jsonl'),
    expectedDigest: first.revision.digest });
  assert.equal(second.revision.revision, 2);
  assert.equal(second.revision.contentDigest, first.revision.contentDigest);
  const old = await service.getDatasetRevision(first.revision.datasetId, first.revision.id);
  assert.equal(old.revision.digest, first.revision.digest);
});

test('JSONL 导入原子化：任一错误都不留下新数据集或半份 revision', async () => {
  const repository = new MemoryEvaluationRepository();
  const service = new EvaluationService(repository, { now: clock() });
  const broken = records('asset-retrieval.jsonl');
  delete broken[1].title;
  await rejects(() => service.importDatasetJsonl({ jsonl: text(broken) }), 'EVALUATION_JSONL_INVALID',
    { line: 2, path: 'case.title' });
  assert.equal((await service.listDatasets()).items.length, 0);

  const first = await service.importDatasetJsonl({ jsonl: read('asset-retrieval.jsonl') });
  const brokenAgain = records('asset-retrieval.jsonl');
  brokenAgain[1].title = '';
  await rejects(() => service.importDatasetJsonl({ jsonl: text(brokenAgain), expectedDigest: first.revision.digest }),
    'EVALUATION_JSONL_INVALID', { line: 2 });
  const revisions = (await service.getDataset(first.revision.datasetId)).revisions;
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].digest, first.revision.digest);
});

test('Case ID 重复、内容完全重复、输入相同但期望不同均返回行号与 caseId', async () => {
  const base = records('novel-breakdown.jsonl');
  const firstCase = structuredClone(base[1]);
  const duplicateId = structuredClone(base);
  duplicateId.push({ ...firstCase });
  await rejects(() => new EvaluationService(new MemoryEvaluationRepository(), { now: clock() })
    .importDatasetJsonl({ jsonl: text(duplicateId) }), 'EVALUATION_JSONL_INVALID',
    { line: 4, caseId: 'case-novel-001' });

  const duplicateContent = structuredClone(base);
  const sameContent = { ...structuredClone(firstCase), caseId: 'case-novel-copy', title: '不同标题但同样例' };
  duplicateContent.push(sameContent);
  await rejects(() => new EvaluationService(new MemoryEvaluationRepository(), { now: clock() })
    .importDatasetJsonl({ jsonl: text(duplicateContent) }), 'EVALUATION_JSONL_INVALID',
    { line: 4, caseId: 'case-novel-copy' });

  const conflict = structuredClone(base);
  const different = { ...structuredClone(firstCase), caseId: 'case-novel-conflict',
    expectation: { ...firstCase.expectation, expectedSourceRefCount: 2 } };
  conflict.push(different);
  await rejects(() => new EvaluationService(new MemoryEvaluationRepository(), { now: clock() })
    .importDatasetJsonl({ jsonl: text(conflict) }), 'EVALUATION_JSONL_INVALID',
    { line: 4, caseId: 'case-novel-conflict' });
});

test('授权缺失或拒绝、Schema 错误、非法版本引用都能定位到行与字段', async () => {
  const missingAuth = records('asset-retrieval.jsonl');
  delete missingAuth[1].authorization;
  await rejects(() => new EvaluationService(new MemoryEvaluationRepository(), { now: clock() })
    .importDatasetJsonl({ jsonl: text(missingAuth) }), 'EVALUATION_JSONL_INVALID',
    { line: 2, path: 'case.authorization' });

  const denied = records('asset-retrieval.jsonl');
  denied[1].authorization.status = 'denied';
  await rejects(() => new EvaluationService(new MemoryEvaluationRepository(), { now: clock() })
    .importDatasetJsonl({ jsonl: text(denied) }), 'EVALUATION_JSONL_INVALID',
    { line: 2, path: 'case.authorization.status', detailCode: 'EVALUATION_AUTHORIZATION_DENIED' });

  const badRef = records('shot-review.jsonl');
  badRef[1].versionRefs[0].id = 'not-a-rubric-revision';
  await rejects(() => new EvaluationService(new MemoryEvaluationRepository(), { now: clock() })
    .importDatasetJsonl({ jsonl: text(badRef) }), 'EVALUATION_JSONL_INVALID',
    { line: 2, path: 'case.versionRefs[0].id' });

  const badSchema = records('asset-retrieval.jsonl');
  badSchema[0].schemaVersion = 'lyra-evaluation-jsonl/999';
  await rejects(() => new EvaluationService(new MemoryEvaluationRepository(), { now: clock() })
    .importDatasetJsonl({ jsonl: text(badSchema) }), 'EVALUATION_JSONL_INVALID',
    { detailCode: 'EVALUATION_JSONL_SCHEMA_MISMATCH' });
});

test('镜头审核引用未冻结或不存在的量表 revision 时返回 line/caseId/path', async () => {
  const service = new EvaluationService(new MemoryEvaluationRepository(), { now: clock() });
  await rejects(() => service.importDatasetJsonl({ jsonl: read('shot-review.jsonl') }),
    'EVALUATION_JSONL_INVALID', { caseId: 'case-shot-001', path: 'case.case-shot-001.input.rubric',
      detailCode: 'EVALUATION_VERSION_REF_INVALID' });

  const rubric = await service.importRubricJsonl({ jsonl: read('shot-review-rubric.jsonl') });
  await rejects(() => service.importDatasetJsonl({ jsonl: read('shot-review.jsonl') }),
    'EVALUATION_JSONL_INVALID', { caseId: 'case-shot-001', detailCode: 'EVALUATION_VERSION_REF_INVALID' });
  await service.freezeRubricRevision(rubric.revision.rubricId, rubric.revision.id,
    { expectedDigest: rubric.revision.digest, reason: '夹具冻结' });
  const imported = await service.importDatasetJsonl({ jsonl: read('shot-review.jsonl') });
  assert.equal(imported.cases[0].input.rubric.digest, rubric.revision.digest);
});

test('JSONL manifest 缺失、重复、未知记录与空文件均被拒绝', async () => {
  const service = () => new EvaluationService(new MemoryEvaluationRepository(), { now: clock() });
  await rejects(() => service().importDatasetJsonl({ jsonl: '' }), 'EVALUATION_INPUT_INVALID');
  await rejects(() => service().importDatasetJsonl({ jsonl: '{"type":"case"}\n' }),
    'EVALUATION_JSONL_INVALID', { path: 'manifest.type' });
  const duplicate = records('asset-retrieval.jsonl');
  duplicate.push(structuredClone(duplicate[0]));
  await rejects(() => service().importDatasetJsonl({ jsonl: text(duplicate) }),
    'EVALUATION_JSONL_INVALID', { path: 'manifest.type' });
  const unknown = records('asset-retrieval.jsonl');
  unknown.push({ type: 'run', caseId: 'case-run' });
  await rejects(() => service().importDatasetJsonl({ jsonl: text(unknown) }),
    'EVALUATION_JSONL_INVALID', { line: 3, path: 'type' });
});
