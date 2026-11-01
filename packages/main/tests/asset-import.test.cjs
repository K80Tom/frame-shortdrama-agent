const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const { parseAssetImport, inspectAssetImage, MAX_ASSET_BYTES } = require('../dist/assets/media');
const { parseAssetInput, validateAssetRecord } = require('@ohao/shared');
const { AssetService } = require('../dist/assets/service');
const { InMemoryAssetRepository, PostgresAssetRepository } = require('../dist/assets/repository');
const { applyNovelAssetBindings } = require('../dist/novel/assets');

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const output = Buffer.alloc(data.length + 12); output.writeUInt32BE(data.length); body.copy(output, 4); output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}
function png(width = 1, height = 1) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const image = png();
const input = (changes = {}) => ({ kind: 'prop', name: '桌面生成测试道具', description: '设计素材，未认定为原文事实', contentBase64: image.toString('base64'), ...changes });

test('raster import validates bytes, canonical base64, bounds and exact fields, never trusting filenames or paths', () => {
  const { record, media } = parseAssetImport(input());
  assert.equal(media.mimeType, 'image/png'); assert.deepEqual(media.bytes, image); assert.equal(media.sha256.length, 64);
  assert.equal(record.resourceUrl, `/api/assets/${record.id}/content`); assert.doesNotThrow(() => validateAssetRecord(record));
  assert.throws(() => parseAssetInput({ kind: record.kind, name: record.name, description: record.description, resourceUrl: record.resourceUrl }));
  assert.throws(() => validateAssetRecord({ ...record, resourceUrl: '/api/assets/asset_' + '0'.repeat(32) + '/content' }));
  for (const value of [input({ path: '../../private/key' }), input({ mimeType: 'image/png' }), input({ contentBase64: '<svg/>' }),
    input({ contentBase64: Buffer.from('<html>not an image</html>').toString('base64') }), input({ contentBase64: image.toString('base64') + '\n' }),
    input({ contentBase64: Buffer.concat([image, Buffer.from('<script>')]).toString('base64') }), input({ contentBase64: image.subarray(0, -1).toString('base64') }),
    input({ contentBase64: png(9000).toString('base64') }), input({ contentBase64: png(8192, 8192).toString('base64') })]) assert.throws(() => parseAssetImport(value));
  const corrupt = Buffer.from(image); corrupt[30] ^= 1; assert.throws(() => inspectAssetImage(corrupt), error => error.code === 'INVALID_ASSET_IMAGE');
  assert.throws(() => parseAssetImport(input({ contentBase64: Buffer.alloc(MAX_ASSET_BYTES + 1).toString('base64') })), error => error.status === 413);
});

test('static WebP and JPEG containers have bounded dimensions and complete terminators', () => {
  const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
  assert.equal(inspectAssetImage(webp), 'image/webp');
  assert.throws(() => inspectAssetImage(webp.subarray(0, -1)));
  // Minimal marker fixture exercises JPEG container validation, not visual decoding.
  const jpeg = Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,218,0,8,1,1,0,0,63,0,3,255,217]);
  assert.equal(inspectAssetImage(jpeg), 'image/jpeg');
  assert.throws(() => inspectAssetImage(jpeg.subarray(0, -2)));
});

test('imports are atomic immutable snapshots and exact retries do not create duplicate registrations', async () => {
  const repository = new InMemoryAssetRepository(); const service = new AssetService(repository);
  const [first, second] = await Promise.all([service.importImage(input()), service.importImage(input())]);
  assert.deepEqual(first, second); assert.equal((await service.list()).length, 1);
  const reloaded = new AssetService(repository); assert.deepEqual(await reloaded.get(first.id), first);
  const media = await reloaded.content(first.id); assert.deepEqual(media.bytes, image); media.bytes[0] = 0;
  assert.deepEqual((await reloaded.content(first.id)).bytes, image);
  assert.notEqual((await service.importImage(input({ description: '另外的明确设计' }))).id, first.id);
  await assert.rejects(repository.create(parseAssetImport(input()).record), error => error.code === 'ASSET_MEDIA_REQUIRED');
  await assert.rejects(new AssetService(repository, false).importImage(input()), error => error.code === 'ASSET_MEDIA_MIGRATION_REQUIRED');
});

