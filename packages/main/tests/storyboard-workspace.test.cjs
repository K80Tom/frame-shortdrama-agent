const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StoryboardService, validateStoryboardOutput, retainedStoryboardSceneIds } = require('../dist/breakdown/storyboard');
const { InMemoryBreakdownRepository } = require('../dist/breakdown/repository');
const { BreakdownService } = require('../dist/breakdown/service');
const { readConfig } = require('../dist/config');
const { createApp } = require('../dist/app');
const { serializeScriptStructure } = require('@lyra/shared');

const ref1 = { scriptVersionId: 'script_1', start: 0, end: 7, quote: '林晚：你来了。' };
const ref2 = { scriptVersionId: 'script_1', start: 8, end: 15, quote: '林晚：出发吧。' };
const sourced = (value, ref) => ({ value, origin: 'source', sourceRefs: [ref], answerIds: [] });
const character = { id: 'char_1', name: sourced('林晚', ref1), aliases: [], sourceRefs: [ref1] };
const plan = { id: 'plan_1', scriptVersionId: 'script_1', content: {
  synopsis: null, characters: [character], locations: [], props: [],
  scenes: [
    { id: 'scene_1', order: 1, title: sourced('第一场', ref1), sourceRefs: [ref1], characterIds: ['char_1'], locationId: null },
    { id: 'scene_2', order: 2, title: sourced('第二场', ref2), sourceRefs: [ref2], characterIds: ['char_1'], locationId: null },
  ],
  dialogues: [
    { id: 'dialogue_1', sceneId: 'scene_1', speakerId: 'char_1', sourceRef: ref1 },
    { id: 'dialogue_2', sceneId: 'scene_2', speakerId: 'char_1', sourceRef: ref2 },
  ],
} };
const shot = (id, sceneId, dialogueId, ref) => ({ id, sceneId, order: 1,
  design: { origin: 'designSuggestion', visualDescription: `${sceneId}旧镜头`, shotSize: '中景', cameraMovement: '固定', durationMs: 3000 },
  sourceRefs: [ref], dialogueIds: [dialogueId], assetRefs: [] });
const baseRow = () => ({ id: 'storyboard_base', project_id: 'project_1', script_version_id: 'script_1',
  source_plan_revision_id: 'plan_1', attempt_id: 'attempt_base', input_digest: 'base-digest',
  content_json: { validatorVersion: 'storyboard-validator/2', scope: { kind: 'project', episodeNumber: null, baseRevisionId: null },
    shots: [shot('shot_one', 'scene_1', 'dialogue_1', ref1), shot('shot_two_old', 'scene_2', 'dialogue_2', ref2)] },
  prompt_version: 'storyboard-design/2', model: 'stub', provider_request_id: null, usage_json: null, created_at: '2026-11-13T00:00:00.000Z' });

function fixture({ assets = [{ id: 'asset_lin', kind: 'character', name: '林晚' }], generate = false } = {}) {
  const row = baseRow();
  const writes = [];
  const database = {
    async query(sql, values) {
      if (sql.startsWith('SELECT * FROM storyboard_revisions WHERE id=$1')) return { rows: [row] };
      if (sql.startsWith('SELECT current_script_version_id')) return { rows: [{ current_script_version_id: 'script_1', active_plan_revision_id: 'plan_1' }] };
      writes.push({ sql, values }); return { rows: [] };
    },
    async transaction(operation) {
      const client = { async query(sql, values) {
        if (sql.startsWith('SELECT current_script_version_id')) return { rows: [{ current_script_version_id: 'script_1', active_plan_revision_id: 'plan_1' }] };
        if (sql.includes('INSERT INTO storyboard_revisions')) return { rows: [{
          id: values[0], project_id: values[1], script_version_id: values[2], source_plan_revision_id: values[3], attempt_id: values[4],
          content_json: JSON.parse(values[5]), input_digest: values[6],
          prompt_version: values.length === 7 ? 'storyboard-manual/1' : values[7],
          model: values.length === 7 ? 'manual-edit' : values[8],
          provider_request_id: values.length === 7 ? null : values[9], usage_json: values[10] ? JSON.parse(values[10]) : null, created_at: '2026-11-13T01:00:00.000Z',
        }] };
        writes.push({ sql, values }); return { rows: [] };
      } };
      return operation(client);
    },
  };
  const breakdown = {
    async getProject() { return { currentScriptVersionId: 'script_1', activePlanRevisionId: 'plan_1', activeStoryboardRevisionId: null }; },
    async getPlanRevision() { return plan; },
    async getScriptVersion() { return { structure: { episodes: [
      { episodeNumber: 1, scenes: [{ id: 'script_scene_1' }] }, { episodeNumber: 2, scenes: [{ id: 'script_scene_2' }] },
    ] } }; },
  };
  const transport = async (_url, options) => {
    assert.equal(generate, true);
    const input = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: 'stub-board', model: input.model,
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ shots: [{
        sceneId: 'scene_2', order: 1, visualDescription: '第二集新镜头', shotSize: '近景', cameraMovement: '推镜', durationMs: 4000,
        sourceRefs: [ref2], dialogueIds: ['dialogue_2'],
      }] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { headers: { 'Content-Type': 'application/json' } });
  };
  const service = new StoryboardService(database, breakdown, readConfig(generate ? { LLM_API_KEY: 'stub', LLM_BASE_URL: 'https://model.test/openai' } : {}),
    transport, { async list() { return assets; } });
  return { service, row, writes };
}

