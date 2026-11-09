import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { ProductionMediaError } from '../contracts';

export const LOCAL_AUDIO_SCHEMA_VERSION = 'production-local-audio/1' as const;
export const MAX_AUDIO_BYTES = 256 * 1024 * 1024;
export const MAX_AUDIO_DURATION_MS = 15 * 60 * 1000;

export type AudioFormat = 'wav' | 'mp3';

export interface LocalAudioObject {
  schemaVersion: typeof LOCAL_AUDIO_SCHEMA_VERSION;
  artifactId: string;
  checksum: string;
  bytes: number;
  format: AudioFormat;
  mimeType: 'audio/wav' | 'audio/mpeg';
  durationMs: number;
  sampleRate: number | null;
  channels: number | null;
  relativePath: string;
  createdAt: string;
}

export interface OwnedLocalAudio {
  object: LocalAudioObject;
  absolutePath: string;
}

function wavMagic(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE';
}

function mp3Magic(bytes: Buffer): boolean {
  if (bytes.length < 3) return false;
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') return true;
  return bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0;
}

function validateFormat(bytes: Buffer, format: AudioFormat): void {
  if (format === 'wav' ? !wavMagic(bytes) : !mp3Magic(bytes)) {
    throw new ProductionMediaError(415, 'LOCAL_AUDIO_FORMAT_INVALID', '音频字节与声明的 WAV/MP3 格式不一致。');
  }
}

export interface PutAudioInput {
  bytes: Buffer;
  format: AudioFormat;
  durationMs: number;
  sampleRate?: number | null;
  channels?: number | null;
}

/**
 * Server-owned content-addressed audio store. No URLs are accepted, no provider
 * bytes are trusted without a magic-byte check, and the browser never receives
 * an internal path.
 */
export class AudioAssetStore {
  private initialized: Promise<void> | null = null;
  constructor(readonly root: string, private readonly now: () => Date = () => new Date()) {
    if (typeof root !== 'string' || !root.trim() || root.includes('\0')) {
      throw new ProductionMediaError(500, 'AUDIO_ROOT_INVALID', '本地音频根目录配置无效。');
    }
  }

