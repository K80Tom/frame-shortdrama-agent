const { createHash } = require('node:crypto');
const shared = require('@lyra/shared');
const { validateStoryboardOutput } = require('../../dist/breakdown/storyboard');
const { sealShotSpecV2 } = require('../../dist/production/shot-spec');
const { sealProductionInputSnapshot } = require('../../dist/production/input-snapshot');
const { compileFrozenProductionRun } = require('../../dist/production/frozen-run');
const { MemoryProductionRepository } = require('../../dist/production/repository');
const { ProductionService } = require('../../dist/production/service');
const { BreakdownProductionExecutor, StoryboardProductionExecutor } = require('../../dist/production/runtime');
const { retrieveAssetForGeneration } = require('../../dist/assets/retrieval');
const { HybridAssetRetriever } = require('../../dist/assets/vector/hybrid');
const { AssetVectorError } = require('../../dist/assets/vector/errors');
const { buildAssetVectorText } = require('../../dist/assets/vector/projection');
const { buildDialogueTrack } = require('../../dist/audio-production/dialogue');
const { DialogueTtsService } = require('../../dist/production-media/audio/tts');
const { buildSubtitleVersion, renderSubtitle } = require('../../dist/audio-production/subtitle');
const { buildAudioMixPlan } = require('../../dist/production-media/audio/mix');
const { createVideoGenerationHandler } = require('../../dist/production/video-worker');
const { MemoryBlobStorageDriver } = require('../../dist/storage/memory-driver');
const { InMemoryModelGenerationAudit } = require('../../dist/production/model-generation-audit');
const { MemoryOutboxTaskStore } = require('../../dist/production/outbox/memory-repository');

const AT = '2026-11-10T08:00:00.000Z';
const TENANT = Object.freeze({
  userId: `usr_${'a'.repeat(32)}`,
  workspaceId: `ws_${'b'.repeat(32)}`,
  role: 'owner',
  requestId: 'e2e-pipeline-smoke',
});
const PROJECT_ID = 'project_e2e_1';
const EPISODE_ID = 'episode_e2e_1';
const SCRIPT_ID = 'script_e2e_1';
const PLAN_ID = 'plan_e2e_1';
const STORYBOARD_ID = 'storyboard_e2e_1';
const PROMPT_ID = 'prompt_e2e_1';
const CAPABILITY_ID = 'capability_e2e_1';
const RETRIEVAL_POLICY_ID = 'asset_policy_e2e';
const QUALITY_GATE_ID = 'quality_gate_e2e';
const BUDGET_ID = 'budget_e2e_1';

const SCRIPT_HEAD = [
  '第一场｜雨夜·旧桥（外）',
  '林晚：你终于来了。',
  '第二场｜室内·客厅（夜）',
  '周宁：我以为你不会来。',
];
const SCRIPT = SCRIPT_HEAD.join('\n');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function digest(value) {
  return shared.canonicalDigest(value);
}

function ref(id, valueDigest = 'c'.repeat(64)) {
  return { id, versionId: id, digest: valueDigest };
}

function sourceRef(lineIndex, quote = SCRIPT_HEAD[lineIndex], line = SCRIPT_HEAD[lineIndex]) {
  const lineStart = SCRIPT.indexOf(line);
  const start = lineStart + line.indexOf(quote);
  return { scriptVersionId: SCRIPT_ID, start, end: start + Array.from(quote).length, quote };
}

function blockRef(firstLine, secondLine) {
  const quote = `${SCRIPT_HEAD[firstLine]}\n${SCRIPT_HEAD[secondLine]}`;
  const start = SCRIPT.indexOf(SCRIPT_HEAD[firstLine]);
  return { scriptVersionId: SCRIPT_ID, start, end: start + Array.from(quote).length, quote };
}

function sourced(value, refs) {
  return { value, origin: 'source', sourceRefs: refs, answerIds: [] };
}

function mediaEntry(seed, view, role) {
  return {
    mediaId: `apm_${seed.repeat(32)}`,
    role,
    view,
    state: null,
    objectId: `object_${seed.toUpperCase().repeat(32)}`,
    objectVersionId: `objver_${seed.toUpperCase().repeat(32)}`,
    checksum: sha256(`media:${seed}:${view}`),
    sizeBytes: 128,
    contentType: 'image/png',
    crop: null,
    qualityStatus: 'pass',
    provenance: { source: 'generated', provider: 'seedream', sourceRef: null },
  };
}

