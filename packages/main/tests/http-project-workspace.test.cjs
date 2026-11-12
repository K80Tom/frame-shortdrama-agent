const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const { InMemoryBreakdownRepository } = require('../dist/breakdown/repository');
const { BreakdownService } = require('../dist/breakdown/service');

const CONFIG = readConfig({});
// GET 只读路由不需要 X-Shortdrama-Call；这里故意不带该头。
const headers = { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:5173' };

async function setup() {
  const repository = new InMemoryBreakdownRepository();
  const breakdownService = new BreakdownService(repository, CONFIG);
  const app = await createApp(CONFIG, async () => new Response('{}'), { breakdownService });
  const request = (method, url) => app.inject({ method, url, headers });
  const project = await breakdownService.createProject({ title: 'HTTP 主链项目' });
  await breakdownService.createScriptVersion(project.id, { rawText: '第1场 走廊 夜 内\r\n林晚走进走廊。\r\n' });
  return { app, request, projectId: project.id };
}

test('workspace-overview：真实项目 200、未知项目 404 PROJECT_NOT_FOUND、GET 无需写令牌', async () => {
  const { request, projectId } = await setup();
  let response = await request('GET', `/api/projects/${projectId}/workspace-overview`);
  assert.equal(response.statusCode, 200, response.body);
  const body = JSON.parse(response.body);
  assert.equal(body.projectId, projectId);
  assert.equal(body.title, 'HTTP 主链项目');
  assert.equal(body.nextAction.id, 'start-breakdown');
  assert.equal(body.script.version, 1);
  assert.deepEqual(body.todos, []);
  assert.deepEqual(body.delivery, { available: false, artifactCount: 0, lastDeliveredAt: null });

  response = await request('GET', '/api/projects/project_nope/workspace-overview');
  assert.equal(response.statusCode, 404, response.body);
  assert.equal(JSON.parse(response.body).error.code, 'PROJECT_NOT_FOUND');
});

test('asset-requirements：无已采用事实返回零值 200；未知项目 404', async () => {
  const { request, projectId } = await setup();
  let response = await request('GET', `/api/projects/${projectId}/asset-requirements`);
  assert.equal(response.statusCode, 200, response.body);
  const body = JSON.parse(response.body);
  assert.equal(body.planRevisionId, null);
  assert.equal(body.ruleVersion, 'production-asset-match/5');
  assert.deepEqual(body.summary, { total: 0, matched: 0, missing: 0, ambiguous: 0 });

  response = await request('GET', '/api/projects/project_nope/asset-requirements');
  assert.equal(response.statusCode, 404, response.body);
  assert.equal(JSON.parse(response.body).error.code, 'PROJECT_NOT_FOUND');
});
