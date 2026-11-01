const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const { readDatabaseConfig } = require('../dist/db/config');
const { InMemoryBreakdownRepository } = require('../dist/breakdown/repository');
const { BreakdownService, canonicalJsonSha256 } = require('../dist/breakdown/service');
const { reconstructSource, validateScriptSourceIndex } = require('../dist/breakdown/source-index');

const config = readConfig({});

function createService() {
  let ordinal = 0;
  return new BreakdownService(new InMemoryBreakdownRepository(), config, {
    now: () => new Date('2026-10-01T08:00:00.000Z'),
    nextId: (prefix) => `${prefix}_${String(++ordinal).padStart(4, '0')}`,
  });
}

test('P0.2 database configuration is optional for model-only mode and fails closed to local PostgreSQL', () => {
  assert.equal(readDatabaseConfig({}), null);
  const local = readDatabaseConfig({
    DATABASE_URL: 'postgresql://shortdrama:localpassword@127.0.0.1:5432/shortdrama_agent',
  });
  assert.equal(local.connectionString, 'postgresql://shortdrama:localpassword@127.0.0.1:5432/shortdrama_agent');
  for (const DATABASE_URL of [
    'postgresql://shortdrama:password@db.example.com:5432/shortdrama_agent',
    'postgresql://shortdrama:password@localhost:5432/shortdrama_agent',
    'postgresql://shortdrama:password@127.0.0.1:5432/shortdrama_agent?sslmode=require',
    'https://shortdrama:password@127.0.0.1:5432/shortdrama_agent',
  ]) assert.throws(() => readDatabaseConfig({ DATABASE_URL }));
});

test('P0.2 persists a lossless source index and creates only a draft extractFacts task', async () => {
  const service = createService();
  const project = await service.createProject({ title: '医院走廊试拆' });
  const rawText = [
    '《😀夜戏》',
    '',
    '第1场 医院走廊 夜 内',
    '林晚：你终于来了。',
    '顾沉：我一直在等。',
  ].join('\r\n') + '\r\n';

  const script = await service.createScriptVersion(project.id, { rawText });
  assert.equal(script.version, 1);
  assert.equal(script.sourceIndex.scriptVersion.id, script.id);
  assert.equal(reconstructSource(script.sourceIndex), rawText);
  validateScriptSourceIndex(script.sourceIndex);

  const listed = await service.listScriptVersions(project.id);
  assert.deepEqual(listed, [{
    id: script.id,
    projectId: project.id,
    version: 1,
    contentSha256: script.contentSha256,
    createdAt: '2026-10-01T08:00:00.000Z',
    sourceIndex: {
      schemaVersion: 'script-source-index/1',
      unitCount: script.sourceIndex.units.length,
      spanCount: script.sourceIndex.spans.length,
      blockCount: script.sourceIndex.blocks.length,
    },
  }]);

  const requirements = {
    language: '中文',
    visualStyle: '真人拟真',
    aspectRatio: '9:16',
    targetDurationSeconds: { min: 60, max: 120 },
  };
  const run = await service.createDraftRun(project.id, {
    requirements,
    maxModelCalls: 2,
    maxOutputTokens: 4096,
  });

  assert.equal(run.target, 'breakdown');
  assert.equal(run.status, 'draft');
  assert.equal(run.sealedAt, null);
  assert.deepEqual(run.modelConfig, {
    provider: 'maas', model: 'deepseek-v4.1-flash-1017', reasoningEffort: 'model-default',
  });
  assert.deepEqual(run.humanCheckpoints, ['candidatePlanReview']);
  assert.equal(run.task.type, 'extractFacts');
  assert.equal(run.task.state, 'pending');
  assert.equal(run.task.maxModelCalls, 2);
  assert.equal(run.task.maxOutputTokens, 4096);
  assert.deepEqual(run.task.inputManifest, {
    schemaVersion: 'breakdown-input-manifest/1',
    sourceIndexSchemaVersion: 'script-source-index/1',
    entries: [
      {
        kind: 'script', id: script.id, revisionId: script.id,
        fields: ['rawText', 'sourceIndex'], digest: script.contentSha256,
      },
      {
        kind: 'requirements', id: run.id, revisionId: run.id,
        fields: ['*'], digest: canonicalJsonSha256(requirements),
      },
    ],
  });

  // Repository reads are snapshots: caller mutation must not alter persisted work.
  run.requirements.language = 'mutated';
  const reread = await service.getRun(run.id);
  assert.equal(reread.requirements.language, '中文');
  assert.equal(reread.task.state, 'pending');
});

