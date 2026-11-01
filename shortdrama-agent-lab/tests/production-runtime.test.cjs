const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compileProductionRun } = require('../dist/production/blueprint');
const {
  BreakdownProductionExecutor, StoryboardProductionExecutor, VideoProductionExecutor,
} = require('../dist/production/runtime');
const { ProductionMediaError } = require('../dist/production-media/contracts');
const { PaidModelExecutionError } = require('../dist/breakdown/errors');

const request = (changes = {}) => ({
  projectId: 'project_0123456789abcdef0123456789abcdef',
  scriptVersionId: 'script_0123456789abcdef0123456789abcdef',
  ratio: '9:16', targetDurationSec: 90, visualStyle: '冷色现实主义', qualityPreset: 'balanced',
  automationMode: 'auto', candidatePolicy: 'gacha', candidateLimit: 2, directorPolicy: 'auto', budgetMicros: 10_000_000,
  currency: 'CNY', allowPaid: true, clientRequestId: 'runtime-test', ...changes,
});

function runFor(changes = {}) {
  return compileProductionRun(request(changes), '2026-10-23T12:00:00.000Z', `production_${changes.clientRequestId ?? 'runtime'}`);
}

function context(run, stage, overrides = {}) {
  const task = overrides.task ?? run.tasks.find(item => item.stage === stage);
  return { run, task, attemptId: 'attempt_1', inputDigest: 'a'.repeat(64), operationKey: 'b'.repeat(64), ...overrides };
}

function plan() {
  return { id: 'plan_1', projectId: request().projectId, scriptVersionId: request().scriptVersionId,
    content: { synopsis: '检验用剧情', characters: [{ id: 'character_1' }], locations: [{ id: 'location_1' }],
      props: [{ id: 'prop_1' }], scenes: [{ id: 'scene_1' }], dialogues: [] } };
}

function breakdownFixture(mode = 'auto') {
  const candidate = plan();
  const check = { id: 'check_1', projectId: candidate.projectId, planRevisionId: candidate.id,
    ruleVersion: 'extract-facts-completeness/2', result: 'passed', issueIds: [] };
  const project = { id: candidate.projectId, currentScriptVersionId: candidate.scriptVersionId,
    activePlanRevisionId: null, activeStoryboardRevisionId: null };
  const draft = { id: 'breakdown_run_1', status: 'draft', task: { state: 'pending' } };
  const adoptions = [];
  const breakdown = {
    async getProject() { return { ...project }; }, async getPlanRevision() { return candidate; },
    async createDraftRun() { return draft; }, async getRun() { return draft; },
    async listPlanRevisions() { return [candidate]; }, async listPlanChecks() { return [check]; },
    async checkPlan() { return { check, issues: [] }; },
    async adoptPlan(_projectId, input) { adoptions.push({ ...input, actor: input.actor ?? 'user' }); project.activePlanRevisionId = input.planRevisionId; },
  };
  let runnerCalls = 0;
  const runner = { async run() { runnerCalls++; draft.status = 'waiting'; draft.task.state = 'waitingHuman'; return { plan: candidate }; } };
  const run = runFor({ automationMode: mode, clientRequestId: `breakdown-${mode}` });
  return { candidate, check, project, draft, adoptions, breakdown, runner, run, calls: () => runnerCalls };
}

test('an in-flight breakdown submit stays unknown and is not sent again', async () => {
  const f = breakdownFixture('auto');
  f.draft.status = 'running'; f.draft.task.state = 'running';
  const executor = new BreakdownProductionExecutor(f.breakdown, f.runner, { estimateCostMicros: 200 });
  const running = await executor.reconcile(context(f.run, 'breakdown'), { providerTaskId: f.draft.id });
  assert.equal(running.state, 'waitingHuman'); assert.equal(running.operationUnknown, true);
  assert.equal(running.issue.code, 'BREAKDOWN_SUBMISSION_UNKNOWN');
  const missing = await executor.reconcile(context(f.run, 'breakdown'), { providerTaskId: null });
  assert.equal(missing.operationUnknown, true); assert.equal(missing.issue.code, 'BREAKDOWN_RUN_ID_MISSING');
  assert.equal(f.calls(), 0);
});

