const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compileProductionRun } = require('../dist/production/blueprint');
const { CandidateProductionExecutor, ReviewProductionExecutor, ComposeProductionExecutor,
  DeliveryProductionExecutor } = require('../dist/production/finalization');

const now = '2026-10-23T12:00:00.000Z';
const mediaA = `media_${'a'.repeat(64)}`;
const mediaB = `media_${'b'.repeat(64)}`;
const input = {
  projectId: 'project_0123456789abcdef0123456789abcdef',
  scriptVersionId: 'script_0123456789abcdef0123456789abcdef', ratio: '9:16', targetDurationSec: 8,
  visualStyle: '真人写实', qualityPreset: 'balanced', automationMode: 'auto', candidatePolicy: 'gacha', candidateLimit: 2,
  directorPolicy: 'auto', budgetMicros: 20_000_000, currency: 'CNY', allowPaid: true,
  clientRequestId: 'finalization-test',
};

function run() {
  const value = compileProductionRun(input, now);
  value.artifacts.push({ id: 'partifact_storyboard', runId: value.id, taskId: value.tasks[3].id, kind: 'text',
    title: '分镜', uri: null, sha256: null, status: 'current', createdAt: now,
    metadata: { storyboardRevisionId: 'storyboard_one', shots: [{ id: 'shot_one', durationMs: 8000 }] } });
  return value;
}

function task(value, stage, dependencies = []) {
  return { id: `ptask_${stage}_${'1'.repeat(24)}`, runId: value.id, stage, label: stage,
    scope: { kind: 'shot', id: 'shot_one' }, status: 'running', dependencies, attemptCount: 1,
    maxAttempts: 2, version: 1, blockingReason: null, inputManifest: [], createdAt: now, updatedAt: now };
}

function artifact(value, taskId, id, mediaId) {
  return { id, runId: value.id, taskId, kind: 'video', title: id, uri: `/api/production-media/${mediaId}`,
    sha256: mediaId.slice(6), metadata: { mediaId }, status: 'current', createdAt: now };
}

function store(overrides = {}) {
  return { async getVideo(id) { return { absolutePath: `/owned/${id}.mp4`, object: { id, sha256: id.slice(6),
    probe: { container: 'mp4', durationSeconds: 8, width: 1080, height: 1920, videoCodec: 'h264',
      hasAudio: true, audioCodec: 'aac' }, ...overrides } }; } };
}

const context = (value, item) => ({ run: value, task: item, attemptId: 'attempt_one', inputDigest: 'd'.repeat(64), operationKey: null });

test('candidate aggregation only exposes verified local videos and recommends the strongest take', async () => {
  const value = run(); const videoA = task(value, 'video'); const videoB = { ...task(value, 'video'), id: `ptask_video_${'2'.repeat(24)}` };
  const candidate = task(value, 'candidates', [videoA.id, videoB.id]);
  value.tasks.push(videoA, videoB, candidate);
  value.artifacts.push(artifact(value, videoA.id, 'partifact_a', mediaA), artifact(value, videoB.id, 'partifact_b', mediaB));
  const outcome = await new CandidateProductionExecutor(store()).execute(context(value, candidate));
  assert.equal(outcome.state, 'succeeded');
  assert.equal(outcome.artifacts.length, 2);
  assert.equal(outcome.candidateSets[0].candidates.length, 2);
  assert.equal(outcome.candidateSets[0].recommendedIndex, 0);
  value.artifacts[1].uri = 'https://cdn.example.test/temp.mp4';
  value.artifacts[2].uri = 'https://cdn.example.test/temp2.mp4';
  const blocked = await new CandidateProductionExecutor(store()).execute(context(value, candidate));
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.issue.code, 'LOCAL_VIDEO_CANDIDATES_MISSING');
});

