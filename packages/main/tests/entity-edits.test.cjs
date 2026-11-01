const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const { InMemoryBreakdownRepository } = require('../dist/breakdown/repository');
const { BreakdownService } = require('../dist/breakdown/service');

const config = readConfig({});
const headers = { host: '127.0.0.1:8788', 'x-shortdrama-call': '1' };

function fixture() {
  let ordinal = 0;
  const repository = new InMemoryBreakdownRepository();
  const service = new BreakdownService(repository, config, {
    now: () => new Date('2026-10-22T12:00:00.000Z'),
    nextId: (prefix) => `${prefix}_${String(++ordinal).padStart(4, '0')}`,
  });
  return { repository, service };
}

function sourceRef(script, quote) {
  const start = Array.from(script.rawText.slice(0, script.rawText.indexOf(quote))).length;
  assert.ok(script.rawText.includes(quote), `quote not found: ${quote}`);
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
    characters: [{
      tempId: 'tmp_lin', name: sourced('林晚', [action, line]),
      aliases: [sourced('小晚', [action])], description: sourced('拿着信封的人。', [action]),
      sourceRefs: [action, line],
    }],
    locations: [{
      tempId: 'tmp_hall', name: sourced('医院走廊', [heading, action]),
      aliases: [], description: null, sourceRefs: [heading, action],
    }],
    props: [{
      tempId: 'tmp_letter', name: sourced('信封', [action]),
      aliases: [], description: sourced('由林晚拿着。', [action]), sourceRefs: [action],
    }],
    scenes: [{
      tempId: 'tmp_scene', order: 1, title: sourced('医院走廊相见', [heading, action]),
      locationTempId: 'tmp_hall', characterTempIds: ['tmp_lin'],
      sourceRefs: [heading, action, line], timeOfDay: sourced('夜', [heading]),
    }],
    dialogues: [{
      tempId: 'tmp_dialogue', sceneTempId: 'tmp_scene', speakerTempId: 'tmp_lin',
      speakerSourceRefs: [line], speakerAnswerIds: [],
      sourceRef: sourceRef(script, '你终于来了。🙂'),
    }],
  };
}

async function prepared(service) {
  const project = await service.createProject({ title: '实体校对离线测试' });
  const script = await service.createScriptVersion(project.id, {
    rawText: '第1场 医院走廊 夜 内\r\n林晚（小晚）拿着信封走进医院走廊。\r\n林晚：你终于来了。🙂\r\n',
  });
  const run = await service.createDraftRun(project.id, {
    requirements: { language: '中文', visualStyle: '真人拟真', aspectRatio: '9:16' },
    maxModelCalls: 1, maxOutputTokens: 4096,
  });
  const plan = await service.createExtractFactsCandidate(run.id, facts(script));
  return { project, script, run, plan };
}

function edit(kind, entity, overrides = {}) {
  return {
    kind, entityId: entity.id, name: entity.name.value,
    aliases: entity.aliases.map((alias) => alias.value), description: entity.description?.value ?? null,
    ...overrides,
  };
}

function requestFor(plan, overrides = {}, expectedActivePlanRevisionId = null) {
  return { expectedActivePlanRevisionId, edits: [edit('character', plan.content.characters[0], { name: '林晚（校对）', ...overrides })] };
}

function lockedFields(plan, entityId) {
  return plan.content.manualLocks.filter((lock) => lock.targetType === 'entity' && lock.targetId === entityId)
    .flatMap((lock) => lock.fields).sort();
}

test('historical provider snapshots do not prevent reading and saving an offline entity correction', async () => {
  const { repository, service } = fixture();
  const { run, plan } = await prepared(service);
  repository.runs.get(run.id).modelConfig = { provider: 'local-proxy', model: 'gpt-5.6-terra', reasoningEffort: 'medium' };
  assert.equal((await service.getRun(run.id)).modelConfig.provider, 'local-proxy');
  assert.deepEqual(await service.getPlanRevision(plan.id), plan);
  const edited = await service.createEntityEditCandidate(plan.id, requestFor(plan));
  assert.equal(edited.runId, run.id);
  assert.equal(edited.content.characters[0].name.value, '林晚（校对）');
  assert.equal(edited.createdBy, 'user');
  assert.equal(repository.attempts.size, 0);
  assert.equal(repository.modelCalls.size, 0);
});

