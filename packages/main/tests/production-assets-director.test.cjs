const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');
const { AssetService } = require('../dist/assets/service');
const { InMemoryAssetRepository } = require('../dist/assets/repository');
const { readConfig } = require('../dist/config');
const { compileProductionRun } = require('../dist/production/blueprint');
const { AssetsProductionExecutor } = require('../dist/production/executors/assets');
const { HybridAssetRetriever } = require('../dist/assets/vector/hybrid');
const { retrieveAssetForGeneration, tokenizeAssetQuery, ASSET_RETRIEVAL_THRESHOLD } = require('../dist/assets/retrieval');
const { DirectorProductionExecutor, buildDirectorSnapshot, directorDecision } = require('../dist/production/executors/director');

const PROJECT = `project_${'1'.repeat(32)}`;
const SCRIPT = `script_${'2'.repeat(32)}`;
const PLAN = `plan_${'3'.repeat(32)}`;
const BOARD = `storyboard_${'4'.repeat(32)}`;

function source(quote, start = 0) {
  return { scriptVersionId: SCRIPT, start, end: start + quote.length, quote };
}
function text(value, ref = source(value)) {
  return { value, origin: 'source', sourceRefs: [ref], answerIds: [] };
}
function entity(id, name, aliases = [], description = `${name}的剧本设定`, start = 0) {
  const ref = source(`${name}出现`, start);
  return { id, name: text(name, ref), aliases: aliases.map(alias => text(alias, ref)),
    description: text(description, ref), sourceRefs: [ref] };
}
function plan() {
  const hero = entity('character_hero', '沈玥', ['小玥'], '年轻女警，穿深色风衣', 10);
  const location = entity('location_alley', '雨巷', [], '狭长湿滑的夜间巷道', 20);
  const prop = entity('prop_phone', '手机', [], '屏幕碎裂的黑色手机', 20);
  const sceneRef = source('雨巷里，沈玥捡起手机。', 10);
  return { id: PLAN, projectId: PROJECT, scriptVersionId: SCRIPT, runId: 'run_source', sourceTaskId: 'task_source',
    attemptId: 'attempt_source', parentRevisionId: null, rebasedFromRevisionId: null,
    createdAt: '2026-10-23T00:00:00.000Z', createdBy: 'agent', reason: 'extract',
    scope: { kind: 'project', targetId: null }, requirements: {}, status: 'candidate', validatorVersion: 'extract-facts-validator/1',
    content: { schemaVersion: 'breakdown-plan-content/1', synopsis: null,
      characters: [hero], locations: [location], props: [prop], dialogues: [], assetRequirements: [], manualLocks: [],
      scenes: [{ id: 'scene_one', order: 1, title: text('雨巷夜景', sceneRef), locationId: location.id,
        characterIds: [hero.id], sourceRefs: [sceneRef], timeOfDay: text('夜', sceneRef), shots: [] }] } };
}
function board() {
  const ref = source('雨巷里，沈玥捡起手机。', 10);
  return { id: BOARD, projectId: PROJECT, scriptVersionId: SCRIPT, sourcePlanRevisionId: PLAN,
    attemptId: 'sbattempt_test', inputDigest: 'digest', promptVersion: 'storyboard-design/1', model: 'test',
    providerRequestId: null, usage: null, createdAt: '2026-10-23T00:01:00.000Z', shots: [
      { id: 'shot_simple', sceneId: 'scene_one', order: 1, design: { origin: 'designSuggestion',
        visualDescription: '沈玥站在巷口观察', shotSize: '中景', cameraMovement: '固定', durationMs: 3000 },
        sourceRefs: [ref], dialogueIds: [] },
      { id: 'shot_complex', sceneId: 'scene_one', order: 2, design: { origin: 'designSuggestion',
        visualDescription: '沈玥奔跑穿过巷道后转身', shotSize: '全景', cameraMovement: '环绕跟拍', durationMs: 9000 },
        sourceRefs: [ref], dialogueIds: [] },
    ] };
}
function project() {
  return { id: PROJECT, title: '测试短剧', source: null, currentScriptVersionId: SCRIPT,
    activePlanRevisionId: PLAN, activeStoryboardRevisionId: BOARD, createdAt: '2026-10-23T00:00:00.000Z' };
}
function production(overrides = {}) {
  return compileProductionRun({ projectId: PROJECT, scriptVersionId: SCRIPT, ratio: '9:16', targetDurationSec: 60,
    visualStyle: '写实雨夜，冷色电影感', qualityPreset: 'balanced', automationMode: 'auto', candidatePolicy: 'gacha', candidateLimit: 2,
    directorPolicy: 'auto', budgetMicros: 20_000_000, currency: 'CNY', allowPaid: true,
    clientRequestId: 'asset-director-test', ...overrides }, '2026-10-23T00:00:00.000Z', `production_${'5'.repeat(32)}`);
}
function readers() {
  const p = plan(); const b = board();
  return { breakdown: { async getProject() { return structuredClone(project()); },
      async getPlanRevision(id) { assert.equal(id, PLAN); return structuredClone(p); } },
    storyboards: { async get(id) { assert.equal(id, BOARD); return structuredClone(b); } }, plan: p, board: b };
}
function context(run, task, prepared) {
  return { run, task, attemptId: 'pattempt_test', inputDigest: prepared?.inputDigest ?? 'input',
    operationKey: prepared?.requiresPaid ? 'operation' : null };
}
function scopedTask(run, stage, scope) {
  const base = run.tasks.find(item => item.stage === stage);
  return { ...structuredClone(base), id: `ptask_${stage}_${scope.kind}_${scope.id ?? 'episode'}`,
    scope, inputManifest: structuredClone(base.inputManifest) };
}
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const output = Buffer.alloc(data.length + 12); output.writeUInt32BE(data.length); body.copy(output, 4);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4); return output;
}
function png() {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 30, 40, 50, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
}
function config(changes = {}) {
  return { ...readConfig({}), endpointUrl: 'https://image.test/v1/images/generations', defaultModel: 'image-test',
    apiKey: 'test-key', authType: 'bearer', timeoutMs: 10_000, connectionRevision: 'image-r1', ...changes };
}