test('direct flow reviews the shot video without requiring any candidate set', async () => {
  const value = run();
  const video = task(value, 'video');
  const review = task(value, 'review', [video.id]);
  value.tasks.push(video, review);
  value.artifacts.push(artifact(value, video.id, 'partifact_direct', mediaA));
  const outcome = await new ReviewProductionExecutor(store()).execute(context(value, review));
  assert.equal(outcome.state, 'succeeded');
  assert.equal(outcome.qualityChecks[0].result, 'pass');
});

test('shot review records a failed check and expands an explicit bounded repair subgraph', async () => {
  const value = run(); const review = task(value, 'review'); value.tasks.push(review);
  const selectedArtifact = artifact(value, 'ptask_candidates_source', 'partifact_selected', mediaA);
  value.artifacts.push(selectedArtifact);
  value.candidateSets.push({ id: 'pcset_one', runId: value.id, taskId: 'ptask_candidates_source', kind: 'video',
    scope: { kind: 'shot', id: 'shot_one' }, status: 'selected', selectedCandidateId: 'pcandidate_one', createdAt: now,
    candidates: [{ id: 'pcandidate_one', artifactId: selectedArtifact.id, label: 'A', summary: '', score: 1,
      status: 'selected', createdAt: now }] });
  const bad = store({ probe: { container: 'mp4', durationSeconds: 20, width: 1920, height: 1080,
    videoCodec: 'h264', hasAudio: false, audioCodec: null } });
  const outcome = await new ReviewProductionExecutor(bad).execute(context(value, review));
  assert.equal(outcome.state, 'succeeded');
  assert.equal(outcome.continueOnFailedQuality, true);
  assert.equal(outcome.qualityChecks[0].result, 'fail');
  assert.deepEqual(outcome.spawnTasks.map(item => item.stage), ['video', 'candidates', 'review']);
});

test('compose uses storyboard order and selected local candidates', async () => {
  const value = run(); const compose = { ...value.tasks.find(item => item.stage === 'compose'), status: 'running' };
  const selectedArtifact = artifact(value, 'ptask_candidates_source', 'partifact_selected', mediaA);
  value.artifacts.push(selectedArtifact);
  value.candidateSets.push({ id: 'pcset_one', runId: value.id, taskId: 'ptask_candidates_source', kind: 'video',
    scope: { kind: 'shot', id: 'shot_one' }, status: 'selected', selectedCandidateId: 'pcandidate_one', createdAt: now,
    candidates: [{ id: 'pcandidate_one', artifactId: selectedArtifact.id, label: 'A', summary: '', score: 1,
      status: 'selected', createdAt: now }] });
  let received;
  const composer = { async compose(request) { received = request; return { id: `timeline_${'c'.repeat(64)}`,
    composition: { strategy: 'ffmpeg-auto-edit', edit: { titleCardText: request.edit.titleCardText,
      endCardText: request.edit.endCardText, transitionSeconds: request.edit.transitionSeconds } },
    output: { id: mediaB, sha256: mediaB.slice(6), probe: { durationSeconds: 8, width: 1080, height: 1920,
      hasAudio: true } } }; } };
  const outcome = await new ComposeProductionExecutor(composer).execute(context(value, compose));
  assert.equal(outcome.state, 'succeeded');
  assert.deepEqual(received.videoIds, [mediaA]);
  assert.equal(received.edit.titleCardText, '整集自动制作成片');
  assert.equal(received.edit.transitionSeconds, 0.4);
  assert.equal(outcome.artifacts[0].title, '整集自动剪辑成片');
  assert.equal(outcome.artifacts[0].metadata.autoEdit, true);
  assert.equal(outcome.qualityChecks[0].ruleVersion, 'local-auto-edit/1');
  assert.equal(outcome.artifacts[0].uri, `/api/production-media/${mediaB}`);
  assert.equal(outcome.timeline.durationSec, 8);
});

