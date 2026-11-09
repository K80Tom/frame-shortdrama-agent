const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, symlink, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');

const {
  MemoryBlobStorageDriver, LocalBlobStorageDriver, S3BlobStorageDriver,
  DRIVER_MANAGED_PREFIX, StorageDriverError, sha256Of,
  normalizeStorageProvider, resolveStorageEndpoint, resolveStoragePublicUrl,
  createStorageDriver, readStorageDriverConfig,
} = require('../dist/storage');

test('存储厂商画像与端点解析', () => {
  assert.equal(normalizeStorageProvider('aliyun_oss'), 'oss');
  assert.equal(normalizeStorageProvider('local'), 'local');
  assert.throws(() => normalizeStorageProvider('unknown_provider'), StorageDriverError);
  const minio = resolveStorageEndpoint({ provider: 'minio', endpoint: 'http://127.0.0.1:9000' });
  assert.equal(minio.pathStyleAccessEnabled, true);
  assert.equal(minio.signingRegion, 'us-east-1');
  assert.throws(() => resolveStorageEndpoint({ provider: 'minio' }), StorageDriverError);
  const s3 = resolveStorageEndpoint({ provider: 's3', region: 'ap-northeast-1' });
  assert.equal(s3.endpoint, 'https://s3.ap-northeast-1.amazonaws.com');
  assert.equal(s3.pathStyleAccessEnabled, false);
  const url = resolveStoragePublicUrl({ resolved: s3, bucket: 'lyra-bucket', objectKey: 'a b/c.txt' });
  assert.equal(url, 'https://lyra-bucket.s3.ap-northeast-1.amazonaws.com/a%20b/c.txt');
  const pathStyle = resolveStoragePublicUrl({ resolved: minio, bucket: 'lyra-bucket', objectKey: 'k.bin' });
  assert.equal(pathStyle, 'http://127.0.0.1:9000/lyra-bucket/k.bin');
});

test('对象键校验拒绝穿越与托管前缀外访问', async () => {
  const driver = new MemoryBlobStorageDriver();
  await assert.rejects(() => driver.put({ key: 'outside/key.bin', body: Buffer.from('x') }), StorageDriverError);
  await assert.rejects(() => driver.put({ key: `${DRIVER_MANAGED_PREFIX}../escape.bin`, body: Buffer.from('x') }), StorageDriverError);
  await assert.rejects(() => driver.put({ key: `${DRIVER_MANAGED_PREFIX}a//b.bin`, body: Buffer.from('x') }), StorageDriverError);
  await assert.rejects(() => driver.list('../outside'), StorageDriverError);
  await assert.rejects(() => driver.list('outside/'), StorageDriverError);
});

test('内存驱动完整生命周期与区间读取', async () => {
  const driver = new MemoryBlobStorageDriver();
  const body = Buffer.from('hello lyra storage driver');
  const stored = await driver.put({ key: `${DRIVER_MANAGED_PREFIX}staging/demo.bin`, body, contentType: 'application/octet-stream' });
  assert.equal(stored.sha256, sha256Of(body));
  assert.equal(stored.size, body.length);
  const head = await driver.head(`${DRIVER_MANAGED_PREFIX}staging/demo.bin`);
  assert.equal(head?.size, body.length);
  const chunk = await driver.readRange(`${DRIVER_MANAGED_PREFIX}staging/demo.bin`, 6, 4);
  assert.equal(chunk.toString(), 'lyra');
  await assert.rejects(() => driver.readRange(`${DRIVER_MANAGED_PREFIX}staging/demo.bin`, 20, 100), StorageDriverError);
  assert.equal(await driver.head(`${DRIVER_MANAGED_PREFIX}staging/missing.bin`), null);
  await driver.put({ key: `${DRIVER_MANAGED_PREFIX}staging/old/0001.bin`, body: Buffer.from('old') });
  const listed = await driver.list(`${DRIVER_MANAGED_PREFIX}staging`);
  assert.equal(listed.length, 2);
  await driver.delete(`${DRIVER_MANAGED_PREFIX}staging/demo.bin`);
  assert.equal((await driver.list(`${DRIVER_MANAGED_PREFIX}staging`)).length, 1);
});

