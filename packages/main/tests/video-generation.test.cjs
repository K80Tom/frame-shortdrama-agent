const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compileVideoGeneration, assertRepairPlanDiscipline } = require('../dist/video-generation/control-plan');
const { parseCreateVideoRun } = require('../dist/video-automation/contracts');
const { parseProviderCapabilityRevision, verifyAdoptedControlFrame } = require('@lyra/shared');

const WS = `ws_${'a'.repeat(32)}`;
const CAP = {
  schemaVersion: 'lyra-provider-capability/1', id: 'cap_seedance_v1', workspaceId: WS,
  provider: 'seedance', model: 'unit-video-model', revision: 'rev_1', textToVideo: true,
  imageToVideo: true, controls: {
    firstFrame: true, lastFrame: true,
    referenceImages: { max: 4, roles: ['style', 'character'] },
    pose: false, depth: false, mask: false, edge: false, camera: false,
  },
  limits: { durationSeconds: { min: 4, max: 30 }, ratios: ['9:16', '16:9'],
    resolutions: ['720p', '1080p'], maxInputBytes: 10_000_000, signedUrlTtlSeconds: 300 },
  seed: true, negativePrompt: false, audioGeneration: false,
  async: { query: true, cancel: false, idempotency: true, reconciliationFields: ['taskId', 'status'] },
  createdAt: '2026-11-09T00:00:00.000Z',
};
const SPEC = {
  schemaVersion: 'lyra-video-control/1', id: 'vspec_1', workspaceId: WS, projectId: 'project_1',
  shotId: 'shot_1', productionInputSnapshotId: 'snap_1', productionInputSnapshotDigest: '1'.repeat(64),
  shotSpecRevisionId: 'shotrev_1', shotSpecDigest: '2'.repeat(64),
  assetPackVersions: [], directorSceneVersions: [], controlFrameVersionIds: ['frame_first'],
  controls: [{ kind: 'first_frame', required: true,
    artifact: { id: 'frame_first', versionId: 'objver_first', digest: '3'.repeat(64) }, ratioTransform: 'none' }],
  prompt: '雨夜镜头', negativePrompt: null, methodPackVersions: [], promptRevision: null, modelRevision: 'rev_1',
  providerCapabilityRevisionId: 'cap_seedance_v1', candidate: { index: 0, policy: 'direct' },
  params: { durationSeconds: 5, ratio: '9:16', resolution: '720p', seed: 7 },
  audioPolicy: 'none', contentDigest: '4'.repeat(64),
};
const FRAME = {
  schemaVersion: 'lyra-video-control/1', id: 'frame_first', workspaceId: WS, projectId: 'project_1',
  shotId: 'shot_1', kind: 'first', sourceShotSpecVersionId: 'shotrev_1', sourceShotSpecDigest: '2'.repeat(64),
  objectVersionId: 'objver_first', checksum: '5'.repeat(64), width: 1080, height: 1920, ratio: '9:16',
  assetPackVersion: null, directorSceneVersion: null, methodPackVersion: null, promptRevision: null, modelRevision: null,
  provenance: { kind: 'generated', providerTaskId: null, sourceCandidateId: null, timeMs: null, actor: 'unit' },
  review: { status: 'pass', reviewer: 'unit', reviewedAt: '2026-11-09T00:01:00.000Z',
    technicalSummary: [], semanticSummary: [] },
  qualitySummary: 'ok', adoptedAt: '2026-11-09T00:02:00.000Z', contentDigest: '6'.repeat(64),
};

test('capability parser accepts a complete matrix and rejects reference role duplication', () => {
  assert.equal(parseProviderCapabilityRevision(CAP).controls.firstFrame, true);
  assert.throws(() => parseProviderCapabilityRevision({ ...CAP, controls: {
    ...CAP.controls, referenceImages: { max: 4, roles: ['style', 'style'] } } }),
  error => error.code === 'VIDEO_CONTROL_INVALID');
});

test('compiler sends adopted first frame and reports optional pose as unsupported, never applied', () => {
  const input = { spec: { ...SPEC, controls: [...SPEC.controls,
    { kind: 'pose', required: false, artifact: { id: 'pose_1', versionId: 'objver_pose', digest: '7'.repeat(64) },
      ratioTransform: 'none' }] }, capability: CAP, controlFrames: [FRAME], directorArtifacts: [] };
  const result = compileVideoGeneration(input);
  assert.equal(result.plan.blockers.length, 0);
  assert.deepEqual(result.plan.providerControls.firstFrameObjectVersionId, 'objver_first');
  assert.deepEqual(result.plan.actualControls, ['first_frame']);
  const pose = result.plan.decisions.find(item => item.requirement === 'pose');
  assert.equal(pose.decision, 'unsupported');
  assert.equal(pose.actualField, null);
  assert.match(result.plan.operationKey, /^video_[a-f0-9]{64}$/);
});

