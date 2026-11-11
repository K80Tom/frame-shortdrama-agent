const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../dist/config');
const { InMemoryBreakdownRepository } = require('../dist/breakdown/repository');
const { BreakdownService } = require('../dist/breakdown/service');
const { ProjectWorkspaceReadModel, decideNextAction } = require('../dist/projects/read-model');

const config = readConfig({});

function fixture() {
  let ordinal = 0;
  const repository = new InMemoryBreakdownRepository();
  const service = new BreakdownService(repository, config, {
    now: () => new Date('2026-11-01T08:00:00.000Z'),
    nextId: (prefix) => `${prefix}_${String(++ordinal).padStart(4, '0')}`,
  });
  return { repository, service };
}

function sourceRef(script, quote) {
  const start = Array.from(script.rawText.slice(0, script.rawText.indexOf(quote))).length;
  return { scriptVersionId: script.id, start, end: start + Array.from(quote).length, quote };
}
function sourced(value, sourceRefs) {
  return { value, origin: 'source', sourceRefs, answerIds: [] };
}
function facts(script) {
  const heading = sourceRef(script, '第1场 医院走廊 夜 内');
  const action = sourceRef(script, '林晚（小晚）拿着信封走进医院走廊。');
  const line = sourceRef(script, '林晚：你终于来了。🙂');
  return {
    synopsis: sourced('林晚拿着信封来到医院走廊。', [heading, action, line]),
    characters: [{ tempId: 'tmp_lin', name: sourced('林晚', [action, line]), aliases: [sourced('小晚', [action])],
      description: sourced('拿着信封的人。', [action]), sourceRefs: [action, line] }],
    locations: [{ tempId: 'tmp_hall', name: sourced('医院走廊', [heading, action]), aliases: [], description: null, sourceRefs: [heading, action] }],
    props: [{ tempId: 'tmp_letter', name: sourced('信封', [action]), aliases: [], description: null, sourceRefs: [action] }],
    scenes: [{ tempId: 'tmp_scene', order: 1, title: sourced('医院走廊相见', [heading, action]), locationTempId: 'tmp_hall',
      characterTempIds: ['tmp_lin'], sourceRefs: [heading, action, line], timeOfDay: sourced('夜', [heading]) }],
    dialogues: [{ tempId: 'tmp_dialogue', sceneTempId: 'tmp_scene', speakerTempId: 'tmp_lin',
      speakerSourceRefs: [line], speakerAnswerIds: [], sourceRef: sourceRef(script, '你终于来了。🙂') }],
  };
}

const RAW_TEXT = '第1场 医院走廊 夜 内\r\n林晚（小晚）拿着信封走进医院走廊。\r\n林晚：你终于来了。🙂\r\n';

async function prepared(service) {
  const project = await service.createProject({ title: '主链读模型' });
  const script = await service.createScriptVersion(project.id, { rawText: RAW_TEXT });
  const run = await service.createDraftRun(project.id, { maxModelCalls: 1, maxOutputTokens: 4096 });
  const plan = await service.createExtractFactsCandidate(run.id, facts(script));
  return { project, script, run, plan };
}

function asset(id, kind, name) {
  return { id, kind, name, description: '', resourceUrl: `https://assets.test/${id}`, createdAt: '2026-10-01T00:00:00.000Z' };
}
function board(id, projectId, scriptVersionId, planRevisionId, shotCount = 2) {
  return { id, projectId, scriptVersionId, sourcePlanRevisionId: planRevisionId,
    shots: Array.from({ length: shotCount }, (_, index) => ({ id: `shot_${index}`, order: index + 1 })),
    createdAt: '2026-10-02T00:00:00.000Z' };
}

function readModel(service, options = {}) {
  return new ProjectWorkspaceReadModel({
    breakdown: service,
    storyboards: options.storyboards ?? null,
    assets: options.assets ?? null,
  });
}

test('nextAction 严格按优先级：无剧本/无 Run/候选未校验/校验未过', async () => {
  {
    const { service } = fixture();
    const project = await service.createProject({ title: '空项目' });
    const overview = await readModel(service).overview(project.id);
    assert.equal(overview.nextAction.id, 'add-script');
    assert.equal(overview.nextAction.section, 'script');
    assert.equal(overview.script, null);
  }
  {
    const { service } = fixture();
    const project = await service.createProject({ title: '只读剧本项目' });
    await service.createScriptVersion(project.id, { rawText: RAW_TEXT });
    const overview = await readModel(service).overview(project.id);
    assert.equal(overview.nextAction.id, 'start-breakdown');
    assert.equal(overview.script.version, 1);
  }
});

test('候选未校验时 review-facts，校验通过未采用时 adopt-facts', async () => {
  const { service } = fixture();
  const { project, plan } = await prepared(service);
  let overview = await readModel(service).overview(project.id);
  assert.equal(overview.nextAction.id, 'review-facts');
  assert.equal(overview.nextAction.section, 'script');

  await service.checkPlan(plan.id);
  overview = await readModel(service).overview(project.id);
  assert.equal(overview.nextAction.id, 'adopt-facts');
});