test('episode asset matching is exact and expands only genuinely missing entities', async () => {
  const r = readers(); const assets = new AssetService(new InMemoryAssetRepository());
  await assets.create({ kind: 'character', name: '小玥', description: '已有角色资产', resourceUrl: 'https://assets.test/hero.png' });
  const executor = new AssetsProductionExecutor({ ...r, assets, config: config(), imageClientFactory: () => ({
    async generateImage() { throw new Error('must not generate in episode coordinator'); },
  }) });
  const run = production(); const task = run.tasks.find(item => item.stage === 'assets');
  const prepared = await executor.prepare({ run, task });
  assert.equal(prepared.requiresPaid, false);
  const outcome = await executor.execute(context(run, task));
  assert.equal(outcome.state, 'succeeded');
  assert.equal(outcome.spawnTasks.length, 2);
  assert.deepEqual(outcome.spawnTasks.map(item => item.scope.id).sort(), ['location_alley', 'prop_phone']);
  const binding = outcome.artifacts[0].metadata.bindings.find(item => item.entityId === 'character_hero');
  assert.equal(binding.matchedBy, 'alias');
});
test('same-priority asset matches block every asset entry point without generating another asset', async () => {
  const r = readers(); const assets = new AssetService(new InMemoryAssetRepository()); let calls = 0;
  const first = await assets.create({ kind: 'character', name: '沈玥', description: '角色候选 A',
    resourceUrl: 'https://assets.test/hero-a.png' });
  const second = await assets.create({ kind: 'character', name: '沈 玥', description: '角色候选 B',
    resourceUrl: 'https://assets.test/hero-b.png' });
  await assets.create({ kind: 'location', name: '雨巷', description: '测试', resourceUrl: 'https://assets.test/location.png' });
  await assets.create({ kind: 'prop', name: '手机', description: '测试', resourceUrl: 'https://assets.test/prop.png' });
  const executor = new AssetsProductionExecutor({ ...r, assets, config: config(), imageClientFactory: () => ({
    async generateImage() { calls++; return { bytes: png(), mimeType: 'image/png', source: 'b64_json' }; },
  }) });
  const run = production(); const episodeTask = run.tasks.find(item => item.stage === 'assets');
  const episode = await executor.execute(context(run, episodeTask));
  assert.equal(episode.state, 'blocked'); assert.equal(episode.issue.code, 'ASSET_MATCH_AMBIGUOUS');
  assert.match(episode.issue.message, /没有按创建时间猜选/); assert.equal(episode.spawnTasks, undefined);
  const report = episode.artifacts[0].metadata;
  assert.equal(report.matchedCount, 2); assert.equal(report.missingCount, 0); assert.equal(report.ambiguousCount, 1);
  const binding = report.bindings.find(item => item.entityId === 'character_hero');
  assert.equal(binding.assetId, null); assert.equal(binding.ambiguous, true);
  assert.deepEqual(new Set(binding.alternatives), new Set([first.id, second.id]));
  assert.deepEqual(new Set(binding.ambiguousCandidates.map(item => item.assetId)), new Set([first.id, second.id]));

  const childTask = scopedTask(run, 'assets', { kind: 'asset', id: 'character_hero' });
  const prepared = await executor.prepare({ run, task: childTask });
  assert.equal(prepared.requiresPaid, false); assert.equal(prepared.estimateCostMicros, 0);
  const child = await executor.execute(context(run, childTask, prepared));
  assert.equal(child.state, 'blocked'); assert.equal(child.issue.code, 'ASSET_MATCH_AMBIGUOUS'); assert.equal(calls, 0);

  const shotTask = scopedTask(run, 'assets', { kind: 'shot', id: 'shot_complex' });
  const shot = await executor.execute(context(run, shotTask));
  assert.equal(shot.state, 'blocked'); assert.equal(shot.issue.code, 'SHOT_ASSET_BINDINGS_AMBIGUOUS');
  assert.deepEqual(shot.artifacts[0].metadata.ambiguousEntityIds, ['character_hero']); assert.equal(calls, 0);
});

