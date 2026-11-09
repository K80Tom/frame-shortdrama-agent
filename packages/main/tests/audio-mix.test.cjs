const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAudioMixPlan } = require('../dist/production-media/audio/mix');
const { parseAudioFfprobe } = require('../dist/production-media/audio/probe');

const subtitle = {
  schemaVersion: 'lyra-subtitle/1', id: 'subtitles_1', workspaceId: `ws_${'e'.repeat(32)}`,
  projectId: 'project-model-generation', dialogueTrackVersionId: 'dialogue_1', mixVersionId: null,
  language: 'zh-CN', locale: 'zh-CN', cues: [{
    id: 'subcue_1', dialogueCueId: 'cue_1', speakerEntityId: 'character_1', text: '第一句对白',
    startMs: 0, endMs: 1500, lines: ['第一句对白'], styleTokens: [], sourceTakeVersionId: 'take_1',
    manualRevision: null,
  }],
  style: { safeArea: '24', maxLines: 2, maxCharsPerLine: 20, fontFamilyRef: null },
  checks: { coverage: 1, duplicateCueIds: [], overlapCueIds: [], readingSpeedFailures: [],
    lineLengthFailures: [], verdict: 'pass' },
  sidecarArtifactId: null, burnInArtifactId: null, contentDigest: 'f'.repeat(64),
  status: 'candidate', createdAt: '2026-01-01T00:00:00.000Z',
};

test('audio mix builds dialogue, ducking, SFX and subtitle burn-in filter graph', () => {
  const plan = buildAudioMixPlan({
    videoPath: '/tmp/shot.mp4', outputPath: '/tmp/mix.mp4', durationMs: 10_000,
    dialogue: [
      { id: 'd1', path: '/tmp/d1.wav', startMs: 0, endMs: 1500, gainDb: 0 },
      { id: 'd2', path: '/tmp/d2.wav', startMs: 2000, endMs: 4000, gainDb: -2 },
    ],
    music: { path: '/tmp/music.mp3', gainDb: -12,
      ducking: { enabled: true, threshold: 0.05, ratio: 4, attackMs: 20, releaseMs: 300 } },
    sfx: [{ id: 's1', path: '/tmp/sfx.wav', startMs: 500, gainDb: -6 }],
    ambience: { path: '/tmp/amb.wav', gainDb: -20 },
    subtitles: { version: subtitle, mode: 'burn-in', srtPath: '/tmp/mix.srt' },
  });
  assert.equal(plan.warnings.length, 0);
  assert.match(plan.filterComplex, /\[dialogue\]/u);
  assert.match(plan.filterComplex, /\[dialogue\]asplit=2\[dsidesrc\]\[dmix\]/u);
  assert.match(plan.filterComplex, /sidechaincompress=threshold=0.05:ratio=4/u);
  assert.match(plan.filterComplex, /\[dmix\]\[musicduck\]/u);
  assert.match(plan.filterComplex, /subtitles=filename='/u);
  assert.match(plan.filterComplex, /amix=inputs=4/u);
  assert.match(plan.filterComplex, /adelay=2000\|2000/u);
  assert.match(plan.filterComplex, /\[aout\]/u);
  assert.equal(plan.subtitlePath, '/tmp/mix.srt');
  assert.ok(plan.subtitleSrt.includes('00:00:00,000 --> 00:00:01,500'));
  assert.ok(plan.args.includes('-filter_complex'));
  assert.ok(plan.args.includes('[vout]'));
});

test('audio mix skips sidechain when music is requested but there is no dialogue', () => {
  const plan = buildAudioMixPlan({
    videoPath: '/tmp/shot.mp4', outputPath: '/tmp/mix.mp4', durationMs: 5_000, dialogue: [],
    music: { path: '/tmp/music.mp3', ducking: { enabled: true, threshold: 0.05, ratio: 4,
      attackMs: 20, releaseMs: 300 } },
    subtitles: null,
  });
  assert.equal(plan.warnings.length, 1);
  assert.doesNotMatch(plan.filterComplex, /sidechaincompress/u);
});

test('audio mix splits a single dialogue clip before using it as a sidechain', () => {
  const plan = buildAudioMixPlan({
    videoPath: '/tmp/shot.mp4', outputPath: '/tmp/mix.mp4', durationMs: 3_000,
    dialogue: [{ id: 'd1', path: '/tmp/d1.wav', startMs: 0, endMs: 1_000 }],
    music: { path: '/tmp/music.mp3', ducking: { enabled: true, threshold: 0.05, ratio: 4,
      attackMs: 20, releaseMs: 300 } },
    subtitles: null,
  }, { amixNormalize: false });
  assert.match(plan.filterComplex, /\[d0\]asplit=2\[dsidesrc\]\[dmix\]/u);
  assert.match(plan.filterComplex, /\[dmix\]\[musicduck\]/u);
  assert.doesNotMatch(plan.filterComplex, /normalize=0/u);
});

test('audio mix refuses a failed subtitle version and never writes a burn-in plan', () => {
  const failed = { ...subtitle, checks: { ...subtitle.checks, verdict: 'fail' } };
  assert.throws(() => buildAudioMixPlan({
    videoPath: '/tmp/shot.mp4', outputPath: '/tmp/mix.mp4', durationMs: 5_000,
    dialogue: [{ id: 'd1', path: '/tmp/d1.wav', startMs: 0, endMs: 1000 }],
    subtitles: { version: failed, mode: 'burn-in', srtPath: '/tmp/mix.srt' },
  }), error => error.code === 'AUDIO_MIX_REQUEST_INVALID');
});

test('audio probe accepts exactly one audio stream and rejects video containers', () => {
  const audio = parseAudioFfprobe({ streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le',
    sample_rate: '48000', channels: 2, duration: '1.5' }], format: { duration: '1.5' } });
  assert.deepEqual(audio, { durationMs: 1_500, sampleRate: 48_000, channels: 2, codec: 'pcm_s16le' });
  assert.throws(() => parseAudioFfprobe({ streams: [{ codec_type: 'video', codec_name: 'h264' },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, duration: 1 }] }),
  error => error.code === 'LOCAL_AUDIO_PROBE_INVALID');
});
