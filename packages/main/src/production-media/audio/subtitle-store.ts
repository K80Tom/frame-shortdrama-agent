import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ProductionMediaError } from '../contracts';

/** Content-addressed SRT sidecars. The browser reads them through the API, never a path. */
export class SubtitleArtifactStore {
  private initialized: Promise<void> | null = null;
  constructor(readonly root: string, private readonly now: () => Date = () => new Date()) {}

  async initialize(): Promise<void> {
    return this.initialized ??= mkdir(join(this.root, 'subtitles'), { recursive: true, mode: 0o700 }).then(() => undefined);
  }

  async put(format: 'srt' | 'vtt', text: string): Promise<{ artifactId: string; checksum: string; bytes: number }> {
    await this.initialize();
    if (!text.trim() || text.length > 2 * 1024 * 1024) {
      throw new ProductionMediaError(422, 'SUBTITLE_SIDECAR_INVALID', '字幕旁挂文件为空或超过大小限制。');
    }
    const checksum = createHash('sha256').update(text).digest('hex');
    const artifactId = `subtitle_${checksum}`;
    const target = resolve(this.root, 'subtitles', `${checksum}.${format}`);
    if (!target.startsWith(`${resolve(this.root)}${sep}`)) {
      throw new ProductionMediaError(500, 'SUBTITLE_PATH_OUTSIDE_ROOT', '字幕路径越过服务自有根目录。');
    }
    try {
      const existing = await readFile(target);
      if (existing.toString('utf8') !== text) {
        throw new ProductionMediaError(409, 'SUBTITLE_HASH_CONFLICT', '内容寻址路径已有不同字幕内容。');
      }
      return { artifactId, checksum, bytes: existing.length };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temp = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
    try {
      try { await link(temp, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { await unlink(temp).catch(() => undefined); }
    return { artifactId, checksum, bytes: Buffer.byteLength(text) };
  }

  async get(artifactId: string): Promise<string> {
    if (!/^subtitle_[a-f0-9]{64}$/u.test(artifactId)) {
      throw new ProductionMediaError(400, 'SUBTITLE_ID_INVALID', '字幕旁挂标识无效。');
    }
    const checksum = artifactId.slice('subtitle_'.length);
    for (const format of ['srt', 'vtt'] as const) {
      try { return (await readFile(resolve(this.root, 'subtitles', `${checksum}.${format}`))).toString('utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    throw new ProductionMediaError(404, 'SUBTITLE_SIDECAR_NOT_FOUND', '字幕旁挂文件不存在。');
  }
}