test('P0.2 local HTTP routes create drafts without calling a model and reject malformed input', async () => {
  const service = createService();
  let modelCalls = 0;
  const app = await createApp(config, async () => {
    modelCalls += 1;
    throw new Error('The draft workflow must never call a model');
  }, { breakdownService: service });
  const server = app.getHttpAdapter().getInstance();
  const headers = { host: '127.0.0.1:8788', 'x-shortdrama-call': '1' };
  try {
    const projectResponse = await server.inject({
      method: 'POST', url: '/api/projects', headers, payload: { title: 'HTTP P0.2' },
    });
    assert.equal(projectResponse.statusCode, 201);
    const project = projectResponse.json();

    const badScript = await server.inject({
      method: 'POST', url: `/api/projects/${project.id}/script-versions`, headers, payload: { rawText: '   ' },
    });
    assert.equal(badScript.statusCode, 400);
    assert.equal(badScript.json().error.code, 'INVALID_BREAKDOWN_REQUEST');

    const scriptResponse = await server.inject({
      method: 'POST', url: `/api/projects/${project.id}/script-versions`, headers,
      payload: { rawText: '第1场 天台 夜 外\n林晚：现在就结束。' },
    });
    assert.equal(scriptResponse.statusCode, 201);
    const script = scriptResponse.json();
    assert.equal(typeof script.rawText, 'undefined');
    assert.equal(script.sourceIndex.schemaVersion, 'script-source-index/1');

    const listResponse = await server.inject({
      method: 'GET', url: `/api/projects/${project.id}/script-versions`, headers,
    });
    assert.equal(listResponse.statusCode, 200);
    assert.equal(listResponse.json().items[0].id, script.id);

    const badRun = await server.inject({
      method: 'POST', url: `/api/projects/${project.id}/breakdown-runs`, headers,
      payload: { maxModelCalls: 1, maxOutputTokens: 4096, unexpected: true },
    });
    assert.equal(badRun.statusCode, 400);

    const runResponse = await server.inject({
      method: 'POST', url: `/api/projects/${project.id}/breakdown-runs`, headers,
      payload: {
        scriptVersionId: script.id,
        requirements: { language: '中文', targetDurationSeconds: { min: 60, max: 120 } },
        modelConfig: { model: 'deepseek-v4.1-flash-1017', reasoningEffort: 'model-default' },
        maxModelCalls: 1,
        maxOutputTokens: 4096,
      },
    });
    assert.equal(runResponse.statusCode, 201);
    const run = runResponse.json();
    assert.equal(run.status, 'draft');
    assert.equal(run.task.type, 'extractFacts');
    assert.equal(run.modelConfig.reasoningEffort, 'model-default');

    const fetched = await server.inject({ method: 'GET', url: `/api/breakdown-runs/${run.id}`, headers });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.json().task.inputManifest.entries[0].id, script.id);
    assert.equal(modelCalls, 0);
  } finally {
    await app.close();
  }
});

test('the default app keeps persistence routes safely unavailable until a repository is configured', async () => {
  const app = await createApp(config, async () => new Response('{}'));
  const server = app.getHttpAdapter().getInstance();
  try {
    const response = await server.inject({
      method: 'POST', url: '/api/projects',
      headers: { host: '127.0.0.1:8788', 'x-shortdrama-call': '1' },
      payload: { title: 'No database yet' },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'PERSISTENCE_UNAVAILABLE');
  } finally {
    await app.close();
  }
});
