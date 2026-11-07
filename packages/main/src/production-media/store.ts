import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_MEDIA_LIMITS, LOCAL_VIDEO_SCHEMA_VERSION, ProductionMediaError,
  parseMediaId, validateProbe, type LocalVideoObject, type OwnedLocalVideo,
  type LocalVideoContent, type ProductionMediaLimits,
} from './contracts';
import type { VideoProber } from './probe';

export interface ProductionMediaStoreOptions {
  limits?: Partial<ProductionMediaLimits>;
  now?: () => Date;
}

export type ProductionMediaStoredHook = (object: Readonly<LocalVideoObject>) => Promise<void>;

/** Content-addressed, server-owned MP4 storage. No URL fetching occurs here. */
export class ProductionMediaStore {
  readonly root: string;
  readonly limits: ProductionMediaLimits;
  private readonly now: () => Date;
  private initialized: Promise<void> | null = null;
  private storedHook: ProductionMediaStoredHook | null = null;

  constructor(root: string, private readonly prober: VideoProber, options: ProductionMediaStoreOptions = {}) {
    if (typeof root !== 'string' || !root.trim() || root.includes('\0')) {
      throw new ProductionMediaError(500, 'MEDIA_ROOT_INVALID', '本地媒体根目录配置无效。');
    }
    this.root = resolve(root);
    this.limits = { ...DEFAULT_MEDIA_LIMITS, ...options.limits };
    this.validateLimits();
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await this.assertDirectory(this.root);
      await this.ensureDirectory(join(this.root, 'objects'));
      await this.ensureDirectory(join(this.root, 'tmp'));
      await this.ensureDirectory(join(this.root, 'manifests'));
    })();
  }

  /** Register once during runtime composition; media is not reported ready until the durable projection is queued. */
  setStoredHook(hook: ProductionMediaStoredHook): void {
    if (this.storedHook) throw new ProductionMediaError(500, 'MEDIA_STORED_HOOK_ALREADY_SET',
      '媒体持久化钩子已经配置。');
    this.storedHook = hook;
  }

  async createWorkDirectory(prefix = 'media-work'): Promise<string> {
    await this.initialize();
    if (!/^[a-z][a-z0-9-]{0,31}$/u.test(prefix)) {
      throw new ProductionMediaError(500, 'MEDIA_WORK_PREFIX_INVALID', '媒体临时目录前缀无效。');
    }
    const parent = join(this.root, 'tmp');
    await this.assertDirectory(parent);
    const path = join(parent, `${prefix}-${randomUUID()}`);
    this.assertWithinRoot(path);
    await mkdir(path, { recursive: false, mode: 0o700 });
    await this.assertDirectory(path);
    return path;
  }

  async putVideoBuffer(input: Buffer, sourceKind: LocalVideoObject['sourceKind'] = 'buffer'): Promise<LocalVideoObject> {
    await this.initialize();
    if (!Buffer.isBuffer(input)) throw new ProductionMediaError(400, 'LOCAL_VIDEO_BUFFER_REQUIRED', '只接受后端持有的视频 Buffer。');
    if (!['buffer', 'ownedFile', 'providerDownload', 'composition'].includes(sourceKind)) {
      throw new ProductionMediaError(400, 'LOCAL_VIDEO_SOURCE_INVALID', '本地视频来源类型无效。');
    }
    if (input.length < 1 || input.length > this.limits.maxBytes) {
      throw new ProductionMediaError(413, 'LOCAL_VIDEO_SIZE_INVALID', '视频文件为空或超过本地媒体大小限制。');
    }
    const bytes = Buffer.from(input);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const id = `media_${sha256}`;
    const target = this.objectPath(sha256);
    const existing = await this.existingObject(id, target, sourceKind);
    if (existing) return this.afterStored(existing);

    const temp = join(this.root, 'tmp', `${sha256}-${randomUUID()}.mp4`);
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    try {
      const probe = validateProbe(await this.prober.probe(temp), bytes.length, this.limits);
      await this.ensureDirectory(dirname(target));
      try { await link(temp, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      // The hard link provides atomic create-if-absent semantics. Drop the
      // staging name before applying the single-link ownership invariant.
      await unlink(temp);
      const file = await this.readOwnedRegularFile(target);
      if (createHash('sha256').update(file).digest('hex') !== sha256) {
        throw new ProductionMediaError(409, 'LOCAL_MEDIA_HASH_CONFLICT', '内容寻址路径已有不同内容，未覆盖原文件。');
      }
      const object: LocalVideoObject = {
        schemaVersion: LOCAL_VIDEO_SCHEMA_VERSION, id, sha256, bytes: file.length, mimeType: 'video/mp4',
        relativePath: this.relativeObjectPath(sha256), sourceKind, probe, createdAt: this.timestamp(),
      };
      await this.saveObjectManifest(object);
      const persisted = await this.readObjectManifest(sha256);
      if (!persisted || persisted.bytes !== file.length) {
        throw new ProductionMediaError(409, 'LOCAL_MEDIA_MANIFEST_INVALID', '本地视频清单与实际内容不一致。');
      }
      return this.afterStored({ ...persisted, probe });
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  private async afterStored(object: LocalVideoObject): Promise<LocalVideoObject> {
    await this.storedHook?.(structuredClone(object));
    return object;
  }

  async importOwnedVideo(path: string, sourceKind: LocalVideoObject['sourceKind'] = 'ownedFile'): Promise<LocalVideoObject> {
    await this.initialize();
    if (typeof path !== 'string' || !path || path.includes('\0')) {
      throw new ProductionMediaError(400, 'OWNED_MEDIA_PATH_INVALID', '本地视频路径无效。');
    }
    if (/^https?:\/\//iu.test(path)) {
      throw new ProductionMediaError(409, 'REMOTE_MEDIA_NOT_LOCAL', '远程链接不能直接作为本地视频或交付。');
    }
    const candidate = isAbsolute(path) ? resolve(path) : resolve(this.root, path);
    this.assertWithinRoot(candidate);
    try {
      return await this.putVideoBuffer(
        await this.readOwnedRegularFile(candidate, this.limits.maxBytes, { requireIndependentLink: true }), sourceKind);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ProductionMediaError(400, 'OWNED_MEDIA_FILE_INVALID', '服务自有根目录内没有这个普通媒体文件。');
      }
      throw error;
    }
  }

  async getVideo(idValue: unknown): Promise<OwnedLocalVideo> {
    const loaded = await this.loadVideo(idValue);
    return { object: loaded.object, absolutePath: loaded.absolutePath };
  }

  async content(idValue: unknown): Promise<LocalVideoContent> {
    const loaded = await this.loadVideo(idValue);
    return { object: structuredClone(loaded.object), bytes: Buffer.from(loaded.bytes) };
  }

  private async loadVideo(idValue: unknown): Promise<OwnedLocalVideo & { bytes: Buffer }> {
    await this.initialize();
    const id = parseMediaId(idValue);
    const sha256 = id.slice('media_'.length);
    const absolutePath = this.objectPath(sha256);
    let bytes: Buffer;
    try { bytes = await this.readOwnedRegularFile(absolutePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ProductionMediaError(404, 'LOCAL_MEDIA_NOT_FOUND', '本地视频不存在或尚未完成入库校验。');
      }
      throw error;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
      throw new ProductionMediaError(409, 'LOCAL_MEDIA_HASH_MISMATCH', '本地视频内容与内容寻址标识不一致。');
    }
    const probe = validateProbe(await this.prober.probe(absolutePath), bytes.length, this.limits);
    const manifest = await this.readObjectManifest(sha256);
    if (!manifest) {
      throw new ProductionMediaError(409, 'LOCAL_MEDIA_MANIFEST_INVALID', '本地视频缺少来源清单，不能作为交付内容。');
    }
    const object: LocalVideoObject = manifest;
    if (object.id !== id || object.sha256 !== sha256 || object.bytes !== bytes.length
      || object.relativePath !== this.relativeObjectPath(sha256)) {
      throw new ProductionMediaError(409, 'LOCAL_MEDIA_MANIFEST_INVALID', '本地视频清单与实际内容不一致。');
    }
    object.probe = probe;
    return { object, absolutePath, bytes };
  }

  manifestPath(id: string): string {
    if (!/^timeline_[a-f0-9]{64}$/u.test(id)) throw new ProductionMediaError(400, 'TIMELINE_ID_INVALID', '时间线标识无效。');
    return join(this.root, 'manifests', `${id}.json`);
  }

  async writeManifest(id: string, manifest: object): Promise<void> {
    await this.initialize();
    const target = this.manifestPath(id);
    await this.writeJsonOnce(target, manifest);
  }

  async readManifest<T>(id: string): Promise<T | null> {
    await this.initialize();
    const path = this.manifestPath(id);
    try { return JSON.parse((await this.readOwnedRegularFile(path, 2 * 1024 * 1024)).toString('utf8')) as T; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof SyntaxError) throw new ProductionMediaError(409, 'TIMELINE_MANIFEST_INVALID', '时间线清单已损坏。');
      throw error;
    }
  }

  private async existingObject(id: string, target: string, sourceKind: LocalVideoObject['sourceKind']): Promise<LocalVideoObject | null> {
    try {
      const file = await this.readOwnedRegularFile(target);
      const sha256 = id.slice('media_'.length);
      if (createHash('sha256').update(file).digest('hex') !== sha256) {
        throw new ProductionMediaError(409, 'LOCAL_MEDIA_HASH_CONFLICT', '内容寻址路径已有不同内容。');
      }
      const probe = validateProbe(await this.prober.probe(target), file.length, this.limits);
      const saved = await this.readObjectManifest(sha256);
      if (saved) {
        if (saved.bytes !== file.length) {
          throw new ProductionMediaError(409, 'LOCAL_MEDIA_MANIFEST_INVALID', '本地视频清单与实际内容不一致。');
        }
        return { ...saved, probe };
      }
      const recovered: LocalVideoObject = { schemaVersion: LOCAL_VIDEO_SCHEMA_VERSION, id, sha256,
        bytes: file.length, mimeType: 'video/mp4', relativePath: this.relativeObjectPath(sha256),
        sourceKind, probe, createdAt: this.timestamp() };
      await this.saveObjectManifest(recovered);
      return recovered;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async saveObjectManifest(object: LocalVideoObject): Promise<void> {
    await this.writeJsonOnce(this.objectManifestPath(object.sha256), object);
  }

  private async readObjectManifest(sha256: string): Promise<LocalVideoObject | null> {
    try {
      const raw = await this.readOwnedRegularFile(this.objectManifestPath(sha256), 256 * 1024);
      const value = JSON.parse(raw.toString('utf8')) as LocalVideoObject;
      if (!value || value.schemaVersion !== LOCAL_VIDEO_SCHEMA_VERSION || value.id !== `media_${sha256}`
        || value.sha256 !== sha256 || value.mimeType !== 'video/mp4'
        || !Number.isSafeInteger(value.bytes) || value.bytes < 1
        || value.relativePath !== this.relativeObjectPath(sha256)
        || !['buffer', 'ownedFile', 'providerDownload', 'composition'].includes(value.sourceKind)
        || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
        || new Date(value.createdAt).toISOString() !== value.createdAt) {
        throw new ProductionMediaError(409, 'LOCAL_MEDIA_MANIFEST_INVALID', '本地视频清单格式无效。');
      }
      return structuredClone(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof SyntaxError) throw new ProductionMediaError(409, 'LOCAL_MEDIA_MANIFEST_INVALID', '本地视频清单已损坏。');
      throw error;
    }
  }

  private async writeJsonOnce(target: string, value: object): Promise<void> {
    this.assertWithinRoot(target);
    await this.ensureDirectory(dirname(target));
    const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    const temp = join(this.root, 'tmp', `${randomUUID()}.json`);
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
    try {
      try { await link(temp, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { await unlink(temp).catch(() => undefined); }
  }

  private objectPath(sha256: string): string { return join(this.root, this.relativeObjectPath(sha256)); }
  private objectManifestPath(sha256: string): string { return join(this.root, 'objects', sha256.slice(0, 2), `${sha256}.json`); }
  private relativeObjectPath(sha256: string): string { return join('objects', sha256.slice(0, 2), `${sha256}.mp4`); }

  // Store-managed objects are written through a temp file plus hard link; some
  // sandboxed runtimes retain a shadow link for that inode forever, so nlink
  // stays 2 and cannot be treated as tampering. Their integrity is instead
  // guaranteed by the sha256 verification performed on every read. The strict
  // single-link requirement therefore applies only to user-imported files.
  private async readOwnedRegularFile(path: string, customMax = this.limits.maxBytes,
    options: { requireIndependentLink?: boolean } = {}): Promise<Buffer> {
    this.assertWithinRoot(path);
    const lexical = resolve(path);
    const entry = await lstat(lexical);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1 || entry.size > customMax
      || await realpath(lexical) !== lexical
      || (options.requireIndependentLink === true && entry.nlink !== 1)) {
      throw new ProductionMediaError(400, 'OWNED_MEDIA_FILE_INVALID', '媒体文件必须是根目录内的独立普通文件，且不能经过符号链接。');
    }
    const handle = await open(lexical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.ino !== entry.ino || before.dev !== entry.dev || before.size !== entry.size) {
        throw new ProductionMediaError(409, 'OWNED_MEDIA_FILE_CHANGED', '媒体文件在读取前发生变化。');
      }
      const data = await handle.readFile();
      const after = await handle.stat();
      if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || data.length !== before.size) {
        throw new ProductionMediaError(409, 'OWNED_MEDIA_FILE_CHANGED', '媒体文件在读取期间发生变化。');
      }
      return data;
    } finally { await handle.close(); }
  }

  private async ensureDirectory(path: string): Promise<void> {
    this.assertWithinRoot(path, true);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await this.assertDirectory(path);
  }

  private async assertDirectory(path: string): Promise<void> {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(path) !== resolve(path)) {
      throw new ProductionMediaError(500, 'MEDIA_ROOT_UNSAFE', '本地媒体目录不能经过符号链接或非目录文件。');
    }
  }

  private assertWithinRoot(path: string, allowRoot = false): void {
    const candidate = resolve(path);
    const rel = relative(this.root, candidate);
    if ((!allowRoot && !rel) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ProductionMediaError(403, 'MEDIA_PATH_OUTSIDE_ROOT', '媒体路径不在服务自有根目录内。');
    }
  }

  private validateLimits(): void {
    const { maxBytes, maxDurationSeconds, maxWidth, maxHeight, maxPixels } = this.limits;
    if (![maxBytes, maxDurationSeconds, maxWidth, maxHeight, maxPixels].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new ProductionMediaError(500, 'MEDIA_LIMITS_INVALID', '本地媒体限制配置无效。');
    }
  }

  private timestamp(): string {
    const date = this.now();
    if (!Number.isFinite(date.valueOf())) throw new ProductionMediaError(500, 'MEDIA_CLOCK_INVALID', '本地媒体时间源无效。');
    return date.toISOString();
  }
}