test('breakdown adapter persists a draft boundary, auto-adopts checked output, and is replay-idempotent', async () => {
  const f = breakdownFixture('auto');
  const executor = new BreakdownProductionExecutor(f.breakdown, f.runner, { estimateCostMicros: 200 });
  const prepared = await executor.prepare(context(f.run, 'breakdown'));
  assert.equal(prepared.requiresPaid, true);
  const submitted = await executor.execute(context(f.run, 'breakdown'));
  assert.deepEqual(submitted, { state: 'waitingExternal', providerTaskId: f.draft.id });
  const completed = await executor.reconcile(context(f.run, 'breakdown'), { providerTaskId: f.draft.id });
  assert.equal(completed.state, 'succeeded'); assert.equal(completed.artifacts[0].metadata.adopted, true);
  assert.equal(completed.actualCostMicros, 200);
  assert.equal(f.calls(), 1); assert.equal(f.adoptions.length, 1); assert.equal(f.adoptions[0].actor, 'agent');
  const replay = await executor.reconcile(context(f.run, 'breakdown'), { providerTaskId: f.draft.id });
  assert.equal(replay.state, 'succeeded'); assert.equal(f.adoptions.length, 1); assert.equal(f.calls(), 1);
});

test('breakdown checkpoint waits for a human and its review hook adopts as user', async () => {
  const f = breakdownFixture('checkpoints');
  const executor = new BreakdownProductionExecutor(f.breakdown, f.runner, { estimateCostMicros: 200 });
  await executor.execute(context(f.run, 'breakdown'));
  const outcome = await executor.reconcile(context(f.run, 'breakdown'), { providerTaskId: f.draft.id });
  assert.equal(outcome.state, 'waitingHuman'); assert.equal(f.adoptions.length, 0);
  assert.equal(outcome.actualCostMicros, 200);
  const task = f.run.tasks.find(item => item.stage === 'breakdown');
  f.run.artifacts.push({ id: 'artifact_plan', runId: f.run.id, taskId: task.id, kind: 'text', title: '拆解', uri: null,
    sha256: null, metadata: { ...outcome.artifacts[0].metadata, key: 'breakdown-plan' }, status: 'current', createdAt: f.run.createdAt });
  await executor.review({ run: f.run, task, input: { taskId: task.id, decision: 'approve', issueId: null, candidateId: null, feedback: '' } });
  assert.equal(f.adoptions.length, 1); assert.equal(f.adoptions[0].actor, 'user');
});

function storyboardRevision() {
  return { id: 'storyboard_1', projectId: request().projectId, scriptVersionId: request().scriptVersionId,
    sourcePlanRevisionId: 'plan_1', attemptId: 'storyboard_attempt_1', inputDigest: 'c'.repeat(64),
    promptVersion: 'storyboard-design/1', model: 'fake', providerRequestId: 'provider_1', usage: null,
    createdAt: '2026-10-23T12:00:00.000Z', shots: [
      { id: 'shot_real_1', sceneId: 'scene_real_1', order: 1, design: { origin: 'designSuggestion',
        visualDescription: '主角走进雨巷', shotSize: '中景', cameraMovement: '跟拍', durationMs: 5000 }, sourceRefs: [], dialogueIds: [] },
      { id: 'shot_real_2', sceneId: 'scene_real_1', order: 2, design: { origin: 'designSuggestion',
        visualDescription: '主角回头', shotSize: '近景', cameraMovement: '固定', durationMs: 4000 }, sourceRefs: [], dialogueIds: [] },
    ] };
}