function makePack({ seed, logicalAssetId, displayName, aliases, description, tags }) {
  const base = {
    schemaVersion: shared.ASSET_PACK_SCHEMA_VERSION,
    id: `apv_${seed.repeat(32)}`,
    workspaceId: TENANT.workspaceId,
    projectScope: 'workspace',
    projectId: null,
    kind: 'character',
    logicalAssetId,
    version: 1,
    parentVersionId: null,
    displayName,
    aliases,
    description,
    tags,
    sourceType: 'generated',
    sourceRefs: [`script:${SCRIPT_ID}`],
    license: 'internal-e2e',
    authorizationStatus: 'allowed',
    authorizationReason: null,
    reviewStatus: 'approved',
    reviewedBy: TENANT.userId,
    reviewedAt: '2026-11-01T00:00:00.000Z',
    validFrom: '2026-11-01T00:00:00.000Z',
    validUntil: null,
    allowedUsages: ['production'],
    restrictedProjects: [],
    mediaEntries: [
      mediaEntry(seed, 'front', 'view'),
      mediaEntry(seed === '1' ? '2' : '3', 'side_left', 'reference'),
      mediaEntry(seed === '1' ? '4' : '5', 'close_up', 'expression'),
    ],
    status: 'adopted',
    createdBy: TENANT.userId,
    createdAt: '2026-11-01T00:00:00.000Z',
  };
  base.contentDigest = shared.assetPackContentDigest(base);
  return shared.parseAssetPackVersion(base);
}

function buildAssetPacks() {
  const packs = [
    makePack({
      seed: '1', logicalAssetId: 'character_linwan', displayName: '林晚', aliases: ['晚姐'],
      description: '冷面女总裁，黑色长风衣，雨夜赴约，眼神克制', tags: ['都市', '冷峻', '女主'],
    }),
    makePack({
      seed: '6', logicalAssetId: 'character_zhounning', displayName: '周宁', aliases: ['阿宁'],
      description: '温和的青年导演，灰色夹克，室内暖光下的迟疑', tags: ['都市', '温和', '男主'],
    }),
  ];
  return new Map(packs.map(pack => [pack.logicalAssetId, pack]));
}

function packRef(pack) {
  return { id: pack.logicalAssetId, versionId: pack.id, digest: pack.contentDigest };
}

function packMediaRefs(pack) {
  return pack.mediaEntries.map(entry => ({
    role: entry.role,
    objectId: entry.objectId,
    objectVersionId: entry.objectVersionId,
    checksum: entry.checksum,
  }));
}

function assetSubject(pack) {
  return {
    id: `asset_${pack.id.slice(4)}`,
    kind: pack.kind,
    name: pack.displayName,
    description: pack.description,
    resourceUrl: `https://assets.e2e.test/${pack.logicalAssetId}.png`,
    createdAt: pack.createdAt,
    workspaceId: pack.workspaceId,
    projectId: pack.projectId,
    assetPackVersionId: pack.id,
    logicalAssetId: pack.logicalAssetId,
    views: [...new Set(pack.mediaEntries.map(entry => entry.view).filter(Boolean))],
    states: [],
    traits: pack.tags,
    authorizationStatus: pack.authorizationStatus,
    reviewStatus: pack.reviewStatus,
    allowedUsages: pack.allowedUsages,
    restrictedProjects: pack.restrictedProjects,
    qualityScore: 1,
  };
}

function createHybridAssetRetriever(assets, options = {}) {
  const score = options.score ?? 0.9;
  const embedding = { embedText: async () => [0.12, 0.34, 0.56] };
  const store = {
    upsert: async () => {},
    deleteByAssetIds: async () => {},
    search: async (_vector, _kind, limit = 12, searchOptions = {}) => {
      const allowed = new Set(searchOptions.assetIds ?? assets.map(asset => asset.id));
      return assets.filter(asset => allowed.has(asset.id)).slice(0, limit).map(asset => ({
        assetId: asset.id,
        score,
        sourceVersion: sha256(buildAssetVectorText(asset)),
      }));
    },
  };
  return new HybridAssetRetriever({
    embedding, store, model: 'e2e-embedding-v1', revision: 'rev-1', queryCostMicros: 0,
  });
}

function createDegradedAssetRetriever() {
  const embedding = { embedText: async () => [0.12, 0.34, 0.56] };
  const store = {
    upsert: async () => {},
    deleteByAssetIds: async () => {},
    search: async () => { throw new AssetVectorError('e2e: Milvus 不可达，按契约降级到词法检索'); },
  };
  return new HybridAssetRetriever({
    embedding, store, model: 'e2e-embedding-v1', revision: 'rev-1', queryCostMicros: 0,
  });
}