test('a unique exact name remains decisive over lower-priority alias matches', async () => {
  const r = readers(); const assets = new AssetService(new InMemoryAssetRepository());
  const exact = await assets.create({ kind: 'character', name: '沈玥', description: '精确名称',
    resourceUrl: 'https://assets.test/hero-exact.png' });
  const alias = await assets.create({ kind: 'character', name: '小玥', description: '别名候选',
    resourceUrl: 'https://assets.test/hero-alias.png' });
  const executor = new AssetsProductionExecutor({ ...r, assets, config: config() });
  const run = production(); const task = run.tasks.find(item => item.stage === 'assets');
  const outcome = await executor.execute(context(run, task));
  assert.equal(outcome.state, 'succeeded');
  const binding = outcome.artifacts[0].metadata.bindings.find(item => item.entityId === 'character_hero');
  assert.equal(binding.assetId, exact.id); assert.equal(binding.ambiguous, false);
  assert.deepEqual(binding.alternatives, [alias.id]);
});

test('missing image configuration blocks before any paid request', async () => {
  const r = readers(); const assets = new AssetService(new InMemoryAssetRepository()); let calls = 0;
  const executor = new AssetsProductionExecutor({ ...r, assets, config: config({ apiKey: '' }), imageClientFactory: () => ({
    async generateImage() { calls++; return { bytes: png(), mimeType: 'image/png', source: 'b64_json' }; },
  }) });
  const run = production(); const task = scopedTask(run, 'assets', { kind: 'asset', id: 'character_hero' });
  const prepared = await executor.prepare({ run, task });
  assert.equal(prepared.requiresPaid, false); assert.equal(prepared.estimateCostMicros, 0);
  const outcome = await executor.execute(context(run, task, prepared));
  assert.equal(outcome.state, 'blocked'); assert.equal(outcome.issue.code, 'IMAGE_MODEL_NOT_CONFIGURED'); assert.equal(calls, 0);
});