test('storyboard auto mode adopts as agent and expands every real shot and candidate without a disabled director', async () => {
  const board = storyboardRevision();
  const project = { id: board.projectId, currentScriptVersionId: board.scriptVersionId,
    activePlanRevisionId: board.sourcePlanRevisionId, activeStoryboardRevisionId: null };
  const adopted = [];
  const breakdown = { async getProject() { return { ...project }; } };
  const storyboards = { async get() { return board; }, async generate() { return board; },
    async adopt(_project, revision, expected, actor = 'user') { adopted.push({ revision, expected, actor }); project.activeStoryboardRevisionId = revision; } };
  const run = runFor({ directorPolicy: 'never', candidateLimit: 3, clientRequestId: 'storyboard-auto' });
  const executor = new StoryboardProductionExecutor(breakdown, storyboards, { estimateCostMicros: 300 });
  const outcome = await executor.execute(context(run, 'storyboard'));
  assert.equal(outcome.state, 'succeeded'); assert.equal(adopted[0].actor, 'agent');
  assert.equal(outcome.actualCostMicros, 300);
  assert.equal(outcome.spawnTasks.filter(task => task.stage === 'director').length, 0);
  assert.equal(outcome.spawnTasks.filter(task => task.stage === 'video').length, board.shots.length * 3);
  for (const shot of board.shots) {
    const videos = outcome.spawnTasks.filter(task => task.stage === 'video' && task.scope.id === shot.id);
    const candidates = outcome.spawnTasks.find(task => task.stage === 'candidates' && task.scope.id === shot.id);
    assert.equal(videos.length, 3); assert.deepEqual(new Set(candidates.dependsOn), new Set(videos.map(task => task.key)));
    assert.ok(outcome.spawnTasks.filter(task => task.scope.id === shot.id).every(task => task.scope.id === shot.id));
  }
});

test('storyboard direct policy expands exactly one video per shot with no gacha task', async () => {
  const board = storyboardRevision();
  const project = { id: board.projectId, currentScriptVersionId: board.scriptVersionId,
    activePlanRevisionId: board.sourcePlanRevisionId, activeStoryboardRevisionId: null };
  const adopted = [];
  const breakdown = { async getProject() { return { ...project }; } };
  const storyboards = { async get() { return board; }, async generate() { return board; },
    async adopt(_project, revision, expected, actor = 'user') { adopted.push({ revision, expected, actor }); project.activeStoryboardRevisionId = revision; } };
  const run = runFor({ directorPolicy: 'never', candidatePolicy: 'direct', candidateLimit: 1, clientRequestId: 'storyboard-direct' });
  const executor = new StoryboardProductionExecutor(breakdown, storyboards, { estimateCostMicros: 300 });
  const outcome = await executor.execute(context(run, 'storyboard'));
  assert.equal(outcome.state, 'succeeded');
  assert.equal(outcome.spawnTasks.filter(task => task.stage === 'candidates').length, 0);
  assert.equal(outcome.spawnTasks.filter(task => task.stage === 'video').length, board.shots.length);
  for (const shot of board.shots) {
    const videos = outcome.spawnTasks.filter(task => task.stage === 'video' && task.scope.id === shot.id);
    const review = outcome.spawnTasks.find(task => task.stage === 'review' && task.scope.id === shot.id);
    assert.equal(videos.length, 1);
    assert.equal(videos[0].label.endsWith('视频'), true);
    assert.deepEqual(review.dependsOn, [videos[0].key]);
  }
});

test('storyboard checkpoint adopts only through the user review hook', async () => {
  const board = storyboardRevision(); const adopted = [];
  const project = { id: board.projectId, currentScriptVersionId: board.scriptVersionId,
    activePlanRevisionId: board.sourcePlanRevisionId, activeStoryboardRevisionId: null };
  const executor = new StoryboardProductionExecutor({ async getProject() { return { ...project }; } }, {
    async get() { return board; }, async generate() { return board; },
    async adopt(_project, revision, expected, actor = 'user') { adopted.push({ revision, expected, actor }); project.activeStoryboardRevisionId = revision; },
  }, { estimateCostMicros: 300 });
  const run = runFor({ automationMode: 'checkpoints', clientRequestId: 'storyboard-checkpoint' });
  const outcome = await executor.execute(context(run, 'storyboard'));
  assert.equal(outcome.state, 'waitingHuman'); assert.equal(adopted.length, 0);
  assert.equal(outcome.actualCostMicros, 300);
  const task = run.tasks.find(item => item.stage === 'storyboard');
  run.artifacts.push({ id: 'artifact_board', runId: run.id, taskId: task.id, kind: 'text', title: '分镜', uri: null, sha256: null,
    metadata: { ...outcome.artifacts[0].metadata, key: 'storyboard' }, status: 'current', createdAt: run.createdAt });
  await executor.review({ run, task, input: { taskId: task.id, decision: 'approve', issueId: null, candidateId: null, feedback: '' } });
  assert.equal(adopted[0].actor, 'user');
});