  async initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      await mkdir(join(this.root, 'objects'), { recursive: true, mode: 0o700 });
      await mkdir(join(this.root, 'manifests'), { recursive: true, mode: 0o700 });
    })();
  }

  async put(input: PutAudioInput): Promise<LocalAudioObject> {
    await this.initialize();
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length < 1 || input.bytes.length > MAX_AUDIO_BYTES) {
      throw new ProductionMediaError(413, 'LOCAL_AUDIO_SIZE_INVALID', '音频为空或超过本地音频大小限制。');
    }
    if (input.format !== 'wav' && input.format !== 'mp3') {
      throw new ProductionMediaError(400, 'LOCAL_AUDIO_FORMAT_INVALID', '只接受 WAV 或 MP3 音频。');
    }
    validateFormat(input.bytes, input.format);
    if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 1 || input.durationMs > MAX_AUDIO_DURATION_MS) {
      throw new ProductionMediaError(422, 'LOCAL_AUDIO_DURATION_INVALID', '音频时长无效。');
    }
    for (const value of [input.sampleRate, input.channels]) {
      if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 1 || value > 192_000)) {
        throw new ProductionMediaError(422, 'LOCAL_AUDIO_METADATA_INVALID', '音频采样率或声道数无效。');
      }
    }
    const checksum = createHash('sha256').update(input.bytes).digest('hex');
    const artifactId = `audio_${checksum}`;
    const target = this.objectPath(checksum, input.format);
    try {
      const existing = await this.readOwned(target);
      if (createHash('sha256').update(existing).digest('hex') !== checksum) {
        throw new ProductionMediaError(409, 'LOCAL_AUDIO_HASH_CONFLICT', '内容寻址路径已有不同音频内容。');
      }
      const saved = await this.readManifest(checksum);
      if (saved) return saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temp = join(this.root, 'objects', `.${checksum}-${randomUUID()}.tmp`);
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(input.bytes); await handle.sync(); }
    finally { await handle.close(); }
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      try { await link(temp, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await unlink(temp);
      const object: LocalAudioObject = {
        schemaVersion: LOCAL_AUDIO_SCHEMA_VERSION, artifactId, checksum, bytes: input.bytes.length,
        format: input.format, mimeType: input.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
        durationMs: input.durationMs, sampleRate: input.sampleRate ?? null, channels: input.channels ?? null,
        relativePath: `objects/${checksum}.${input.format}`, createdAt: this.now().toISOString(),
      };
      await this.writeManifestOnce(checksum, object);
      return (await this.readManifest(checksum)) ?? object;
    } finally { await unlink(temp).catch(() => undefined); }
  }

  async get(artifactId: unknown): Promise<OwnedLocalAudio> {
    if (typeof artifactId !== 'string' || !/^audio_[a-f0-9]{64}$/u.test(artifactId)) {
      throw new ProductionMediaError(400, 'LOCAL_AUDIO_ID_INVALID', '本地音频标识无效。');
    }
    const checksum = artifactId.slice('audio_'.length);
    const saved = await this.readManifest(checksum);
    if (!saved) throw new ProductionMediaError(404, 'LOCAL_AUDIO_NOT_FOUND', '本地音频不存在或清单缺失。');
    const absolutePath = this.objectPath(checksum, saved.format);
    const bytes = await this.readOwned(absolutePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ProductionMediaError(404, 'LOCAL_AUDIO_NOT_FOUND', '本地音频文件不存在。');
      }
      throw error;
    });
    if (createHash('sha256').update(bytes).digest('hex') !== checksum) {
      throw new ProductionMediaError(409, 'LOCAL_AUDIO_HASH_MISMATCH', '本地音频内容与内容寻址标识不一致。');
    }
    validateFormat(bytes, saved.format);
    if (bytes.length !== saved.bytes) {
      throw new ProductionMediaError(409, 'LOCAL_AUDIO_MANIFEST_INVALID', '本地音频清单与文件大小不一致。');
    }
    return { object: saved, absolutePath };
  }

  async content(artifactId: unknown): Promise<{ object: LocalAudioObject; bytes: Buffer }> {
    const owned = await this.get(artifactId);
    return { object: structuredClone(owned.object), bytes: await this.readOwned(owned.absolutePath) };
  }

  private objectPath(checksum: string, format: AudioFormat): string {
    const path = join(this.root, 'objects', `${checksum}.${format}`);
    this.assertWithinRoot(path);
    return path;
  }

  private manifestPath(checksum: string): string {
    const path = join(this.root, 'manifests', `${checksum}.json`);
    this.assertWithinRoot(path);
    return path;
  }

  private async readManifest(checksum: string): Promise<LocalAudioObject | null> {
    try {
      const parsed: unknown = JSON.parse((await this.readOwned(this.manifestPath(checksum))).toString('utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('invalid');
      const object = parsed as LocalAudioObject;
      if (object.schemaVersion !== LOCAL_AUDIO_SCHEMA_VERSION || object.checksum !== checksum
        || object.artifactId !== `audio_${checksum}` || object.relativePath !== `objects/${checksum}.${object.format}`) {
        throw new ProductionMediaError(409, 'LOCAL_AUDIO_MANIFEST_INVALID', '本地音频清单内容无效。');
      }
      return object;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof SyntaxError) {
        throw new ProductionMediaError(409, 'LOCAL_AUDIO_MANIFEST_INVALID', '本地音频清单已损坏。');
      }
      throw error;
    }
  }

  private async writeManifestOnce(checksum: string, object: LocalAudioObject): Promise<void> {
    const path = this.manifestPath(checksum);
    try {
      await this.readOwned(path);
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temp = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(object)); await handle.sync(); }
    finally { await handle.close(); }
    try {
      try { await link(temp, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { await unlink(temp).catch(() => undefined); }
  }

  private async readOwned(path: string): Promise<Buffer> {
    const resolved = await realpath(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw new ProductionMediaError(500, 'AUDIO_PATH_INVALID', '本地音频路径无法解析。');
    });
    this.assertWithinRoot(resolved);
    return readFile(resolved);
  }

  private assertWithinRoot(path: string): void {
    const root = resolve(this.root);
    const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new ProductionMediaError(500, 'AUDIO_PATH_OUTSIDE_ROOT', '音频路径越过服务自有根目录。');
    }
  }
}
