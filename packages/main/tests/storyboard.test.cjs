const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StoryboardService, validateStoryboardOutput } = require('../dist/breakdown/storyboard');
const { readConfig } = require('../dist/config');

const ref = { scriptVersionId: 'script_1', start: 0, end: 7, quote: '林晚：你来了。' };
const dialogueRef = { scriptVersionId: 'script_1', start: 3, end: 7, quote: '你来了。' };
const plan = { content: {
  scenes: [{ id: 'scene_1', order: 1, sourceRefs: [ref] }],
  dialogues: [{ id: 'dialogue_1', sceneId: 'scene_1', sourceRef: dialogueRef }],
} };
const candidate = { shots: [{ sceneId: 'scene_1', order: 1, visualDescription: '林晚中景',
  shotSize: '中景', cameraMovement: '固定', durationMs: 3000, sourceRefs: [ref], dialogueIds: ['dialogue_1'] }] };

test('unconfigured storyboard generation creates no execution rows and does not call any provider', async () => {
  let queries = 0;
  let calls = 0;
  const service = new StoryboardService({ async query() { queries++; throw new Error('must not touch DB'); } },
    { async getProject() { throw new Error('must fail before reading the project'); } },
    readConfig({}), async () => { calls++; throw new Error('must not call'); });
  await assert.rejects(service.generate('project_test'), error => error.status === 503 && error.code === 'MODEL_NOT_CONFIGURED');
  assert.equal(queries, 0);
  assert.equal(calls, 0);
});

test('storyboard design is marked as suggestion and every shot cites original source', () => {
  const [shot] = validateStoryboardOutput(candidate, plan, () => 'shot_test');
  assert.equal(shot.id, 'shot_test');
  assert.equal(shot.design.origin, 'designSuggestion');
  assert.deepEqual(shot.sourceRefs, [ref]);
});

test('storyboard rejects fabricated quote and missing dialogue', () => {
  const fake = structuredClone(candidate);
  fake.shots[0].sourceRefs[0].quote = '林晚：别走。';
  assert.throws(() => validateStoryboardOutput(fake, plan), { code: 'STORYBOARD_SOURCE_INVALID' });
  const missing = structuredClone(candidate);
  missing.shots[0].dialogueIds = [];
  assert.throws(() => validateStoryboardOutput(missing, plan), { code: 'STORYBOARD_COVERAGE_INCOMPLETE' });
});

function orderedFixture() {
  const sourceRef = (start, quote) => ({ scriptVersionId: 'script_1', start,
    end: start + Array.from(quote).length, quote });
  const sceneOne = sourceRef(0, '林晚：你😀来了。\n周宁：我来了。');
  const sceneTwo = sourceRef(sceneOne.end + 1, '林晚：走吧。');
  const lines = [sourceRef(3, '你😀来了。'), sourceRef(12, '我来了。'), sourceRef(sceneTwo.start + 3, '走吧。')];
  const orderedPlan = { content: {
    scenes: [{ id: 'scene_1', order: 1, sourceRefs: [sceneOne] },
      { id: 'scene_2', order: 2, sourceRefs: [sceneTwo] }],
    dialogues: lines.map((sourceRef, index) => ({ id: `dialogue_${index + 1}`,
      sceneId: index < 2 ? 'scene_1' : 'scene_2', sourceRef })),
  } };
  const orderedCandidate = { shots: lines.map((_, index) => ({
    ...candidate.shots[0], sceneId: index < 2 ? 'scene_1' : 'scene_2', order: index < 2 ? index + 1 : 1,
    sourceRefs: [index < 2 ? sceneOne : sceneTwo], dialogueIds: [`dialogue_${index + 1}`],
  })) };
  return { orderedPlan, orderedCandidate };
}

test('storyboard preserves source dialogue order across shots and permits silent shots', () => {
  const { orderedPlan, orderedCandidate } = orderedFixture();
  orderedCandidate.shots.unshift({ ...orderedCandidate.shots[0], dialogueIds: [] });
  orderedCandidate.shots[1].order = 2;
  orderedCandidate.shots[2].order = 3;
  const shots = validateStoryboardOutput(orderedCandidate, orderedPlan);
  assert.deepEqual(shots.flatMap(shot => shot.dialogueIds), ['dialogue_1', 'dialogue_2', 'dialogue_3']);
});

test('storyboard rejects reversed dialogue across shots even when coverage is complete', () => {
  const { orderedPlan, orderedCandidate } = orderedFixture();
  orderedCandidate.shots[0].dialogueIds = ['dialogue_2'];
  orderedCandidate.shots[1].dialogueIds = ['dialogue_1'];
  assert.throws(() => validateStoryboardOutput(orderedCandidate, orderedPlan),
    { code: 'STORYBOARD_DIALOGUE_ORDER_INVALID' });
});

test('storyboard rejects reversed dialogue inside one shot', () => {
  const { orderedPlan, orderedCandidate } = orderedFixture();
  orderedCandidate.shots[0].dialogueIds = ['dialogue_2', 'dialogue_1'];
  orderedCandidate.shots.splice(1, 1);
  assert.throws(() => validateStoryboardOutput(orderedCandidate, orderedPlan),
    { code: 'STORYBOARD_DIALOGUE_ORDER_INVALID' });
  orderedCandidate.shots[0].dialogueIds.reverse();
  assert.doesNotThrow(() => validateStoryboardOutput(orderedCandidate, orderedPlan));
});

