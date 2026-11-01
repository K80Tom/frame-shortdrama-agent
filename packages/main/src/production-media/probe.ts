import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import { ProductionMediaError, type VideoProbeResult } from './contracts';

export interface ProcessResult { stdout: Buffer; stderr: Buffer }
export interface ProcessRunner {
  run(command: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number }): Promise<ProcessResult>;
}
export type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

/** Runs an exact executable with an argument vector. Shell parsing is never enabled. */
export class BoundedProcessRunner implements ProcessRunner {
  constructor(private readonly spawnProcess: SpawnProcess = spawn as SpawnProcess) {}

  run(command: string, args: readonly string[], options: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<ProcessResult> {
    if (!command || !Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) {
      throw new ProductionMediaError(500, 'MEDIA_PROCESS_INVALID', '媒体处理命令配置无效。');
    }
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(command, [...args], {
          cwd: options.cwd,
          shell: false,
          windowsHide: true,
          // Keep the overload typed as ChildProcessWithoutNullStreams, then
          // close stdin immediately. ffmpeg also receives -nostdin.
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        reject(new ProductionMediaError(503, 'MEDIA_PROCESS_UNAVAILABLE', '本机媒体处理程序无法启动。'));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (error?: ProductionMediaError) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      };
      const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += bytes.length;
        if (outputBytes > maxOutputBytes) {
          child.kill('SIGKILL');
          finish(new ProductionMediaError(502, 'MEDIA_PROCESS_OUTPUT_TOO_LARGE', '本机媒体处理程序返回了过多诊断信息。'));
          return;
        }
        target.push(Buffer.from(bytes));
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.stdin.end();
      child.once('error', () => finish(new ProductionMediaError(503, 'MEDIA_PROCESS_UNAVAILABLE', '本机媒体处理程序无法启动。')));
      child.once('close', code => finish(code === 0 ? undefined
        : new ProductionMediaError(422, 'MEDIA_PROCESS_FAILED', '本机媒体处理未完成，未登记任何成片。')));
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new ProductionMediaError(504, 'MEDIA_PROCESS_TIMEOUT', '本机媒体处理超时，未登记任何成片。'));
      }, timeoutMs);
      timer.unref();
    });
  }
}

export interface VideoProber { probe(path: string): Promise<VideoProbeResult> }

export class FfprobeVideoProber implements VideoProber {
  constructor(private readonly runner: ProcessRunner = new BoundedProcessRunner(), private readonly executable = 'ffprobe') {}

  async probe(path: string): Promise<VideoProbeResult> {
    const result = await this.runner.run(this.executable, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path,
    ], { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 });
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout.toString('utf8')); }
    catch { throw new ProductionMediaError(415, 'LOCAL_VIDEO_PROBE_INVALID', 'ffprobe 没有返回可验证的视频信息。'); }
    return parseFfprobe(parsed);
  }
}

export function parseFfprobe(value: unknown): VideoProbeResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidProbe();
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.streams) || !record.format || typeof record.format !== 'object' || Array.isArray(record.format)) return invalidProbe();
  const streams = record.streams.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[];
  const videos = streams.filter(stream => stream.codec_type === 'video');
  const audios = streams.filter(stream => stream.codec_type === 'audio');
  if (videos.length !== 1 || audios.length > 1) return invalidProbe();
  const video = videos[0]!;
  const audio = audios[0];
  const format = record.format as Record<string, unknown>;
  const names = typeof format.format_name === 'string' ? format.format_name.split(',') : [];
  const durationSeconds = typeof format.duration === 'string' || typeof format.duration === 'number'
    ? Number(format.duration) : Number.NaN;
  if (!names.includes('mp4') || !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height)
    || typeof video.codec_name !== 'string' || (audio && typeof audio.codec_name !== 'string')) return invalidProbe();
  return { container: 'mp4', durationSeconds, width: video.width as number, height: video.height as number,
    videoCodec: video.codec_name, hasAudio: Boolean(audio), audioCodec: audio ? audio.codec_name as string : null };
}

function invalidProbe(): never {
  throw new ProductionMediaError(415, 'LOCAL_VIDEO_PROBE_INVALID', 'ffprobe 返回的视频容器或流结构不受支持。');
}