test('paid model failures distinguish confirmed cost, uncertain submission, and pre-call failure', async () => {
  const project = { activePlanRevisionId: 'plan_1', activeStoryboardRevisionId: null,
    currentScriptVersionId: request().scriptVersionId };
  for (const [paidModelCallState, expected] of [
    ['confirmed', { state: 'failed', actualCostMicros: 300 }],
    ['unknown', { state: 'waitingHuman', operationUnknown: true }],
    ['none', { state: 'failed', actualCostMicros: 0, retryable: true }],
  ]) {
    const run = runFor({ clientRequestId: `paid-${paidModelCallState}` });
    const storyboards = { async get() { throw new Error('not adopted'); },
      async generate() { throw new PaidModelExecutionError(422, 'MODEL_OUTPUT_INVALID', '模型输出无效。', paidModelCallState); },
      async adopt() { throw new Error('must not adopt'); } };
    const executor = new StoryboardProductionExecutor({ async getProject() { return project; } }, storyboards,
      { estimateCostMicros: 300 });
    const outcome = await executor.execute(context(run, 'storyboard'));
    assert.equal(outcome.state, expected.state);
    if ('actualCostMicros' in expected) assert.equal(outcome.actualCostMicros, expected.actualCostMicros);
    if ('retryable' in expected) assert.equal(outcome.retryable, expected.retryable);
    if ('operationUnknown' in expected) {
      assert.equal(outcome.operationUnknown, true); assert.equal(outcome.issue.code, 'MODEL_EXECUTION_UNKNOWN');
      assert.equal('actualCostMicros' in outcome, false);
    }
  }
});

function localVideo() {
  return { schemaVersion: 'production-local-video/1', id: `media_${'d'.repeat(64)}`, sha256: 'd'.repeat(64), bytes: 100,
    mimeType: 'video/mp4', relativePath: 'objects/dd/file.mp4', sourceKind: 'providerDownload', createdAt: '2026-10-23T12:00:00.000Z',
    probe: { container: 'mp4', durationSeconds: 5.1, width: 1080, height: 1920, videoCodec: 'h264', hasAudio: false, audioCodec: null } };
}

const ASSET_ONE = `asset_${'a'.repeat(32)}`;
const ASSET_TWO = `asset_${'b'.repeat(32)}`;

function videoFixture() {
  const board = storyboardRevision(); const run = runFor({ candidatePolicy: 'gacha', candidateLimit: 2, clientRequestId: 'video-runtime' });
  const base = run.tasks.find(item => item.stage === 'video');
  const task = { ...base, id: 'ptask_video_candidate_1', label: '场 1 · 镜 1 视频候选 2', scope: { kind: 'shot', id: board.shots[0].id },
    inputManifest: [...base.inputManifest, { kind: 'dynamicScope', id: board.shots[0].id,
      revisionId: `shot-1-${board.shots[0].id}-video-candidate-1`, digest: 'e'.repeat(64) }] };
  run.tasks.push(task);
  run.artifacts.push({ id: 'artifact_storyboard', runId: run.id, taskId: run.tasks.find(item => item.stage === 'storyboard').id,
    kind: 'text', title: '已采用分镜', uri: null, sha256: null, status: 'current', createdAt: run.createdAt,
    metadata: { key: 'storyboard', storyboardRevisionId: board.id, adopted: true } });
  run.artifacts.push({ id: 'artifact_asset_bindings', runId: run.id, taskId: 'ptask_asset_bindings', kind: 'report',
    title: '镜头资产绑定', uri: null, sha256: null, status: 'current', createdAt: run.createdAt,
    metadata: { key: 'shot-asset-bindings', shotId: board.shots[0].id, missingEntityIds: [], bindings: [
      { entityId: 'character_1', kind: 'character', entityName: '林晚', assetId: ASSET_ONE },
      { entityId: 'location_1', kind: 'location', entityName: '雨巷', assetId: ASSET_TWO },
      { entityId: 'prop_1', kind: 'prop', entityName: '雨伞', assetId: ASSET_ONE },
    ] } });
  run.artifacts.push({ id: 'artifact_director_scene', runId: run.id, taskId: 'ptask_director', kind: 'directorScene',
    title: '3D 白模', uri: null, sha256: null, status: 'current', createdAt: run.createdAt, metadata: { key: 'director-shot', snapshot: {
      activeCameraId: 'camera_main', aspectRatio: '9:16', provenance: { shotId: board.shots[0].id },
      cameras: [{ id: 'camera_main', name: '主机位', focalLength: 50, target: { x: 0, y: 1.2, z: 0 },
        transform: { position: { x: 1, y: 1.6, z: 4 } }, provenance: { cameraMovement: '跟拍' } }],
      objects: [{ id: 'actor_1', type: 'mannequin', name: '林晚', transform: {
        position: { x: -0.5, y: 0.1, z: 0.2 }, rotation: { x: 0, y: 0.18, z: 0 } }, pose: { preset: 'turn' } }],
    } } });
  const project = { activeStoryboardRevisionId: board.id };
  return { board, run, task, project };
}