function scriptPlanAndStoryboard(packs) {
  const sceneOneRef = blockRef(0, 1);
  const sceneTwoRef = blockRef(2, 3);
  const dialogueOneRef = sourceRef(1, '你终于来了。');
  const dialogueTwoRef = sourceRef(3, '我以为你不会来。');
  const headingOneRef = sourceRef(0);
  const headingTwoRef = sourceRef(2);

  const characters = [
    { id: 'character_linwan', name: sourced('林晚', [sourceRef(1, '林晚')]), aliases: [],
      description: sourced('冷面女总裁，黑色长风衣', [sceneOneRef]), sourceRefs: [sourceRef(1, '林晚')] },
    { id: 'character_zhounning', name: sourced('周宁', [sourceRef(3, '周宁')]), aliases: [],
      description: sourced('温和的青年导演，灰色夹克', [sceneTwoRef]), sourceRefs: [sourceRef(3, '周宁')] },
  ];
  const locations = [
    { id: 'location_bridge', name: sourced('旧桥', [headingOneRef]), aliases: [], description: null, sourceRefs: [headingOneRef] },
    { id: 'location_living', name: sourced('客厅', [headingTwoRef]), aliases: [], description: null, sourceRefs: [headingTwoRef] },
  ];
  const scenes = [
    { id: 'scene_e2e_1', order: 1, title: sourced('雨夜·旧桥', [headingOneRef]),
      locationId: 'location_bridge', characterIds: ['character_linwan'], sourceRefs: [sceneOneRef],
      timeOfDay: sourced('夜', [headingOneRef]) },
    { id: 'scene_e2e_2', order: 2, title: sourced('室内·客厅', [headingTwoRef]),
      locationId: 'location_living', characterIds: ['character_zhounning'], sourceRefs: [sceneTwoRef],
      timeOfDay: sourced('夜', [headingTwoRef]) },
  ];
  const dialogues = [
    { id: 'dialogue_e2e_1', sceneId: 'scene_e2e_1', speakerId: 'character_linwan',
      speakerSourceRefs: [sourceRef(1, '林晚')], speakerAnswerIds: [], sourceRef: dialogueOneRef, tone: '克制' },
    { id: 'dialogue_e2e_2', sceneId: 'scene_e2e_2', speakerId: 'character_zhounning',
      speakerSourceRefs: [sourceRef(3, '周宁')], speakerAnswerIds: [], sourceRef: dialogueTwoRef, tone: '迟疑' },
  ];
  const plan = {
    id: PLAN_ID, projectId: PROJECT_ID, scriptVersionId: SCRIPT_ID, runId: 'run_e2e_1',
    sourceTaskId: 'task_e2e_1', attemptId: null, parentRevisionId: null, rebasedFromRevisionId: null,
    createdAt: AT, createdBy: 'agent', reason: 'extract', scope: { kind: 'project', targetId: null },
    requirements: {}, status: 'candidate', validatorVersion: 'extract-facts-validator/1',
    content: {
      schemaVersion: 'breakdown-plan-content/1', synopsis: sourced('雨夜旧桥的重逢。', [sceneOneRef]),
      characters, locations, props: [], dialogues, scenes, assetRequirements: [], manualLocks: [],
    },
  };

  const rawStoryboard = { shots: [
    { sceneId: 'scene_e2e_1', order: 1,
      visualDescription: '雨夜旧桥，林晚撑着黑伞站在霓虹反光里，中景缓慢推近，雨丝可见',
      shotSize: '中景', cameraMovement: '缓慢推近', durationMs: 5000,
      sourceRefs: [sceneOneRef], dialogueIds: ['dialogue_e2e_1'] },
    { sceneId: 'scene_e2e_2', order: 1,
      visualDescription: '室内客厅暖光，周宁放下茶杯抬眼，近景固定，背景虚化',
      shotSize: '近景', cameraMovement: '固定', durationMs: 5000,
      sourceRefs: [sceneTwoRef], dialogueIds: ['dialogue_e2e_2'] },
  ] };
  let counter = 0;
  const storyboardShots = validateStoryboardOutput(rawStoryboard, plan, () => `shot_e2e_${++counter}`);

  const styleByScene = {
    scene_e2e_1: '雨夜霓虹，冷蓝调，湿润反光，手持感',
    scene_e2e_2: '室内暖光，低饱和，静帧质感',
  };
  const shots = storyboardShots.map((shot, index) => {
    const scene = scenes.find(item => item.id === shot.sceneId);
    const lines = dialogues.filter(line => shot.dialogueIds.includes(line.id));
    const dialogue = lines.map(line => ({
      id: line.id,
      speakerEntityId: line.speakerId,
      text: line.sourceRef.quote,
      tone: line.tone,
      sourceRef: { ...line.sourceRef },
    }));
    const timeline = dialogue.map((line, lineIndex) => ({
      id: `cue_e2e_${index + 1}_${lineIndex + 1}`,
      kind: 'dialogue',
      startMs: 300,
      endMs: 2800,
      dialogueId: line.id,
      entityId: line.speakerEntityId,
      text: line.text,
      asset: null,
    }));
    const assetPacks = scene.characterIds.map(entityId => {
      const pack = packs.get(entityId);
      if (!pack) throw new Error(`missing asset pack for ${entityId}`);
      return { entityId, kind: pack.kind, pack: packRef(pack), media: packMediaRefs(pack) };
    });
    const revisionId = `shotrev_e2e_${index + 1}`;
    return sealShotSpecV2({
      schemaVersion: shared.SHOT_SPEC_SCHEMA_VERSION,
      revisionId,
      workspaceId: TENANT.workspaceId,
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      scriptVersionId: SCRIPT_ID,
      planRevisionId: PLAN_ID,
      storyboardRevisionId: STORYBOARD_ID,
      shotId: shot.id,
      sceneId: shot.sceneId,
      order: shot.order,
      durationMs: shot.design.durationMs,
      ratio: '9:16',
      shotSize: shot.design.shotSize,
      camera: {
        description: shot.design.visualDescription,
        movement: shot.design.cameraMovement,
        focalLengthMm: null,
        composition: null,
      },
      dialogue,
      actions: [{ id: `action_e2e_${index + 1}`, origin: 'design',
        text: shot.design.visualDescription, sourceRefs: [shot.sourceRefs[0]] }],
      assetPacks,
      controls: [],
      visualStyle: styleByScene[shot.sceneId],
      negativeConstraints: ['不要生成品牌标识', '不要新增无关人物'],
      continuity: { before: [], after: [] },
      timeline,
      generation: {
        methodPackRevisions: [],
        promptPackRevision: ref(PROMPT_ID, sha256('prompt-pack')),
        modelCapabilityRevision: ref(CAPABILITY_ID, sha256('model-capability')),
        candidatePolicy: { mode: 'direct', limit: 1 },
      },
      sourceRefs: shot.sourceRefs.map(item => ({ ...item })),
      source: { kind: 'generated', actor: TENANT.userId, sourceRevisionId: null },
      createdAt: AT,
    });
  });
  return { plan, storyboardShots, shots, sceneOneRef, sceneTwoRef };
}