async function adopt(service, project, plan, expectedActivePlanRevisionId = null) {
  const result = await service.checkPlan(plan.id);
  assert.equal(result.check.result, 'passed');
  return service.adoptPlan(project.id, {
    planRevisionId: plan.id, checkId: result.check.id, expectedActivePlanRevisionId,
  });
}

test('entity proofreading saves character/location/prop edits as an immutable user revision with stable evidence and IDs', async () => {
  const { repository, service } = fixture();
  const { project, script, run, plan } = await prepared(service);
  const before = structuredClone(plan);
  const edits = [
    edit('character', plan.content.characters[0], { name: '林晚（女主）', aliases: ['晚晚'], description: '用户确认的角色说明。' }),
    edit('location', plan.content.locations[0], { name: '医院主楼走廊', aliases: ['长廊'], description: '用户补充的地点说明。' }),
    edit('prop', plan.content.props[0], { name: '白色信封', aliases: ['信件'], description: '用户确认的道具说明。' }),
  ];
  const saved = await service.createEntityEditCandidate(plan.id, { expectedActivePlanRevisionId: null, edits });

  assert.notEqual(saved.id, plan.id);
  assert.equal(saved.parentRevisionId, plan.id);
  assert.equal(saved.createdBy, 'user');
  assert.equal(saved.reason, 'manualEdit');
  assert.equal(saved.status, 'candidate');
  assert.equal(saved.projectId, project.id);
  assert.equal(saved.scriptVersionId, script.id);
  assert.equal(saved.runId, run.id);
  assert.equal(saved.attemptId, null, 'manual editing must not impersonate a model attempt');
  assert.deepEqual(saved.requirements, plan.requirements);
  assert.deepEqual(saved.content.synopsis, plan.content.synopsis);
  assert.deepEqual(saved.content.scenes, plan.content.scenes);
  assert.deepEqual(saved.content.dialogues, plan.content.dialogues);
  assert.deepEqual(saved.content.assetRequirements, []);
  for (const [index, field] of ['characters', 'locations', 'props'].entries()) {
    const actual = saved.content[field][0];
    assert.equal(actual.id, plan.content[field][0].id);
    assert.deepEqual(actual.sourceRefs, plan.content[field][0].sourceRefs);
    assert.equal(actual.name.value, edits[index].name);
    assert.equal(actual.name.origin, 'user');
    assert.deepEqual(actual.aliases.map((alias) => alias.value), edits[index].aliases);
    assert.ok(actual.aliases.every((alias) => alias.origin === 'user'));
    assert.equal(actual.description.value, edits[index].description);
    assert.equal(actual.description.origin, 'user');
    assert.deepEqual(lockedFields(saved, actual.id), ['aliases', 'description', 'name']);
    assert.ok(saved.content.manualLocks.filter((lock) => lock.targetId === actual.id)
      .every((lock) => lock.introducedInRevisionId === saved.id));
  }
  assert.deepEqual(await service.getPlanRevision(plan.id), before);
  assert.equal((await repository.getProject(project.id)).activePlanRevisionId, null, 'save is not adoption');
  assert.deepEqual((await service.listPlanRevisions(run.id)).map((item) => item.id).sort(), [plan.id, saved.id].sort());

  edits[0].name = 'mutated request';
  saved.content.characters[0].name.value = 'mutated response';
  assert.equal((await service.getPlanRevision(saved.id)).content.characters[0].name.value, '林晚（女主）');
});

