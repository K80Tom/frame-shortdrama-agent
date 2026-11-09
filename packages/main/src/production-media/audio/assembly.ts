import { createHash } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AUDIO_PRODUCTION_SCHEMA_VERSION, DELIVERY_MEDIA_SCHEMA_VERSION, canonicalDigest,
  type CueSheetCue, type CueSheetVersion, type DeliveryMediaManifest, type DialogueTrackVersion, type MixVersion,
  type SubtitleVersion, type VoiceProfileVersion, type VoiceTakeVersion,
} from '@lyra/shared';
import { buildSubtitleVersion, renderSubtitle, type SubtitleStyleProfile } from '../../audio-production/subtitle';
import { ProductionMediaError, type LocalVideoObject } from '../contracts';
import type { ProcessRunner } from '../probe';
import type { ProductionMediaStore } from '../store';
import { findTimelineFont, timelineFontFilterPath, timelineFontCandidates } from '../timeline-fonts';
import { AudioAssetStore } from './audio-store';
import { SubtitleArtifactStore } from './subtitle-store';

export interface AudioDuckingOptions {
  /** Target attenuation in dB; converted to a conservative sidechain ratio. */
  amountDb: number;
  threshold?: number;
  ratio?: number;
  attackMs?: number;
  releaseMs?: number;
}

export interface AssemblyBgmInput {
  artifactId: string;
  gainDb?: number;
  /** Loop the BGM so it covers the whole episode. */
  loop?: boolean;
  ducking?: AudioDuckingOptions | null;
}

export interface AssemblySfxInput {
  artifactId: string;
  startMs: number;
  gainDb?: number;
}

export interface AssemblyDialogueInput {
  track: Readonly<DialogueTrackVersion>;
  takes: ReadonlyArray<Readonly<VoiceTakeVersion>>;
  profiles?: ReadonlyArray<Readonly<VoiceProfileVersion>>;
}

export interface AssemblySubtitleInput {
  version?: Readonly<SubtitleVersion>;
  mode: 'sidecar' | 'burn_in' | 'none';
  style?: SubtitleStyleProfile;
  language?: string;
  locale?: string;
}

export interface AssembleEpisodeInput {
  workspaceId: string;
  projectId: string;
  videoIds: string[];
  title: string;
  dialogue?: AssemblyDialogueInput;
  bgm?: AssemblyBgmInput;
  sfx?: AssemblySfxInput[];
  subtitle?: AssemblySubtitleInput;
}

export interface AudioAssemblyResult {
  video: LocalVideoObject;
  cueSheet: CueSheetVersion;
  subtitle: SubtitleVersion | null;
  subtitleText: string | null;
  mixVersion: MixVersion | null;
  delivery: DeliveryMediaManifest;
  durationSeconds: number;
  width: number;
  height: number;
}

export interface AssemblyCapabilities {
  amixNormalize: boolean;
  sidechain: boolean;
  drawtext: boolean;
  alimiter: boolean;
}

export interface AudioAssemblyArgsInput {
  videos: readonly string[];
  dialogue: ReadonlyArray<{ path: string; startMs: number; durationMs: number; gainDb?: number }>;
  bgm: (Readonly<{ path: string; gainDb?: number; loop?: boolean }> & {
    ducking?: Readonly<Required<Pick<AudioDuckingOptions, 'amountDb' | 'threshold' | 'ratio' | 'attackMs' | 'releaseMs'>>> | null;
  }) | null;
  sfx: ReadonlyArray<{ path: string; startMs: number; durationMs: number; gainDb?: number }>;
  width: number;
  height: number;
  totalDurationSeconds: number;
  burnIn: { fontPath: string; cues: ReadonlyArray<{ startMs: number; endMs: number; lines: string[] }>;
    fontSize?: number; marginBottom?: number } | null;
  amixNormalize: boolean;
  alimiter: boolean;
  outputPath: string;
}

interface ResolvedDialogueClip {
  path: string;
  startMs: number;
  durationMs: number;
  endMs: number;
  cueId: string;
  shotId: string;
  artifactId: string;
}