test('video adapter submits once, reconciles, and exposes only verified local media metadata', async () => {
  const f = videoFixture(); let creates = 0; let ingests = 0; let createdRequest;
  const pending = { id: 'video_run_1', status: 'waitingExternal', model: 'video-model', modelConnectionRevision: 'revision_1', result: null, error: null };
  const completed = { ...pending, status: 'completed', result: { videoUrl: 'https://cdn.example.com/video.mp4' } };
  const videos = { async status() { return { available: true, busy: false, connectionRevision: 'revision_1' }; },
    async create(value) { creates++; createdRequest = value; return pending; }, async get() { return completed; }, async reconcile() { return completed; } };
  const executor = new VideoProductionExecutor({ async getProject() { return f.project; } }, { async get() { return f.board; } }, videos,
    { estimateCostMicros: 500, mediaIngestor: { async ingestProviderUrl() { ingests++; return localVideo(); } } });
  const prepared = await executor.prepare({ run: f.run, task: f.task });
  const ctx = context(f.run, 'video', { task: f.task, inputDigest: prepared.inputDigest });
  const submitted = await executor.execute(ctx);
  assert.equal(submitted.state, 'waitingExternal'); assert.equal(creates, 1); assert.equal(createdRequest.allowPaid, true);
  assert.equal(createdRequest.generateAudio, true);
  assert.deepEqual(createdRequest.referenceAssetIds, [ASSET_ONE, ASSET_TWO]);
  assert.match(createdRequest.prompt, /图片1：角色「林晚」、道具「雨伞」/);
  assert.match(createdRequest.prompt, /3D 白模构图约束/);
  assert.match(createdRequest.prompt, /人物站位：林晚/);
  const outcome = await executor.reconcile(ctx, { providerTaskId: pending.id });
  assert.equal(outcome.state, 'succeeded'); assert.equal(creates, 1); assert.equal(ingests, 1);
  const artifact = outcome.artifacts[0];
  assert.equal(artifact.uri, `/api/production-media/${localVideo().id}`); assert.equal(artifact.sha256, localVideo().sha256);
  assert.deepEqual({ mediaId: artifact.metadata.mediaId, shotId: artifact.metadata.shotId,
    candidateIndex: artifact.metadata.candidateIndex, storyboardRevisionId: artifact.metadata.storyboardRevisionId,
    durationSeconds: artifact.metadata.durationSeconds, width: artifact.metadata.width,
    height: artifact.metadata.height, hasAudio: artifact.metadata.hasAudio }, {
    mediaId: localVideo().id, shotId: f.board.shots[0].id, candidateIndex: 1, storyboardRevisionId: f.board.id,
    durationSeconds: 5.1, width: 1080, height: 1920, hasAudio: false,
  });
  assert.equal(artifact.metadata.directorConstraintMode, 'prompt-only');
  assert.equal(artifact.metadata.directorSceneArtifactId, 'artifact_director_scene');
  assert.equal('remoteTemporaryUrl' in artifact.metadata, false);
});

