import { mkdir, writeFile } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { BoundedProcessRunner, type ProcessRunner } from '../probe';
import { FfprobeVideoProber, type VideoProber } from '../probe';
import type { VideoProbeResult } from '../contracts';
import { buildAudioMixPlan, type AudioMixPlan, type AudioMixRequest } from './mix';
import { AudioMixError } from './mix';

export interface AudioMixComposerOptions {
  runner?: ProcessRunner;
  prober?: VideoProber;
  ffmpegPath?: string;
  /** Override capability detection; mainly for deterministic tests. */
  amixNormalizeSupported?: boolean;
  subtitleBurnInSupported?: boolean;
}

export interface AudioMixComposeOptions {
  workDirectory: string;
  /** Optional caller-provided basename; traversal components are discarded. */
  outputName?: string;
}

export interface AudioMixComposeResult {
  outputPath: string;
  subtitlePath: string | null;
  probe: VideoProbeResult;
  plan: AudioMixPlan;
}

/**
 * Executes the mixed master inside an isolated work directory. The final object
 * is not registered in the content-addressed store here; callers must still run
 * the normal media ingestion/probe gate before delivery.
 */
export class AudioMixComposer {
  private readonly runner: ProcessRunner;
  private readonly prober: VideoProber;
  private readonly ffmpegPath: string;
  private amixNormalizeSupported: boolean | null;
  private subtitleBurnInSupported: boolean | null;

  constructor(options: AudioMixComposerOptions = {}) {
    this.runner = options.runner ?? new BoundedProcessRunner();
    this.prober = options.prober ?? new FfprobeVideoProber();
    this.ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
    this.amixNormalizeSupported = options.amixNormalizeSupported ?? null;
    this.subtitleBurnInSupported = options.subtitleBurnInSupported ?? null;
  }

  /** FFmpeg < 4.4 does not expose amix's normalize option; probe once. */
  private async supportsAmixNormalize(): Promise<boolean> {
    if (this.amixNormalizeSupported !== null) return this.amixNormalizeSupported;
    try {
      const help = await this.runner.run(this.ffmpegPath, ['-hide_banner', '-h', 'filter=amix'], {
        timeoutMs: 15_000, maxOutputBytes: 512 * 1024,
      });
      this.amixNormalizeSupported = help.stdout.toString('utf8').includes('normalize');
    } catch { this.amixNormalizeSupported = true; }
    return this.amixNormalizeSupported;
  }

  /** Some ffmpeg builds omit libass; fail closed instead of silently losing subtitles. */
  private async supportsSubtitleBurnIn(): Promise<boolean> {
    if (this.subtitleBurnInSupported !== null) return this.subtitleBurnInSupported;
    try {
      const filters = await this.runner.run(this.ffmpegPath, ['-hide_banner', '-filters'], {
        timeoutMs: 15_000, maxOutputBytes: 4 * 1024 * 1024,
      });
      this.subtitleBurnInSupported = /\bsubtitles\b/u.test(filters.stdout.toString('utf8'));
    } catch { this.subtitleBurnInSupported = false; }
    return this.subtitleBurnInSupported;
  }

  async compose(request: AudioMixRequest, options: AudioMixComposeOptions): Promise<AudioMixComposeResult> {
    const workDirectory = resolve(options.workDirectory);
    await mkdir(workDirectory, { recursive: true, mode: 0o700 });
    const outputName = basename(options.outputName ?? request.outputPath ?? 'mix.mp4');
    if (!/^[A-Za-z0-9_.-]{1,120}\.mp4$/u.test(outputName)) {
      throw new Error('混音输出必须使用安全的 .mp4 文件名。');
    }
    if (request.subtitles?.mode === 'burn-in' && !(await this.supportsSubtitleBurnIn())) {
      throw new AudioMixError('AUDIO_MIX_FILTER_UNAVAILABLE', '当前 ffmpeg 构建缺少 libass subtitles 滤镜，不能安全烧录字幕。');
    }
    const outputPath = join(workDirectory, outputName);
    const subtitlePath = join(workDirectory, `${outputName.slice(0, -4)}.srt`);
    const plan = buildAudioMixPlan({ ...request, outputPath,
      subtitles: request.subtitles ? { ...request.subtitles, srtPath: subtitlePath } : null },
    { amixNormalize: await this.supportsAmixNormalize() });
    if (plan.subtitleSrt !== null) {
      await writeFile(subtitlePath, plan.subtitleSrt, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    await this.runner.run(this.ffmpegPath, plan.args, { cwd: workDirectory, timeoutMs: 300_000,
      maxOutputBytes: 4 * 1024 * 1024 });
    const probe = await this.prober.probe(outputPath);
    return { outputPath, subtitlePath: plan.subtitlePath, probe, plan };
  }
}