test('entity proofreading preserves unchanged field origins and retains previous manual locks on later edits', async () => {
  const { service } = fixture();
  const { plan } = await prepared(service);
  const first = await service.createEntityEditCandidate(plan.id, requestFor(plan));
  const character = first.content.characters[0];
  assert.deepEqual(character.aliases, plan.content.characters[0].aliases);
  assert.deepEqual(character.description, plan.content.characters[0].description);
  assert.deepEqual(first.content.locations, plan.content.locations);
  assert.deepEqual(first.content.props, plan.content.props);
  assert.deepEqual(lockedFields(first, character.id), ['name']);
  const firstLock = structuredClone(first.content.manualLocks.find((lock) => lock.targetId === character.id));

  const second = await service.createEntityEditCandidate(first.id, {
    expectedActivePlanRevisionId: null, edits: [edit('character', character, { description: null })],
  });
  assert.equal(second.parentRevisionId, first.id);
  assert.deepEqual(second.content.characters[0].name, character.name);
  assert.equal(second.content.characters[0].description, null);
  assert.ok(second.content.manualLocks.some((lock) => JSON.stringify(lock) === JSON.stringify(firstLock)));
  assert.deepEqual(lockedFields(second, character.id), ['description', 'name']);
  assert.deepEqual((await service.getPlanRevision(first.id)).content.characters[0].description, plan.content.characters[0].description);
});

test('entity proofreading invalidates previous checks and requires checking the new revision before adoption', async () => {
  const { repository, service } = fixture();
  const { project, plan } = await prepared(service);
  const oldCheck = await service.checkPlan(plan.id);
  assert.equal(oldCheck.check.result, 'passed');
  await service.adoptPlan(project.id, { planRevisionId: plan.id, checkId: oldCheck.check.id, expectedActivePlanRevisionId: null });
  const revised = await service.createEntityEditCandidate(plan.id, requestFor(plan, {}, plan.id));
  assert.deepEqual(await service.listPlanChecks(revised.id), []);
  assert.equal((await repository.getProject(project.id)).activePlanRevisionId, plan.id);
  await assert.rejects(service.adoptPlan(project.id, {
    planRevisionId: revised.id, checkId: oldCheck.check.id, expectedActivePlanRevisionId: plan.id,
  }), (error) => error.status === 409);
  await adopt(service, project, revised, plan.id);
  assert.equal((await repository.getProject(project.id)).activePlanRevisionId, revised.id);
  assert.equal((await service.getPlanRevision(revised.id)).content.characters[0].name.origin, 'user');
  assert.deepEqual((await service.listPlanChecks(plan.id))[0], oldCheck.check);
});

test('entity proofreading preserves an unchanged alias and records later alias removal without losing evidence', async () => {
  const { service } = fixture();
  const { plan } = await prepared(service);
  const character = plan.content.characters[0];
  const first = await service.createEntityEditCandidate(plan.id, {
    expectedActivePlanRevisionId: null,
    edits: [edit('character', character, { aliases: ['小晚', '晚晚'] })],
  });
  assert.deepEqual(first.content.characters[0].aliases[0], character.aliases[0]);
  assert.equal(first.content.characters[0].aliases[1].origin, 'user');
  assert.deepEqual(lockedFields(first, character.id), ['aliases']);
  const second = await service.createEntityEditCandidate(first.id, {
    expectedActivePlanRevisionId: null,
    edits: [edit('character', first.content.characters[0], { aliases: [] })],
  });
  assert.deepEqual(second.content.characters[0].aliases, []);
  assert.deepEqual(second.content.characters[0].sourceRefs, character.sourceRefs);
  assert.deepEqual(lockedFields(second, character.id), ['aliases']);
  assert.ok(second.content.manualLocks.some((lock) => lock.targetId === character.id && lock.introducedInRevisionId === second.id));
  assert.equal((await service.getPlanRevision(first.id)).content.characters[0].aliases.length, 2);
});

test('entity proofreading does not normalize unchanged source names and aliases when only the description changes', async () => {
  const { service } = fixture();
  const { script, run } = await prepared(service);
  const candidate = facts(script);
  candidate.characters[0].name.value = ' 林晚 ';
  candidate.characters[0].aliases[0].value = ' 小晚 ';
  const plan = await service.createExtractFactsCandidate(run.id, candidate);
  const character = plan.content.characters[0];
  const revised = await service.createEntityEditCandidate(plan.id, {
    expectedActivePlanRevisionId: null,
    edits: [edit('character', character, { description: '仅修改人物说明。' })],
  });
  assert.deepEqual(revised.content.characters[0].name, character.name);
  assert.deepEqual(revised.content.characters[0].aliases, character.aliases);
  assert.equal(revised.content.characters[0].description.value, '仅修改人物说明。');
  assert.equal(revised.content.characters[0].description.origin, 'user');
  assert.deepEqual(lockedFields(revised, character.id), ['description']);
  assert.deepEqual((await service.getPlanRevision(plan.id)).content.characters[0], character);
});

