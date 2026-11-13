const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');
const { InMemoryAssetRepository } = require('../dist/assets/repository');
const { AssetService } = require('../dist/assets/service');

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
const input = (changes = {}) => ({ kind: 'character', name: '老林', description: '初版说明', contentBase64: png().toString('base64'), ...changes });

async function setup() {
  const service = new AssetService(new InMemoryAssetRepository());
  const record = await service.importImage(input());
  return { service, record };
}

test('更新资产信息保留 ID、素材链接与既有图片字节', async () => {
  const { service, record } = await setup();
  const before = await service.content(record.id);
  const saved = await service.update(record.id, { kind: 'character', name: '老林 · 青年', description: '替换后的说明' });
  assert.equal(saved.id, record.id);
  assert.equal(saved.resourceUrl, record.resourceUrl);
  assert.equal(saved.createdAt, record.createdAt);
  assert.equal(saved.name, '老林 · 青年');
  assert.equal(saved.description, '替换后的说明');
  const after = await service.content(record.id);
  assert.equal(after.sha256, before.sha256);
  assert.deepEqual(after.bytes, before.bytes);
});

test('重新上传图片就地替换媒体且 ID 不变；外部链接资产转为本地图片', async () => {
  const { service, record } = await setup();
  const next = png(2, 2);
  const saved = await service.replaceMedia(record.id, { contentBase64: next.toString('base64') });
  assert.equal(saved.id, record.id);
  assert.equal(saved.name, record.name);
  assert.deepEqual((await service.content(record.id)).bytes, next);

  const external = await service.create({ kind: 'prop', name: '外部链接道具', description: '', resourceUrl: 'https://example.org/a.png' });
  const converted = await service.replaceMedia(external.id, { contentBase64: next.toString('base64') });
  assert.equal(converted.resourceUrl, `/api/assets/${external.id}/content`);
  assert.deepEqual((await service.content(external.id)).bytes, next);
});

test('更新与替换拒绝未知资产、非法名称与非法图片载荷', async () => {
  const { service, record } = await setup();
  const missing = 'asset_00000000000000000000000000000000';
  await assert.rejects(service.update(missing, { kind: 'character', name: 'x', description: '' }), error => error.status === 404);
  await assert.rejects(service.update(record.id, { kind: 'character', name: '', description: '' }), error => error.status === 400);
  await assert.rejects(service.replaceMedia(record.id, { contentBase64: 'not-base64' }), error => error.status === 400);
  await assert.rejects(service.replaceMedia(record.id, { contentBase64: png().toString('base64'), name: '篡改' }), error => error.status === 400);
  await assert.rejects(service.replaceMedia(missing, { contentBase64: png().toString('base64') }), error => error.status === 404);
});