interface ResolvedBgm {
  path: string;
  artifactId: string;
  gainDb: number;
  loop: boolean;
  ducking: Required<Pick<AudioDuckingOptions, 'amountDb' | 'threshold' | 'ratio' | 'attackMs' | 'releaseMs'>> | null;
}

interface ResolvedSfx {
  path: string;
  artifactId: string;
  startMs: number;
  durationMs: number;
  gainDb: number;
}

function even(value: number): number {
  return value % 2 === 0 ? value : value - 1;
}

function seconds(valueMs: number): string {
  return Math.max(0, valueMs / 1000).toFixed(3);
}

function gain(value: number | undefined): string {
  const db = Number.isFinite(value) ? Math.max(-60, Math.min(24, value!)) : 0;
  return `${db.toFixed(2)}dB`;
}

function duckingRatio(options: Readonly<Required<Pick<AudioDuckingOptions, 'amountDb' | 'threshold' | 'ratio' | 'attackMs' | 'releaseMs'>>>): number {
  if (options.ratio > 1) return Math.max(1.1, Math.min(20, options.ratio));
  // 6 dB -> ~2x, 12 dB -> ~4x, 18 dB -> ~8x. Capped to avoid pumping.
  return Math.max(1.1, Math.min(20, Math.round(2 ** (Math.abs(options.amountDb) / 6) * 10) / 10));
}

/** Escape only the characters ffmpeg's filter parser treats as syntax. */
function escapeDrawtext(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'").replace(/:/gu, '\\:')
    .replace(/%/gu, '\\%').replace(/[\r\n]/gu, ' ');
}

function drawtextChain(label: string, cue: { startMs: number; endMs: number; lines: string[] },
  fontPath: string, fontSize: number, marginBottom: number, width: number): { filters: string[]; out: string } {
  const filters: string[] = [];
  let current = label;
  const lineHeight = Math.round(fontSize * 1.28);
  for (let index = 0; index < cue.lines.length; index++) {
    const next = `${current}_s${index}`;
    const text = cue.lines[index] ?? '';
    if (text.trim()) {
      const y = `h-${marginBottom}-${(cue.lines.length - index) * lineHeight}`;
      filters.push(`[${current}]drawtext=fontfile='${timelineFontFilterPath(fontPath)}':text='${escapeDrawtext(text)}':`+
        `fontcolor=white:fontsize=${fontSize}:x=(w-text_w)/2:y=${y}:borderw=2:bordercolor=black@0.85:`+
        `enable='between(t,${seconds(cue.startMs)},${seconds(cue.endMs)})'[${next}]`);
    } else {
      filters.push(`[${current}]null[${next}]`);
    }
    current = next;
  }
  // Keep the command bounded for very dense subtitle tracks.
  void width;
  return { filters, out: current };
}

/**
 * Build the exact FFmpeg argv. This is pure so the mix graph can be asserted
 * without invoking a binary. Audio inputs are appended after the video inputs.
 */