test('entity proofreading HTTP saves and rereads a revision without model calls', async () => {
  const { service } = fixture();
  let modelCalls = 0;
  const app = await createApp(config, async () => { modelCalls += 1; throw new Error('no model call expected'); }, { breakdownService: service });
  const server = app.getHttpAdapter().getInstance();
  try {
    const { project, run, plan } = await prepared(service);
    const response = await server.inject({ method: 'POST', url: `/api/plan-revisions/${plan.id}/entity-edits`, headers, payload: requestFor(plan) });
    assert.equal(response.statusCode, 201, response.body);
    const saved = response.json();
    const fetched = await server.inject({ method: 'GET', url: `/api/plan-revisions/${saved.id}`, headers });
    assert.equal(fetched.statusCode, 200);
    assert.deepEqual(fetched.json(), saved);
    const listed = await server.inject({ method: 'GET', url: `/api/breakdown-runs/${run.id}/candidate-plan-revisions`, headers });
    assert.equal(listed.statusCode, 200);
    assert.ok(listed.json().items.some((item) => item.id === saved.id));
    const projectPlans = await server.inject({ method: 'GET', url: `/api/projects/${project.id}/plan-revisions`, headers });
    assert.equal(projectPlans.statusCode, 200);
    assert.deepEqual(projectPlans.json().items.map((item) => item.id), [plan.id, saved.id]);
    assert.equal(modelCalls, 0);
  } finally { await app.close(); }
});

test('entity proofreading rejects malformed HTTP payloads and attempts to replace source evidence', async () => {
  const { service } = fixture();
  const app = await createApp(config, undefined, { breakdownService: service });
  const server = app.getHttpAdapter().getInstance();
  try {
    const { run, plan } = await prepared(service);
    for (const mutate of [
      (value) => { delete value.expectedActivePlanRevisionId; },
      (value) => { value.unexpected = true; },
      (value) => { value.edits[0].kind = 'scene'; },
      (value) => { value.edits[0].name = 3; },
      (value) => { value.edits[0].name = ' \t\n'; },
      (value) => { value.edits[0].aliases = '别名'; },
      (value) => { value.edits[0].aliases = ['  ']; },
      (value) => { value.edits[0].description = {}; },
      (value) => { value.edits[0].description = '\n'; },
      (value) => { value.edits[0].sourceRefs = [{ ...plan.content.characters[0].sourceRefs[0], quote: '伪造原文' }]; },
      (value) => { value.edits[0].origin = 'source'; },
      (value) => { value.edits[0].id = 'character_replaced'; },
      (value) => { value.content = structuredClone(plan.content); },
    ]) {
      const payload = requestFor(plan);
      mutate(payload);
      const response = await server.inject({ method: 'POST', url: `/api/plan-revisions/${plan.id}/entity-edits`, headers, payload });
      assert.equal(response.statusCode, 400, response.body);
    }
    assert.equal((await service.listPlanRevisions(run.id)).length, 1);
  } finally { await app.close(); }
});

test('entity proofreading rejects invalid targets, duplicate edits and no-op requests without saving a revision', async () => {
  const { service } = fixture();
  const { run, plan } = await prepared(service);
  for (const mutate of [
    (value) => { value.edits[0].entityId = 'character_missing'; },
    (value) => { value.edits[0].kind = 'prop'; },
    (value) => { value.edits[0].aliases = ['同一个别名', ' 同一个别名 ']; },
    (value) => { value.edits.push(structuredClone(value.edits[0])); },
    (value) => { value.edits = [edit('character', plan.content.characters[0])]; },
  ]) {
    const payload = requestFor(plan);
    mutate(payload);
    await assert.rejects(service.createEntityEditCandidate(plan.id, payload), (error) => error.status === 422);
    assert.equal((await service.listPlanRevisions(run.id)).length, 1);
  }
});