test('episode generation merges into a new candidate without discarding other episode shots', async () => {
  const { service, row } = fixture({ generate: true });
  const before = structuredClone(row);
  const revision = await service.generate('project_1', undefined, '', { episodeNumber: 2, baseRevisionId: 'storyboard_base' });
  assert.equal(revision.scope.kind, 'episode');
  assert.equal(revision.scope.episodeNumber, 2);
  assert.equal(revision.scope.baseRevisionId, 'storyboard_base');
  assert.equal(revision.shots.length, 2);
  assert.equal(revision.shots.find(item => item.sceneId === 'scene_1').id, 'shot_one');
  assert.notEqual(revision.shots.find(item => item.sceneId === 'scene_2').id, 'shot_two_old');
  assert.equal(revision.shots.find(item => item.sceneId === 'scene_2').design.visualDescription, '第二集新镜头');
  assert.deepEqual(revision.shots.find(item => item.sceneId === 'scene_2').assetRefs,
    [{ entityId: 'char_1', assetId: 'asset_lin', kind: 'character' }]);
  assert.deepEqual(row, before, 'generation must not mutate the base row');
});

test('多集剧本只采用第一集事实时仍可生成第一集，目标集缺事实会明确阻断', async () => {
  const structure = { episodes: [1, 2].map(episodeNumber => ({
    id: `episode_${episodeNumber}`, episodeNumber, title: `第${episodeNumber}集`, synopsis: '',
    scenes: [{ id: `script_scene_${episodeNumber}`, sceneNumber: `${episodeNumber}-1`, sceneHeading: `第${episodeNumber}场`,
      location: '破庙', timeOfDay: '夜', intExt: '内', sceneDescription: '', dialogues: [] }],
  })) };
  const rawText = serializeScriptStructure(structure);
  const partial = { ...plan, content: { ...plan.content,
    scenes: [{ ...plan.content.scenes[0], sourceRefs: [{ scriptVersionId: 'script_1', start: 0, end: 3, quote: '第1集' }] }],
    dialogues: [plan.content.dialogues[0]] } };
  const { service } = fixture();
  service.breakdown = { async getScriptVersion() { return { rawText, structure }; } };
  const first = await service.episodePlan('project_1', partial, 1);
  assert.deepEqual(first.content.scenes.map(scene => scene.id), ['scene_1']);
  await assert.rejects(service.episodePlan('project_1', partial, 2), error => {
    assert.equal(error.code, 'STORYBOARD_EPISODE_FACTS_REQUIRED'); return true;
  });
  service.breakdown = { async getScriptVersion() { return { rawText: '无法定位原文', structure }; } };
  await assert.rejects(service.episodePlan('project_1', partial, 1), error => {
    assert.equal(error.code, 'STORYBOARD_EPISODE_MAP_INVALID'); return true;
  });
});

test('旧 validator/3 候选继续可读，缺少角度和声音字段也兼容', async () => {
  const { service, row } = fixture();
  row.content_json.validatorVersion = 'storyboard-validator/3';
  const revision = await service.get(row.id);
  assert.equal(revision.id, row.id);
  assert.equal(revision.shots[0].design.cameraAngle, undefined);
  assert.equal(revision.shots[0].design.sound, undefined);
});

test('ambiguous same-name assets are never guessed during shot binding', async () => {
  const { service } = fixture({ assets: [
    { id: 'asset_a', kind: 'character', name: '林晚' }, { id: 'asset_b', kind: 'character', name: '林 晚' },
  ] });
  const bound = await service.bindAssets([shot('shot_two', 'scene_2', 'dialogue_2', ref2)], plan);
  assert.deepEqual(bound[0].assetRefs, []);
});