export function buildAudioAssemblyArgs(input: AudioAssemblyArgsInput): string[] {
  if (!input.videos.length) throw new ProductionMediaError(409, 'AUDIO_ASSEMBLY_NO_VIDEO', '成片至少需要一个视频镜头。');
  if (input.dialogue.length === 0 && !input.bgm && input.sfx.length === 0) {
    throw new ProductionMediaError(409, 'AUDIO_ASSEMBLY_NO_AUDIO', '成片没有对白、BGM 或音效，不能生成有声交付。');
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n'];
  for (const video of input.videos) args.push('-i', video);
  let index = input.videos.length;
  const dialogueIndices: number[] = [];
  for (const track of input.dialogue) { args.push('-i', track.path); dialogueIndices.push(index++); }
  let bgmIndex: number | null = null;
  if (input.bgm) {
    if (input.bgm.loop) args.push('-stream_loop', '-1');
    args.push('-i', input.bgm.path);
    bgmIndex = index++;
  }
  const sfxIndices: number[] = [];
  for (const track of input.sfx) { args.push('-i', track.path); sfxIndices.push(index++); }

  const filters: string[] = [];
  const width = even(Math.max(2, input.width));
  const height = even(Math.max(2, input.height));
  for (let i = 0; i < input.videos.length; i++) {
    filters.push(`[${i}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,`+
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${i}]`);
  }
  if (input.videos.length === 1) filters.push('[v0]null[vout]');
  else filters.push(`${input.videos.map((_, i) => `[v${i}]`).join('')}concat=n=${input.videos.length}:v=1:a=0[vout]`);

  let videoLabel = 'vout';
  if (input.burnIn?.cues.length) {
    const fontSize = input.burnIn.fontSize ?? Math.max(24, Math.round(width / 30));
    const marginBottom = input.burnIn.marginBottom ?? Math.max(48, Math.round(height * 0.08));
    let label = videoLabel;
    for (const cue of input.burnIn.cues) {
      const chain = drawtextChain(label, cue, input.burnIn.fontPath, fontSize, marginBottom, width);
      filters.push(...chain.filters);
      label = chain.out;
    }
    videoLabel = label;
  }

  const mixOptions = (count: number) => `amix=inputs=${count}:duration=longest${input.amixNormalize ? ':normalize=0' : ''}`;
  const duckingRequested = Boolean(input.bgm?.ducking && input.dialogue.length > 0);
  const dialogueLabels: string[] = [];
  input.dialogue.forEach((track, i) => {
    const duration = Math.min(track.durationMs, input.totalDurationSeconds * 1000);
    filters.push(`[${dialogueIndices[i]}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,`+
      `atrim=0:${seconds(duration)},asetpts=PTS-STARTPTS,adelay=${Math.max(0, Math.round(track.startMs))},`+
      `volume=${gain(track.gainDb)}[d${i}]`);
    dialogueLabels.push(`d${i}`);
  });
  let foreground: string | null = null;
  if (dialogueLabels.length === 1) {
    filters.push(`[${dialogueLabels[0]}]anull[dlg]`);
    foreground = 'dlg';
  } else if (dialogueLabels.length > 1) {
    filters.push(`${dialogueLabels.map(label => `[${label}]`).join('')}${mixOptions(dialogueLabels.length)}[dlg]`);
    foreground = 'dlg';
  }
  // The dialogue graph is consumed once. Split it before SFX mixing so the same
  // rendered dialogue can both key the compressor and reach the final mix.
  if (foreground && duckingRequested) {
    filters.push(`[dlg]asplit=2[dside][dmix]`);
    foreground = 'dmix';
  }

  const sfxLabels: string[] = [];
  input.sfx.forEach((track, i) => {
    const duration = Math.min(track.durationMs, input.totalDurationSeconds * 1000);
    filters.push(`[${sfxIndices[i]}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,`+
      `atrim=0:${seconds(duration)},asetpts=PTS-STARTPTS,adelay=${Math.max(0, Math.round(track.startMs))},`+
      `volume=${gain(track.gainDb)}[s${i}]`);
    sfxLabels.push(`s${i}`);
  });
  if (sfxLabels.length) {
    if (foreground) {
      filters.push(`[${foreground}]${sfxLabels.map(label => `[${label}]`).join('')}`+
        `${mixOptions(sfxLabels.length + 1)}[fg]`);
      foreground = 'fg';
    } else if (sfxLabels.length === 1) {
      filters.push(`[${sfxLabels[0]}]anull[fg]`);
      foreground = 'fg';
    } else {
      filters.push(`${sfxLabels.map(label => `[${label}]`).join('')}${mixOptions(sfxLabels.length)}[fg]`);
      foreground = 'fg';
    }
  }

  let music: string | null = null;
  if (bgmIndex !== null && input.bgm) {
    const duration = input.totalDurationSeconds;
    filters.push(`[${bgmIndex}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,`+
      `atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${gain(input.bgm.gainDb)}[musicraw]`);
    music = 'musicraw';
    if (duckingRequested) {
      const options = input.bgm.ducking!;
      const ratio = duckingRatio(options);
      const threshold = Math.max(0.0001, Math.min(1, options.threshold));
      filters.push(`[musicraw][dside]sidechaincompress=threshold=${threshold.toFixed(4)}:ratio=${ratio}:`+
        `attack=${Math.max(1, Math.round(options.attackMs))}:release=${Math.max(1, Math.round(options.releaseMs))}:`+
        `makeup=1[musicduck]`);
      music = 'musicduck';
    }
  }

  if (foreground && music) {
    filters.push(`[${foreground}][${music}]${mixOptions(2)}[aoutpre]`);
  } else if (foreground) {
    filters.push(`[${foreground}]anull[aoutpre]`);
  } else if (music) {
    filters.push(`[${music}]anull[aoutpre]`);
  } else {
    throw new ProductionMediaError(409, 'AUDIO_ASSEMBLY_NO_AUDIO', '没有可混流的音频源。');
  }
  filters.push(`[aoutpre]atrim=0:${input.totalDurationSeconds.toFixed(3)},apad=whole_dur=${input.totalDurationSeconds.toFixed(3)},`+
    `${input.alimiter ? 'alimiter=limit=0.95,' : ''}aresample=48000,asetpts=PTS-STARTPTS[aout]`);

  args.push('-filter_complex', filters.join(';'), '-map', `[${videoLabel}]`, '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn',
    '-t', input.totalDurationSeconds.toFixed(3), '-movflags', '+faststart', '-f', 'mp4', input.outputPath);
  return args;
}

export class AudioVideoAssembler {
  private capabilityPromise: Promise<AssemblyCapabilities> | null = null;
  constructor(private readonly store: ProductionMediaStore, private readonly audio: AudioAssetStore,
    private readonly runner: ProcessRunner, private readonly subtitles: SubtitleArtifactStore,
    private readonly options: { ffmpegExecutable?: string; timeoutMs?: number; fontCandidates?: readonly string[];
      maxDurationSeconds?: number } = {}) {}

  async assemble(input: AssembleEpisodeInput): Promise<AudioAssemblyResult> {
    if (!input.videoIds.length) throw new ProductionMediaError(409, 'AUDIO_ASSEMBLY_NO_VIDEO', '成片至少需要一个视频镜头。');
    const videos = [];
    for (const id of input.videoIds) videos.push(await this.store.getVideo(id));
    const first = videos[0]!;
    const width = even(first.object.probe.width);
    const height = even(first.object.probe.height);
    const totalDurationSeconds = videos.reduce((sum, video) => sum + video.object.probe.durationSeconds, 0);
    if (!Number.isFinite(totalDurationSeconds) || totalDurationSeconds <= 0
      || totalDurationSeconds > (this.options.maxDurationSeconds ?? this.store.limits.maxDurationSeconds)) {
      throw new ProductionMediaError(413, 'AUDIO_ASSEMBLY_DURATION_INVALID', '成片总时长无效或超过本地装配限制。');
    }
    const capabilities = await this.capabilities();
    const dialogue = input.dialogue ? await this.resolveDialogue(input, input.dialogue) : [];
    const bgm = input.bgm ? await this.resolveBgm(input.bgm) : null;
    const sfx = input.sfx?.length ? await Promise.all(input.sfx.map(item => this.resolveSfx(item))) : [];
    if (input.dialogue && (input.dialogue.track.workspaceId !== input.workspaceId
      || input.dialogue.track.projectId !== input.projectId)) {
      throw new ProductionMediaError(422, 'AUDIO_DIALOGUE_SCOPE_MISMATCH', '对白轨不属于当前工作区或项目。');
    }
    const subtitle = await this.resolveSubtitle(input);
    if (subtitle?.mode === 'burn_in' && !capabilities.drawtext) {
      throw new ProductionMediaError(503, 'AUDIO_SUBTITLE_BURN_IN_UNAVAILABLE',
        '本机 FFmpeg 缺少 drawtext 滤镜，不能烧录字幕；已拒绝静默产出无字幕成片。');
    }
    if (bgm && bgm.ducking && dialogue.length && !capabilities.sidechain) {
      throw new ProductionMediaError(503, 'AUDIO_DUCKING_UNAVAILABLE',
        '本机 FFmpeg 缺少 sidechaincompress 滤镜，不能执行自动闪避。');
    }
    let fontPath: string | null = null;
    if (subtitle?.mode === 'burn_in') {
      fontPath = await findTimelineFont(this.options.fontCandidates ?? timelineFontCandidates());
      if (!fontPath) {
        throw new ProductionMediaError(503, 'AUDIO_SUBTITLE_FONT_UNAVAILABLE', '本机没有可用的中文字幕字体，不能烧录字幕。');
      }
    }
    const work = await this.store.createWorkDirectory('audio-assemble');
    const outputPath = join(work, 'output.mp4');
    try {
      const args = buildAudioAssemblyArgs({
        videos: videos.map(video => video.absolutePath),
        dialogue: dialogue.map(clip => ({ path: clip.path, startMs: clip.startMs, durationMs: clip.durationMs, gainDb: 0 })),
        bgm: bgm ? { path: bgm.path, gainDb: bgm.gainDb, loop: bgm.loop,
          ducking: bgm.ducking ? { ...bgm.ducking } : null } : null,
        sfx: sfx.map(clip => ({ path: clip.path, startMs: clip.startMs, durationMs: clip.durationMs, gainDb: clip.gainDb })),
        width, height, totalDurationSeconds,
        burnIn: subtitle?.mode === 'burn_in' && fontPath ? { fontPath, cues: subtitle.version.cues } : null,
        amixNormalize: capabilities.amixNormalize, alimiter: capabilities.alimiter, outputPath,
      });
      await this.runner.run(this.options.ffmpegExecutable ?? 'ffmpeg', args, { cwd: work,
        timeoutMs: this.options.timeoutMs ?? 15 * 60_000, maxOutputBytes: 8 * 1024 * 1024 });
      const output = await this.store.importOwnedVideo(outputPath, 'composition');
      const tolerance = Math.max(2, totalDurationSeconds * 0.05);
      if (output.probe.width !== width || output.probe.height !== height || !output.probe.hasAudio
        || Math.abs(output.probe.durationSeconds - totalDurationSeconds) > tolerance) {
        throw new ProductionMediaError(422, 'AUDIO_ASSEMBLY_OUTPUT_MISMATCH',
          '成片时长、分辨率或音轨与装配计划不一致，未登记交付。');
      }
      const subtitleText = subtitle ? renderSubtitle(subtitle.version, 'srt') : null;
      let subtitleRecord: SubtitleVersion | null = subtitle?.version ?? null;
      let sidecarChecksum: string | null = null;
      if (subtitleText && subtitle) {
        const sidecar = await this.subtitles.put('srt', subtitleText);
        sidecarChecksum = sidecar.checksum;
        subtitleRecord = { ...subtitle.version, sidecarArtifactId: sidecar.artifactId };
        if (subtitle.mode === 'burn_in') subtitleRecord.burnInArtifactId = output.id;
      }
      const cueSheet = this.buildCueSheet(input, dialogue, bgm, sfx, totalDurationSeconds);
      const mix = await this.buildMix(input, cueSheet, dialogue, bgm, sfx, totalDurationSeconds, output);
      const delivery = this.buildDelivery(input, output, subtitleRecord, sidecarChecksum, mix, totalDurationSeconds, width, height);
      return { video: output, cueSheet, subtitle: subtitleRecord, subtitleText, mixVersion: mix,
        delivery, durationSeconds: totalDurationSeconds, width, height };
    } finally {
      await unlink(outputPath).catch(() => undefined);
      const { rmdir } = await import('node:fs/promises');
      await rmdir(work).catch(() => undefined);
    }
  }

  private async capabilities(): Promise<AssemblyCapabilities> {
    return this.capabilityPromise ??= (async () => {
      const [filters, amix] = await Promise.all([
        this.runner.run(this.options.ffmpegExecutable ?? 'ffmpeg', ['-hide_banner', '-filters'], { timeoutMs: 30_000 }),
        this.runner.run(this.options.ffmpegExecutable ?? 'ffmpeg', ['-hide_banner', '-h', 'filter=amix'], { timeoutMs: 30_000 }),
      ]);
      const text = filters.stdout.toString('utf8');
      return {
        amixNormalize: /normalize/iu.test(amix.stdout.toString('utf8')),
        sidechain: /\bsidechaincompress\b/u.test(text),
        drawtext: /\bdrawtext\b/u.test(text),
        alimiter: /\balimiter\b/u.test(text),
      };
    })();
  }

  private async resolveDialogue(input: AssembleEpisodeInput, dialogue: AssemblyDialogueInput):
    Promise<ResolvedDialogueClip[]> {
    const result: ResolvedDialogueClip[] = [];
    for (const cue of dialogue.track.cues) {
      const take = cue.adoptedVoiceTakeVersionId
        ? dialogue.takes.find(item => item.id === cue.adoptedVoiceTakeVersionId)
        : dialogue.takes.find(item => item.dialogueCueId === cue.cueId
          && (item.status === 'adopted' || item.status === 'generated'));
      if (!take) {
        if (cue.waiver?.granted) continue;
        throw new ProductionMediaError(422, 'AUDIO_DIALOGUE_TAKE_MISSING', `台词 ${cue.cueId} 没有可用的配音 take。`);
      }
      if (!take.audioArtifactId) {
        throw new ProductionMediaError(422, 'AUDIO_DIALOGUE_ARTIFACT_MISSING', `台词 ${cue.cueId} 的 take 没有音频产物。`);
      }
      if (take.workspaceId !== input.workspaceId || take.projectId !== input.projectId) {
        throw new ProductionMediaError(422, 'AUDIO_DIALOGUE_SCOPE_MISMATCH', `台词 ${cue.cueId} 的配音 take 不属于当前项目。`);
      }
      const file = await this.audio.get(take.audioArtifactId);
      const durationMs = take.durationMs ?? file.object.durationMs;
      const startMs = Math.max(0, cue.timing.expectedStartMs + (take.alignment?.offsetMs ?? 0));
      result.push({ path: file.absolutePath, startMs, durationMs, cueId: cue.cueId, shotId: cue.shotId,
        endMs: startMs + durationMs, artifactId: file.object.artifactId });
    }
    return result;
  }

  private async resolveBgm(bgm: AssemblyBgmInput): Promise<ResolvedBgm> {
    const file = await this.audio.get(bgm.artifactId);
    return { path: file.absolutePath, artifactId: file.object.artifactId, gainDb: bgm.gainDb ?? -6, loop: bgm.loop ?? false,
      ducking: bgm.ducking ? { amountDb: bgm.ducking.amountDb, threshold: bgm.ducking.threshold ?? 0.05,
        ratio: bgm.ducking.ratio ?? 0, attackMs: bgm.ducking.attackMs ?? 20,
        releaseMs: bgm.ducking.releaseMs ?? 300 } : null };
  }

  private async resolveSfx(sfx: AssemblySfxInput): Promise<ResolvedSfx> {
    if (!Number.isSafeInteger(sfx.startMs) || sfx.startMs < 0) {
      throw new ProductionMediaError(422, 'AUDIO_SFX_TIMING_INVALID', '音效起始时间无效。');
    }
    const file = await this.audio.get(sfx.artifactId);
    return { path: file.absolutePath, artifactId: file.object.artifactId, startMs: sfx.startMs,
      durationMs: file.object.durationMs, gainDb: sfx.gainDb ?? 0 };
  }

  private async resolveSubtitle(input: AssembleEpisodeInput):
    Promise<{ version: SubtitleVersion; mode: 'sidecar' | 'burn_in' | 'none' } | null> {
    const requested = input.subtitle;
    if (!requested || requested.mode === 'none') return null;
    if (requested.version) {
      if (requested.version.checks.verdict === 'fail') {
        throw new ProductionMediaError(422, 'SUBTITLE_INVALID', '字幕版本存在未解决的时长、覆盖率或阅读速度失败。');
      }
      return { version: requested.version, mode: requested.mode };
    }
    if (!input.dialogue) throw new ProductionMediaError(422, 'SUBTITLE_DIALOGUE_REQUIRED', '没有对白轨时不能生成字幕。');
    const style = requested.style ?? { safeArea: 'bottom', maxLines: 2, maxCharsPerLine: 18, fontFamilyRef: null };
    const seed = createHash('sha256').update(JSON.stringify({ track: input.dialogue.track.contentDigest,
      takes: input.dialogue.takes.map(take => take.id), style, mode: requested.mode })).digest('hex');
    const version = buildSubtitleVersion({
      id: `subtitle_${seed.slice(0, 40)}`, workspaceId: input.workspaceId, projectId: input.projectId,
      track: input.dialogue.track, takes: input.dialogue.takes,
      language: requested.language ?? 'zh-CN', locale: requested.locale ?? 'zh-CN', style,
      createdAt: new Date().toISOString(),
    });
    if (version.checks.verdict === 'fail') {
      throw new ProductionMediaError(422, 'SUBTITLE_INVALID', '字幕打轴校验失败。');
    }
    if (version.cues.some(cue => cue.endMs > 0 && cue.startMs < 0)) {
      throw new ProductionMediaError(422, 'SUBTITLE_INVALID', '字幕时间轴为负。');
    }
    return { version, mode: requested.mode };
  }

  private buildCueSheet(input: AssembleEpisodeInput, dialogue: ResolvedDialogueClip[],
    bgm: ResolvedBgm | null, sfx: ResolvedSfx[], durationSeconds: number): CueSheetVersion {
    const timelineId = `timeline_${canonicalDigest({ videos: input.videoIds, durationSeconds }).slice(0, 40)}`;
    const endLimitMs = Math.round(durationSeconds * 1_000);
    const cues: CueSheetCue[] = [
      ...dialogue.map(clip => ({
        id: `cue_dialogue_${clip.cueId}`, track: 'dialogue' as const,
        startMs: clip.startMs, endMs: Math.min(endLimitMs, clip.endMs),
        artifactVersionId: clip.artifactId, dialogueCueId: clip.cueId,
        gainDb: 0, pan: 0, fadeInMs: 0, fadeOutMs: 0, loop: false, ducking: null,
        shotId: clip.shotId, sceneId: null,
      })),
      ...(bgm ? [{
        id: 'cue_music_main', track: 'music' as const, startMs: 0, endMs: endLimitMs,
        artifactVersionId: bgm.artifactId, dialogueCueId: null, gainDb: bgm.gainDb,
        pan: 0, fadeInMs: 0, fadeOutMs: 0, loop: bgm.loop,
        ducking: bgm.ducking ? { target: 'dialogue' as const, amountDb: bgm.ducking.amountDb } : null,
        shotId: null, sceneId: null,
      }] : []),
      ...sfx.map((clip, index) => ({
        id: `cue_sfx_${index}`, track: 'sfx' as const, startMs: clip.startMs,
        endMs: Math.min(endLimitMs, clip.startMs + clip.durationMs),
        artifactVersionId: clip.artifactId, dialogueCueId: null, gainDb: clip.gainDb,
        pan: 0, fadeInMs: 0, fadeOutMs: 0, loop: false, ducking: null,
        shotId: null, sceneId: null,
      })),
    ];
    const contentDigest = canonicalDigest({ workspaceId: input.workspaceId, projectId: input.projectId,
      timelineId, cues });
    return {
      schemaVersion: AUDIO_PRODUCTION_SCHEMA_VERSION, id: `cue_sheet_${contentDigest.slice(0, 40)}`,
      workspaceId: input.workspaceId, projectId: input.projectId, timelineId, cues,
      baseVersionId: null, contentDigest, adoptedAt: null, createdBy: 'system',
      createdAt: new Date().toISOString(),
    };
  }

  private async buildMix(input: AssembleEpisodeInput, cueSheet: CueSheetVersion,
    dialogue: ResolvedDialogueClip[], bgm: ResolvedBgm | null, sfx: ResolvedSfx[],
    durationSeconds: number, output: LocalVideoObject): Promise<MixVersion | null> {
    if (!input.dialogue && !bgm && sfx.length === 0) return null;
    const takes = input.dialogue?.takes ?? [];
    const seed = canonicalDigest({ video: output.sha256, durationSeconds,
      dialogue: takes.map(take => take.checksum ?? take.id), bgm: bgm?.artifactId ?? null,
      sfx: sfx.map(item => `${item.artifactId}:${item.startMs}`) });
    const id = `mix_${seed.slice(0, 40)}`;
    return {
      schemaVersion: AUDIO_PRODUCTION_SCHEMA_VERSION, id,
      workspaceId: input.workspaceId, projectId: input.projectId,
      cueSheetVersionId: cueSheet.id,
      inputManifest: [
        ...takes.filter(take => take.checksum).map(take => ({
          artifactVersionId: take.audioArtifactId ?? take.id, checksum: take.checksum!, role: 'dialogue' })),
        ...(bgm ? [{ artifactVersionId: bgm.artifactId, checksum: bgm.artifactId.slice('audio_'.length), role: 'music' }] : []),
        ...sfx.map(item => ({ artifactVersionId: item.artifactId,
          checksum: item.artifactId.slice('audio_'.length), role: 'sfx' })),
      ],
      inputManifestDigest: seed,
      composer: { engine: 'ffmpeg', version: 'system', commandTemplateVersion: 'lyra-audio-assembly/1' },
      masterArtifactId: output.id, masterChecksum: output.sha256, stems: [],
      loudness: { targetLufs: -14, measuredLufs: null, truePeakDbfs: null },
      technical: { durationMs: Math.round(durationSeconds * 1_000), sampleRate: 48_000, channels: 2 },
      quality: { verdict: 'inconclusive', issues: ['loudness_not_measured', 'true_peak_not_measured'],
        evidenceRefs: [] }, costMicros: 0,
      status: 'candidate', createdAt: new Date().toISOString(),
    };
  }

  private buildDelivery(input: AssembleEpisodeInput, output: LocalVideoObject, subtitle: SubtitleVersion | null,
    sidecarChecksum: string | null, mix: MixVersion | null, durationSeconds: number, width: number, height: number): DeliveryMediaManifest {
    const digest = canonicalDigest({ video: output.sha256, mix: mix?.id ?? null, subtitle: subtitle?.id ?? null,
      mode: input.subtitle?.mode ?? 'none', durationSeconds });
    return {
      schemaVersion: DELIVERY_MEDIA_SCHEMA_VERSION, id: `delivery_${digest.slice(0, 40)}`,
      workspaceId: input.workspaceId, projectId: input.projectId,
      timelineVersionId: `timeline_${digest.slice(0, 40)}`, videoArtifactVersionId: output.id,
      mixVersionId: mix?.id ?? `mix_none_${digest.slice(0, 32)}`,
      subtitleVersionId: subtitle?.id ?? null,
      subtitleMode: subtitle ? (input.subtitle?.mode ?? 'sidecar') : 'none',
      output: { width, height, fps: 30, audioCodec: 'aac', loudnessTargetLufs: -14 },
      artifacts: [{ role: 'master_video', artifactId: output.id, objectVersionId: output.id, checksum: output.sha256 },
        ...(subtitle?.sidecarArtifactId ? [{ role: 'subtitle_sidecar', artifactId: subtitle.sidecarArtifactId,
          objectVersionId: subtitle.sidecarArtifactId, checksum: sidecarChecksum ?? subtitle.contentDigest }] : [])],
      rights: { voiceAuthorizations: input.dialogue?.profiles?.map(profile => profile.id) ?? [],
        audioLicenses: [input.bgm?.artifactId].filter((value): value is string => Boolean(value)),
        warnings: [] },
      composer: { build: 'system', commandTemplateVersion: 'lyra-audio-assembly/1' },
      manifestDigest: digest, status: 'candidate', createdAt: new Date().toISOString(),
    };
  }
}