test('asset child generates exactly one verified image, imports it, and exact replay reuses it', async () => {
  const r = readers(); const assets = new AssetService(new InMemoryAssetRepository()); let calls = 0; let prompt = '';
  const executor = new AssetsProductionExecutor({ ...r, assets, config: config(), imageCostMicros: 1_500_000,
    imageClientFactory: () => ({ async generateImage(input) { calls++; prompt = input.prompt;
      return { bytes: png(), mimeType: 'image/png', source: 'b64_json' }; } }) });
  const run = production(); const task = scopedTask(run, 'assets', { kind: 'asset', id: 'character_hero' });
  run.methodPacks = [{ id: 'character-pack', nodes: ['character-image'], digest: 'c', excerpt: '保留颧骨特征' },
    { id: 'other-pack', nodes: ['video'], digest: 'v', excerpt: '不应出现的推拉镜头' }];
  const firstPrepare = await executor.prepare({ run, task });
  assert.equal(firstPrepare.requiresPaid, true); assert.equal(firstPrepare.estimateCostMicros, 1_500_000);
  const outcome = await executor.execute(context(run, task, firstPrepare));
  assert.equal(outcome.state, 'succeeded'); assert.equal(outcome.actualCostMicros, 1_500_000); assert.equal(calls, 1);
  assert.match(prompt, /已核对的剧本事实/); assert.match(prompt, /沈玥/); assert.match(prompt, /写实雨夜/);
  assert.match(prompt, /保留颧骨特征/); assert.doesNotMatch(prompt, /不应出现的推拉镜头/);
  const records = await assets.list(); assert.equal(records.length, 1); assert.match(records[0].resourceUrl, /^\/api\/assets\//);
  const replayPrepare = await executor.prepare({ run, task }); assert.equal(replayPrepare.requiresPaid, false);
  const replay = await executor.execute(context(run, task)); assert.equal(replay.state, 'succeeded'); assert.equal(calls, 1);
  assert.equal(replay.artifacts[0].metadata.generated, false);
});

test('connection changes after prepare stop before the paid image request', async () => {
  const r = readers(); const assets = new AssetService(new InMemoryAssetRepository()); let calls = 0;
  let live = config();
  const executor = new AssetsProductionExecutor({ ...r, assets, config: () => live,
    imageClientFactory: () => ({ async generateImage() { calls++; return { bytes: png(), mimeType: 'image/png', source: 'b64_json' }; } }) });
  const run = production(); const task = scopedTask(run, 'assets', { kind: 'asset', id: 'character_hero' });
  const prepared = await executor.prepare({ run, task }); assert.equal(prepared.requiresPaid, true);
  live = config({ connectionRevision: 'image-r2', defaultModel: 'image-test-v2' });
  const outcome = await executor.execute(context(run, task, prepared));
  assert.equal(outcome.state, 'blocked'); assert.equal(outcome.issue.code, 'IMAGE_MODEL_SELECTION_CHANGED'); assert.equal(calls, 0);
});

test('shot asset task emits deterministic bindings and refuses to guess missing assets', async () => {
  const r = readers(); const assets = new AssetService(new InMemoryAssetRepository());
  for (const [kind, name] of [['character', '沈玥'], ['location', '雨巷']]) {
    await assets.create({ kind, name, description: '测试', resourceUrl: `https://assets.test/${kind}.png` });
  }
  const executor = new AssetsProductionExecutor({ ...r, assets, config: config() });
  const run = production(); const task = scopedTask(run, 'assets', { kind: 'shot', id: 'shot_complex' });
  const missing = await executor.execute(context(run, task));
  assert.equal(missing.state, 'blocked'); assert.equal(missing.issue.code, 'SHOT_ASSET_BINDINGS_MISSING');
  await assets.create({ kind: 'prop', name: '手机', description: '测试', resourceUrl: 'https://assets.test/prop.png' });
  const outcome = await executor.execute(context(run, task));
  assert.equal(outcome.state, 'succeeded'); assert.equal(outcome.artifacts[0].metadata.bindings.length, 3);
  assert.deepEqual(outcome.artifacts[0].metadata.missingEntityIds, []);
});

test('RAG reuses a unique description match across episode, child, and shot without generating', async () => {
  const r = readers(); const assets = new AssetService(new InMemoryAssetRepository()); let calls = 0;
  const reused = await assets.create({ kind: 'character', name: '风衣女警立绘',
    description: '年轻女警，深色风衣，冷色雨夜', resourceUrl: 'https://assets.test/rag-hero.png' });
  await assets.create({ kind: 'location', name: '雨巷', description: '测试', resourceUrl: 'https://assets.test/location.png' });
  await assets.create({ kind: 'prop', name: '手机', description: '测试', resourceUrl: 'https://assets.test/prop.png' });
  const executor = new AssetsProductionExecutor({ ...r, assets, config: config(), imageClientFactory: () => ({
    async generateImage() { calls++; return { bytes: png(), mimeType: 'image/png', source: 'b64_json' }; },
  }) });
  const run = production(); const episodeTask = run.tasks.find(item => item.stage === 'assets');
  const episode = await executor.execute(context(run, episodeTask));
  assert.equal(episode.state, 'succeeded'); assert.deepEqual(episode.spawnTasks, []);
  const binding = episode.artifacts[0].metadata.bindings.find(item => item.entityId === 'character_hero');
  assert.equal(binding.assetId, reused.id); assert.equal(binding.matchedBy, 'retrieval');
  assert.equal(binding.retrieval.status, 'unique'); assert.ok(binding.retrieval.score >= ASSET_RETRIEVAL_THRESHOLD);

  const childTask = scopedTask(run, 'assets', { kind: 'asset', id: 'character_hero' });
  const prepared = await executor.prepare({ run, task: childTask });
  assert.equal(prepared.requiresPaid, false); assert.equal(prepared.estimateCostMicros, 0);
  const child = await executor.execute(context(run, childTask, prepared));
  assert.equal(child.state, 'succeeded'); assert.equal(child.artifacts[0].metadata.generated, false);
  assert.equal(child.artifacts[0].metadata.matchedBy, 'retrieval'); assert.equal(calls, 0);

  const shotTask = scopedTask(run, 'assets', { kind: 'shot', id: 'shot_complex' });
  const shot = await executor.execute(context(run, shotTask));
  assert.equal(shot.state, 'succeeded');
  assert.equal(shot.artifacts[0].metadata.bindings.find(item => item.entityId === 'character_hero').matchedBy, 'retrieval');
  assert.equal(calls, 0);
});

test('same-confidence RAG candidates block every asset entry point without generating', async () => {
  const r = readers(); const assets = new AssetService(new InMemoryAssetRepository()); let calls = 0;
  for (const suffix of ['A', 'B']) {
    await assets.create({ kind: 'character', name: `风衣女警${suffix}`, description: '年轻女警，深色风衣',
      resourceUrl: `https://assets.test/rag-${suffix}.png` });
  }
  const executor = new AssetsProductionExecutor({ ...r, assets, config: config(), imageClientFactory: () => ({
    async generateImage() { calls++; return { bytes: png(), mimeType: 'image/png', source: 'b64_json' }; },
  }) });
  const run = production(); const episodeTask = run.tasks.find(item => item.stage === 'assets');
  const episode = await executor.execute(context(run, episodeTask));
  assert.equal(episode.state, 'blocked'); assert.equal(episode.issue.code, 'ASSET_MATCH_AMBIGUOUS');
  const binding = episode.artifacts[0].metadata.bindings.find(item => item.entityId === 'character_hero');
  assert.equal(binding.retrieval.status, 'ambiguous'); assert.equal(binding.ambiguousCandidates.length, 2);
  assert.ok(binding.ambiguousCandidates.every(item => item.matchedBy === 'retrieval'));

  const childTask = scopedTask(run, 'assets', { kind: 'asset', id: 'character_hero' });
  const prepared = await executor.prepare({ run, task: childTask });
  assert.equal(prepared.requiresPaid, false);
  const child = await executor.execute(context(run, childTask, prepared));
  assert.equal(child.state, 'blocked'); assert.equal(child.issue.code, 'ASSET_MATCH_AMBIGUOUS'); assert.equal(calls, 0);

  const shotTask = scopedTask(run, 'assets', { kind: 'shot', id: 'shot_complex' });
  const shot = await executor.execute(context(run, shotTask));
  assert.equal(shot.state, 'blocked'); assert.equal(shot.issue.code, 'SHOT_ASSET_BINDINGS_AMBIGUOUS'); assert.equal(calls, 0);
});

test('unrelated or cross-kind retrieval candidates do not suppress a genuinely missing image', async () => {
  const r = readers(); const assets = new AssetService(new InMemoryAssetRepository()); let calls = 0;
  await assets.create({ kind: 'location', name: '女警办公室', description: '年轻女警，深色风衣',
    resourceUrl: 'https://assets.test/wrong-kind.png' });
  await assets.create({ kind: 'character', name: '林医生', description: '年长男医生，穿白大褂',
    resourceUrl: 'https://assets.test/unrelated.png' });
  const executor = new AssetsProductionExecutor({ ...r, assets, config: config(), imageClientFactory: () => ({
    async generateImage() { calls++; return { bytes: png(), mimeType: 'image/png', source: 'b64_json' }; },
  }) });
  const run = production(); const task = scopedTask(run, 'assets', { kind: 'asset', id: 'character_hero' });
  const prepared = await executor.prepare({ run, task }); assert.equal(prepared.requiresPaid, true);
  const outcome = await executor.execute(context(run, task, prepared));
  assert.equal(outcome.state, 'succeeded'); assert.equal(outcome.artifacts[0].metadata.generated, true); assert.equal(calls, 1);
});

test('structured retrieval exposes bounded terms and rejects tautological low-confidence matches', () => {
  const terms = tokenizeAssetQuery('想找红斗篷少女，雨夜场景');
  assert.ok(terms.includes('红斗篷')); assert.ok(terms.includes('少女')); assert.ok(terms.length <= 24);
  const stored = { id: 'asset_generic', kind: 'character', name: '角色甲', description: '沈玥的剧本设定',
    resourceUrl: 'https://assets.test/generic.png', createdAt: '2026-10-23T00:00:00.000Z' };
  const result = retrieveAssetForGeneration({ kind: 'character', name: '沈玥', aliases: ['小玥'],
    description: '沈玥的剧本设定' }, [stored]);
  assert.equal(result.asset, null); assert.equal(result.status, 'below_threshold');
  assert.ok(result.score < ASSET_RETRIEVAL_THRESHOLD);
});

test('director coordinator only reports decisions; shot task builds a stable web-importable whitebox', async () => {
  const r = readers(); const executor = new DirectorProductionExecutor(r); const run = production();
  const episode = run.tasks.find(item => item.stage === 'director');
  const summary = await executor.execute(context(run, episode));
  assert.equal(summary.state, 'succeeded'); assert.equal(summary.spawnTasks, undefined);
  assert.equal(summary.artifacts[0].metadata.requiredShots, 1);

  const simpleTask = scopedTask(run, 'director', { kind: 'shot', id: 'shot_simple' });
  const simple = await executor.execute(context(run, simpleTask));
  assert.equal(simple.state, 'succeeded'); assert.equal(simple.artifacts[0].kind, 'report');

  const complexTask = scopedTask(run, 'director', { kind: 'shot', id: 'shot_complex' });
  const complex = await executor.execute(context(run, complexTask));
  assert.equal(complex.state, 'succeeded'); assert.equal(complex.artifacts[0].kind, 'directorScene');
  const snapshot = complex.artifacts[0].metadata.snapshot;
  assert.equal(snapshot.schemaVersion, 1); assert.equal(snapshot.aspectRatio, '9:16');
  assert.equal(snapshot.provenance.ruleBased, true); assert.equal(snapshot.objects[0].type, 'geometry');
  assert.equal(snapshot.objects[1].type, 'mannequin'); assert.equal(snapshot.cameras[0].type, 'camera');
  assert.deepEqual(snapshot, buildDirectorSnapshot(run, r.plan, r.board, r.board.shots[1]));
});

test('director auto complexity and never policy are explicit deterministic rules', () => {
  const [simple, complex] = board().shots;
  assert.deepEqual(directorDecision('auto', simple, 1).reasons, ['simpleStaticComposition']);
  assert.equal(directorDecision('auto', complex, 1).required, true);
  assert.deepEqual(directorDecision('never', complex, 5).reasons, ['policy:never']);
  assert.deepEqual(directorDecision('always', simple, 0).reasons, ['policy:always']);
});

test('Milvus semantic recall reuses catalog assets without image generation and budgets query embeddings', async () => {
  const r = readers(); const assets = new AssetService(new InMemoryAssetRepository());
  const hero = await assets.create({ kind: 'character', name: '林澜', description: '冷傲女总裁，常穿灰色西装',
    resourceUrl: 'https://assets.test/semantic-hero.png' });
  let embeddings = 0; let imageCalls = 0;
  const retrieval = new HybridAssetRetriever({
    embedding: { async embedText() { embeddings++; return [0.2, 0.8]; } },
    store: { async search(_vector, kind) { return kind === 'character' ? [{ assetId: hero.id, score: 0.92 }] : []; },
      async upsert() {}, async deleteByAssetIds() {} },
    model: 'embedding-test', revision: 'test-revision', queryCostMicros: 7_000,
  });
  const executor = new AssetsProductionExecutor({ ...r, assets, config: config(), retrieval,
    imageCostMicros: 2_000_000, imageClientFactory: () => ({ async generateImage() {
      imageCalls++; throw new Error('semantic reuse must not generate');
    } }) });
  const run = production(); const episodeTask = run.tasks.find(item => item.stage === 'assets');
  const prepared = await executor.prepare({ run, task: episodeTask });
  assert.equal(prepared.requiresPaid, false); assert.equal(prepared.provider, null);
  assert.equal(prepared.estimateCostMicros, 21_000); assert.equal(embeddings, 0);
  const outcome = await executor.execute(context(run, episodeTask, prepared));
  assert.equal(outcome.state, 'succeeded'); assert.equal(outcome.actualCostMicros, 21_000);
  assert.equal(embeddings, 3); assert.equal(imageCalls, 0); assert.equal(outcome.spawnTasks.length, 2);
  const match = outcome.artifacts[0].metadata.bindings.find(item => item.entityId === 'character_hero');
  assert.equal(match.assetId, hero.id); assert.equal(match.matchedBy, 'retrieval');
  assert.equal(match.retrieval.semantic.status, 'available');
  await assets.create({ kind: 'location', name: '雨巷', description: '已有场景', resourceUrl: 'https://assets.test/semantic-location.png' });
  await assets.create({ kind: 'prop', name: '手机', description: '已有道具', resourceUrl: 'https://assets.test/semantic-prop.png' });
  const shotTask = scopedTask(run, 'assets', { kind: 'shot', id: 'shot_complex' });
  const shot = await executor.execute(context(run, shotTask));
  assert.equal(shot.state, 'succeeded');
  assert.equal(shot.artifacts[0].metadata.bindings.find(item => item.entityId === 'character_hero').assetId, hero.id);
  const childTask = scopedTask(run, 'assets', { kind: 'asset', id: 'character_hero' });
  const childPrepared = await executor.prepare({ run, task: childTask });
  assert.equal(childPrepared.estimateCostMicros, 2_007_000); assert.equal(childPrepared.requiresPaid, true);
  const child = await executor.execute(context(run, childTask, childPrepared));
  assert.equal(child.state, 'succeeded'); assert.equal(child.actualCostMicros, 7_000);
  assert.equal(child.artifacts[0].metadata.generated, false); assert.equal(imageCalls, 0);
});

test('exact identity matches do not call the embedding provider', async () => {
  const r = readers(); const assets = new AssetService(new InMemoryAssetRepository());
  for (const [kind, name] of [['character', '沈玥'], ['location', '雨巷'], ['prop', '手机']]) {
    await assets.create({ kind, name, description: '已有正式资产', resourceUrl: `https://assets.test/exact-${kind}.png` });
  }
  let embeddings = 0;
  const retrieval = new HybridAssetRetriever({
    embedding: { async embedText() { embeddings++; throw new Error('exact match must skip embedding'); } },
    store: { async search() { return []; }, async upsert() {}, async deleteByAssetIds() {} },
    model: 'embedding-test', revision: 'test-revision', queryCostMicros: 7_000,
  });
  const executor = new AssetsProductionExecutor({ ...r, assets, config: config(), retrieval });
  const run = production(); const task = run.tasks.find(item => item.stage === 'assets');
  const prepared = await executor.prepare({ run, task });
  assert.equal(prepared.estimateCostMicros, 0);
  const outcome = await executor.execute(context(run, task, prepared));
  assert.equal(outcome.state, 'succeeded'); assert.equal(outcome.actualCostMicros, 0);
  assert.equal(outcome.spawnTasks.length, 0); assert.equal(embeddings, 0);
});