test('已采用事实后资产缺失优先于分镜动作', async () => {
  const { service } = fixture();
  const { project, plan } = await prepared(service);
  const checked = await service.checkPlan(plan.id);
  await service.adoptPlan(project.id, { planRevisionId: plan.id, checkId: checked.check.id, expectedActivePlanRevisionId: null });
  const overview = await readModel(service, {
    storyboards: { list: async () => [board('board_0001', project.id, plan.scriptVersionId, plan.id)] },
    assets: { list: async () => [] },
  }).overview(project.id);
  assert.equal(overview.facts.stale, false);
  assert.equal(overview.facts.entityCount, 3);
  assert.equal(overview.assets.missing, 3);
  assert.equal(overview.nextAction.id, 'resolve-assets');
  assert.equal(overview.nextAction.section, 'assets');
});

test('资产齐全后：分镜候选未采用 → adopt-storyboard；已采用新鲜分镜 → create-production', async () => {
  const { repository, service } = fixture();
  const { project, plan } = await prepared(service);
  const checked = await service.checkPlan(plan.id);
  await service.adoptPlan(project.id, { planRevisionId: plan.id, checkId: checked.check.id, expectedActivePlanRevisionId: null });
  const storyboards = { list: async () => [board('board_new', project.id, plan.scriptVersionId, plan.id)] };
  const assets = { list: async () => [asset('a1', 'character', '林晚'), asset('a2', 'location', '医院走廊'), asset('a3', 'prop', '信封')] };
  let overview = await readModel(service, { storyboards, assets }).overview(project.id);
  assert.equal(overview.assets.ready, 3);
  assert.equal(overview.nextAction.id, 'adopt-storyboard');

  // 采用事实会清空分镜指针，测试直接置位模拟已采用分镜。
  repository.projects.get(project.id).activeStoryboardRevisionId = 'board_adopted';
  storyboards.list = async () => [board('board_adopted', project.id, plan.scriptVersionId, plan.id)];
  overview = await readModel(service, { storyboards, assets }).overview(project.id);
  assert.equal(overview.storyboard.revisionId, 'board_adopted');
  assert.equal(overview.storyboard.shotCount, 2);
  assert.equal(overview.storyboard.stale, false);
  assert.equal(overview.nextAction.id, 'create-production');
});

test('保存新剧本版本后已采用指针被仓库清空，回到 start-breakdown', async () => {
  const { service } = fixture();
  const { project, plan } = await prepared(service);
  const checked = await service.checkPlan(plan.id);
  await service.adoptPlan(project.id, { planRevisionId: plan.id, checkId: checked.check.id, expectedActivePlanRevisionId: null });
  let overview = await readModel(service).overview(project.id);
  assert.equal(overview.facts.stale, false);
  await service.createScriptVersion(project.id, { rawText: `${RAW_TEXT}新的一段。\r\n` });
  overview = await readModel(service).overview(project.id);
  assert.equal(overview.facts, null);
  assert.equal(overview.script.version, 2);
  assert.equal(overview.storyboard, null);
  assert.equal(overview.nextAction.id, 'start-breakdown');
});

test('asset-requirements：无已采用事实返回零值 200；有事实返回匹配/缺失/歧义', async () => {
  const { service } = fixture();
  const { project, plan } = await prepared(service);
  let response = await readModel(service).assetRequirements(project.id);
  assert.equal(response.planRevisionId, null);
  assert.equal(response.ruleVersion, 'production-asset-match/5');
  assert.deepEqual(response.summary, { total: 0, matched: 0, missing: 0, ambiguous: 0 });
  assert.deepEqual(response.requirements, []);

  const checked = await service.checkPlan(plan.id);
  await service.adoptPlan(project.id, { planRevisionId: plan.id, checkId: checked.check.id, expectedActivePlanRevisionId: null });
  response = await readModel(service, {
    assets: { list: async () => [
      asset('a1', 'character', '林晚'),
      asset('x1', 'location', '医院走廊'), asset('x2', 'location', '医院走廊'),
    ] },
  }).assetRequirements(project.id);
  assert.equal(response.planRevisionId, plan.id);
  assert.equal(response.summary.total, 3);
  assert.equal(response.summary.matched, 1);
  assert.equal(response.summary.ambiguous, 1);
  assert.equal(response.summary.missing, 1);
  const lin = response.requirements.find(item => item.name === '林晚');
  assert.equal(lin.match.assetId, 'a1');
  assert.equal(lin.action.kind, 'none');
  const hall = response.requirements.find(item => item.name === '医院走廊');
  assert.equal(hall.match.ambiguous, true);
  assert.equal(hall.match.alternatives.length, 2);
  assert.equal(hall.action.kind, 'choose');
  const letter = response.requirements.find(item => item.name === '信封');
  assert.equal(letter.match.assetId, null);
  assert.equal(letter.action.kind, 'create');
  assert.ok(hall.sceneIds.length >= 1);
});

test('decideNextAction 纯逻辑尾部：handle-todos / view-delivery / null', () => {
  const base = {
    hasScript: true, hasRuns: true, adoptedPlan: { id: 'p1' }, freshAdoptedPlan: true,
    latestCandidate: null, latestCheck: null, openIssueCount: 0,
    assets: { missing: 0, ambiguous: 0 },
    boards: { adopted: { id: 'b1' }, freshAdopted: true, unadoptedCandidates: 0 },
    hasProductionRun: true, todos: [], deliveryAvailable: false,
  };
  assert.equal(decideNextAction(base), null);
  assert.equal(decideNextAction({ ...base, todos: [{ id: 't1', label: 'x', kind: 'x' }] }).id, 'handle-todos');
  assert.equal(decideNextAction({ ...base, todos: [], deliveryAvailable: true }).id, 'view-delivery');
});
