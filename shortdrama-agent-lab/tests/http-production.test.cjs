const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const { InMemoryBreakdownRepository } = require('../dist/breakdown/repository');
const { BreakdownService } = require('../dist/breakdown/service');

test('local browser can use production routes; paid stages require explicit opt-in', async () => {
  const config = readConfig({});
  const service = new BreakdownService(new InMemoryBreakdownRepository(), config);
  let factCalls = 0;
  let boardCalls = 0;
  const app = await createApp(config, fetch, { breakdownService: service,
    stageRunner: { async run(id) { factCalls++; return { invokedRunId: id }; } },
    storyboardService: { async generate(id) { boardCalls++; return { invokedProjectId: id }; } },
  });
  const request = (method, url, payload) => app.inject({ method, url,
    headers: { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:5173',
      'x-shortdrama-call': '1' }, ...(payload === undefined ? {} : { payload }) });
  try {
    const source = { url: 'https://www.qidian.com/chapter/1049358005/906767983/' };
    const project = JSON.parse((await request('POST', '/api/projects', { title: '本地验证', source })).body);
    assert.ok(project.id);
    assert.deepEqual(project.source, source);
    assert.equal(JSON.parse((await request('GET', `/api/projects/${project.id}`)).body).source.url, source.url);
    assert.equal((await request('POST', '/api/projects', { title: '错误链接', source: { url: 'http://example.com/' } })).statusCode, 400);
    assert.equal((await request('GET', '/api/projects')).statusCode, 200);
    assert.equal((await request('POST', `/api/projects/${project.id}/script-versions`, {
      rawText: '第1场 走廊 夜 内\n林晚：你好。',
    })).statusCode, 201);
    const run = JSON.parse((await request('POST', `/api/projects/${project.id}/breakdown-runs`, {
      maxModelCalls: 1, maxOutputTokens: 4096,
    })).body);
    assert.equal((await request('POST', `/api/breakdown-runs/${run.id}/execute`, {})).statusCode, 400);
    assert.equal(factCalls, 0);
    assert.equal((await request('POST', `/api/breakdown-runs/${run.id}/execute`, { allowPaid: true })).statusCode, 201);
    assert.equal(factCalls, 1);
    assert.equal((await request('POST', `/api/projects/${project.id}/storyboards`, {})).statusCode, 400);
    assert.equal(boardCalls, 0);
    assert.equal((await request('POST', `/api/projects/${project.id}/storyboards`, { allowPaid: true })).statusCode, 201);
    assert.equal(boardCalls, 1);
  } finally { await app.close(); }
});

test('paid extract-facts stays closed when the stage runner is not ready', async () => {
  const config = readConfig({});
  const service = new BreakdownService(new InMemoryBreakdownRepository(), config);
  const app = await createApp(config, async () => { throw new Error('must not call a provider'); }, { breakdownService: service });
  const request = (method, url, payload) => app.inject({ method, url,
    headers: { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:5173', 'x-shortdrama-call': '1' },
    payload });
  try {
    const project = JSON.parse((await request('POST', '/api/projects', { title: '未迁移账本' })).body);
    await request('POST', `/api/projects/${project.id}/script-versions`, { rawText: '第1场 走廊 夜 内\n林晚：你好。' });
    const run = JSON.parse((await request('POST', `/api/projects/${project.id}/breakdown-runs`, {
      maxModelCalls: 1, maxOutputTokens: 4096,
    })).body);
    const blocked = await request('POST', `/api/breakdown-runs/${run.id}/execute`, { allowPaid: true });
    assert.equal(blocked.statusCode, 503);
    assert.equal(blocked.json().error.code, 'STAGE_RUNNER_UNAVAILABLE');
    assert.match(blocked.json().error.message, /017/);
    assert.equal(blocked.body.includes('response_json'), false);
  } finally { await app.close(); }
});
