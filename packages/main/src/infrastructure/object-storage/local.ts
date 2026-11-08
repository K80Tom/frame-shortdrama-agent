import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import {
  ObjectStorageError, normalizeObjectKey, validateContentType, validateMaxBytes, validateSha256,
  workspaceIdOf, type ObjectDescriptor, type ObjectStorage, type ObjectStorageScope,
  type PutObjectRequest, type ReadObjectRequest, type ObjectReadResult,
} from './port';

/** Local immutable adapter kept as a rollback path while remote object storage is introduced. */
export class LocalObjectStorage implements ObjectStorage {
  readonly provider = 'local' as const;
  readonly bucket: string;
  private readonly root: string;
  private initialized: Promise<void> | null = null;
  private canonicalRoot = '';

  constructor(root: string, options: { bucket?: string } = {}) {
    if (typeof root !== 'string' || !root.trim() || root.includes('\0')) {
      throw new ObjectStorageError('OBJECT_STORAGE_CONFIG_INVALID', '本地对象存储目录无效。');
    }
    this.root = resolve(root);
    this.bucket = options.bucket?.trim() || 'local';
  }

  async probe(): Promise<void> {
    let target: string | undefined;
    try {
      await this.initialize();
      target = resolve(this.canonicalRoot, '.tmp', `.readiness-${randomUUID()}`);
      const handle = await open(target,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(Buffer.from('ok', 'utf8'));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await unlink(target);
    } catch (error) {
      if (target) await unlink(target).catch(() => undefined);
      throw new ObjectStorageError('OBJECT_STORAGE_UNAVAILABLE', '本地对象存储不可写。', error);
    }
  }

  async put(request: PutObjectRequest): Promise<ObjectDescriptor> {
    const body = Buffer.isBuffer(request.body) ? Buffer.from(request.body) : null;
    if (!body || !body.length) throw new ObjectStorageError('OBJECT_BODY_INVALID', '对象内容不能为空。');
    const contentType = validateContentType(request.contentType);
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (request.expectedSha256 && validateSha256(request.expectedSha256) !== sha256) {
      throw new ObjectStorageError('OBJECT_CHECKSUM_MISMATCH', '对象内容与预期 SHA-256 不一致。');
    }
    const { logicalKey, target } = await this.target(request.scope, request.key, true);
    const existing = await this.head(request.scope, logicalKey);
    if (existing) {
      if (existing.sha256 !== sha256 || existing.size !== body.length) {
        throw new ObjectStorageError('OBJECT_ALREADY_EXISTS', '同一对象键已存在不同内容，未覆盖。');
      }
      return { ...existing, contentType };
    }
    const temporary = resolve(this.canonicalRoot, '.tmp', `${randomUUID()}.part`);
    await mkdir(dirname(temporary), { recursive: true, mode: 0o700 });
    const handle = await open(temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(body); await handle.sync(); }
    finally { await handle.close(); }
    try {
      try { await link(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const raced = await this.head(request.scope, logicalKey);
        if (!raced || raced.sha256 !== sha256 || raced.size !== body.length) {
          throw new ObjectStorageError('OBJECT_ALREADY_EXISTS', '同一对象键已存在不同内容，未覆盖。');
        }
      }
    } finally { await unlink(temporary).catch(() => undefined); }
    return { provider: this.provider, bucket: this.bucket, key: logicalKey, versionId: null, etag: null,
      sha256, size: body.length, contentType };
  }

  async get(request: ReadObjectRequest): Promise<ObjectReadResult> {
    const maxBytes = validateMaxBytes(request.maxBytes);
    const { logicalKey, target } = await this.target(request.scope, request.key, false);
    let handle;
    try { handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ObjectStorageError('OBJECT_NOT_FOUND', '对象不存在。');
      }
      throw new ObjectStorageError('OBJECT_STORAGE_UNAVAILABLE', '本地对象暂时无法读取。', error);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) {
        throw new ObjectStorageError('OBJECT_SIZE_INVALID', '对象不是普通文件或超过读取上限。');
      }
      const body = await handle.readFile();
      const sha256 = createHash('sha256').update(body).digest('hex');
      if (request.expectedSha256 && validateSha256(request.expectedSha256) !== sha256) {
        throw new ObjectStorageError('OBJECT_CHECKSUM_MISMATCH', '对象内容与预期 SHA-256 不一致。');
      }
      return { object: { provider: this.provider, bucket: this.bucket, key: logicalKey,
        versionId: null, etag: null, sha256, size: body.length, contentType: null }, body };
    } finally { await handle.close(); }
  }

  async head(scope: ObjectStorageScope, key: string): Promise<ObjectDescriptor | null> {
    try { return (await this.get({ scope, key, maxBytes: 4 * 1024 * 1024 * 1024 })).object; }
    catch (error) {
      if (error instanceof ObjectStorageError && error.code === 'OBJECT_NOT_FOUND') return null;
      throw error;
    }
  }

  async delete(scope: ObjectStorageScope, key: string): Promise<void> {
    const { target } = await this.target(scope, key, false);
    try { await unlink(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ObjectStorageError('OBJECT_STORAGE_UNAVAILABLE', '本地对象暂时无法删除。', error);
      }
    }
  }

  private async initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      this.canonicalRoot = await realpath(this.root);
      await mkdir(resolve(this.canonicalRoot, '.tmp'), { recursive: true, mode: 0o700 });
    })();
  }

  private async target(scope: ObjectStorageScope, key: string, createParent: boolean):
  Promise<{ logicalKey: string; target: string }> {
    await this.initialize();
    const workspaceId = workspaceIdOf(scope);
    const logicalKey = normalizeObjectKey(key);
    const target = resolve(this.canonicalRoot, 'workspaces', workspaceId, ...logicalKey.split('/'));
    this.assertWithinRoot(target);
    const parent = dirname(target);
    if (createParent) await mkdir(parent, { recursive: true, mode: 0o700 });
    try {
      const canonicalParent = await realpath(parent);
      this.assertWithinRoot(resolve(canonicalParent, 'placeholder'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { logicalKey, target };
  }

  private assertWithinRoot(path: string): void {
    const rel = relative(this.canonicalRoot, path);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new ObjectStorageError('OBJECT_PATH_INVALID', '对象路径越出受控目录。');
    }
  }
}