test('video localization retry reuses the completed provider run without another paid submission', async () => {
  const f = videoFixture(); let creates = 0; let ingests = 0; let statusCalls = 0;
  const completed = { id: 'video_run_done', status: 'completed', model: 'video-model', modelConnectionRevision: 'revision_1',
    result: { videoUrl: 'https://cdn.example.com/video.mp4' }, error: null };
  const videos = { async status() { statusCalls++; return { available: true, busy: false, connectionRevision: 'revision_1' }; },
    async create() { creates++; return completed; }, async get() { return completed; }, async reconcile() { return completed; } };
  const mediaIngestor = { async ingestProviderUrl() { ingests++; if (ingests === 1) {
    throw new ProductionMediaError(502, 'REMOTE_MEDIA_FETCH_FAILED', '下载失败');
  } return localVideo(); } };
  const executor = new VideoProductionExecutor({ async getProject() { return f.project; } }, { async get() { return f.board; } }, videos,
    { estimateCostMicros: 500, mediaIngestor });
  const firstPrepared = await executor.prepare({ run: f.run, task: f.task });
  let ctx = context(f.run, 'video', { task: f.task, inputDigest: firstPrepared.inputDigest });
  const blocked = await executor.execute(ctx);
  assert.equal(blocked.state, 'waitingHuman'); assert.equal(creates, 1);
  f.run.artifacts.push({ id: 'provider_ref', runId: f.run.id, taskId: f.task.id, kind: 'report', title: '待入库', uri: null,
    sha256: null, metadata: { ...blocked.artifacts[0].metadata, key: 'provider-video-result' }, status: 'superseded', createdAt: f.run.createdAt });
  const prepared = await executor.prepare({ run: f.run, task: f.task });
  assert.equal(prepared.requiresPaid, false); assert.equal(statusCalls, 2);
  ctx = { ...ctx, operationKey: null };
  const recovered = await executor.execute(ctx);
  assert.equal(recovered.state, 'succeeded'); assert.equal(recovered.actualCostMicros, 0);
  assert.equal(creates, 1); assert.equal(ingests, 2);
});

test('video references and repair requirements are frozen into a changed paid prompt before submission', async () => {
  const f = videoFixture(); let creates = 0; const requests = [];
  const pending = { id: 'video_repair_1', status: 'waitingExternal', model: 'video-model',
    modelConnectionRevision: 'revision_1', result: null, error: null };
  const videos = { async status() { return { available: true, busy: false, connectionRevision: 'revision_1' }; },
    async create(value) { creates++; requests.push(value); return pending; }, async get() { return pending; }, async reconcile() { return pending; } };
  const executor = new VideoProductionExecutor({ async getProject() { return f.project; } }, { async get() { return f.board; } }, videos,
    { estimateCostMicros: 500, mediaIngestor: { async ingestProviderUrl() { return localVideo(); } } });
  const initialPrepared = await executor.prepare({ run: f.run, task: f.task });
  const initial = await executor.execute(context(f.run, 'video', { task: f.task, inputDigest: initialPrepared.inputDigest }));
  assert.equal(initial.state, 'waitingExternal');

  const parentTaskId = 'ptask_failed_review';
  const repairTask = { ...f.task, id: 'ptask_repair_video', dependencies: [parentTaskId],
    inputManifest: [...f.task.inputManifest, { kind: 'dynamicScope', id: f.task.scope.id,
      revisionId: `repair-${f.task.scope.id}-1-video`, digest: 'f'.repeat(64) }] };
  f.run.tasks.push(repairTask);
  f.run.artifacts.push({ id: 'artifact_repair_report', runId: f.run.id, taskId: parentTaskId, kind: 'report',
    title: '返修报告', uri: null, sha256: null, status: 'current', createdAt: f.run.createdAt,
    metadata: { key: 'repair-report', shotId: f.task.scope.id, repairRound: 1, issues: ['未检测到音轨', '时长偏短'] } });
  f.run.qualityChecks.push({ id: 'check_repair', runId: f.run.id, taskId: parentTaskId, level: 'shot', result: 'fail',
    ruleVersion: 'local-shot-media/1', summary: '需返修', issues: ['未检测到音轨'], createdAt: f.run.createdAt });
  const repairPrepared = await executor.prepare({ run: f.run, task: repairTask });
  assert.notEqual(repairPrepared.inputDigest, initialPrepared.inputDigest);
  const repaired = await executor.execute(context(f.run, 'video', { task: repairTask, inputDigest: repairPrepared.inputDigest }));
  assert.equal(repaired.state, 'waitingExternal'); assert.equal(creates, 2);
  assert.match(requests[1].prompt, /返修要求（第 1 轮）/);
  assert.match(requests[1].prompt, /必须修复：未检测到音轨/);
  assert.notEqual(requests[1].prompt, requests[0].prompt);
});