test('delivery only marks a locally re-probed MP4 as verified', async () => {
  const value = run(); const deliver = { ...value.tasks.find(item => item.stage === 'deliver'), status: 'running' };
  value.artifacts.push({ ...artifact(value, value.tasks.find(item => item.stage === 'compose').id,
    'partifact_timeline', mediaA), metadata: { mediaId: mediaA, timelineId: `timeline_${'c'.repeat(64)}` } });
  const outcome = await new DeliveryProductionExecutor(store()).execute(context(value, deliver));
  assert.equal(outcome.state, 'succeeded');
  assert.equal(outcome.delivery.verified, true);
  assert.equal(outcome.artifacts[0].kind, 'delivery');
  assert.equal(outcome.qualityChecks[0].result, 'pass');
});

test('delivery blocks a technically valid timeline that misses the frozen target duration', async () => {
  const value = run(); value.targetDurationSec = 90;
  const deliver = { ...value.tasks.find(item => item.stage === 'deliver'), status: 'running' };
  value.artifacts.push({ ...artifact(value, value.tasks.find(item => item.stage === 'compose').id,
    'partifact_short_timeline', mediaA), metadata: { mediaId: mediaA, timelineId: `timeline_${'d'.repeat(64)}` } });
  const outcome = await new DeliveryProductionExecutor(store({ probe: { container: 'mp4', durationSeconds: 30,
    width: 1080, height: 1920, videoCodec: 'h264', hasAudio: true, audioCodec: 'aac' } })).execute(context(value, deliver));
  assert.equal(outcome.state, 'waitingHuman');
  assert.equal(outcome.issue.code, 'DELIVERY_CHECK_FAILED');
  assert.match(outcome.issue.message, /冻结目标 90s/);
  assert.equal(outcome.qualityChecks[0].result, 'fail');
});

const { ProductionService } = require('../dist/production/service');
const { MemoryProductionRepository } = require('../dist/production/repository');
const { FrameAssessor } = require('../dist/production-media/frame-assessment');
const { ModelError } = require('@lyra/shared');

const trimAdvice = shotId => ({ shotId, verdict: 'weak', scores: { identity: 3, anatomy: 4, action: 2, quality: 4 },
  issues: ['动作拖沓'], advice: { action: 'trim', speedFactor: 1, trimSeconds: 5, reason: '裁掉静滞尾段' } });

async function budgetFixture({ budget = 200, withAssessment = true, answers = [], failCompose = false } = {}) {
  // Snapshot from an earlier version: review has finished and only the episode compose gate exists.
  const value = run();
  value.budgetMicros = budget;
  const board = value.artifacts[0];
  board.metadata.shots = [{ id: 'shot_one', visualDescription: '门口等候' }, { id: 'shot_two' }];
  for (const [id, media] of [['shot_one', mediaA], ['shot_two', mediaB]]) {
    const video = { ...task(value, 'video'), id: `video_${id}`, scope: { kind: 'shot', id } };
    value.tasks.push(video);
    value.artifacts.push(artifact(value, video.id, `artifact_${id}`, media));
  }
  for (const t of value.tasks) t.status = t.stage === 'compose' ? 'ready' : t.stage === 'deliver' ? 'pending' : 'succeeded';
  const repo = new MemoryProductionRepository();
  await repo.create(value);
  const calls = [], claims = [], compositions = [];
  const assessor = { async assessOne(input) {
    const snapshot = await repo.get(value.id);
    const attempt = snapshot.attempts.at(-1);
    assert.equal(snapshot.budgetLedger.find(entry => entry.attemptId === attempt.id && entry.kind === 'reserve')?.amountMicros, 100);
    assert.equal(snapshot.externalOperations.at(-1).status, 'prepared');
    claims.push(snapshot);
    calls.push(input);
    return answers.shift() ?? { submission: 'answered', assessment: trimAdvice(input.shotId) };
  } };
  const composer = { async compose(request) {
    compositions.push(request);
    if (failCompose) { failCompose = false; throw new Error('local ffmpeg'); }
    return { id: `timeline_${'c'.repeat(64)}`, composition: { strategy: 'ffmpeg-auto-edit' },
      output: { id: mediaB, sha256: mediaB.slice(6), probe: { durationSeconds: 16, width: 1080, height: 1920, hasAudio: true } } };
  } };
  const executor = new ComposeProductionExecutor(composer, withAssessment
    ? { frameAssessment: { assessor, ceilingMicrosPerShot: 100 } } : {});
  const service = new ProductionService(repo, { executors: [executor] });
  return { service, repo, executor, id: value.id, calls, claims, compositions,
    get: () => service.get(value.id),
    tick: async (n = 1) => { for (let i = 0; i < n; i++) await service.tick(value.id); } };
}

