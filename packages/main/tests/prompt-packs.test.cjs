const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { PromptPackService } = require('../dist/prompt-packs/service');
const { methodReference } = require('../dist/prompt-packs/runtime');
const { ProductionService } = require('../dist/production/service');
const { MemoryProductionRepository } = require('../dist/production/repository');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const { StoryboardService } = require('../dist/breakdown/storyboard');

function makeRoot({ withLibraryPack = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'lyra-packs-'));
  mkdirSync(path.join(root, 'packs'), { recursive: true });
  if (withLibraryPack) {
    const dir = path.join(root, 'packs', 'sample-pack');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
      id: 'sample-pack',
      name: '示例包',
      version: '1.0.0',
      summary: '内置示例',
      stages: ['script-review'],
      models: [],
      license: 'MIT',
      quality: 'unevaluated',
      enabledByDefault: false,
      entry: 'SKILL.md',
    }));
    writeFileSync(path.join(dir, 'SKILL.md'), '# 示例方法\n正文');
  }
  return root;
}

function memoryRepos(seed = []) {
  const states = new Map();
  const imports = [...seed];
  return {
    states: {
      async all() {
        return [...states.entries()].map(([packId, enabled]) => ({ packId, enabled, updatedAt: '2026-01-01T00:00:00.000Z' }));
      },
      async save(packId, enabled) {
        states.set(packId, enabled);
        return { packId, enabled, updatedAt: '2026-01-01T00:00:00.000Z' };
      },
    },
    imports: {
      async all() { return imports; },
      async find(id) { return imports.find((row) => row.id === id) ?? null; },
      async create(row) {
        const record = { ...row, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
        imports.push(record);
        return record;
      },
    },
  };
}

test('HTTP toggles govern new runs and manual storyboard model requests, with immutable private excerpts', async t => {
  const repos = memoryRepos();
  const packs = new PromptPackService(repos.states, repos.imports, makeRoot({ withLibraryPack: true }));
  const runs = new MemoryProductionRepository();
  const production = new ProductionService(runs, { methodPacks: project => packs.freeze(project) });
  const config = readConfig({ LLM_API_KEY: 'test-key', LLM_BASE_URL: 'https://model.test/openai' });
  const requests = [];
  const storyboards = new StoryboardService({ query: async () => ({ rows: [] }) }, {
    getProject: async () => ({ activePlanRevisionId: 'plan_test', currentScriptVersionId: 'script_test' }),
    getPlanRevision: async () => ({ id: 'plan_test', scriptVersionId: 'script_test',
      content: { synopsis: null, characters: [], locations: [], props: [], scenes: [], dialogues: [] } }),
  }, config, async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response('', { status: 400 }); // End the bounded request before saving a generated revision.
  });
  const app = await createApp(config, fetch, { promptPacksService: packs, productionService: production, storyboardService: storyboards });
  t.after(() => app.close());
  const headers = { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:5173', 'x-shortdrama-call': '1' };
  const post = (url, payload) => app.inject({ method: 'POST', url, payload, headers });
  const toggle = async (id, enabled) => assert.equal((await post('/api/prompt-packs/' + id + '/state', { enabled })).statusCode, 200);
  const payload = { projectId: 'project_test', scriptVersionId: 'script_test', ratio: '9:16', targetDurationSec: 60,
    visualStyle: '写实', qualityPreset: 'balanced', automationMode: 'auto', candidatePolicy: 'direct', candidateLimit: 1,
    directorPolicy: 'auto', budgetMicros: 5_000_000, currency: 'CNY', allowPaid: true, clientRequestId: 'freeze-test' };
  const created = await post('/api/prompt-packs/import', { id: 'custom', name: '分镜方法', stages: ['storyboard'], content: 'FRAME_METHOD' });
  assert.equal(created.statusCode, 201);
  await toggle('custom', true); await toggle('sample-pack', true);
  const response = await post('/api/production-runs', payload);
  assert.equal(response.statusCode, 202);
  assert.doesNotMatch(response.body, /FRAME_METHOD|# 示例方法/);
  const frozen = await runs.get(response.json().id);
  assert.match(methodReference(frozen.methodPacks, 'storyboard'), /FRAME_METHOD/);
  assert.doesNotMatch(methodReference(frozen.methodPacks, 'storyboard'), /示例方法/);
  assert.match(methodReference(frozen.methodPacks, 'breakdown'), /示例方法/);
  const first = await post('/api/projects/project_test/storyboards', { allowPaid: true });
  assert.equal(requests.length, 1, first.body);
  assert.match(requests[0].messages[1].content, /FRAME_METHOD/);
  assert.doesNotMatch(requests[0].messages[0].content, /FRAME_METHOD/);
  await toggle('custom', false);
  await post('/api/projects/project_test/storyboards', { allowPaid: true });
  assert.doesNotMatch(requests[1].messages[1].content, /FRAME_METHOD/);
  const replay = await post('/api/production-runs', payload);
  assert.equal(replay.json().id, frozen.id);
  assert.match(methodReference((await runs.get(frozen.id)).methodPacks, 'storyboard'), /FRAME_METHOD/);
  const fresh = await production.create({ ...payload, clientRequestId: 'freeze-test-next' });
  assert.equal(methodReference((await runs.get(fresh.id)).methodPacks, 'storyboard'), '');
  assert.equal(methodReference(undefined, 'video'), '');
});

test('adaptation targets only adapted material, topic is browse-only, and selection is bounded', async () => {
  const repos = memoryRepos();
  const packs = new PromptPackService(repos.states, repos.imports, makeRoot());
  const add = (id, stages, content = id) => packs.importPack({ id, name: id, stages, content });
  await add('adapted', ['adaptation'], '🙂'.repeat(4000)); await packs.setState('adapted', true);
  assert.deepEqual(await packs.freeze(), []);
  const adapted = await packs.freeze({ source: { kind: 'novelAdaptation' } });
  assert.equal(adapted.length, 1); assert.ok(adapted[0].excerpt.length <= 4000);
  assert.equal(adapted[0].excerpt.isWellFormed(), true);
  await add('topic-only', ['topic']);
  await assert.rejects(packs.setState('topic-only', true), { code: 'PROMPT_PACK_NO_NODE' });
  for (let i = 0; i < 9; i++) {
    await add('shot-' + i, ['storyboard']); await packs.setState('shot-' + i, true);
  }
  await assert.rejects(packs.freeze(), { code: 'PROMPT_PACK_STAGE_LIMIT' });
  assert.deepEqual(await packs.freeze(undefined, 'video'), []);
});

test('自己导入的方法默认关闭，并出现在列表里', async () => {
  const repos = memoryRepos();
  const service = new PromptPackService(repos.states, repos.imports, makeRoot());

  const result = await service.importPack({
    name: '我的三幕反转法',
    stages: ['script', 'script-review'],
    summary: '三幕结构 + 反转钩子',
    content: '# 三幕反转法\n第一幕建立，第二幕加压，第三幕反转。',
  });

  assert.match(result.id, /^[a-z0-9-]{1,80}$/u);
  assert.equal(result.stages.length, 2);

  const list = await service.list();
  assert.equal(list.total, 1);
  assert.equal(list.packs[0].origin, 'imported');
  assert.equal(list.packs[0].enabled, false);
  assert.equal(list.packs[0].source, '本机导入');
});

test('导入的正文可按需读取，并能单独启停', async () => {
  const repos = memoryRepos();
  const service = new PromptPackService(repos.states, repos.imports, makeRoot());
  const imported = await service.importPack({ name: 'Hook Pack', stages: ['script'], content: '正文内容' });

  const content = await service.content(imported.id);
  assert.equal(content.content, '正文内容');
  assert.equal(content.origin, 'imported');

  const saved = await service.setState(imported.id, true);
  assert.equal(saved.enabled, true);
  const list = await service.list();
  assert.equal(list.packs[0].enabled, true);
});

test('同名方法包自动追加序号，指定标识冲突时报 409', async () => {
  const repos = memoryRepos();
  const service = new PromptPackService(repos.states, repos.imports, makeRoot());
  const first = await service.importPack({ name: 'Hook Pack', stages: ['script'], content: 'a' });
  const second = await service.importPack({ name: 'Hook Pack', stages: ['script'], content: 'b' });
  assert.equal(first.id, 'self-hook-pack');
  assert.equal(second.id, 'self-hook-pack-2');

  const reposWithPack = memoryRepos();
  const root = makeRoot({ withLibraryPack: true });
  const service2 = new PromptPackService(reposWithPack.states, reposWithPack.imports, root);
  await assert.rejects(
    () => service2.importPack({ id: 'sample-pack', name: '撞名', stages: ['script'], content: 'x' }),
    (error) => error.status === 409 && error.code === 'PROMPT_PACK_ID_TAKEN',
  );
});

test('导入参数做完整校验', async () => {
  const repos = memoryRepos();
  const service = new PromptPackService(repos.states, repos.imports, makeRoot());
  const invalid = [
    [{ stages: ['script'], content: 'x' }, '缺少名称'],
    [{ name: '', stages: ['script'], content: 'x' }, '名称不能为空'],
    [{ name: 'x', stages: [], content: 'x' }, '阶段'],
    [{ name: 'x', stages: ['unknown'], content: 'x' }, '不受支持'],
    [{ name: 'x', stages: ['script'], content: '   ' }, '正文不能为空'],
  ];
  for (const [body] of invalid) {
    await assert.rejects(() => service.importPack(body), (error) => error.status === 400);
  }
});

test('内置包与新导入包共存，各自按需读取', async () => {
  const repos = memoryRepos();
  const root = makeRoot({ withLibraryPack: true });
  const service = new PromptPackService(repos.states, repos.imports, root);

  const imported = await service.importPack({ name: 'Self Pack', stages: ['script'], content: '自己写的' });
  const list = await service.list();
  assert.equal(list.total, 2);
  assert.ok(list.packs.some((pack) => pack.origin === 'library'));
  assert.ok(list.packs.some((pack) => pack.origin === 'imported'));

  const library = await service.content('sample-pack');
  assert.equal(library.origin, 'library');
  assert.match(library.content, /示例方法/);
  const own = await service.content(imported.id);
  assert.equal(own.content, '自己写的');
});