test('hard pose or missing first frame blocks paid submission before the provider is called', () => {
  const pose = { kind: 'pose', required: true, artifact: { id: 'pose_1', versionId: 'objver_pose', digest: '7'.repeat(64) }, ratioTransform: 'none' };
  const poseResult = compileVideoGeneration({ spec: { ...SPEC, controls: [...SPEC.controls, pose] }, capability: CAP,
    controlFrames: [FRAME, {
      ...{ schemaVersion: 'lyra-video-control/1', id: 'pose_1', workspaceId: WS, projectId: 'project_1', shotId: 'shot_1',
        kind: 'reference', sourceShotSpecVersionId: 'shotrev_1', sourceShotSpecDigest: '2'.repeat(64),
        objectVersionId: 'objver_pose', checksum: '7'.repeat(64), width: 512, height: 512, ratio: '9:16',
        assetPackVersion: null, directorSceneVersion: null, methodPackVersion: null, promptRevision: null,
        modelRevision: null, provenance: { kind: 'imported', providerTaskId: null, sourceCandidateId: null,
          timeMs: null, actor: 'unit' }, review: { status: 'pass', reviewer: 'unit', reviewedAt: null,
          technicalSummary: [], semanticSummary: [] }, qualitySummary: null, adoptedAt: null, contentDigest: '8'.repeat(64) },
    }], directorArtifacts: [] });
  assert.ok(poseResult.plan.blockers.some(item => item.code === 'VIDEO_POSE_UNSUPPORTED'));
  assert.equal(poseResult.plan.decisions.find(item => item.requirement === 'pose').decision, 'blocked');

  const noFrame = compileVideoGeneration({ spec: SPEC, capability: CAP, controlFrames: [], directorArtifacts: [] });
  assert.ok(noFrame.plan.blockers.some(item => item.code === 'CONTROL_FRAME_NOT_FOUND'));
});

test('a frame ratio mismatch is explicitly transformed or blocked, never silently stretched', () => {
  const squareFrame = { ...FRAME, width: 1080, height: 1080, ratio: '16:9' };
  const transformed = compileVideoGeneration({ spec: { ...SPEC, controls: [{
    ...SPEC.controls[0], ratioTransform: 'fit_letterbox' }] }, capability: CAP, controlFrames: [squareFrame], directorArtifacts: [] });
  assert.equal(transformed.plan.decisions[0].decision, 'transformed');
  const blocked = compileVideoGeneration({ spec: { ...SPEC, controls: [{ ...SPEC.controls[0], ratioTransform: 'blocked' }] },
    capability: CAP, controlFrames: [squareFrame], directorArtifacts: [] });
  assert.ok(blocked.plan.blockers.some(item => item.code === 'CONTROL_FRAME_RATIO_INCOMPATIBLE'));
});

test('verifyAdoptedControlFrame rejects unadopted or broken lineage', () => {
  assert.equal(verifyAdoptedControlFrame(FRAME).objectVersionId, 'objver_first');
  assert.throws(() => verifyAdoptedControlFrame({ ...FRAME, adoptedAt: null }), /付费视频提交/);
  assert.throws(() => verifyAdoptedControlFrame({ ...FRAME, checksum: 'not-a-digest' }),
    error => error.code === 'VIDEO_CONTROL_INVALID');
});

test('video run parser accepts an explicit first/last frame asset pair and rejects ambiguous roles', () => {
  const base = { prompt: '原创测试镜头', ratio: '9:16', duration: 5, resolution: '720p',
    generateAudio: false, clientRequestId: 'control-frame-1', expectedModelConnectionRevision: 'rev_1', allowPaid: true };
  const first = `asset_${'a'.repeat(32)}`; const last = `asset_${'b'.repeat(32)}`;
  const parsed = parseCreateVideoRun({ ...base, firstFrameAssetId: first, lastFrameAssetId: last });
  assert.equal(parsed.firstFrameAssetId, first); assert.equal(parsed.lastFrameAssetId, last);
  assert.throws(() => parseCreateVideoRun({ ...base, lastFrameAssetId: last }), /VIDEO_REQUEST_INVALID|视频设置/);
  assert.throws(() => parseCreateVideoRun({ ...base, firstFrameAssetId: first,
    referenceAssetIds: [first] }), /VIDEO_REQUEST_INVALID|视频设置/);
});

test('RepairPlan discipline rejects vague or empty action lists', () => {
  assert.doesNotThrow(() => assertRepairPlanDiscipline(['regenerate_candidate', 'reevaluate']));
  assert.throws(() => assertRepairPlanDiscipline(['优化一下']), /unbounded|unknown/);
  assert.throws(() => assertRepairPlanDiscipline([]), /unbounded|unknown/);
});