function buildFixture() {
  const packs = buildAssetPacks();
  const built = scriptPlanAndStoryboard(packs);
  const snapshot = sealProductionInputSnapshot({
    schemaVersion: shared.PRODUCTION_INPUT_SCHEMA_VERSION,
    id: 'snapshot_e2e_1',
    workspaceId: TENANT.workspaceId,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    baseProjectRevision: '42',
    state: 'frozen',
    findings: [],
    shots: built.shots.map(shot => ({
      shotId: shot.shotId, revisionId: shot.revisionId, contentDigest: shot.contentDigest,
    })),
    script: ref(SCRIPT_ID, sha256(SCRIPT)),
    plan: ref(PLAN_ID, digest(built.plan.content)),
    storyboard: ref(STORYBOARD_ID, digest(built.storyboardShots)),
    assetPacks: [...packs.values()].map(packRef),
    directorScenes: [],
    controls: [],
    methodPacks: [],
    promptPacks: [ref(PROMPT_ID, sha256('prompt-pack'))],
    modelConnections: [],
    retrievalPolicy: ref(RETRIEVAL_POLICY_ID, shared.DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY.policyDigest),
    qualityGates: [ref(QUALITY_GATE_ID, sha256('quality-gate'))],
    budgetPolicy: { version: ref(BUDGET_ID, sha256('budget-policy')), limitMicros: 50_000_000, currency: 'CNY', allowPaid: true },
    candidatePolicy: { mode: 'direct', limit: 1 },
    automationMode: 'auto',
    executionPolicy: {
      ratio: '9:16', visualStyle: '雨夜冷蓝与室内暖光的都市短剧', targetDurationSec: 15,
      qualityPreset: 'balanced', directorPolicy: 'never',
    },
    createdBy: TENANT.userId,
    createdAt: AT,
    reason: 'E2E 冒烟：冻结两镜短剧输入',
  });
  return {
    packs,
    plan: built.plan,
    storyboardShots: built.storyboardShots,
    shots: built.shots,
    input: { snapshot, shots: built.shots },
    assetRetrievalPolicy: shared.DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY,
    methodPacks: [],
  };
}

function runRequest(fixture) {
  return {
    snapshotId: fixture.input.snapshot.id,
    snapshotDigest: fixture.input.snapshot.snapshotDigest,
    clientRequestId: 'e2e-pipeline-smoke-run-1',
    allowPaid: true,
  };
}

async function createProductionRun(fixture) {
  const repository = new MemoryProductionRepository();
  const compiled = compileFrozenProductionRun(TENANT, runRequest(fixture), fixture, AT);
  const run = await repository.create(compiled);
  return { repository, run };
}

function stubTtsProvider() {
  const provider = 'stub-tts';
  const model = 'voice-e2e-v1';
  const revision = 'rev-1';
  let calls = 0;
  return {
    provider, model, modelRevision: revision,
    calls: () => calls,
    async synthesize(request) {
      calls += 1;
      const textLength = [...request.text].length;
      const durationMs = Math.max(1200, textLength * 220);
      const wav = Buffer.alloc(64);
      wav.write('RIFF', 0, 'latin1');
      wav.writeUInt32LE(56, 4);
      wav.write('WAVE', 8, 'latin1');
      wav.write('fmt ', 12, 'latin1');
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(2, 22);
      wav.writeUInt32LE(48_000, 24);
      wav.writeUInt32LE(192_000, 28);
      wav.writeUInt16LE(4, 32);
      wav.writeUInt16LE(16, 34);
      wav.write('data', 36, 'latin1');
      wav.writeUInt32LE(20, 40);
      return { bytes: wav, format: 'wav', durationMs, sampleRate: 48_000, channels: 2,
        alignment: { kind: 'estimated', offsetMs: 0 }, costMicros: 0 };
    },
  };
}