test('missing, incomplete, or excessive shot asset bindings block before paid video creation', async () => {
  for (const mutate of [
    run => { run.artifacts = run.artifacts.filter(item => item.metadata.key !== 'shot-asset-bindings'); },
    run => { run.artifacts.find(item => item.metadata.key === 'shot-asset-bindings').metadata.missingEntityIds = ['character_2']; },
    run => { run.artifacts.find(item => item.metadata.key === 'shot-asset-bindings').metadata.bindings = Array.from({ length: 31 }, (_, index) => ({
      entityId: `prop_${index}`, kind: 'prop', entityName: `道具${index}`, assetId: `asset_${index.toString(16).padStart(32, '0')}` })); },
  ]) {
    const f = videoFixture(); mutate(f.run); let creates = 0;
    const videos = { async status() { return { available: true, busy: false, connectionRevision: 'revision_1' }; },
      async create() { creates++; throw new Error('must not create'); }, async get() {}, async reconcile() {} };
    const executor = new VideoProductionExecutor({ async getProject() { return f.project; } }, { async get() { return f.board; } }, videos,
      { estimateCostMicros: 500, mediaIngestor: { async ingestProviderUrl() { return localVideo(); } } });
    const prepared = await executor.prepare({ run: f.run, task: f.task });
    assert.equal(prepared.requiresPaid, false);
    const outcome = await executor.execute(context(f.run, 'video', { task: f.task, inputDigest: prepared.inputDigest, operationKey: null }));
    assert.equal(outcome.state, 'blocked'); assert.equal(creates, 0);
  }
});

test('a busy local video slot defers without reserving budget or consuming an attempt', async () => {
  const f = videoFixture(); let creates = 0;
  const videos = { async status() { return { available: true, busy: true, connectionRevision: 'revision_1' }; },
    async create() { creates++; throw new Error('must stay deferred'); }, async get() {}, async reconcile() {} };
  const executor = new VideoProductionExecutor({ async getProject() { return f.project; } }, { async get() { return f.board; } }, videos,
    { estimateCostMicros: 500, mediaIngestor: { async ingestProviderUrl() { return localVideo(); } } });
  const prepared = await executor.prepare({ run: f.run, task: f.task });
  assert.equal(prepared.defer.code, 'VIDEO_AUTOMATION_BUSY'); assert.equal(prepared.requiresPaid, false);
  assert.equal(prepared.estimateCostMicros, 0); assert.equal(creates, 0);
});

test('video failure before provider submission costs zero while a submitted failure consumes the reservation', async () => {
  for (const [providerTaskId, expectedCost] of [[null, 0], ['seedance_task_1', 500]]) {
    const f = videoFixture();
    const failed = { id: `video_failed_${expectedCost}`, status: 'failed', providerTaskId,
      model: 'video-model', modelConnectionRevision: 'revision_1', result: null,
      error: { code: 'VIDEO_PROVIDER_FAILED', message: '生成失败' } };
    const videos = { async status() { return { available: true, busy: false, connectionRevision: 'revision_1' }; },
      async create() { return failed; }, async get() { return failed; }, async reconcile() { return failed; } };
    const executor = new VideoProductionExecutor({ async getProject() { return f.project; } }, { async get() { return f.board; } }, videos,
      { estimateCostMicros: 500, mediaIngestor: { async ingestProviderUrl() { return localVideo(); } } });
    const prepared = await executor.prepare({ run: f.run, task: f.task });
    const outcome = await executor.execute(context(f.run, 'video', { task: f.task, inputDigest: prepared.inputDigest }));
    assert.equal(outcome.state, 'failed'); assert.equal(outcome.actualCostMicros, expectedCost);
  }
});

