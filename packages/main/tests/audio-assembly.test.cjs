const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, readFile, realpath, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const {
  AUDIO_PRODUCTION_SCHEMA_VERSION, DELIVERY_MEDIA_SCHEMA_VERSION,
} = require('@lyra/shared');
const { ProductionMediaError, ProductionMediaStore } = require('../dist/production-media');
const {
  AudioAssetStore, AudioVideoAssembler, DialogueTtsService, SubtitleArtifactStore,
  buildAudioAssemblyArgs,
} = require('../dist/production-media/audio');

const MIN_WAV = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x40\x1f\x00\x00\x80>\x00\x00\x02\x00\x10\x00data\x00\x00\x00\x00', 'binary');

function probe(changes = {}) {
  return { container: 'mp4', durationSeconds: 2, width: 720, height: 1280,
    videoCodec: 'h264', hasAudio: false, audioCodec: null, ...changes };
}

class ContentProber {
  constructor(entries = {}) { this.entries = entries; }
  async probe(path) {
    const key = (await readFile(path)).toString('utf8');
    return structuredClone(this.entries[key] ?? probe());
  }
}

class FakeRunner {
  constructor(outputBytes = 'assembled') { this.calls = []; this.outputBytes = outputBytes; }
  async run(command, args, options) {
    this.calls.push({ command, args: [...args], options });
    if (args.includes('-filters')) {
      return { stdout: Buffer.from(' sidechaincompress AA->A Sidechain compressor.\n drawtext V->V Draw text.\n alimiter A->A Limit.\n'), stderr: Buffer.alloc(0) };
    }
    if (args.includes('-h') && args.includes('filter=amix')) {
      return { stdout: Buffer.from('  normalize  bool  normalize\n'), stderr: Buffer.alloc(0) };
    }
    const output = args[args.length - 1];
    await writeFile(output, this.outputBytes);
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
}

function profile(overrides = {}) {
  return {
    schemaVersion: AUDIO_PRODUCTION_SCHEMA_VERSION, id: 'voice_1', workspaceId: 'ws', projectId: 'project',
    displayName: '女主角', provider: 'fake', model: 'tts-1', modelRevision: 'r1',
    voiceReference: 'voice-ref-opaque', language: 'zh-CN',
    attributes: { gender: 'female', age: 'young', style: ['calm'] }, previewArtifactId: null,
    authorization: { subject: 'virtual-1', type: 'synthetic', commercialUse: true,
      territories: ['CN'], channels: ['online'], validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2030-01-01T00:00:00.000Z', consentRecordRef: null, revokedAt: null,
      cloningConsent: false },
    scope: { workspaceWide: true, projectIds: [] }, reviewStatus: 'approved',
    contentDigest: 'profile-digest', createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

function track(overrides = {}) {
  const cue = {
    cueId: 'cue_1', shotId: 'shot_1', speakerEntityId: 'entity_hero', text: '你好，世界',
    language: 'zh-CN', emotion: 'calm', pace: 'normal', pauseAfterMs: 0, pronunciationHints: [],
    sourceScriptVersionId: 'script_1', shotSpecVersionId: 'shotrev_1',
    sourceRange: { start: 0, end: 6, quote: '你好，世界' }, sourceDigest: 'cue-digest',
    timing: { expectedStartMs: 100, expectedEndMs: 1_100, toleranceMs: 450,
      contextBeforeCueId: null, contextAfterCueId: null },
    adoptedVoiceTakeVersionId: null, waiver: null, reviewStatus: 'approved',
  };
  return {
    schemaVersion: AUDIO_PRODUCTION_SCHEMA_VERSION, id: 'track_1', workspaceId: 'ws', projectId: 'project',
    episodeId: 'episode_1', scriptVersionId: 'script_1', productionInputSnapshotId: 'snapshot_1',
    productionInputSnapshotDigest: 'snapshot-digest', cues: [cue], baseVersionId: null,
    contentDigest: 'track-digest', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'tester',
    adoptedAt: null, ...overrides,
  };
}

function take(overrides = {}) {
  return {
    schemaVersion: AUDIO_PRODUCTION_SCHEMA_VERSION, id: 'take_1', workspaceId: 'ws', projectId: 'project',
    dialogueCueVersionId: 'track_1', dialogueCueId: 'cue_1', voiceProfileVersionId: 'voice_1',
    provider: 'fake', modelRevision: 'r1', inputDigest: 'op', operationKey: 'op', attemptId: 'attempt',
    audioArtifactId: 'audio_1', objectVersionId: null, checksum: 'checksum', durationMs: 1_000,
    sampleRate: 48_000, channels: 1, codec: 'wav', alignment: { kind: 'provider', offsetMs: 0 },
    costMicros: 10, status: 'adopted', quality: { decoded: true, textCoverage: 1, silenceRatio: null,
      clippingRatio: null, verdict: 'pass', evidenceRefs: [] }, createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

async function fixture(t) {
  const temp = await realpath(tmpdir());
  const base = await mkdtemp(join(temp, 'lyra-audio-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const store = new ProductionMediaStore(join(base, 'media'), new ContentProber({ videoA: probe(), videoB: probe(), assembled: probe({ hasAudio: true, audioCodec: 'aac' }) }));
  await store.initialize();
  const audio = new AudioAssetStore(join(base, 'audio'), () => new Date('2026-01-01T00:00:00.000Z'));
  await audio.initialize();
  const subtitles = new SubtitleArtifactStore(join(base, 'subtitles'));
  await subtitles.initialize();
  return { base, store, audio, subtitles };
}

test('audio store is content-addressed, rejects magic mismatches, and deduplicates', async t => {
  const f = await fixture(t);
  const first = await f.audio.put({ bytes: MIN_WAV, format: 'wav', durationMs: 1_000, sampleRate: 48_000, channels: 1 });
  const second = await f.audio.put({ bytes: MIN_WAV, format: 'wav', durationMs: 1_000, sampleRate: 48_000, channels: 1 });
  assert.equal(first.artifactId, `audio_${createHash('sha256').update(MIN_WAV).digest('hex')}`);
  assert.deepEqual(second, first);
  assert.equal((await readFile((await f.audio.get(first.artifactId)).absolutePath)).length, MIN_WAV.length);
  await assert.rejects(f.audio.put({ bytes: Buffer.from('not a wav'), format: 'wav', durationMs: 1 }),
    error => error.code === 'LOCAL_AUDIO_FORMAT_INVALID');
  await assert.rejects(f.audio.put({ bytes: MIN_WAV, format: 'wav', durationMs: 0 }),
    error => error.code === 'LOCAL_AUDIO_DURATION_INVALID');
});

test('TTS fails closed before any provider call when voice authorization is missing', async t => {
  const f = await fixture(t);
  let called = 0;
  const provider = { provider: 'fake', model: 'tts-1', modelRevision: 'r1',
    async synthesize() { called += 1; throw new Error('must not run'); } };
  const denied = profile({ authorization: { ...profile().authorization, revokedAt: '2026-06-01T00:00:00.000Z' } });
  await assert.rejects(new DialogueTtsService().synthesize({
    workspaceId: 'ws', projectId: 'project', track: track(), assignments: [{ speakerEntityId: 'entity_hero', profile: denied }],
    provider, audioStore: f.audio, now: '2026-11-10T00:00:00.000Z',
  }), error => error.code === 'license_expired');
  assert.equal(called, 0, 'authorization must be evaluated before the paid provider call');
});

test('TTS produces versioned takes with durable audio artifacts and stable operation keys', async t => {
  const f = await fixture(t);
  const calls = [];
  const provider = { provider: 'fake', model: 'tts-1', modelRevision: 'r1',
    async synthesize(request) {
      calls.push(request);
      return { bytes: MIN_WAV, format: 'wav', durationMs: 1_200, sampleRate: 48_000, channels: 1,
        alignment: { kind: 'estimated', offsetMs: 0 }, costMicros: 100 };
    } };
  const result = await new DialogueTtsService().synthesize({
    workspaceId: 'ws', projectId: 'project', track: track(),
    assignments: [{ speakerEntityId: 'entity_hero', profile: profile() }],
    provider, audioStore: f.audio, now: '2026-11-10T00:00:00.000Z',
  });
  assert.equal(result.takes.length, 1);
  assert.equal(result.operationKeys.length, 1);
  assert.equal(calls.length, 1);
  assert.match(result.takes[0].audioArtifactId, /^audio_[a-f0-9]{64}$/);
  assert.equal(result.takes[0].checksum, createHash('sha256').update(MIN_WAV).digest('hex'));
  assert.equal(result.takes[0].status, 'generated');
  const replay = await new DialogueTtsService().synthesize({
    workspaceId: 'ws', projectId: 'project', track: track(),
    assignments: [{ speakerEntityId: 'entity_hero', profile: profile() }],
    provider, audioStore: f.audio, now: '2026-11-10T00:00:00.000Z',
  });
  assert.equal(replay.operationKeys[0], result.operationKeys[0]);
});

test('mix graph splits dialogue for sidechain and keeps the same track in the final mix', () => {
  const args = buildAudioAssemblyArgs({
    videos: ['v0.mp4', 'v1.mp4'],
    dialogue: [{ path: 'd0.wav', startMs: 100, durationMs: 1_000 }, { path: 'd1.wav', startMs: 1_500, durationMs: 1_200 }],
    bgm: { path: 'music.mp3', gainDb: -6, loop: true, ducking: { amountDb: 12, threshold: 0.05,
      ratio: 0, attackMs: 20, releaseMs: 300 } },
    sfx: [{ path: 'sfx.wav', startMs: 300, durationMs: 200, gainDb: -3 }],
    width: 720, height: 1280, totalDurationSeconds: 4,
    burnIn: { fontPath: '/System/Library/Fonts/PingFang.ttc', cues: [{ startMs: 100, endMs: 1_100,
      lines: ['你好，世界', '第二行'] }] },
    amixNormalize: true, alimiter: true, outputPath: 'out.mp4',
  });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /\[dlg\]asplit=2\[dside\]\[dmix\]/u);
  assert.match(graph, /\[musicraw\]\[dside\]sidechaincompress=threshold=0\.0500:ratio=4:attack=20:release=300/u);
  assert.match(graph, /\[dmix\]\[s0\]amix=inputs=2:duration=longest:normalize=0\[fg\]/u);
  assert.match(graph, /\[fg\]\[musicduck\]amix=inputs=2:duration=longest:normalize=0\[aoutpre\]/u);
  assert.equal((graph.match(/drawtext=/gu) ?? []).length, 2, 'each subtitle line must be drawn separately');
  assert.ok(args.includes('-stream_loop'), 'looping BGM must be requested before its input');
  assert.equal(args.at(-2), 'mp4');
  assert.equal(args.at(-1), 'out.mp4');
});

test('episode assembly persists a sidecar, records a candidate mix and delivery manifest', async t => {
  const f = await fixture(t);
  const runner = new FakeRunner();
  const video = await f.store.putVideoBuffer(Buffer.from('videoA'));
  const second = await f.store.putVideoBuffer(Buffer.from('videoB'));
  const dialogueAudio = await f.audio.put({ bytes: MIN_WAV, format: 'wav', durationMs: 1_000, sampleRate: 48_000, channels: 1 });
  const musicAudio = await f.audio.put({ bytes: Buffer.concat([Buffer.from('ID3'), Buffer.from([0xff, 0xfb])]), format: 'mp3', durationMs: 3_000, sampleRate: 44_100, channels: 2 });
  const assembler = new AudioVideoAssembler(f.store, f.audio, runner, f.subtitles);
  const result = await assembler.assemble({
    workspaceId: 'ws', projectId: 'project', videoIds: [video.id, second.id], title: '第一集',
    dialogue: { track: track(), takes: [take({ audioArtifactId: dialogueAudio.artifactId })] },
    bgm: { artifactId: musicAudio.artifactId, gainDb: -6, loop: true, ducking: { amountDb: 12 } },
    subtitle: { mode: 'sidecar', language: 'zh-CN', locale: 'zh-CN' },
  });
  assert.equal(result.video.probe.hasAudio, true);
  assert.equal(result.delivery.schemaVersion, DELIVERY_MEDIA_SCHEMA_VERSION);
  assert.equal(result.delivery.subtitleMode, 'sidecar');
  assert.equal(result.cueSheet.schemaVersion, AUDIO_PRODUCTION_SCHEMA_VERSION);
  assert.equal(result.cueSheet.cues.length, 2, 'dialogue + BGM cues must be frozen in the cue sheet');
  assert.equal(result.mixVersion.cueSheetVersionId, result.cueSheet.id);
  assert.equal(result.mixVersion.status, 'candidate');
  assert.equal(result.mixVersion.quality.verdict, 'inconclusive');
  assert.match(result.subtitleText, /你好，世界/u);
  assert.match(result.subtitle.sidecarArtifactId, /^subtitle_[a-f0-9]{64}$/u);
  assert.equal(await f.subtitles.get(result.subtitle.sidecarArtifactId), result.subtitleText);
  const finalArgs = runner.calls.at(-1).args;
  assert.match(finalArgs[finalArgs.indexOf('-filter_complex') + 1], /sidechaincompress/u);
  assert.ok(finalArgs.includes('-t'), 'assembly must pin the exact episode duration');
});

test('burn-in capability failure is explicit instead of silently shipping an unsubtitled MP4', async t => {
  const f = await fixture(t);
  class NoDrawtextRunner extends FakeRunner {
    async run(command, args, options) {
      if (args.includes('-filters')) {
        this.calls.push({ command, args: [...args], options });
        return { stdout: Buffer.from(' sidechaincompress AA->A\n'), stderr: Buffer.alloc(0) };
      }
      return super.run(command, args, options);
    }
  }
  const runner = new NoDrawtextRunner();
  const video = await f.store.putVideoBuffer(Buffer.from('videoA'));
  const assembler = new AudioVideoAssembler(f.store, f.audio, runner, f.subtitles);
  await assert.rejects(assembler.assemble({
    workspaceId: 'ws', projectId: 'project', videoIds: [video.id], title: '第一集',
    subtitle: { mode: 'burn_in', version: {
      schemaVersion: 'lyra-subtitle/1', id: 'subtitle_1', workspaceId: 'ws', projectId: 'project',
      dialogueTrackVersionId: 'track_1', mixVersionId: null, language: 'zh-CN', locale: 'zh-CN',
      cues: [{ id: 'sc1', dialogueCueId: 'cue_1', speakerEntityId: 'entity_hero', text: '你好',
        startMs: 100, endMs: 900, lines: ['你好'], styleTokens: [], sourceTakeVersionId: null, manualRevision: null }],
      style: { safeArea: 'bottom', maxLines: 2, maxCharsPerLine: 18, fontFamilyRef: null },
      checks: { coverage: 1, duplicateCueIds: [], overlapCueIds: [], readingSpeedFailures: [],
        lineLengthFailures: [], verdict: 'pass' }, sidecarArtifactId: null, burnInArtifactId: null,
      contentDigest: 'sub-digest', status: 'candidate', createdAt: '2026-01-01T00:00:00.000Z',
    } },
  }), error => error.code === 'AUDIO_SUBTITLE_BURN_IN_UNAVAILABLE');
});

test('real FFmpeg smoke: dialogue, ducked BGM and burned subtitles produce a playable episode MP4', {
  skip: process.env.LYRA_TEST_FFMPEG !== '1',
}, async t => {
  const { spawnSync } = require('node:child_process');
  const { FfprobeVideoProber, BoundedProcessRunner } = require('../dist/production-media');
  const temp = await realpath(tmpdir());
  const base = await mkdtemp(join(temp, 'lyra-audio-smoke-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const mediaRoot = join(base, 'media');
  const runner = new BoundedProcessRunner();
  const store = new ProductionMediaStore(mediaRoot, new FfprobeVideoProber(runner));
  await store.initialize();
  const incoming = join(mediaRoot, 'incoming');
  const audio = new AudioAssetStore(join(base, 'audio'));
  await audio.initialize();
  const subtitles = new SubtitleArtifactStore(join(base, 'subtitles'));
  await subtitles.initialize();
  const { mkdir } = require('node:fs/promises');
  await mkdir(incoming, { recursive: true });
  const generate = (args) => {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr?.toString());
  };
  for (const [name, color] of [['a.mp4', '0x224466'], ['b.mp4', '0x662244']]) {
    generate(['-f', 'lavfi', '-i', `color=c=${color}:s=320x568:r=30:d=2`, '-an',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(incoming, name)]);
  }
  generate(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.4:sample_rate=48000', '-c:a', 'pcm_s16le',
    join(base, 'd.wav')]);
  generate(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=4:sample_rate=48000', '-c:a', 'libmp3lame',
    '-q:a', '4', join(base, 'music.mp3')]);
  const first = await store.importOwnedVideo(join(incoming, 'a.mp4'));
  const second = await store.importOwnedVideo(join(incoming, 'b.mp4'));
  const dialogueAudio = await audio.put({ bytes: await readFile(join(base, 'd.wav')), format: 'wav',
    durationMs: 1_400, sampleRate: 48_000, channels: 1 });
  const musicAudio = await audio.put({ bytes: await readFile(join(base, 'music.mp3')), format: 'mp3',
    durationMs: 4_000, sampleRate: 48_000, channels: 1 });
  const t2 = track();
  const take2 = take({ audioArtifactId: dialogueAudio.artifactId, durationMs: 1_400 });
  const assembler = new AudioVideoAssembler(store, audio, runner, subtitles);
  const result = await assembler.assemble({
    workspaceId: 'ws', projectId: 'project', videoIds: [first.id, second.id], title: '声音字幕回归',
    dialogue: { track: t2, takes: [take2] },
    bgm: { artifactId: musicAudio.artifactId, gainDb: -6, loop: true, ducking: { amountDb: 12 } },
    subtitle: { mode: 'burn_in' },
  });
  assert.equal(result.video.probe.hasAudio, true);
  assert.ok(Math.abs(result.video.probe.durationSeconds - 4) < 0.15);
  assert.equal(result.subtitle.burnInArtifactId, result.video.id);
  assert.match(result.subtitleText, /你好，世界/u);
  const output = await store.getVideo(result.video.id);
  const frame = await runner.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.5',
    '-i', output.absolutePath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
  { timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 });
  const pixels = frame.stdout;
  let bright = 0;
  for (let index = 0; index < pixels.length; index += 3) {
    if (pixels[index] > 190 && pixels[index + 1] > 190 && pixels[index + 2] > 190) bright++;
  }
  assert.ok(bright > 20, 'burned subtitle glyphs must be visible in the lower frame region');
});