test('storyboard frames persist image asset ids and reject invalid frame combinations', () => {
  const first = `asset_${'c'.repeat(32)}`;
  const last = `asset_${'d'.repeat(32)}`;
  const assets = [first, last].map(id => ({ id, kind: 'prop', resourceUrl: `/api/assets/${id}/content` }));
  const raw = { shots: [{ id: 'shot_frames', sceneId: 'scene_1', order: 1,
    visualDescription: '林晚抬头', shotSize: '近景', cameraMovement: '固定', durationMs: 4000,
    sourceRefs: [ref1], dialogueIds: ['dialogue_1'], firstFrameAssetId: first, lastFrameAssetId: last }] };
  const validated = validateStoryboardOutput(raw, plan, undefined, { requireCoverage: false, assets });
  assert.equal(validated[0].firstFrameAssetId, first);
  assert.equal(validated[0].lastFrameAssetId, last);
  const { firstFrameAssetId: _first, lastFrameAssetId: _last, ...withoutFrames } = raw.shots[0];
  for (const [frames, code] of [
    [{ lastFrameAssetId: last }, 'STORYBOARD_FRAME_INVALID'],
    [{ firstFrameAssetId: first, lastFrameAssetId: first }, 'STORYBOARD_FRAME_INVALID'],
    [{ firstFrameAssetId: `asset_${'e'.repeat(32)}` }, 'STORYBOARD_FRAME_ASSET_INVALID'],
  ]) {
    assert.throws(() => validateStoryboardOutput({ shots: [{ ...withoutFrames, ...frames }] }, plan,
      undefined, { requireCoverage: false, assets }), error => error.code === code);
  }
});

test('manual editing derives an immutable revision and partial candidates remain unadoptable', async () => {
  const { service, row, writes } = fixture();
  const before = structuredClone(row);
  const input = { shots: row.content_json.shots.map(item => ({ id: item.id, sceneId: item.sceneId, order: item.order,
    visualDescription: item.sceneId === 'scene_1' ? '手工改写画面' : item.design.visualDescription,
    shotSize: item.design.shotSize, cameraMovement: item.design.cameraMovement, durationMs: item.design.durationMs,
    ...(item.sceneId === 'scene_1' ? { cameraAngle: '俯拍', sound: '远处钟声与钟表滴答声',
      visualBeats: ['林晚抬起头，视线停在后门方向', '林晚放下手中的伞，雨水沿伞尖滴落'],
      atmosphere: '冷灰天光从门口进入，湿地反出微弱高光' } : {}),
    sourceRefs: item.sourceRefs, dialogueIds: item.dialogueIds, assetRefs: item.assetRefs })) };
  const revision = await service.revise('storyboard_base', input);
  assert.notEqual(revision.id, row.id);
  assert.equal(revision.model, 'manual-edit');
  assert.equal(revision.scope.baseRevisionId, 'storyboard_base');
  assert.equal(revision.shots[0].id, 'shot_one');
  assert.equal(revision.shots[0].design.visualDescription, '手工改写画面');
  assert.equal(revision.shots[0].design.cameraAngle, '俯拍');
  assert.equal(revision.shots[0].design.sound, '远处钟声与钟表滴答声');
  assert.deepEqual(revision.shots[0].design.visualBeats, ['林晚抬起头，视线停在后门方向', '林晚放下手中的伞，雨水沿伞尖滴落']);
  assert.equal(revision.shots[0].design.atmosphere, '冷灰天光从门口进入，湿地反出微弱高光');
  assert.equal(revision.shots[1].design.visualBeats, undefined);
  assert.equal(revision.shots[1].design.atmosphere, undefined);
  assert.equal(revision.shots[1].design.cameraAngle, undefined);
  assert.deepEqual(row, before, 'manual editing must not mutate the source revision');
  row.content_json.shots = row.content_json.shots.filter(item => item.sceneId === 'scene_1');
  await assert.rejects(service.adopt('project_1', 'storyboard_base', null), { code: 'STORYBOARD_COVERAGE_INCOMPLETE' });
  assert.equal(writes.filter(item => item.sql.includes('UPDATE projects')).length, 0);
});