test('entity proofreading detects two saves from the same base and permits continuing from the saved child', async () => {
  const { service } = fixture();
  const { run, plan } = await prepared(service);
  const results = await Promise.allSettled([
    service.createEntityEditCandidate(plan.id, requestFor(plan, { name: '第一次修改' })),
    service.createEntityEditCandidate(plan.id, requestFor(plan, { name: '另一个页面的修改' })),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
  const child = results.find((result) => result.status === 'fulfilled').value;
  assert.equal((await service.listPlanRevisions(run.id)).length, 2);
  await assert.rejects(service.createEntityEditCandidate(plan.id, requestFor(plan)), (error) => error.status === 409);
  const continued = await service.createEntityEditCandidate(child.id, requestFor(child, { name: '在最新校对版本上继续' }));
  assert.equal(continued.parentRevisionId, child.id);
  assert.equal((await service.listPlanRevisions(run.id)).length, 3);
});

test('entity proofreading rejects saves after the project switches to a new script', async () => {
  const { service } = fixture();
  const { project, run, plan } = await prepared(service);
  await service.createScriptVersion(project.id, { rawText: '第1场 新场景 日 内\n林晚：新版台词。' });
  await assert.rejects(service.createEntityEditCandidate(plan.id, requestFor(plan)), (error) => error.status === 409);
  assert.equal((await service.listPlanRevisions(run.id)).length, 1);
});

test('entity proofreading rejects stale adopted-plan pointers and pointers belonging to another project', async () => {
  const { service } = fixture();
  const own = await prepared(service);
  const other = await prepared(service);
  await adopt(service, own.project, own.plan);
  await assert.rejects(service.createEntityEditCandidate(own.plan.id, requestFor(own.plan)), (error) => error.status === 409);
  await assert.rejects(service.createEntityEditCandidate(own.plan.id, requestFor(own.plan, {}, other.plan.id)), (error) => error.status === 409);
  assert.equal((await service.listPlanRevisions(own.run.id)).length, 1);
  assert.equal((await service.listPlanRevisions(other.run.id)).length, 1);
  const saved = await service.createEntityEditCandidate(own.plan.id, requestFor(own.plan, {}, own.plan.id));
  assert.equal(saved.parentRevisionId, own.plan.id);
});

test('entity proofreading uses the latest project/script revision across runs instead of only the current run', async () => {
  const { service } = fixture();
  const { project, script, run, plan } = await prepared(service);
  const newerRun = await service.createDraftRun(project.id, {
    requirements: { language: '中文', visualStyle: '真人拟真', aspectRatio: '9:16' },
    maxModelCalls: 1, maxOutputTokens: 4096,
  });
  const newerPlan = await service.createExtractFactsCandidate(newerRun.id, facts(script));
  await assert.rejects(service.createEntityEditCandidate(plan.id, requestFor(plan)), (error) => error.status === 409);
  assert.equal((await service.listPlanRevisions(run.id)).length, 1);
  const revised = await service.createEntityEditCandidate(newerPlan.id, requestFor(newerPlan));
  assert.equal(revised.parentRevisionId, newerPlan.id);
  assert.equal(revised.runId, newerRun.id);
});

test('entity proofreading prevents rechecking and adopting older snapshots over newer manual work', async () => {
  const { repository, service } = fixture();
  const { project, plan } = await prepared(service);
  const first = await service.createEntityEditCandidate(plan.id, requestFor(plan));
  const latest = await service.createEntityEditCandidate(first.id, requestFor(first, { name: '最终校对名字' }));
  for (const stale of [plan, first]) {
    const rechecked = await service.checkPlan(stale.id);
    assert.equal(rechecked.check.result, 'passed');
    await assert.rejects(service.adoptPlan(project.id, {
      planRevisionId: stale.id, checkId: rechecked.check.id, expectedActivePlanRevisionId: null,
    }), (error) => error.status === 409);
    assert.equal((await repository.getProject(project.id)).activePlanRevisionId, null);
  }
  await adopt(service, project, latest);
  assert.equal((await repository.getProject(project.id)).activePlanRevisionId, latest.id);
  const oldCheck = await service.checkPlan(first.id);
  await assert.rejects(service.adoptPlan(project.id, {
    planRevisionId: first.id, checkId: oldCheck.check.id, expectedActivePlanRevisionId: latest.id,
  }), (error) => error.status === 409, 'refreshing the active pointer must not allow overwriting manual work with an older candidate');
});