test('storyboard rejects reversed or interleaved scene playback', () => {
  const { orderedPlan, orderedCandidate } = orderedFixture();
  const [first, second, third] = orderedCandidate.shots;
  for (const shots of [[third, first, second], [first, third, second]]) {
    assert.throws(() => validateStoryboardOutput({ shots }, orderedPlan),
      { code: 'STORYBOARD_SCENE_ORDER_INVALID' });
  }
});

test('storyboard scene order also applies when scenes contain no dialogue', () => {
  const { orderedPlan, orderedCandidate } = orderedFixture();
  orderedPlan.content.dialogues = [];
  for (const shot of orderedCandidate.shots) shot.dialogueIds = [];
  orderedCandidate.shots.reverse();
  orderedCandidate.shots[1].order = 1;
  orderedCandidate.shots[2].order = 2;
  assert.throws(() => validateStoryboardOutput(orderedCandidate, orderedPlan),
    { code: 'STORYBOARD_SCENE_ORDER_INVALID' });
});

test('storyboard follows adopted scene order rather than imposing a global source offset order', () => {
  const { orderedPlan, orderedCandidate } = orderedFixture();
  orderedPlan.content.scenes[0].order = 2;
  orderedPlan.content.scenes[1].order = 1;
  const [firstLine, secondLine, thirdLine] = orderedPlan.content.dialogues;
  orderedPlan.content.dialogues = [thirdLine, firstLine, secondLine];
  const [first, second, third] = orderedCandidate.shots;
  assert.doesNotThrow(() => validateStoryboardOutput({ shots: [third, first, second] }, orderedPlan));
});

function storedStoryboardFixture(validatorVersion = 'storyboard-validator/1', beforeTransaction = () => {}) {
  const { orderedPlan, orderedCandidate } = orderedFixture();
  const row = { id: 'storyboard_1', project_id: 'project_1', script_version_id: 'script_1',
    source_plan_revision_id: 'plan_1', attempt_id: 'attempt_1',
    content_json: { validatorVersion, shots: orderedCandidate.shots.map((shot, index) => ({
      id: `shot_saved_${index}`, sceneId: shot.sceneId, order: shot.order,
      design: { origin: 'designSuggestion', visualDescription: shot.visualDescription,
        shotSize: shot.shotSize, cameraMovement: shot.cameraMovement, durationMs: shot.durationMs },
      sourceRefs: shot.sourceRefs, dialogueIds: shot.dialogueIds,
    })) }, input_digest: 'digest', prompt_version: 'storyboard-design/1', model: 'test-model',
    provider_request_id: null, usage_json: null, created_at: '2026-10-22T00:00:00.000Z' };
  const writes = [];
  const project = { current_script_version_id: 'script_1', active_plan_revision_id: 'plan_1',
    active_storyboard_revision_id: null };
  let transactionActive = false;
  const database = { async query(sql, values) {
    if (sql.startsWith('SELECT current_script_version_id')) return { rows: [project] };
    if (sql.startsWith('SELECT * FROM storyboard_revisions')) return { rows: [row] };
    writes.push({ sql, values });
    return { rows: [] };
  }, async transaction(operation) {
    beforeTransaction(project);
    transactionActive = true;
    try { return await operation(this); }
    finally { transactionActive = false; }
  } };
  const breakdown = { async getPlanRevision(id) {
    assert.equal(transactionActive, false, 'Plan reads must not acquire a second pool connection during adoption');
    assert.equal(id, 'plan_1');
    return orderedPlan;
  } };
  const service = new StoryboardService(database, breakdown, {}, () => { throw new Error('Unexpected model call'); });
  return { row, service, writes };
}

test('storyboard keeps legacy versions readable and preserves their shot IDs on adoption', async () => {
  for (const version of ['storyboard-validator/1', 'storyboard-validator/2']) {
    const { row, service, writes } = storedStoryboardFixture(version);
    const original = structuredClone(row);
    assert.deepEqual((await service.get('storyboard_1')).shots, row.content_json.shots);
    await service.adopt('project_1', 'storyboard_1', null);
    assert.deepEqual(row, original);
    assert.equal(writes.length, 2);
    assert.ok(writes.every(({ sql }) => !sql.includes('UPDATE storyboard_revisions')));
  }
});

test('storyboard adoption rechecks legacy dialogue order before changing the adopted pointer', async () => {
  const { row, service, writes } = storedStoryboardFixture();
  row.content_json.shots[0].dialogueIds = ['dialogue_2'];
  row.content_json.shots[1].dialogueIds = ['dialogue_1'];
  assert.deepEqual((await service.get('storyboard_1')).shots, row.content_json.shots);
  await assert.rejects(service.adopt('project_1', 'storyboard_1', null),
    { code: 'STORYBOARD_DIALOGUE_ORDER_INVALID' });
  assert.deepEqual(writes, []);
});

test('storyboard adoption still rejects project changes after immutable revision preflight', async () => {
  for (const [field, value, code] of [
    ['current_script_version_id', 'script_2', 'STORYBOARD_NOT_ADOPTABLE'],
    ['active_plan_revision_id', 'plan_2', 'STORYBOARD_NOT_ADOPTABLE'],
    ['active_storyboard_revision_id', 'storyboard_2', 'STORYBOARD_ADOPTION_CONFLICT'],
  ]) {
    const { service, writes } = storedStoryboardFixture('storyboard-validator/1', project => {
      project[field] = value;
    });
    await assert.rejects(service.adopt('project_1', 'storyboard_1', null), { code });
    assert.deepEqual(writes, []);
  }
});
