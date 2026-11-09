const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDialogueTrack, computeInvalidation } = require('../dist/audio-production/dialogue');
const { buildSubtitleVersion, validateSubtitleCues, renderSubtitle } = require('../dist/audio-production/subtitle');
const { evaluateVoiceAuthorization, assertVoiceAuthorization, VoiceAuthorizationError } = require('../dist/audio-production/authorization');

const WS = `ws_${'a'.repeat(32)}`;
const PROJECT = 'project_1';
const EPISODE = 'episode_1';
const SCRIPT = 'script_1';

function shot(overrides = {}) {
  return {
    schemaVersion: 'lyra-shot-spec/2', revisionId: 'shotrev_1', workspaceId: WS, projectId: PROJECT,
    episodeId: EPISODE, scriptVersionId: SCRIPT, planRevisionId: 'plan_1', storyboardRevisionId: 'board_1',
    shotId: 'shot_1', sceneId: 'scene_1', order: 0, durationMs: 3000, ratio: '9:16', shotSize: '中景',
    camera: { description: null, movement: '固定', focalLengthMm: null, composition: null },
    dialogue: [{ id: 'dialogue_1', speakerEntityId: 'character_1', text: '你终于来了吗', tone: '克制',
      sourceRef: { scriptVersionId: SCRIPT, start: 10, end: 20, quote: '你终于来了吗' } }],
    actions: [], assetPacks: [], controls: [],
    visualStyle: '雨夜', negativeConstraints: [],
    continuity: { before: [], after: [] },
    timeline: [{ id: 'cue_1', kind: 'dialogue', startMs: 500, endMs: 2500, dialogueId: 'dialogue_1',
      entityId: 'character_1', text: '你终于来了吗', asset: null }],
    generation: { methodPackRevisions: [], promptPackRevision: { id: 'prompt', versionId: 'v1', digest: '0'.repeat(64) },
      modelCapabilityRevision: { id: 'cap', versionId: 'v1', digest: '0'.repeat(64) }, candidatePolicy: { mode: 'direct', limit: 1 } },
    sourceRefs: [], source: { kind: 'user', actor: 'unit', sourceRevisionId: null },
    createdAt: '2026-11-09T00:00:00.000Z', contentDigest: '1'.repeat(64), ...overrides,
  };
}

function track() {
  return buildDialogueTrack({
    id: 'dialogue_track_1', workspaceId: WS, projectId: PROJECT, episodeId: EPISODE, scriptVersionId: SCRIPT,
    productionInputSnapshotId: 'snapshot_1', productionInputSnapshotDigest: '2'.repeat(64),
    shots: [shot(), shot({ revisionId: 'shotrev_2', shotId: 'shot_2', order: 1, durationMs: 3000,
      dialogue: [{ id: 'dialogue_2', speakerEntityId: 'character_2', text: '我等了你很久', tone: '疲惫',
        sourceRef: { scriptVersionId: SCRIPT, start: 30, end: 40, quote: '我等了你很久' } }],
      timeline: [{ id: 'cue_2', kind: 'dialogue', startMs: 0, endMs: 2000, dialogueId: 'dialogue_2',
        entityId: 'character_2', text: '我等了你很久', asset: null }] })],
    createdBy: 'unit', createdAt: '2026-11-09T00:00:00.000Z',
  });
}

function graph() {
  return {
    voiceTakes: [
      { id: 'take_1', dialogueCueId: 'cue_1', voiceProfileVersionId: 'voice_1', shotId: 'shot_1' },
      { id: 'take_2', dialogueCueId: 'cue_2', voiceProfileVersionId: 'voice_2', shotId: 'shot_2' },
    ],
    lipSyncCandidates: [
      { id: 'lip_1', shotId: 'shot_1', voiceTakeVersionId: 'take_1' },
      { id: 'lip_2', shotId: 'shot_2', voiceTakeVersionId: 'take_2' },
    ],
    subtitleVersion: { id: 'subtitle_1', dialogueTrackVersionId: 'dialogue_track_1', cues: [
      { id: 'subcue_1', dialogueCueId: 'cue_1', shotId: 'shot_1', startMs: 500, endMs: 2500 },
      { id: 'subcue_2', dialogueCueId: 'cue_2', shotId: 'shot_2', startMs: 3200, endMs: 5000 },
    ] },
    cueSheets: [
      { id: 'sheet_1', cues: [
        { id: 'c1', dialogueCueId: 'cue_1', shotId: 'shot_1', startMs: 500, endMs: 2500, track: 'dialogue' },
        { id: 'm1', dialogueCueId: null, shotId: 'shot_1', startMs: 500, endMs: 2500, track: 'music' },
      ] },
      { id: 'sheet_2', cues: [
        { id: 'c2', dialogueCueId: 'cue_2', shotId: 'shot_2', startMs: 3000, endMs: 5000, track: 'dialogue' },
      ] },
    ],
    mixes: [{ id: 'mix_1', cueSheetVersionId: 'sheet_1' }, { id: 'mix_2', cueSheetVersionId: 'sheet_2' }],
    deliveryManifests: [
      { id: 'delivery_1', mixVersionId: 'mix_1', subtitleVersionId: 'subtitle_1', timelineVersionId: 'timeline_1', shotIds: ['shot_1'] },
      { id: 'delivery_2', mixVersionId: 'mix_2', subtitleVersionId: 'subtitle_1', timelineVersionId: 'timeline_1', shotIds: ['shot_2'] },
    ],
  };
}

