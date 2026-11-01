const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compileProductionRun } = require('../dist/production/blueprint');
const { CandidateProductionExecutor, ReviewProductionExecutor, ComposeProductionExecutor,
  DeliveryProductionExecutor, frameAssessmentHint } = require('../dist/production/finalization');

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

test('frame assessment hint prefers the flat artifact fields and falls back to design', () => {
  assert.equal(frameAssessmentHint({ visualDescription: '主角跑下楼梯', shotSize: '全景', cameraMovement: '跟拍',
    design: { visualDescription: '不应使用嵌套文案', shotSize: '特写', cameraMovement: '固定' } }),
    '主角跑下楼梯｜景别：全景｜运镜：跟拍');
  assert.equal(frameAssessmentHint({ design: { visualDescription: '走进门', shotSize: '中景', cameraMovement: '固定' } }),
    '走进门｜景别：中景｜运镜：固定');
  assert.equal(frameAssessmentHint({ id: 'shot_one', durationMs: 8000 }), '');
});

test('frame assessment reads the flat storyboard design stored on the shot', async () => {
  const value = run();
  value.artifacts[0].metadata.shots[0] = { id: 'shot_one', durationMs: 8000,
    visualDescription: '主角跑下楼梯', shotSize: '全景', cameraMovement: '跟拍' };
  const compose = { ...value.tasks.find(item => item.stage === 'compose'), status: 'running' };
  const selectedArtifact = artifact(value, 'ptask_candidates_source', 'partifact_selected', mediaA);
  value.artifacts.push(selectedArtifact);
  value.candidateSets.push({ id: 'pcset_one', runId: value.id, taskId: 'ptask_candidates_source', kind: 'video',
    scope: { kind: 'shot', id: 'shot_one' }, status: 'selected', selectedCandidateId: 'pcandidate_one', createdAt: now,
    candidates: [{ id: 'pcandidate_one', artifactId: selectedArtifact.id, label: 'A', summary: '', score: 1,
      status: 'selected', createdAt: now }] });
  const composer = { async compose() { return { id: `timeline_${'c'.repeat(64)}`,
    composition: { strategy: 'ffmpeg-auto-edit', edit: { titleCardText: '整集自动制作成片',
      endCardText: '本片由 AI 流水线自动生成', transitionSeconds: 0.4 } },
    output: { id: mediaB, sha256: mediaB.slice(6), probe: { durationSeconds: 8, width: 1080, height: 1920, hasAudio: true } } }; } };
  const assessor = { async assess(inputs) {
    assert.equal(inputs.length, 1);
    assert.match(inputs[0].hint, /主角跑下楼梯/);
    assert.match(inputs[0].hint, /景别：全景/);
    assert.match(inputs[0].hint, /运镜：跟拍/);
    return { shots: [], summary: { pass: 0, weak: 0, reject: 0, recommendedTrim: 0, recommendedSpeedup: 0, recommendedDrop: 0 } };
  } };
  const outcome = await new ComposeProductionExecutor(composer, { assessFrames: assessor }).execute(context(value, compose));
  assert.equal(outcome.state, 'succeeded');
  assert.equal(outcome.artifacts[0].metadata.frameAssessment, 'applied');
});

test('compose runs the frame assessment first and passes clip directives', async () => {
  const value = run(); const compose = { ...value.tasks.find(item => item.stage === 'compose'), status: 'running' };
  const selectedArtifact = artifact(value, 'ptask_candidates_source', 'partifact_selected', mediaA);
  value.artifacts.push(selectedArtifact);
  value.candidateSets.push({ id: 'pcset_one', runId: value.id, taskId: 'ptask_candidates_source', kind: 'video',
    scope: { kind: 'shot', id: 'shot_one' }, status: 'selected', selectedCandidateId: 'pcandidate_one', createdAt: now,
    candidates: [{ id: 'pcandidate_one', artifactId: selectedArtifact.id, label: 'A', summary: '', score: 1,
      status: 'selected', createdAt: now }] });
  let received; let assessed = 0;
  const composer = { async compose(request) { received = request; return { id: `timeline_${'c'.repeat(64)}`,
    composition: { strategy: 'ffmpeg-auto-edit', edit: { titleCardText: request.edit.titleCardText,
      endCardText: request.edit.endCardText, transitionSeconds: request.edit.transitionSeconds } },
    output: { id: mediaB, sha256: mediaB.slice(6), probe: { durationSeconds: 8, width: 1080, height: 1920, hasAudio: true } } }; } };
  const assessor = { async assess(inputs) { assessed++;
    assert.equal(inputs.length, 1); assert.equal(inputs[0].mediaId, mediaA); assert.equal(inputs[0].shotId, 'shot_one');
    return { shots: [{ shotId: 'shot_one', verdict: 'weak', scores: { identity: 3, anatomy: 4, action: 2, quality: 4 },
      issues: ['动作拖沓'], advice: { action: 'trim', speedFactor: 1, trimSeconds: 5, reason: '裁掉静滞尾段' } }],
    summary: { pass: 0, weak: 1, reject: 0, recommendedTrim: 1, recommendedSpeedup: 0, recommendedDrop: 0 } }; } };
  const outcome = await new ComposeProductionExecutor(composer, { assessFrames: assessor }).execute(context(value, compose));
  assert.equal(outcome.state, 'succeeded');
  assert.equal(assessed, 1);
  assert.deepEqual(received.edit.clipDirectives, [{ videoId: mediaA, action: 'trim', trimSeconds: 5 }]);
  assert.equal(received.edit.targetSeconds, 8);
  assert.equal(outcome.artifacts.some(item => item.key === 'frame-review'), true);
  assert.equal(outcome.artifacts[0].metadata.frameAssessment, 'applied');
});

test('a failing frame assessment degrades to a plain compose instead of blocking delivery', async () => {
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
    output: { id: mediaB, sha256: mediaB.slice(6), probe: { durationSeconds: 8, width: 1080, height: 1920, hasAudio: true } } }; } };
  const assessor = { async assess() { throw new Error('视觉模型网关不可用'); } };
  const outcome = await new ComposeProductionExecutor(composer, { assessFrames: assessor }).execute(context(value, compose));
  assert.equal(outcome.state, 'succeeded');
  assert.equal(received.edit.clipDirectives, undefined);
  assert.equal(outcome.artifacts[0].metadata.frameAssessment, 'skipped');
  assert.equal(outcome.artifacts.some(item => item.key === 'frame-review'), false);
});