function voiceProfiles(provider) {
  const body = {
    schemaVersion: shared.AUDIO_PRODUCTION_SCHEMA_VERSION,
    workspaceId: TENANT.workspaceId, projectId: PROJECT_ID,
    provider: provider.provider, model: provider.model, modelRevision: provider.modelRevision,
    language: 'zh-CN', attributes: { gender: 'female', age: 'young', style: ['克制'] },
    previewArtifactId: null,
    authorization: { subject: 'synthetic:linwan', type: 'synthetic', commercialUse: true,
      territories: ['CN'], channels: ['web'], validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: null, consentRecordRef: null, revokedAt: null, cloningConsent: false },
    scope: { workspaceWide: true, projectIds: [] }, reviewStatus: 'approved',
    createdAt: '2026-11-01T00:00:00.000Z',
  };
  const linwan = { ...body, id: 'voice_linwan_e2e', displayName: '林晚·冷感女声',
    voiceReference: 'voice://linwan', contentDigest: digest({ ...body, displayName: '林晚·冷感女声', voiceReference: 'voice://linwan' }) };
  const zhounning = { ...body, id: 'voice_zhounning_e2e', displayName: '周宁·温和男声',
    attributes: { gender: 'male', age: 'young', style: ['温和'] }, voiceReference: 'voice://zhounning',
    contentDigest: digest({ ...body, displayName: '周宁·温和男声', voiceReference: 'voice://zhounning',
      attributes: { gender: 'male', age: 'young', style: ['温和'] } }) };
  return new Map([
    ['character_linwan', linwan],
    ['character_zhounning', zhounning],
  ]);
}

async function composeAudioAndSubtitle(fixture) {
  const shots = [...fixture.input.shots].sort((left, right) => left.order - right.order);
  const track = buildDialogueTrack({
    id: 'dialogue_track_e2e_1',
    workspaceId: TENANT.workspaceId,
    projectId: PROJECT_ID,
    episodeId: EPISODE_ID,
    scriptVersionId: SCRIPT_ID,
    productionInputSnapshotId: fixture.input.snapshot.id,
    productionInputSnapshotDigest: fixture.input.snapshot.snapshotDigest,
    shots,
    createdBy: TENANT.userId,
    createdAt: AT,
    baseVersionId: null,
  });
  const provider = stubTtsProvider();
  const assignments = [...voiceProfiles(provider).entries()].map(([speakerEntityId, profile]) => ({ speakerEntityId, profile }));
  const tts = new DialogueTtsService({ maxConcurrency: 2 });
  const synthesized = await tts.synthesize({
    workspaceId: TENANT.workspaceId,
    projectId: PROJECT_ID,
    track,
    assignments,
    provider,
    format: 'wav',
    now: AT,
  });
  const takes = synthesized.takes.map(take => ({ ...take, status: 'adopted' }));
  for (const cue of track.cues) {
    const take = takes.find(item => item.dialogueCueId === cue.cueId);
    if (!take) throw new Error(`missing take for ${cue.cueId}`);
    cue.adoptedVoiceTakeVersionId = take.id;
    cue.reviewStatus = 'approved';
  }
  track.adoptedAt = AT;
  const subtitle = buildSubtitleVersion({
    id: 'subtitle_e2e_1',
    workspaceId: TENANT.workspaceId,
    projectId: PROJECT_ID,
    track,
    takes,
    mixVersionId: 'mix_e2e_1',
    language: 'zh-CN',
    locale: 'zh-CN',
    style: { safeArea: '8', maxLines: 2, maxCharsPerLine: 18, fontFamilyRef: null },
    createdAt: AT,
  });
  const srt = renderSubtitle(subtitle, 'srt');
  const durationMs = shots.reduce((sum, shot) => sum + shot.durationMs, 0);
  const mixPlan = buildAudioMixPlan({
    videoPath: '/tmp/lyra-e2e/picture-lock.mp4',
    outputPath: '/tmp/lyra-e2e/master.mp4',
    durationMs,
    sampleRate: 48_000,
    channels: 2,
    dialogue: track.cues.map(cue => ({
      id: cue.cueId,
      path: `/tmp/lyra-e2e/${cue.cueId}.wav`,
      startMs: cue.timing.expectedStartMs,
      endMs: cue.timing.expectedEndMs,
      gainDb: 0,
    })),
    music: {
      path: '/tmp/lyra-e2e/bgm.mp3',
      gainDb: -3,
      ducking: { enabled: true, threshold: 0.05, ratio: 4, attackMs: 20, releaseMs: 300 },
    },
    sfx: [{ id: 'sfx_rain', path: '/tmp/lyra-e2e/rain.wav', startMs: 0, gainDb: -12 }],
    ambience: null,
    subtitles: { version: subtitle, mode: 'burn-in', srtPath: '/tmp/lyra-e2e/master.srt' },
  });
  return { shots, track, takes, ttsCalls: provider.calls(), subtitle, srt, durationMs, mixPlan };
}