test('dialogue track is built from frozen ShotSpec timings and source lineage', () => {
  const built = track();
  assert.equal(built.cues.length, 2);
  assert.equal(built.cues[0].timing.expectedStartMs, 500);
  assert.equal(built.cues[1].timing.expectedStartMs, 3000);
  assert.equal(built.cues[0].speakerEntityId, 'character_1');
  assert.equal(built.cues[0].shotSpecVersionId, 'shotrev_1');
  assert.match(built.contentDigest, /^[a-f0-9]{64}$/);
  assert.equal(built.cues[0].timing.contextAfterCueId, 'cue_2');
});

test('cue edit invalidates only its take, lip sync, subtitle cues, mix and delivery', () => {
  const built = track();
  const result = computeInvalidation({ kind: 'dialogue_cue', track: built, cueIds: ['cue_1'], reason: 'text edit' },
    graph(), '2026-11-09T00:10:00.000Z');
  const affected = new Set(result.affected.map(item => `${item.kind}:${item.id}`));
  assert.ok(affected.has('voice_take:take_1'));
  assert.ok(affected.has('lip_sync:lip_1'));
  assert.ok(affected.has('subtitle_cue:subcue_1'));
  assert.ok(affected.has('mix:mix_1'));
  assert.ok(affected.has('delivery_manifest:delivery_1'));
  assert.equal(affected.has('voice_take:take_2'), false);
  assert.equal(affected.has('lip_sync:lip_2'), false);
  assert.equal(affected.has('mix:mix_2'), false);
  assert.equal(affected.has('delivery_manifest:delivery_2'), false);
  const preserved = new Set(result.preserved.map(item => `${item.kind}:${item.id}`));
  assert.ok(preserved.has('voice_take:take_2'));
  assert.ok(preserved.has('mix:mix_2'));
});

test('music gain rebuilds only the affected mix and delivery, never TTS, lip sync or subtitles', () => {
  const built = track();
  const result = computeInvalidation({ kind: 'music_gain', track: built, cueSheetVersionId: 'sheet_1', cueId: 'm1', reason: 'gain' },
    graph(), '2026-11-09T00:10:00.000Z');
  assert.deepEqual(result.affected.map(item => `${item.kind}:${item.id}`).sort(), ['delivery_manifest:delivery_1', 'mix:mix_1']);
});

test('subtitle style rerenders only the subtitle version and manifests using it', () => {
  const result = computeInvalidation({ kind: 'subtitle_style', track: track(), subtitleVersionId: 'subtitle_1', reason: 'style' },
    graph(), '2026-11-09T00:10:00.000Z');
  assert.deepEqual(result.affected.map(item => item.kind).sort(), ['delivery_manifest', 'delivery_manifest', 'subtitle_version']);
});

test('video candidate change rechecks lip sync and delivery but preserves independent TTS', () => {
  const result = computeInvalidation({ kind: 'video_candidate', track: track(), shotId: 'shot_1', reason: 'new take' },
    graph(), '2026-11-09T00:10:00.000Z');
  const affected = new Set(result.affected.map(item => `${item.kind}:${item.id}`));
  assert.ok(affected.has('lip_sync:lip_1'));
  assert.ok(affected.has('delivery_manifest:delivery_1'));
  assert.equal(affected.has('lip_sync:lip_2'), false);
  assert.equal(affected.has('voice_take:take_1'), false);
  assert.ok(result.preserved.some(item => item.id === 'take_1'));
});