test('frame model calls reserve per selected shot; exhausted budget pauses before dispatch and raising it resumes only the missing shot', async () => {
  const h = await budgetFixture({ budget: 100 });
  await h.tick(4);
  const paused = await h.get();
  assert.deepEqual(h.calls.map(input => input.shotId), ['shot_one']);
  assert.equal(h.calls[0].hint, '门口等候');
  assert.equal(paused.status, 'pausedBudget');
  assert.equal(paused.issues.at(-1).estimatedAdditionalCostMicros, 100);
  assert.match(paused.issues.at(-1).message, /抽帧评估/);
  assert.equal(paused.summary.budget.spentMicros, 100);
  assert.equal(paused.summary.budget.frameAssessmentEstimateMicros, 100);
  assert.equal(paused.externalOperations[0].actualCostMicros, null);
  assert.equal(paused.budgetLedger.find(entry => entry.kind === 'charge').basis, 'frameAssessmentCeiling');
  await h.service.action(h.id, { type: 'raiseBudget', budgetMicros: 200, reason: '测试' });
  await h.tick(2);
  assert.deepEqual(h.calls.map(input => input.shotId), ['shot_one', 'shot_two']);
  assert.deepEqual(h.compositions[0].edit.clipDirectives, [mediaA, mediaB].map(videoId => ({ videoId, action: 'trim', trimSeconds: 5 })));
  const final = await h.get();
  assert.equal(final.summary.budget.frameAssessmentEstimateMicros, 200);
  assert.equal(final.summary.budget.reservedMicros, 0);
  assert.equal(final.artifacts.find(a => a.metadata.key === 'frame-review').metadata.shots.length, 2);
});

test('an insufficient initial budget creates no external operation or charge', async () => {
  const h = await budgetFixture({ budget: 99 });
  await h.tick(3);
  const paused = await h.get();
  assert.equal(paused.status, 'pausedBudget');
  assert.deepEqual(paused.budgetLedger, []);
  assert.deepEqual(paused.externalOperations, []);
  assert.equal(h.calls.length, 0);
});

test('disabled assessment needs no budget and goes straight to local composition', async () => {
  const h = await budgetFixture({ budget: 0, withAssessment: false });
  await h.tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.compositions[0].edit.clipDirectives, undefined);
  assert.equal((await h.get()).budgetLedger.length, 0);
});

test('unsubmitted frame extraction releases funds; an unusable but answered assessment still consumes its ceiling', async () => {
  const h = await budgetFixture({ budget: 100, answers: [{ submission: 'notSubmitted' }, { submission: 'answered', assessment: null }] });
  await h.tick(4);
  const run = await h.get();
  assert.deepEqual(run.budgetLedger.map(entry => entry.kind), ['reserve','release','reserve','charge']);
  assert.equal(run.externalOperations[0].actualCostMicros, 0);
  assert.equal(run.externalOperations[1].actualCostMicros, null);
  assert.equal(run.summary.budget.spentMicros, 100);
  assert.equal(h.compositions[0].edit.clipDirectives, undefined);
});