test('video reconciliation without a saved run id stays unknown and does not create another task', async () => {
  const f = videoFixture(); let creates = 0;
  const videos = { async status() { return { available: true, busy: false, connectionRevision: 'revision_1' }; },
    async create() { creates++; throw new Error('must not create'); },
    async get() { throw new Error('must not get'); }, async reconcile() { throw new Error('must not reconcile'); } };
  const executor = new VideoProductionExecutor({ async getProject() { return f.project; } }, { async get() { return f.board; } }, videos,
    { estimateCostMicros: 500, mediaIngestor: { async ingestProviderUrl() { throw new Error('must not ingest'); } } });
  const outcome = await executor.reconcile(context(f.run, 'video', { task: f.task }), { providerTaskId: null });
  assert.equal(outcome.state, 'waitingHuman'); assert.equal(outcome.operationUnknown, true);
  assert.equal(outcome.issue.code, 'VIDEO_RUN_ID_MISSING'); assert.equal(creates, 0);
});

test('unknown video submission without a provider ID becomes a durable human reconciliation gate', async () => {
  const f = videoFixture(); let reconciles = 0;
  const unknown = { id: 'video_unknown_local_run', status: 'unknown', providerTaskId: null,
    model: 'video-model', modelConnectionRevision: 'revision_1', result: null,
    error: { code: 'VIDEO_SUBMISSION_UNCERTAIN', message: '提交结果不明' } };
  const videos = { async status() { return { available: true, busy: false, connectionRevision: 'revision_1' }; },
    async create() { return unknown; }, async get() { return unknown; }, async reconcile() { reconciles++; return unknown; } };
  const executor = new VideoProductionExecutor({ async getProject() { return f.project; } }, { async get() { return f.board; } }, videos,
    { estimateCostMicros: 500, mediaIngestor: { async ingestProviderUrl() { return localVideo(); } } });
  const prepared = await executor.prepare({ run: f.run, task: f.task });
  const ctx = context(f.run, 'video', { task: f.task, inputDigest: prepared.inputDigest });
  const first = await executor.execute(ctx);
  assert.equal(first.state, 'waitingHuman'); assert.equal(first.issue.code, 'VIDEO_SUBMISSION_UNKNOWN');
  assert.equal(first.operationUnknown, true); assert.equal('actualCostMicros' in first, false);
  assert.equal(first.artifacts[0].metadata.videoRunId, unknown.id);
  assert.equal(first.artifacts[0].metadata.providerTaskIdPresent, false);
  const reconciled = await executor.reconcile(ctx, { providerTaskId: unknown.id });
  assert.equal(reconciled.state, 'waitingHuman'); assert.equal(reconciled.issue.code, 'VIDEO_SUBMISSION_UNKNOWN');
  assert.equal(reconciles, 1);
});

test('exhausted unknown video polling with a provider ID becomes a human gate without another submission', async () => {
  const f = videoFixture(); let creates = 0; let reconciles = 0;
  const unknown = { id: 'video_unknown_provider_run', status: 'unknown', providerTaskId: 'seedance_provider_1',
    reconciliationAttempts: 3, model: 'video-model', modelConnectionRevision: 'revision_1', result: null,
    error: { code: 'VIDEO_RECONCILIATION_LIMIT_REACHED', message: '自动查询已停止' } };
  const videos = { async status() { return { available: true, busy: false, connectionRevision: 'revision_1' }; },
    async create() { creates++; return unknown; }, async get() { return unknown; },
    async reconcile() { reconciles++; return unknown; } };
  const executor = new VideoProductionExecutor({ async getProject() { return f.project; } }, { async get() { return f.board; } }, videos,
    { estimateCostMicros: 500, mediaIngestor: { async ingestProviderUrl() { throw new Error('must not ingest'); } } });
  const prepared = await executor.prepare({ run: f.run, task: f.task });
  const ctx = context(f.run, 'video', { task: f.task, inputDigest: prepared.inputDigest });
  const first = await executor.execute(ctx);
  assert.equal(first.state, 'waitingHuman'); assert.equal(first.operationUnknown, true);
  assert.equal(first.issue.code, 'VIDEO_RECONCILIATION_LIMIT_REACHED'); assert.equal(creates, 1);
  assert.equal(first.artifacts[0].metadata.providerTaskIdPresent, true);
  assert.equal(first.artifacts[0].metadata.reconciliationAttempts, 3);
  const repeated = await executor.reconcile(ctx, { providerTaskId: unknown.id });
  assert.equal(repeated.state, 'waitingHuman'); assert.equal(repeated.operationUnknown, true);
  assert.equal(reconciles, 1); assert.equal(creates, 1);
});