test('VoiceProfile authorization blocks unconsented cloning, expiry and revocation', () => {
  const profile = {
    workspaceId: WS, scope: { workspaceWide: true, projectIds: [] },
    authorization: { subject: 'actor', type: 'licensed_real_person', commercialUse: true,
      territories: ['CN'], channels: ['web'], validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2027-01-01T00:00:00.000Z', consentRecordRef: 'consent_1', revokedAt: null, cloningConsent: false },
  };
  const context = { now: '2026-11-09T00:00:00.000Z', workspaceId: WS, projectId: PROJECT, purpose: 'generate', commercialUse: true };
  const denied = evaluateVoiceAuthorization(profile, context);
  assert.equal(denied.allowed, false); assert.equal(denied.code, 'unauthorized_voice');
  assert.throws(() => assertVoiceAuthorization(profile, context), error => error instanceof VoiceAuthorizationError && error.code === 'unauthorized_voice');
  assert.equal(evaluateVoiceAuthorization({ ...profile, authorization: { ...profile.authorization, cloningConsent: true,
    consentRecordRef: null } }, context).allowed, false);
  assert.equal(evaluateVoiceAuthorization({ ...profile, authorization: { ...profile.authorization, cloningConsent: true,
    revokedAt: '2026-06-01T00:00:00.000Z' } }, context).code, 'license_expired');
  assert.equal(evaluateVoiceAuthorization({ ...profile, authorization: { ...profile.authorization, cloningConsent: true,
    validUntil: '2026-10-01T00:00:00.000Z' } }, context).code, 'license_expired');
  assert.equal(evaluateVoiceAuthorization({ ...profile, authorization: { ...profile.authorization, cloningConsent: true,
    consentRecordRef: 'consent_1' } }, context).allowed, true);
});

test('subtitle is built from adopted take timing and renders identical SRT and WebVTT cues', () => {
  const built = track();
  built.cues[0].adoptedVoiceTakeVersionId = 'take_1';
  built.cues[1].adoptedVoiceTakeVersionId = 'take_2';
  const takes = [
    { id: 'take_1', status: 'adopted', durationMs: 2000, alignment: { kind: 'provider', offsetMs: 0 } },
    { id: 'take_2', status: 'adopted', durationMs: 1900, alignment: { kind: 'provider', offsetMs: 20 } },
  ];
  const subtitle = buildSubtitleVersion({ id: 'subtitle_1', workspaceId: WS, projectId: PROJECT, track: built,
    takes, language: 'zh-CN', locale: 'zh-CN', style: { safeArea: 'bottom', maxLines: 2, maxCharsPerLine: 20,
      fontFamilyRef: null }, createdAt: '2026-11-09T00:00:00.000Z' });
  assert.equal(subtitle.checks.verdict, 'pass');
  assert.equal(subtitle.cues.length, 2);
  assert.equal(subtitle.cues[1].startMs, 3020);
  assert.equal(subtitle.cues[1].endMs, 4920);
  const srt = renderSubtitle(subtitle, 'srt');
  const vtt = renderSubtitle(subtitle, 'vtt');
  assert.match(srt, /00:00:00,500 --> 00:00:02,500/);
  assert.match(vtt, /WEBVTT/);
  assert.match(vtt, /00:00:03\.020 --> 00:00:04\.920/);
  assert.equal(srt.includes('你终于来了吗'), true);
  assert.equal(vtt.includes('我等了你很久'), true);
});

test('subtitle validation catches overlap and reading-speed failures', () => {
  const built = track();
  built.cues[0].adoptedVoiceTakeVersionId = 'take_1';
  built.cues[1].adoptedVoiceTakeVersionId = 'take_2';
  const takes = [
    { id: 'take_1', status: 'adopted', durationMs: 3000, alignment: { kind: 'provider', offsetMs: 0 } },
    { id: 'take_2', status: 'adopted', durationMs: 300, alignment: { kind: 'provider', offsetMs: 0 } },
  ];
  const subtitle = buildSubtitleVersion({ id: 'subtitle_bad', workspaceId: WS, projectId: PROJECT, track: built,
    takes, language: 'zh-CN', locale: 'zh-CN', style: { safeArea: 'bottom', maxLines: 2, maxCharsPerLine: 20,
      fontFamilyRef: null }, createdAt: '2026-11-09T00:00:00.000Z' });
  assert.equal(subtitle.checks.verdict, 'fail');
  assert.ok(subtitle.checks.overlapCueIds.length > 0 || subtitle.checks.readingSpeedFailures.length > 0);
  assert.throws(() => renderSubtitle(subtitle, 'srt'), /unresolved/);
});