test('uncertain response keeps only its own reservation on restart; forced ordinary retry cannot dispatch twice', async () => {
  const h = await budgetFixture({ answers: [{ submission: 'answered', assessment: trimAdvice('shot_one') }, { submission: 'unknown' }] });
  await h.tick(4);
  const issueRun = await h.get();
  const blocked = issueRun.tasks.find(item => item.scope.id === 'shot_two' && item.stage === 'compose');
  assert.equal(issueRun.summary.budget.spentMicros, 100);
  assert.equal(issueRun.summary.budget.reservedMicros, 100);
  assert.equal(issueRun.externalOperations.at(-1).status, 'unknown');
  await h.service.start(); await h.service.stop();
  await assert.rejects(h.service.action(h.id, { type: 'retryTask', taskId: blocked.id, force: true, reason: 'retry' }),
    error => error.code === 'PRODUCTION_EXTERNAL_OPERATION_UNKNOWN');
  await h.tick();
  assert.equal(h.calls.length, 2);
  await h.service.action(h.id, { type: 'abandonOperation', taskId: blocked.id, reason: '人工核查后按最高预估处理旧请求' });
  await h.tick();
  const after = await h.get();
  assert.equal(after.summary.budget.frameAssessmentEstimateMicros, 200);
  assert.equal(after.summary.budget.reservedMicros, 0);
  assert.equal(after.status, 'pausedBudget');
  assert.equal(h.calls.length, 2);
});

test('restoring a journal captured immediately before a model result prevents automatic resubmission', async () => {
  const h = await budgetFixture({ budget: 100 });
  await h.tick(2);
  const restored = new MemoryProductionRepository();
  await restored.create(h.claims[0]);
  const service = new ProductionService(restored, { executors: [h.executor] });
  await service.start(); await service.stop();
  const run = await service.get(h.id);
  assert.equal(h.calls.length, 1);
  assert.equal(run.externalOperations.length, 1);
  assert.equal(run.externalOperations[0].status, 'unknown');
  assert.equal(run.summary.budget.spentMicros, 0);
  assert.equal(run.summary.budget.reservedMicros, 100);
});

test('retry of local ffmpeg composition only reuses persisted shot assessments', async () => {
  const h = await budgetFixture({ failCompose: true });
  await h.tick(4);
  const compose = (await h.get()).tasks.find(t => t.stage === 'compose' && t.scope.kind === 'episode');
  await h.service.action(h.id, { type: 'retryTask', taskId: compose.id, reason: '本地编码器已恢复' });
  await h.tick();
  assert.equal(h.compositions.length, 2);
  assert.equal(h.calls.length, 2);
  assert.equal((await h.get()).summary.budget.spentMicros, 200);
});

test('real frame assessor distinguishes extraction, local model validation, ambiguous network and a returned invalid verdict', async () => {
  const { writeFile } = require('node:fs/promises');
  const input = { shotId: 's', mediaId: mediaA, label: '镜一', hint: '' };
  let calls = 0;
  const frameRunner = { async run(command, args) { await writeFile(args.at(-1), 'mock-jpeg'); return {}; } };
  const judge = { async call() { calls++; throw new Error('timeout'); } };
  const options = { framesPerShot: 1 };
  const failedExtract = new FrameAssessor(store(), { async run() { throw new Error(); } }, judge, 'ffmpeg', options);
  assert.equal((await failedExtract.assessOne(input)).submission, 'notSubmitted');
  assert.equal(calls, 0);
  const assessor = new FrameAssessor(store(), frameRunner, judge, 'ffmpeg', options);
  assert.equal((await assessor.assessOne(input)).submission, 'unknown');
  judge.call = async () => { throw new ModelError(503, 'MODEL_NOT_CONFIGURED', ''); };
  assert.equal((await assessor.assessOne(input)).submission, 'notSubmitted');
  judge.call = async () => ({ text: 'bad-json' });
  assert.deepEqual(await assessor.assessOne(input), { submission: 'answered', assessment: null });
});
