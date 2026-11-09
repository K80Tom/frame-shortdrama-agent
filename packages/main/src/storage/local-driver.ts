import { createHash } from 'node:crypto';
import { mkdir, open, realpath, rename, lstat, rm, stat, readdir, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  DRIVER_MANAGED_PREFIX, StorageDriverError, validateContentType, validateDriverKey,
  validateManagedPrefix, type BlobStorageDriver, type DriverListEntry, type DriverPutInput,
  type StoredObject,
} from './driver';

/**
 * 本地文件驱动（移植自融光 media-blob-store.ts openLocal 的安全语义）：
 * - 根目录与托管目录拒绝符号链接逃逸；
 * - 对象路径拒绝符号链接，只允许普通文件；
 * - 写入先落临时文件再原子 rename；
 * - 支持字节区间读取。
 */
export class LocalBlobStorageDriver implements BlobStorageDriver {
  readonly provider = 'local';
  readonly managedPrefix = DRIVER_MANAGED_PREFIX;
  private readonly managedDir: string;
  private initialized = false;

  constructor(readonly root: string) {
    if (typeof root !== 'string' || root.trim().length === 0) {
      throw new StorageDriverError('STORAGE_CONFIG_INVALID', '本地存储必须配置根目录。');
    }
    this.managedDir = join(root, DRIVER_MANAGED_PREFIX.slice(0, -1));
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const base = await realpath(this.root);
    await mkdir(this.managedDir, { recursive: true });
    const folderStats = await lstat(this.managedDir);
    if (folderStats.isSymbolicLink() || !(await realpath(this.managedDir)).startsWith(base)) {
      throw new StorageDriverError('STORAGE_UNSAFE_PATH', '托管目录不允许链接到根目录之外。');
    }
    this.initialized = true;
  }

  private async pathOf(key: string): Promise<string> {
    await this.ensureInitialized();
    const validated = validateDriverKey(key);
    const path = resolve(this.managedDir, validated.slice(DRIVER_MANAGED_PREFIX.length));
    if (!path.startsWith(resolve(this.managedDir) + '/') && path !== resolve(this.managedDir)) {
      throw new StorageDriverError('STORAGE_UNSAFE_PATH', '对象路径逃逸出托管目录。');
    }
    return path;
  }

  async put(input: DriverPutInput): Promise<StoredObject> {
    const path = await this.pathOf(input.key);
    if (input.contentType !== undefined) validateContentType(input.contentType);
    await mkdir(dirname(path), { recursive: true });
    const temp = join(tmpdir(), `lyra-blob-${randomBytes(8).toString('hex')}`);
    try {
      const handle = await open(temp, 'w', 0o600);
      try { await handle.writeFile(input.body); } finally { await handle.close(); }
      const existing = await lstat(path).catch(() => null);
      if (existing?.isSymbolicLink()) throw new StorageDriverError('STORAGE_UNSAFE_PATH', '目标位置存在符号链接，拒绝覆盖。');
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
    const sha256 = createHash('sha256').update(input.body).digest('hex');
    return { key: validateDriverKey(input.key), size: input.body.length, etag: sha256.slice(0, 32), sha256, contentType: input.contentType ?? null };
  }

  async head(key: string): Promise<StoredObject | null> {
    const path = await this.pathOf(key);
    const stats = await lstat(path).catch(() => null);
    if (!stats) return null;
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new StorageDriverError('STORAGE_UNSAFE_PATH', '对象不是普通文件，拒绝访问。');
    }
    const body = await this.readAll(path, stats.size);
    const sha256 = createHash('sha256').update(body).digest('hex');
    return { key: validateDriverKey(key), size: stats.size, etag: sha256.slice(0, 32), sha256, contentType: null };
  }

  async readRange(key: string, offset: number, length: number): Promise<Buffer> {
    const path = await this.pathOf(key);
    const stats = await lstat(path).catch(() => null);
    if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
      throw new StorageDriverError('OBJECT_NOT_FOUND', `对象不存在：${key}`);
    }
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length <= 0 || offset + length > stats.size) {
      throw new StorageDriverError('OBJECT_RANGE_INVALID', '对象读取范围无效。');
    }
    let handle: FileHandle | null = await open(path, 'r');
    try {
      const target = Buffer.allocUnsafe(length);
      const result = await handle.read(target, 0, length, offset);
      if (result.bytesRead !== length) throw new StorageDriverError('OBJECT_RANGE_INVALID', '对象读取长度不符。');
      return target;
    } finally {
      await handle.close().catch(() => undefined);
      handle = null;
    }
  }

  async delete(key: string): Promise<void> {
    const path = await this.pathOf(key);
    const stats = await lstat(path).catch(() => null);
    if (!stats) return;
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new StorageDriverError('STORAGE_UNSAFE_PATH', '对象不是普通文件，拒绝删除。');
    }
    await unlink(path);
  }

  async list(prefix: string, options?: { limit?: number }): Promise<DriverListEntry[]> {
    await this.ensureInitialized();
    const scoped = validateManagedPrefix(prefix);
    if (!scoped.startsWith(this.managedPrefix)) {
      throw new StorageDriverError('OBJECT_KEY_INVALID', '列表前缀必须位于托管命名空间内。');
    }
    const limit = options?.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new StorageDriverError('OBJECT_LIMIT_INVALID', '列表上限无效。');
    }
    const baseDir = resolve(this.managedDir, scoped.slice(this.managedPrefix.length));
    const entries: DriverListEntry[] = [];
    await this.walk(baseDir, this.managedDir, limit, entries);
    entries.sort((a, b) => a.key.localeCompare(b.key));
    return entries;
  }

  private async walk(dir: string, rootDir: string, limit: number, out: DriverListEntry[]): Promise<void> {
    if (out.length >= limit) return;
    const dirStats = await stat(dir).catch(() => null);
    if (!dirStats?.isDirectory()) return;
    const children = await readdir(dir).catch(() => []);
    for (const child of children) {
      if (out.length >= limit) return;
      const childPath = join(dir, child);
      const stats = await lstat(childPath).catch(() => null);
      if (!stats) continue;
      if (stats.isDirectory()) {
        await this.walk(childPath, rootDir, limit, out);
        continue;
      }
      if (stats.isSymbolicLink() || !stats.isFile()) continue;
      const relative = childPath.slice(rootDir.length + 1);
      const key = `${DRIVER_MANAGED_PREFIX}${relative.split('\\').join('/')}`;
      const body = await this.readAll(childPath, stats.size);
      const sha256 = createHash('sha256').update(body).digest('hex');
      out.push({ key, size: stats.size, etag: sha256.slice(0, 32), sha256, contentType: null });
    }
  }

  private async readAll(path: string, size: number): Promise<Buffer> {
    let handle: FileHandle | null = await open(path, 'r');
    try {
      const target = Buffer.allocUnsafe(size);
      let read = 0;
      while (read < size) {
        const result = await handle.read(target, read, size - read, read);
        if (result.bytesRead <= 0) break;
        read += result.bytesRead;
      }
      return read === size ? target : target.subarray(0, read);
    } finally {
      await handle.close().catch(() => undefined);
      handle = null;
    }
  }
}