test('本地驱动：原子写入、区间读取与符号链接防护', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyra-local-driver-'));
  try {
    const driver = new LocalBlobStorageDriver(root);
    const key = `${DRIVER_MANAGED_PREFIX}staging/case/text.txt`;
    const body = Buffer.from('0123456789abcdef');
    const stored = await driver.put({ key, body, contentType: 'text/plain' });
    assert.equal(stored.sha256, sha256Of(body));
    assert.equal((await driver.readRange(key, 2, 5)).toString(), '23456');
    const head = await driver.head(key);
    assert.equal(head?.size, body.length);
    const listed = await driver.list(`${DRIVER_MANAGED_PREFIX}staging`);
    assert.ok(listed.some(entry => entry.key === key));
    // 符号链接逃逸防护：managed 目录内的 symlink 指向外部文件必须被拒绝。
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'secret');
    await symlink(outside, join(root, DRIVER_MANAGED_PREFIX, 'staging/case/evil.txt'));
    await assert.rejects(() => driver.head(`${DRIVER_MANAGED_PREFIX}staging/case/evil.txt`), StorageDriverError);
    await assert.rejects(() => driver.delete(`${DRIVER_MANAGED_PREFIX}staging/case/evil.txt`), StorageDriverError);
    const listing = await driver.list(`${DRIVER_MANAGED_PREFIX}staging`);
    assert.ok(!listing.some(entry => entry.key.endsWith('evil.txt')));
    // 目录符号链接也不能通过 list 进入。
    await mkdir(join(root, DRIVER_MANAGED_PREFIX, 'staging/linkdir'));
    await symlink(join(root, 'outside.txt'), join(root, DRIVER_MANAGED_PREFIX, 'staging/linkdir/inner.txt'));
    const safeListing = await driver.list(`${DRIVER_MANAGED_PREFIX}staging`);
    assert.ok(!safeListing.some(entry => entry.key.includes('linkdir/inner.txt')));
    await driver.delete(key);
    assert.equal(await driver.head(key), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function stubS3Commands() {
  const calls = [];
  const objects = new Map();
  const make = name => class { constructor(input) { calls.push({ name, input }); this.input = input; } };
  return {
    calls, objects,
    commands: {
      PutObjectCommand: make('PutObject'), HeadObjectCommand: make('Head'),
      GetObjectCommand: make('Get'), DeleteObjectCommand: make('Delete'),
      ListObjectsV2Command: make('List'),
    },
  };
}

test('S3 驱动使用桩客户端，不出网且校验长度与范围', async () => {
  const stub = stubS3Commands();
  stub.objects.set('.lyra-driver/staging/a.bin', Buffer.from('0123456789'));
  const driver = new S3BlobStorageDriver({
    bucket: 'bk',
    endpoint: resolveStorageEndpoint({ provider: 'minio', endpoint: 'http://127.0.0.1:9000' }),
    client: {
      async send(command) {
        const name = stub.calls.at(-1).name;
        if (name === 'PutObject') return { ETag: '"etag-1"' };
        if (name === 'Head') {
          const body = stub.objects.get(command.input.Key);
          if (!body) { const error = new Error('not found'); error.name = 'NoSuchKey'; throw error; }
          return { ContentLength: body.length, ETag: '"etag-1"' };
        }
        if (name === 'Get') {
          const body = stub.objects.get(command.input.Key);
          if (!body) { const error = new Error('not found'); error.name = 'NoSuchKey'; throw error; }
          const match = /^bytes=(\d+)-(\d+)$/.exec(command.input.Range ?? '');
          if (!match) throw new Error('Range required');
          const start = Number(match[1]); const end = Number(match[2]);
          if (end >= body.length) throw new Error('range out of bounds');
          const slice = body.subarray(start, end + 1);
          return { ContentLength: slice.length, Body: { async transformToByteArray() { return Uint8Array.from(slice); } } };
        }
        if (name === 'List') {
          return {
            IsTruncated: false,
            Contents: [...stub.objects.keys()].filter(key => key.startsWith(command.input.Prefix))
              .map(key => ({ Key: key, Size: stub.objects.get(key).length, ETag: '"x"' })),
          };
        }
        return {};
      },
    },
    commands: stub.commands,
  });
  const key = `${DRIVER_MANAGED_PREFIX}staging/a.bin`;
  const stored = await driver.put({ key, body: Buffer.from('0123456789') });
  assert.equal(stored.etag, 'etag-1');
  assert.equal(stub.calls.at(-1).name, 'PutObject');
  assert.equal(stub.calls.at(-1).input.Bucket, 'bk');
  assert.equal((await driver.head(key))?.size, 10);
  assert.equal(await driver.head(`${DRIVER_MANAGED_PREFIX}staging/missing.bin`), null);
  const chunk = await driver.readRange(key, 3, 4);
  assert.equal(chunk.toString(), '3456');
  const last = stub.calls.at(-1);
  assert.equal(last.name, 'Get');
  assert.equal(last.input.Range, 'bytes=3-6');
  const listed = await driver.list(`${DRIVER_MANAGED_PREFIX}staging`);
  assert.deepEqual(listed.map(entry => entry.key), [key]);
  // 越界范围必须被拒绝（HeadObject 先校验长度）。
  await assert.rejects(() => driver.readRange(key, 8, 10), StorageDriverError);
  await driver.delete(key);
  assert.equal(stub.calls.at(-1).name, 'Delete');
});

test('存储驱动环境装配：memory/local/s3 与配置缺失报错', () => {
  const memory = createStorageDriver({ provider: 'memory' });
  assert.equal(memory.provider, 'memory');
  const local = createStorageDriver({ provider: 'local', root: '/tmp/lyra-driver-test' });
  assert.equal(local.provider, 'local');
  const config = readStorageDriverConfig({
    OBJECT_STORAGE_PROVIDER: 'minio',
    OBJECT_STORAGE_BUCKET: 'bk',
    OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
    OBJECT_STORAGE_PREFIX: '/tenant-a/',
  });
  assert.equal(config.provider, 'minio');
  assert.equal(config.basePrefix, 'tenant-a');
  assert.throws(() => readStorageDriverConfig({ OBJECT_STORAGE_PROVIDER: 's3' }), StorageDriverError);
});