test('local image registrations bind using the existing confirmed novel entity contract without changing facts', async () => {
  const asset = await new AssetService(new InMemoryAssetRepository()).importImage(input());
  const entity = { id: 'book', kind: 'prop', label: '书籍', description: '原文描述', sourceRefs: [], speakerId: null, classification: null, uncertainty: null, review: 'confirmed', origin: 'user' };
  const revision = { id: 'revision', chapterId: 'chapter', content: { items: [entity], warnings: [] } };
  const content = applyNovelAssetBindings(revision, { expectedRevisionId: 'revision', bindings: [{ itemId: 'book', status: 'linked', assetId: asset.id, note: '生成的设计候选' }] }, [asset]);
  assert.deepEqual(content.items, revision.content.items); assert.deepEqual(content.assetBindings[0].asset, asset);
});

test('HTTP import and local content use the local write guard, safe image headers, and no remote fetch', async () => {
  let calls = 0; const service = new AssetService(new InMemoryAssetRepository());
  const app = await createApp(readConfig({}), async () => { calls++; throw new Error('No network'); }, { assetService: service });
  const headers = { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:5173', 'x-shortdrama-call': '1' };
  try {
    const denied = await app.inject({ method: 'POST', url: '/api/assets/import', headers: { host: headers.host }, payload: input() }); assert.equal(denied.statusCode, 403);
    const imported = await app.inject({ method: 'POST', url: '/api/assets/import', headers, payload: input() }); assert.equal(imported.statusCode, 201, imported.body);
    const asset = imported.json();
    for (const suffix of ['', '?download=1']) {
      const result = await app.inject({ method: 'GET', url: asset.resourceUrl + suffix, headers });
      assert.equal(result.statusCode, 200); assert.deepEqual(result.rawPayload, image);
      assert.equal(result.headers['content-type'], 'image/png'); assert.equal(result.headers['x-content-type-options'], 'nosniff');
      assert.match(result.headers['content-security-policy'], /sandbox/); assert.match(result.headers['cache-control'], /no-store/);
      assert.match(result.headers['content-disposition'], suffix ? /^attachment/ : /^inline/);
    }
    assert.equal((await app.inject({ method: 'GET', url: asset.resourceUrl, headers: { ...headers, origin: 'https://foreign.test' } })).statusCode, 403);
    const external = await service.create({ kind: 'prop', name: '远程', description: '', resourceUrl: 'https://example.invalid/a.png' });
    assert.equal((await app.inject({ method: 'GET', url: `/api/assets/${external.id}/content`, headers })).statusCode, 404);
    for (const id of ['asset_' + '0'.repeat(32), '..%2Fsecret', 'http%3A%2F%2Fprivate']) {
      assert.notEqual((await app.inject({ method: 'GET', url: `/api/assets/${id}/content`, headers })).statusCode, 200);
    }
    const list = (await app.inject({ method: 'GET', url: '/api/assets', headers })).json();
    assert.equal(JSON.stringify(list).includes(image.toString('base64')), false); assert.equal(calls, 0);
  } finally { await app.close(); }
});

test('PostgreSQL imports write catalogue and bytes inside one transaction; errors expose no raw data', async () => {
  const { record, media } = parseAssetImport(input()); const calls = [];
  const repository = new PostgresAssetRepository({ transaction: async run => run({ query: async (sql, params) => {
    calls.push([sql, params]);
    return { rows: sql.startsWith('INSERT INTO asset_catalog') ? [{ id: record.id, kind: record.kind, name: record.name, description: record.description, resource_url: record.resourceUrl, created_at: new Date(record.createdAt) }] : [] };
  } }) });
  assert.deepEqual(await repository.createWithMedia(record, media), record);
  assert.equal(calls.length, 2); assert.equal(calls[1][0].startsWith('INSERT INTO asset_media'), true); assert.deepEqual(calls[1][1][3], image);
  const broken = new PostgresAssetRepository({ transaction: async () => { throw new Error('secret bytes and SQL'); } });
  await assert.rejects(broken.createWithMedia(record, media), error => error.code === 'ASSET_PERSISTENCE_UNAVAILABLE' && !error.message.includes('secret'));
});
