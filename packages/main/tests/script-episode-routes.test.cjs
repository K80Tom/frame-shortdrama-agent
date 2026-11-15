const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { readConfig } = require('../dist/config');
const { createApp } = require('../dist/app');
const { InMemoryBreakdownRepository } = require('../dist/breakdown/repository');
const { BreakdownService } = require('../dist/breakdown/service');
const { ScriptParseService } = require('../dist/breakdown/script-parse');
const { parseScriptStructure } = require('@lyra/shared');

const rawText = `第1集

1-1 内景 钟表铺 日
老周：这块表。
林澈：十一年前了。`;

const modelOutput = {
  title: '第1集', synopsis: '',
  characters: [{ name: '林澈', aliases: [], description: '年轻人。', role: 'protagonist' }],
  locations: [{ name: '钟表铺', aliases: [], description: '' }],
  props: [],
  scenes: [{
    sceneHeading: '钟表铺', location: '钟表铺', timeOfDay: '日', intExt: '内', sceneDescription: '',
    elements: [{ type: 1, characterName: '林澈', parenthetical: '', content: '十一年前了。' }],
  }],
};

function config() {
  return { ...readConfig({}), baseUrl: 'https://stub.local', apiKey: 'test-key', defaultModel: 'parse-stub',
    reasoningEffort: 'model-default', maxOutputTokens: 8192, timeoutMs: 30000, connectionRevision: 'test-revision' };
}

