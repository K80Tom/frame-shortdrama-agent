import { renderSubtitle } from '../../audio-production/subtitle';
import type { SubtitleVersion } from '@lyra/shared';

export interface AudioDialogueClip {
  id: string;
  path: string;
  startMs: number;
  endMs: number;
  gainDb?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
}

export interface AudioMusicClip {
  path: string;
  gainDb?: number;
  ducking?: {
    enabled: boolean;
    threshold: number;
    ratio: number;
    attackMs: number;
    releaseMs: number;
  };
}

export interface AudioSfxClip {
  id: string;
  path: string;
  startMs: number;
  gainDb?: number;
}

export interface AudioAmbienceClip {
  path: string;
  gainDb?: number;
}

export interface AudioMixRequest {
  videoPath: string;
  outputPath: string;
  durationMs: number;
  sampleRate?: 48_000;
  channels?: 2;
  dialogue: AudioDialogueClip[];
  music?: AudioMusicClip | null;
  sfx?: AudioSfxClip[];
  ambience?: AudioAmbienceClip | null;
  subtitles?: {
    version: Readonly<SubtitleVersion>;
    mode: 'burn-in' | 'sidecar' | 'none';
    /** Path of the SRT that the caller writes from subtitleSrt; defaults beside output. */
    srtPath?: string;
  } | null;
}

export interface AudioMixPlan {
  args: string[];
  filterComplex: string;
  subtitleSrt: string | null;
  subtitlePath: string | null;
  warnings: string[];
}

export class AudioMixError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AudioMixError';
  }
}

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;

function invalid(message: string): never {
  throw new AudioMixError('AUDIO_MIX_REQUEST_INVALID', message);
}

function checkedPath(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || CONTROL.test(value) || value.includes('\n')) {
    invalid(`${label}不是有效本地路径。`);
  }
  return value;
}

function finite(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max) invalid(`${label}超出范围。`);
  return value;
}

function gain(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < -60 || value > 12) invalid('音量增益超出 -60..12 dB。');
  return value;
}

