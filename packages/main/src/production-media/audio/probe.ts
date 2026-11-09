import { ProductionMediaError } from '../contracts';
import { BoundedProcessRunner, type ProcessRunner } from '../probe';

export interface AudioProbeResult {
  durationMs: number;
  sampleRate: number;
  channels: number;
  codec: string;
}

export interface AudioProber {
  probe(path: string): Promise<AudioProbeResult>;
}

/** ffprobe path for audio-only objects; the video parser intentionally rejects them. */
export class FfprobeAudioProber implements AudioProber {
  constructor(private readonly runner: ProcessRunner = new BoundedProcessRunner(), private readonly executable = 'ffprobe') {}

  async probe(path: string): Promise<AudioProbeResult> {
    const result = await this.runner.run(this.executable, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path,
    ], { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 });
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout.toString('utf8')); }
    catch { throw invalidAudio(); }
    return parseAudioFfprobe(parsed);
  }
}

export function parseAudioFfprobe(value: unknown): AudioProbeResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidAudio();
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.streams)) return invalidAudio();
  const streams = record.streams.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[];
  const videos = streams.filter(stream => stream.codec_type === 'video');
  const audios = streams.filter(stream => stream.codec_type === 'audio');
  if (videos.length || audios.length !== 1) return invalidAudio();
  const stream = audios[0]!;
  const format = record.format && typeof record.format === 'object' && !Array.isArray(record.format)
    ? record.format as Record<string, unknown> : {};
  const rawDuration = stream.duration ?? format.duration;
  const duration = typeof rawDuration === 'number' ? rawDuration : typeof rawDuration === 'string' ? Number(rawDuration) : Number.NaN;
  const sampleRate = typeof stream.sample_rate === 'number' ? stream.sample_rate
    : typeof stream.sample_rate === 'string' ? Number(stream.sample_rate) : Number.NaN;
  const channels = typeof stream.channels === 'number' ? stream.channels : Number.NaN;
  if (!Number.isFinite(duration) || duration < 0 || duration > 3_600
    || !Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000
    || !Number.isSafeInteger(channels) || channels < 1 || channels > 8
    || typeof stream.codec_name !== 'string' || !stream.codec_name) return invalidAudio();
  return { durationMs: Math.round(duration * 1000), sampleRate, channels, codec: stream.codec_name };
}

function invalidAudio(): never {
  throw new ProductionMediaError(415, 'LOCAL_AUDIO_PROBE_INVALID', 'ffprobe 返回的音频容器或流结构不受支持。');
}