const FAKE_MP4 = Buffer.from('00000018667479706d703432000000006d70343100000000', 'hex');

function stubVideoAdapter() {
  let submits = 0;
  return {
    submits: () => submits,
    async submit(request) {
      submits += 1;
      return { provider: request.provider, taskId: `cgt-e2e-${sha256(request.operationKey).slice(0, 20)}`,
        model: request.model, operationKey: request.operationKey,
        reservationId: `pgbudget_${sha256(request.operationKey).slice(0, 12)}`, status: 'submitted' };
    },
    async poll({ providerTaskId }) {
      return { provider: 'seedance', taskId: providerTaskId, state: 'succeeded',
        videoUrl: 'https://cdn.e2e.test/video.mp4', lastFrameUrl: null, message: null };
    },
  };
}

function createVideoPipeline() {
  const outbox = new MemoryOutboxTaskStore();
  const driver = new MemoryBlobStorageDriver();
  const audit = new InMemoryModelGenerationAudit();
  const adapter = stubVideoAdapter();
  const handler = createVideoGenerationHandler({
    adapters: { seedance: adapter },
    verifier: { check: async () => null },
    loadFrameBytes: async () => { throw new Error('e2e 不使用首尾帧'); },
    driver,
    audit,
    pollIntervalMs: 0,
    pollDeadlineMs: 10_000,
    sleep: async () => {},
    download: async () => Buffer.from(FAKE_MP4),
  });

  async function runJob(shot) {
    const operationKey = `video:seedance:${shot.shotId}`;
    const task = await outbox.append({
      workspaceId: TENANT.workspaceId,
      taskType: 'video.generate',
      aggregateType: 'production_shot',
      aggregateId: shot.shotId,
      idempotencyKey: `e2e.video.${shot.shotId}`,
      payload: {
        operationKey,
        clientRequestId: `client-${shot.shotId}`,
        provider: 'seedance',
        model: 'doubao-seedance-1-5-pro-251215',
        prompt: `${shot.visualStyle}｜${shot.dialogue.map(line => line.text).join(' ')}`,
        durationSeconds: shot.durationMs / 1000,
        ratio: shot.ratio,
        resolution: '1080p',
        estimateMicros: 100_000,
        budgetLimitMicros: 500_000,
        currency: 'CNY',
      },
      maxAttempts: 1,
    });
    const initialState = task.state;
    const [claimed] = await outbox.claimBatch({ workerId: 'e2e-video-worker', batchSize: 1, leaseMs: 60_000 });
    if (!claimed) throw new Error('video outbox task was not claimed');
    const claimedState = claimed.state;
    const result = await handler.execute({ task: claimed, signal: new AbortController().signal });
    const completion = await outbox.completeDelivery({
      taskId: claimed.taskId,
      workspaceId: TENANT.workspaceId,
      consumerName: 'e2e-video-consumer',
      workerId: 'e2e-video-worker',
      fencingToken: claimed.fencingToken,
      result,
    });
    const finalTask = await outbox.getTask({ taskId: claimed.taskId });
    const consumers = await outbox.listConsumerRecords({ taskId: claimed.taskId, limit: 5 });
    return {
      shotId: shot.shotId,
      initialState,
      claimedState,
      completion,
      finalState: finalTask.state,
      consumers,
      result,
      operationKey,
    };
  }

  return { outbox, driver, audit, adapter, handler, runJob };
}

function prepared(task) {
  return {
    executor: 'e2e-pipeline-stub/1',
    inputDigest: task.inputManifest[0].digest,
    estimateCostMicros: 0,
    requiresPaid: false,
    provider: null,
  };
}