function fakeAttemptDatabase() {
  const attempts = new Map();
  return {
    async query(sql, params) {
      if (/INSERT INTO script_parse_attempts/i.test(sql)) {
        const [id, projectId, scriptVersionId, model, promptVersion, inputDigest, commandId] = params;
        attempts.set(id, { id, project_id: projectId, script_version_id: scriptVersionId, model,
          prompt_version: promptVersion, input_digest: inputDigest, command_id: commandId,
          status: 'running', output_json: null, usage_json: null, error_code: null, provider_request_id: null,
          created_at: new Date().toISOString(), ended_at: null });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE script_parse_attempts/i.test(sql)) {
        const row = attempts.get(params[0]);
        if (!row) return { rows: [], rowCount: 0 };
        if (/status='succeeded'/.test(sql)) {
          row.status = 'succeeded';
          row.output_json = params[1] ? JSON.parse(params[1]) : null;
          row.usage_json = params[3] ? JSON.parse(params[3]) : null;
        } else {
          row.status = 'failed';
          row.error_code = params[1];
        }
        return { rows: [], rowCount: 1 };
      }
      if (/WHERE id=\$1 AND project_id=\$2/i.test(sql)) {
        const [id, projectId] = params;
        const row = attempts.get(id);
        return { rows: row && row.project_id === projectId ? [row] : [] };
      }
      if (/FROM script_parse_attempts/i.test(sql)) {
        const [projectId, commandId] = params;
        return { rows: [...attempts.values()].filter(item =>
          item.project_id === projectId && item.command_id === commandId) };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

async function boot() {
  let modelCalls = 0;
  const requests = [];
  const transport = async (_url, init) => {
    modelCalls += 1;
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      id: 'chatcmpl-test', model: 'parse-stub',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(modelOutput) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const breakdown = new BreakdownService(new InMemoryBreakdownRepository(), config(), {
    now: () => new Date('2026-10-01T08:00:00.000Z'),
    nextId: (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
  });
  const scriptParseService = new ScriptParseService(fakeAttemptDatabase(), breakdown, config(), transport, null);
  const app = await createApp(config(), fetch, { breakdownService: breakdown, scriptParseService });
  const request = (method, url, payload) => app.inject({ method, url,
    headers: { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:5173', 'x-shortdrama-call': '1' },
    ...(payload === undefined ? {} : { payload }) });
  const project = JSON.parse((await request('POST', '/api/projects', { title: '路由验证' })).body);
  const structure = parseScriptStructure(rawText);
  const script = JSON.parse((await request('POST', `/api/projects/${project.id}/script-versions`,
    { rawText, structure })).body);
  return { request, project, script, get modelCalls() { return modelCalls; }, requests };
}

test('解析路由：缺 allowPaid / 非法 commandId / 空原文被拒；成功使用弹窗 rawText 返回单集候选', async () => {
  const { request, project, script, requests } = await boot();
  const denied = await request('POST', `/api/projects/${project.id}/episodes/1/parse`,
    { commandId: 'cmd-no-paid', rawText: '一些文本。', overwriteConfirmed: true });
  assert.equal(denied.statusCode, 400);
  assert.equal(JSON.parse(denied.body).error.code, 'PAID_CALL_NOT_AUTHORIZED');

  const badCommand = await request('POST', `/api/projects/${project.id}/episodes/1/parse`,
    { commandId: '错误命令 id!', rawText: '一些文本。', overwriteConfirmed: true, allowPaid: true });
  assert.equal(badCommand.statusCode, 400);
  assert.equal(JSON.parse(badCommand.body).error.code, 'INVALID_COMMAND_ID');

  const emptyText = await request('POST', `/api/projects/${project.id}/episodes/1/parse`,
    { commandId: 'cmd-empty', rawText: '   ', overwriteConfirmed: true, allowPaid: true });
  assert.equal(emptyText.statusCode, 400);
  assert.equal(JSON.parse(emptyText.body).error.code, 'INVALID_SCRIPT_RAW_TEXT');

  const mismatch = await request('POST', `/api/projects/${project.id}/episodes/1/parse`,
    { commandId: 'cmd-mismatch', rawText: '一些文本。', episodeNumber: 2, overwriteConfirmed: true, allowPaid: true });
  assert.equal(mismatch.statusCode, 400);
  assert.equal(JSON.parse(mismatch.body).error.code, 'SCRIPT_EPISODE_MISMATCH');

  const pasted = '弹窗粘贴的新原文，不是已保存版本。';
  const ok = await request('POST', `/api/projects/${project.id}/episodes/1/parse`,
    { commandId: 'cmd-route-1', rawText: pasted, overwriteConfirmed: true, allowPaid: true, scriptVersionId: script.id });
  assert.equal(ok.statusCode, 201);
  const body = JSON.parse(ok.body);
  assert.equal(body.episodeNumber, 1);
  assert.equal(body.reused, false);
  assert.equal(body.characters[0].name, '林澈');
  assert.equal(requests[requests.length - 1].messages[1].content, pasted);
});

test('确认路由：缺 attemptId 被拒；勾选后基于解析草稿生成不可变新版本并返回校验结果', async () => {
  const { request, project, script } = await boot();
  const parsed = JSON.parse((await request('POST', `/api/projects/${project.id}/episodes/1/parse`,
    { commandId: 'cmd-route-confirm', rawText: '林澈：新台词。', overwriteConfirmed: true, allowPaid: true, scriptVersionId: script.id })).body);

  const missingAttempt = await request('POST', `/api/projects/${project.id}/episodes/1/confirm-entities`,
    { scriptVersionId: script.id, selections: [] });
  assert.equal(missingAttempt.statusCode, 400);

  const ok = await request('POST', `/api/projects/${project.id}/episodes/1/confirm-entities`, {
    scriptVersionId: script.id,
    attemptId: parsed.attemptId,
    selections: [{
      candidateId: 'candidate_1', kind: 'character', name: '林澈', aliases: [],
      description: '年轻人。', selected: true, renameTo: '林晨',
    }],
  });
  assert.equal(ok.statusCode, 201);
  const body = JSON.parse(ok.body);
  assert.notEqual(body.scriptVersion.id, script.id);
  assert.equal(body.scriptVersion.structure.episodes[0].scenes[0].dialogues[0].characterName, '林晨');
  assert.ok(body.check.check.id);
  assert.ok(body.plan.id);
});

test('迁移 057：command_id 幂等列与部分唯一索引；启动门禁同时要求 056 与 057', () => {
  const sql = readFileSync(join(__dirname, '../migrations/057_script_parse_command_id.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS command_id TEXT NULL/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*\(project_id, command_id\)[\s\S]*WHERE command_id IS NOT NULL/);
  const main = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');
  assert.match(main, /hasMigrations\(\['056', '057'\]\)/);
});