function db(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}dB`;
}

function seconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

function escapeSubtitlePath(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/:/gu, '\\:').replace(/'/gu, "\\'");
}

function subtitleStyle(version: Readonly<SubtitleVersion>): string | null {
  const safe = version.style.safeArea;
  return /^\d{1,4}$/u.test(safe) ? `force_style='Alignment=2,MarginV=${safe}'` : null;
}

/**
 * Builds the FFmpeg filter graph for an independent dialogue/music/SFX mix.
 * Dialogue is the sidechain key for music ducking, and subtitle burn-in is
 * rendered from the same immutable SubtitleVersion used for the sidecar. This
 * function only builds argv; it never executes ffmpeg or writes files.
 */
export interface AudioMixOptions {
  /**
   * FFmpeg's amix `normalize` option was added in 4.4. Default true; the
   * composer probes the local binary and passes false on older builds.
   */
  amixNormalize?: boolean;
}

export function buildAudioMixPlan(raw: AudioMixRequest, options: AudioMixOptions = {}): AudioMixPlan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('混音请求格式无效。');
  const videoPath = checkedPath(raw.videoPath, '视频输入');
  const outputPath = checkedPath(raw.outputPath, '混音输出');
  const durationMs = finite(raw.durationMs, 1, 600_000, '混音时长');
  if (raw.sampleRate !== undefined && raw.sampleRate !== 48_000) invalid('混音只支持 48kHz。');
  if (raw.channels !== undefined && raw.channels !== 2) invalid('混音只支持双声道。');
  if (!Array.isArray(raw.dialogue) || raw.dialogue.length > 100) invalid('对白轨最多 100 段。');
  if (!Array.isArray(raw.sfx) && raw.sfx !== undefined) invalid('音效轨格式无效。');
  if ((raw.sfx?.length ?? 0) > 100) invalid('音效轨最多 100 段。');

  const warnings: string[] = [];
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath];
  const filters: string[] = [];
  const inputs: Array<{ index: number; kind: 'dialogue' | 'music' | 'sfx' | 'ambience'; clip: unknown }> = [];
  let index = 1;
  const amixNormalize = options.amixNormalize === false ? '' : ':normalize=0';

  const dialogue = raw.dialogue.map((clip, i) => {
    const path = checkedPath(clip.path, `对白 ${i + 1}`);
    if (!/^[A-Za-z0-9_.:-]{1,80}$/u.test(clip.id)) invalid('对白片段 ID 无效。');
    const startMs = finite(clip.startMs, 0, durationMs, '对白起点');
    const endMs = finite(clip.endMs, startMs + 1, durationMs, '对白终点');
    const clipDuration = endMs - startMs;
    const fadeIn = clip.fadeInMs === undefined ? 0 : finite(clip.fadeInMs, 0, clipDuration / 2, '对白淡入');
    const fadeOut = clip.fadeOutMs === undefined ? 0 : finite(clip.fadeOutMs, 0, clipDuration / 2, '对白淡出');
    const at = index++;
    args.push('-i', path);
    inputs.push({ index: at, kind: 'dialogue', clip });
    const chain = [`[${at}:a]aresample=48000`, 'aformat=sample_fmts=fltp:channel_layouts=stereo',
      `volume=${db(gain(clip.gainDb))}`];
    if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${seconds(fadeIn)}`);
    if (fadeOut > 0) chain.push(`afade=t=out:st=${seconds(clipDuration - fadeOut)}:d=${seconds(fadeOut)}`);
    chain.push(`atrim=0:${seconds(clipDuration)}`, `adelay=${Math.round(startMs)}|${Math.round(startMs)}`,
      `apad=pad_dur=${seconds(durationMs)}`, `atrim=0:${seconds(durationMs)}`);
    filters.push(`${chain.join(',')}[d${i}]`);
    return `[d${i}]`;
  });

  let dialogueLabel: string | null = null;
  if (dialogue.length === 1) dialogueLabel = dialogue[0]!;
  else if (dialogue.length > 1) {
    // The dialogue bus must exist before sidechaincompress references it.
    filters.push(`${dialogue.join('')}amix=inputs=${dialogue.length}${amixNormalize}:dropout_transition=0[dialogue]`);
    dialogueLabel = '[dialogue]';
  }

  // sidechaincompress consumes its sidechain input. Split the dialogue bus so
  // one branch drives ducking and the other remains in the final mix.
  let dialogueMixLabel = dialogueLabel;
  let dialogueSidechainLabel: string | null = null;
  if (dialogueLabel && raw.music?.ducking?.enabled) {
    filters.push(`${dialogueLabel}asplit=2[dsidesrc][dmix]`);
    dialogueSidechainLabel = '[dsidesrc]';
    dialogueMixLabel = '[dmix]';
  }

  let musicLabel: string | null = null;
  if (raw.music) {
    const path = checkedPath(raw.music.path, '背景音乐');
    const at = index++;
    args.push('-i', path);
    inputs.push({ index: at, kind: 'music', clip: raw.music });
    const music = `[${at}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${db(gain(raw.music.gainDb))}`;
    if (raw.music.ducking?.enabled) {
      const duck = raw.music.ducking;
      finite(duck.threshold, 0.0001, 1, 'Ducking 阈值');
      finite(duck.ratio, 1, 20, 'Ducking 压缩比');
      finite(duck.attackMs, 1, 500, 'Ducking attack');
      finite(duck.releaseMs, 10, 5000, 'Ducking release');
      filters.push(`${music},apad=pad_dur=${seconds(durationMs)},atrim=0:${seconds(durationMs)}[musicraw]`);
      if (dialogueSidechainLabel) {
        filters.push(`[musicraw]${dialogueSidechainLabel}sidechaincompress=threshold=${duck.threshold}:ratio=${duck.ratio}:`
          + `attack=${Math.round(duck.attackMs)}:release=${Math.round(duck.releaseMs)}:makeup=1[musicduck]`);
        musicLabel = '[musicduck]';
      } else {
        warnings.push('背景音乐要求 Ducking，但没有对白轨；已跳过侧链压缩。');
        filters.push('[musicraw]anull[musicduck]');
        musicLabel = '[musicduck]';
      }
    } else {
      filters.push(`${music},apad=pad_dur=${seconds(durationMs)},atrim=0:${seconds(durationMs)}[musicduck]`);
      musicLabel = '[musicduck]';
    }
  }

  const extra: string[] = [];
  for (const [i, clip] of (raw.sfx ?? []).entries()) {
    const path = checkedPath(clip.path, `音效 ${i + 1}`);
    if (!/^[A-Za-z0-9_.:-]{1,80}$/u.test(clip.id)) invalid('音效片段 ID 无效。');
    const startMs = finite(clip.startMs, 0, durationMs, '音效起点');
    const at = index++;
    args.push('-i', path);
    inputs.push({ index: at, kind: 'sfx', clip });
    filters.push(`[${at}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${db(gain(clip.gainDb))},`
      + `adelay=${Math.round(startMs)}|${Math.round(startMs)},apad=pad_dur=${seconds(durationMs)},atrim=0:${seconds(durationMs)}[s${i}]`);
    extra.push(`[s${i}]`);
  }
  if (raw.ambience) {
    const path = checkedPath(raw.ambience.path, '环境声');
    const at = index++;
    args.push('-i', path);
    inputs.push({ index: at, kind: 'ambience', clip: raw.ambience });
    filters.push(`[${at}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${db(gain(raw.ambience.gainDb))},`
      + `apad=pad_dur=${seconds(durationMs)},atrim=0:${seconds(durationMs)}[amb]`);
    extra.push('[amb]');
  }

  let subtitleSrt: string | null = null;
  let subtitlePath: string | null = null;
  if (raw.subtitles && raw.subtitles.mode !== 'none') {
    const version = raw.subtitles.version;
    if (version.checks.verdict !== 'pass') invalid('字幕版本未通过检查，不能烧录或导出 sidecar。');
    subtitleSrt = renderSubtitle(version, 'srt');
    subtitlePath = checkedPath(raw.subtitles.srtPath ?? `${outputPath}.srt`, '字幕文件');
    if (raw.subtitles.mode === 'burn-in') {
      const style = subtitleStyle(version);
      const subtitleFilter = `subtitles=filename='${escapeSubtitlePath(subtitlePath)}'${style ? `:${style}` : ''}`;
      filters.push(`[0:v]${subtitleFilter}[vout]`);
    } else {
      filters.push('[0:v]null[vout]');
    }
  } else {
    filters.push('[0:v]null[vout]');
  }

  const mixInputs = [dialogueMixLabel, musicLabel, ...extra].filter((value): value is string => Boolean(value));
  if (!mixInputs.length) invalid('混音至少需要一条对白、音乐、音效或环境声。');
  const mixed = mixInputs.join('');
  filters.push(mixInputs.length === 1
    ? `${mixed}anull[aout]`
    : `${mixed}amix=inputs=${mixInputs.length}${amixNormalize}:dropout_transition=0,alimiter=limit=0.95[aout]`);

  const filterComplex = filters.join(';');
  args.push('-filter_complex', filterComplex, '-map', '[vout]', '-map', '[aout]');
  // A filtered video plane always requires encoding. Burn-in uses the same
  // H.264 profile as non-burn-in so delivery does not depend on drawtext.
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-t', seconds(durationMs),
    '-movflags', '+faststart', outputPath);

  // `inputs` is retained for callers that need to write temporary SRT files and
  // map source paths back to indices; it is not part of the argv.
  void inputs;
  return { args, filterComplex, subtitleSrt, subtitlePath, warnings };
}