function createPipelineExecutors({ fixture, video, observation }) {
  const forbidden = new Proxy({}, {
    get() { throw new Error('冻结运行不应读取当前项目/目录状态'); },
  });
  const shotById = new Map(fixture.input.shots.map(shot => [shot.shotId, shot]));
  // 线下 e2e 固定走“向量索引不可达 -> 词法降级”契约，既证明混合检索接线，
  // 又不依赖 Milvus/嵌入网络。
  const assetRetriever = createDegradedAssetRetriever();

  const assets = {
    stage: 'assets',
    frozenInputVersion: 1,
    async prepare({ task }) { return prepared(task); },
    async execute({ task, frozenInput }) {
      const shot = shotById.get(task.scope.id);
      if (!shot) throw new Error(`unknown shot ${task.scope.id}`);
      const state = frozenInput ?? fixture.input;
      const resolved = [];
      for (const assetPack of shot.assetPacks) {
        const pack = fixture.packs.get(assetPack.entityId);
        if (!pack) throw new Error(`missing pack ${assetPack.entityId}`);
        const query = {
          kind: 'character',
          name: pack.displayName,
          aliases: pack.aliases,
          description: pack.description,
          workspaceId: TENANT.workspaceId,
          projectId: PROJECT_ID,
          shotId: shot.shotId,
          requiredView: 'front',
          usage: 'production',
          authorizationRequired: true,
          reviewRequired: true,
          topK: 3,
        };
        const retrieval = retrieveAssetForGeneration(query, [assetSubject(pack)]);
        const hybrid = await assetRetriever.retrieve(query, [assetSubject(pack)]);
        if (retrieval.status !== 'unique' || !retrieval.asset) {
          throw new Error(`asset retrieval ${retrieval.status} for ${pack.displayName}`);
        }
        const front = pack.mediaEntries.find(entry => entry.view === 'front');
        if (!front) throw new Error(`pack ${pack.id} has no front view`);
        resolved.push({
          entityId: assetPack.entityId,
          assetId: retrieval.asset.id,
          assetPackVersionId: retrieval.asset.assetPackVersionId,
          packInputVersionId: assetPack.pack.versionId,
          view: 'front',
          objectId: front.objectId,
          objectVersionId: front.objectVersionId,
          checksum: front.checksum,
          retrievalStatus: retrieval.status,
          retrievalScore: retrieval.score,
          retrievalRuleVersion: retrieval.ruleVersion,
          hybridRetrievalRuleVersion: hybrid.ruleVersion,
          hybridRetrievalMode: hybrid.retrievalMode,
          hybridSemanticStatus: hybrid.semantic.status,
          hybridDegradationReason: hybrid.degradationReason,
          hybridStatus: hybrid.status,
        });
      }
      observation.assetBindings.set(shot.shotId, resolved);
      return {
        state: 'succeeded',
        artifacts: [{
          key: 'shot-asset-bindings', kind: 'text', title: `${shot.shotId} 角色资产绑定`,
          metadata: {
            shotId: shot.shotId,
            snapshotId: state.snapshot.id,
            snapshotDigest: state.snapshot.snapshotDigest,
            bindings: resolved,
            retrievalMode: resolved[0]?.hybridRetrievalMode ?? 'degraded-lexical',
            degradationReason: resolved[0]?.hybridDegradationReason ?? 'milvus-unreachable',
          },
        }],
        qualityChecks: [{ level: 'shot', result: 'pass', ruleVersion: 'asset-rag-structured/1',
          summary: '对白角色已绑定到冻结资产包的 front 视图与 objectVersionId' }],
      };
    },
  };

  const videoExecutor = {
    stage: 'video',
    frozenInputVersion: 1,
    async prepare({ task }) { return prepared(task); },
    async execute({ task, frozenInput }) {
      if (task.scope.kind === 'episode') {
        return { state: 'succeeded', artifacts: [{ key: 'video-coordinator', kind: 'report',
          title: '镜头视频调度汇总', metadata: { shots: fixture.input.shots.map(shot => shot.shotId) } }],
        qualityChecks: [{ level: 'episode', result: 'pass', ruleVersion: 'e2e-video-coordination/1',
          summary: '全部镜头视频任务已按依赖完成' }] };
      }
      const shot = shotById.get(task.scope.id);
      const job = await video.runJob(shot);
      observation.videoJobs.push(job);
      return {
        state: 'succeeded',
        artifacts: [{
          key: 'shot-video', kind: 'video', title: `${shot.shotId} 视频候选`,
          uri: `/api/production-media/video/${job.result.taskId}`,
          sha256: job.result.sha256,
          metadata: {
            shotId: shot.shotId,
            shotRevisionId: shot.revisionId,
            shotContentDigest: shot.contentDigest,
            snapshotDigest: frozenInput.snapshot.snapshotDigest,
            provider: job.result.provider,
            providerTaskId: job.result.providerTaskId,
            outboxTaskId: job.result.taskId,
            outboxFinalState: job.finalState,
            outputKey: job.result.outputKey,
            sizeBytes: job.result.sizeBytes,
            durationSeconds: shot.durationMs / 1000,
            ratio: shot.ratio,
            resolution: '1080p',
          },
        }],
        qualityChecks: [{ level: 'shot', result: 'pass', ruleVersion: 'e2e-video-stub/1',
          summary: '确定性桩适配器输出 9:16 视频并挂载 SHA-256' }],
      };
    },
  };

  const review = {
    stage: 'review',
    frozenInputVersion: 1,
    async prepare({ task }) { return prepared(task); },
    async execute({ task }) {
      return {
        state: 'succeeded',
        artifacts: [{ key: 'shot-review', kind: 'report', title: `${task.label}复核`,
          metadata: { scope: task.scope, verdict: 'pass' } }],
        qualityChecks: [{ level: task.scope.kind === 'episode' ? 'episode' : 'shot', result: 'pass',
          ruleVersion: 'e2e-review/1', summary: '规格、时长、画幅与字幕检查通过' }],
      };
    },
  };

  const compose = {
    stage: 'compose',
    frozenInputVersion: 1,
    async prepare({ task }) { return prepared(task); },
    async execute({ frozenInput }) {
      const composition = await composeAudioAndSubtitle({ ...fixture, input: frozenInput });
      observation.composition = composition;
      const srtSha = sha256(composition.srt);
      return {
        state: 'succeeded',
        artifacts: [
          { key: 'audio-mix', kind: 'audio', title: '对白/BGM/SFX 混音',
            metadata: {
              filterComplex: composition.mixPlan.filterComplex,
              ffmpegArgs: composition.mixPlan.args,
              dialogueTrackId: composition.track.id,
              dialogueCues: composition.track.cues.length,
              voiceTakes: composition.takes.length,
              subtitleVersionId: composition.subtitle.id,
              subtitleChecks: composition.subtitle.checks,
              ducking: { threshold: 0.05, ratio: 4, attackMs: 20, releaseMs: 300 },
              srtSha256: srtSha,
              durationMs: composition.durationMs,
            } },
          { key: 'subtitles', kind: 'text', title: '同源 SRT 字幕',
            metadata: {
              subtitleVersionId: composition.subtitle.id,
              subtitleSchemaVersion: composition.subtitle.schemaVersion,
              srt: composition.srt,
              srtSha256: srtSha,
              verdict: composition.subtitle.checks.verdict,
              coverage: composition.subtitle.checks.coverage,
              readingSpeedFailures: composition.subtitle.checks.readingSpeedFailures,
              lineLengthFailures: composition.subtitle.checks.lineLengthFailures,
              burnInFilterPresent: composition.mixPlan.filterComplex.includes('subtitles=filename='),
            } },
        ],
        timeline: {
          tracks: [
            { kind: 'audio', artifactKeys: ['audio-mix'] },
            { kind: 'subtitle', artifactKeys: ['subtitles'] },
          ],
          durationSec: composition.durationMs / 1000,
        },
        qualityChecks: [{
          level: 'episode', result: 'pass', ruleVersion: 'e2e-audio-subtitle/1',
          summary: '对白轨、-6dB 侧链避让、同源 SRT 与阅读速度检查通过',
        }],
      };
    },
  };

  const deliver = {
    stage: 'deliver',
    frozenInputVersion: 1,
    async prepare({ task }) { return prepared(task); },
    async execute({ run, task }) {
      const composition = observation.composition;
      if (!composition) throw new Error('compose 尚未生成，不能交付');
      const masterSha = sha256(JSON.stringify({
        runId: run.id,
        snapshot: fixture.input.snapshot.snapshotDigest,
        dialogueTrack: composition.track.contentDigest,
        subtitle: composition.subtitle.contentDigest,
        filter: composition.mixPlan.filterComplex,
      }));
      return {
        state: 'succeeded',
        artifacts: [{
          key: 'master', kind: 'delivery', title: '短剧成片 MP4',
          uri: `/api/production-media/${run.id}/master`,
          sha256: masterSha,
          metadata: {
            container: 'mp4', ratio: run.ratio, durationSec: composition.durationMs / 1000,
            dialogueTrackId: composition.track.id,
            subtitleVersionId: composition.subtitle.id,
            subtitleSrtSha256: sha256(composition.srt),
            burnedIn: true,
            taskId: task.id,
          },
        }],
        delivery: {
          artifactKey: 'master', durationSec: composition.durationMs / 1000, container: 'mp4', verified: true,
        },
        qualityChecks: [{ level: 'episode', result: 'pass', ruleVersion: 'e2e-delivery/1',
          summary: '成片 MP4 容器、画幅、时长与字幕同源校验通过' }],
      };
    },
  };

  return {
    executors: [
      new BreakdownProductionExecutor(forbidden, forbidden, { estimateCostMicros: 100 }),
      new StoryboardProductionExecutor(forbidden, forbidden, { estimateCostMicros: 100 }),
      assets, videoExecutor, review, compose, deliver,
    ],
    shotById,
  };
}

async function driveProduction({ fixture, run, repository, executors, observation }) {
  const service = new ProductionService(repository, {
    frozenInputLoader: async () => structuredClone(fixture.input),
    now: () => new Date(observation.clock += 1_000),
    executors,
  });
  const tickUntil = async (predicate, label, maxTicks = 80) => {
    for (let index = 0; index < maxTicks; index += 1) {
      const stored = await repository.get(run.id);
      if (predicate(stored)) return stored;
      await service.tick(run.id);
      observation.ticks += 1;
    }
    throw new Error(`e2e 调度未在 ${maxTicks} 次 tick 内达到：${label}`);
  };
  return { service, tickUntil };
}

module.exports = {
  AT, TENANT, PROJECT_ID, EPISODE_ID, SCRIPT_ID, SCRIPT,
  buildFixture, runRequest, createProductionRun, createVideoPipeline,
  createPipelineExecutors, driveProduction, composeAudioAndSubtitle,
  retrieveAssetForGeneration, assetSubject, packMediaRefs,
  createHybridAssetRetriever, createDegradedAssetRetriever,
};
