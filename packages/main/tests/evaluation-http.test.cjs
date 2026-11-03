const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { MemoryEvaluationRepository } = require('../dist/evaluation/repository');
const { EvaluationService } = require('../dist/evaluation/service');
const { parseDatasetJsonl } = require('../dist/evaluation/jsonl');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');

const fixtures = join(__dirname, '../fixtures/evaluation');
const read = name => readFileSync(join(fixtures, name), 'utf8');
const document = parseDatasetJsonl(read('novel-breakdown.jsonl'));
const body = { kind: document.manifest.kind, title: document.manifest.title, description: document.manifest.description,
  note: document.manifest.note, contentSummary: document.manifest.contentSummary, slices: document.manifest.slices,
  tags: document.manifest.tags, authorization: document.manifest.authorization,
  sensitivity: document.manifest.sensitivity, provenance: document.manifest.provenance, cases: document.cases };

test('HTTP 评测目录：创建、冻结、追加失败、JSONL 导入导出与引用登记可定位', async t => {
  const evaluation = new EvaluationService(new MemoryEvaluationRepository());
  const config = readConfig({ LLM_API_KEY: 'test-key', LLM_BASE_URL: 'https://model.test/openai' });
  const app = await createApp(config, fetch, { evaluationService: evaluation });
  t.after(() => app.close());
  const headers = { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:5173', 'x-shortdrama-call': '1' };
  const post = (url, payload) => app.inject({ method: 'POST', url, payload, headers });
  const get = url => app.inject({ method: 'GET', url, headers });

  const created = await post('/api/evaluation/datasets', body);
  assert.equal(created.statusCode, 200);
  const dataset = created.json();
  assert.equal(dataset.cases.length, 2);

  const list = await get('/api/evaluation/datasets');
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items.length, 1);

  const frozen = await post(`/api/evaluation/datasets/${dataset.revision.datasetId}/revisions/${dataset.revision.id}/freeze`,
    { expectedDigest: dataset.revision.digest, reason: 'HTTP 冻结' });
  assert.equal(frozen.statusCode, 200);
  assert.equal(frozen.json().revision.status, 'frozen');

  const extra = structuredClone(document.cases[0]);
  extra.caseId = 'case-http-extra';
  extra.input.segments[0].text = `${extra.input.segments[0].text}（HTTP 追加）`;
  const blocked = await post(`/api/evaluation/datasets/${dataset.revision.datasetId}/revisions/${dataset.revision.id}/cases`,
    { expectedDigest: dataset.revision.digest, cases: [extra] });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error.code, 'EVALUATION_REVISION_IMMUTABLE');

  const next = await post(`/api/evaluation/datasets/${dataset.revision.datasetId}/revisions`,
    { baseRevisionId: dataset.revision.id, expectedDigest: dataset.revision.digest, reason: 'HTTP 派生' });
  assert.equal(next.statusCode, 200);
  assert.equal(next.json().revision.revision, 2);
  const appended = await post(`/api/evaluation/datasets/${dataset.revision.datasetId}/revisions/${next.json().revision.id}/cases`,
    { expectedDigest: next.json().revision.digest, cases: [extra] });
  assert.equal(appended.statusCode, 200);
  assert.equal(appended.json().revision.caseCount, 3);
  const nextFrozen = await post(`/api/evaluation/datasets/${dataset.revision.datasetId}/revisions/${next.json().revision.id}/freeze`,
    { expectedDigest: appended.json().revision.digest, reason: 'HTTP 派生冻结' });
  assert.equal(nextFrozen.statusCode, 200);
  const deprecated = await post(`/api/evaluation/datasets/${dataset.revision.datasetId}/revisions/${next.json().revision.id}/deprecate`,
    { expectedDigest: nextFrozen.json().revision.digest, reason: 'HTTP 废弃' });
  assert.equal(deprecated.statusCode, 200);
  assert.equal(deprecated.json().status, 'deprecated');

  const exported = await get(`/api/evaluation/datasets/${dataset.revision.datasetId}/revisions/${dataset.revision.id}/export`);
  assert.equal(exported.statusCode, 200);
  assert.match(exported.json().jsonl, /"type":"manifest"/u);
  assert.equal(exported.json().contentDigest, dataset.revision.contentDigest);

  const rubricImported = await post('/api/evaluation/rubrics/import', { jsonl: read('shot-review-rubric.jsonl') });
  assert.equal(rubricImported.statusCode, 200);
  const rubric = rubricImported.json();
  const rubricFrozen = await post(`/api/evaluation/rubrics/${rubric.revision.rubricId}/revisions/${rubric.revision.id}/freeze`,
    { expectedDigest: rubric.revision.digest, reason: 'HTTP 量表冻结' });
  assert.equal(rubricFrozen.statusCode, 200);

  const importedShot = await post('/api/evaluation/datasets/import', { jsonl: read('shot-review.jsonl') });
  assert.equal(importedShot.statusCode, 200);
  assert.equal(importedShot.json().cases[0].input.rubric.digest, rubric.revision.digest);

  const usage = await post('/api/evaluation/usages', { revisionKind: 'dataset', revisionId: dataset.revision.id,
    usageKind: 'evaluation_run', usageRef: 'http-run-001', note: '端到端引用' });
  assert.equal(usage.statusCode, 200);
  const draft = await post('/api/evaluation/datasets/import', { jsonl: read('asset-retrieval.jsonl') });
  assert.equal(draft.statusCode, 200);
  const draftUsage = await post('/api/evaluation/usages', { revisionKind: 'dataset',
    revisionId: draft.json().revision.id, usageKind: 'evaluation_run', usageRef: 'http-run-002' });
  assert.equal(draftUsage.statusCode, 409);
  assert.equal(draftUsage.json().error.code, 'EVALUATION_REVISION_NOT_BINDABLE');

  const invalid = parseDatasetJsonl(read('novel-breakdown.jsonl'));
  const invalidLine = JSON.parse(read('novel-breakdown.jsonl').trim().split('\n')[1]);
  delete invalidLine.title;
  const badJsonl = `${JSON.stringify(invalid.manifest)}\n${JSON.stringify(invalidLine)}\n`;
  const bad = await post('/api/evaluation/datasets/import', { jsonl: badJsonl });
  assert.equal(bad.statusCode, 400);
  const error = bad.json().error;
  assert.equal(error.code, 'EVALUATION_JSONL_INVALID');
  assert.ok(error.details.some(item => item.line === 2 && item.caseId === 'case-novel-001' && item.path === 'case.title'));
  assert.doesNotMatch(bad.body, /CAST|SQL|stack/iu);
});

test('HTTP 参数错误返回 400 且不落库，未注入 Service 时不暴露评测路由', async t => {
  const evaluation = new EvaluationService(new MemoryEvaluationRepository());
  const config = readConfig({ LLM_API_KEY: 'test-key', LLM_BASE_URL: 'https://model.test/openai' });
  const app = await createApp(config, fetch, { evaluationService: evaluation });
  t.after(() => app.close());
  const headers = { host: '127.0.0.1:8788', 'x-shortdrama-call': '1' };
  const response = await app.inject({ method: 'POST', url: '/api/evaluation/datasets', headers,
    payload: { kind: 'novel_breakdown' } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'EVALUATION_INPUT_INVALID');
  assert.ok(response.json().error.details.length > 0);
  assert.equal((await evaluation.listDatasets()).items.length, 0);

  const without = await createApp(config, fetch, {});
  t.after(() => without.close());
  const missing = await without.inject({ method: 'GET', url: '/api/evaluation/datasets',
    headers: { host: '127.0.0.1:8788' } });
  assert.equal(missing.statusCode, 404);
});