test('HTTP routes preserve episode generation scope and accept only shot edits', async t => {
  const calls = [];
  const storyboardService = {
    async generate(projectId, expected, methodReference, scope) {
      calls.push({ projectId, expected, methodReference, scope }); return { id: 'storyboard_generated', scope };
    },
    async revise(revisionId, body) { calls.push({ revisionId, body }); return { id: 'storyboard_edited', scope: { baseRevisionId: revisionId } }; },
  };
  const app = await createApp(readConfig({}), fetch, { storyboardService });
  t.after(() => app.close());
  const headers = { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:5173', 'x-shortdrama-call': '1' };
  const generated = await app.inject({ method: 'POST', url: '/api/projects/project_1/storyboards', headers,
    payload: { allowPaid: true, episodeNumber: 2, baseRevisionId: 'storyboard_base' } });
  assert.equal(generated.statusCode, 201, generated.body);
  assert.deepEqual(calls[0].scope, { episodeNumber: 2, baseRevisionId: 'storyboard_base' });
  const edited = await app.inject({ method: 'POST', url: '/api/storyboards/storyboard_generated/edits', headers,
    payload: { shots: [] } });
  assert.equal(edited.statusCode, 201, edited.body);
  assert.deepEqual(calls[1], { revisionId: 'storyboard_generated', body: { shots: [] } });
  const invalid = await app.inject({ method: 'POST', url: '/api/storyboards/storyboard_generated/edits', headers,
    payload: { shots: [], allowPaid: true } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'INVALID_STORYBOARD_EDIT');
});

test('raw structure errors identify the shot and required visual description', () => {
  assert.throws(() => validateStoryboardOutput({ shots: [{
    id: 'shot_empty', sceneId: 'scene_1', order: 1, visualDescription: ' ', shotSize: '中景',
    cameraMovement: '固定', durationMs: 3000, sourceRefs: [ref1], dialogueIds: [], assetRefs: [],
  }] }, plan, undefined, { requireCoverage: false }), error => {
    assert.equal(error.code, 'STORYBOARD_OUTPUT_INVALID');
    assert.match(error.message, /第 1 个镜头画面描述不能为空/);
    return true;
  });
});

test('正式覆盖不再要求旁白动作全选，但重复绑定仍保持数据有效', () => {
  const { storyboardNarrativeBeats } = require('@lyra/shared');
  const narrativeRef = { scriptVersionId: 'script_1', start: 20, end: 49,
    quote: '【旁白】时间留下残渣。\n【动作】老林夹起铜屑。' };
  const narrativePlan = { ...plan, content: { ...plan.content,
    scenes: [{ ...plan.content.scenes[0], sourceRefs: [narrativeRef] }], dialogues: [] } };
  const beats = storyboardNarrativeBeats(narrativePlan.content.scenes);
  assert.equal(beats.length, 2);
  const input = { id: 'shot_narrative', sceneId: 'scene_1', order: 1, visualDescription: '老林夹起铜屑',
    shotSize: '近景', cameraMovement: '缓推', durationMs: 5000, sourceRefs: [narrativeRef], dialogueIds: [], narrativeBeatIds: [], assetRefs: [] };
  assert.equal(validateStoryboardOutput({ shots: [input] }, narrativePlan)[0].narrativeBeatIds.length, 0);
  const covered = validateStoryboardOutput({ shots: [{ ...input, narrativeBeatIds: beats.map(beat => beat.id) }] }, narrativePlan);
  assert.deepEqual(covered[0].narrativeBeatIds, beats.map(beat => beat.id));
  assert.throws(() => validateStoryboardOutput({ shots: [
    { ...input, narrativeBeatIds: [beats[0].id] },
    { ...input, id: 'shot_duplicate', order: 2, narrativeBeatIds: [beats[0].id] },
  ] }, narrativePlan, undefined, { requireCoverage: false }), error => error.code === 'STORYBOARD_NARRATIVE_INVALID');
});

test('新剧本版本保留已采用事实与分镜指针，不再连锁清空', async () => {
  const repository = new InMemoryBreakdownRepository();
  const service = new BreakdownService(repository, readConfig({}));
  const project = await service.createProject({ title: '删集版本链' });
  await service.createScriptVersion(project.id, { rawText: '第1场 钟表铺 日\n老林夹起铜屑。' });
  Object.assign(repository.projects.get(project.id), { activePlanRevisionId: 'plan_1', activeStoryboardRevisionId: 'board_1' });
  await service.createScriptVersion(project.id, { rawText: '第2场 钟表铺 日\n老林放下铜屑。' });
  const current = await service.getProject(project.id);
  assert.equal(current.activePlanRevisionId, 'plan_1');
  assert.equal(current.activeStoryboardRevisionId, 'board_1');
});

test('删除第一集后仅保留第二集事实场次，其他集资产实体 ID 不变', async () => {
  const currentEpisodes = [{ id: 'episode_2', episodeNumber: 2, scenes: [{ id: 'script_scene_2' }] }];
  const adoptedEpisodes = [{ id: 'episode_1', episodeNumber: 1, scenes: [{ id: 'script_scene_1' }] }, ...currentEpisodes];
  const breakdown = {
    async getProject() { return { currentScriptVersionId: 'script_2' }; },
    async getScriptVersion(_project, id) { return { structure: { episodes: id === 'script_2' ? currentEpisodes : adoptedEpisodes } }; },
  };
  const retained = await retainedStoryboardSceneIds(breakdown, 'project_1', plan);
  assert.deepEqual([...retained], ['scene_2']);
  assert.equal(plan.content.characters[0].id, 'char_1');
});
