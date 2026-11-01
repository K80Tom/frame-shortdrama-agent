const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const { InMemoryNovelRepository } = require('../dist/novel/repository');
const { NovelService } = require('../dist/novel/service');
const { InMemoryAssetRepository } = require('../dist/assets/repository');
const { AssetService } = require('../dist/assets/service');

// Original prose and inert example links only. No model or media network calls.
const RAW = '第一章 灯塔\r\n阿澄拿着铜钥匙站在灯塔外。😀\r\n“等雨停。”阿澄说。\r\n第二章 旧桥\r\n夏禾站在旧桥上。';
const headers = { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:5173', 'x-shortdrama-call': '1' };
const json = response => JSON.parse(response.body);
async function setup(withAssets = true) {
  const config = readConfig({});
  let calls = 0;
  const transport = async () => { calls++; throw new Error('No network is allowed in asset workflows.'); };
  const assets = new AssetService(new InMemoryAssetRepository());
  const service = new NovelService(new InMemoryNovelRepository(), config, transport, withAssets ? assets : undefined);
  const app = await createApp(config, transport, { novelService: service, ...(withAssets ? { assetService: assets } : {}) });
  const request = (method, url, payload) => app.inject({ method, url, headers,
    ...(payload === undefined ? {} : { payload }) });
  async function saved(method, url, payload) {
    const response = await request(method, url, payload);
    assert.equal(response.statusCode, method === 'POST' ? 201 : 200, response.body);
    return json(response);
  }
  const source = await saved('POST', '/api/novels', { title: '原创资产 API 验收', rawText: RAW });
  const initial = await saved('POST', `/api/novel-chapters/${source.chapters[0].id}/seed`, { expectedRevisionId: null });
  const entity = (id, kind, label) => {
    const start = Array.from(RAW.slice(0, RAW.indexOf(label))).length;
    return { id, kind, label, description: '', sourceRefs: [{ documentId: source.id, start,
      end: start + Array.from(label).length, quote: label }], speakerId: null, classification: null,
      uncertainty: null, review: 'confirmed', origin: 'user' };
  };
  const items = [...initial.content.items, entity('person', 'character', '阿澄'),
    entity('place', 'location', '灯塔外'), entity('object', 'prop', '铜钥匙')];
  const confirmed = await saved('POST', `/api/novel-revisions/${initial.id}/corrections`, { expectedRevisionId: initial.id, items });
  const patch = (revision, itemId, assetId = null, note = '') => ({ expectedRevisionId: revision.id,
    bindings: [{ itemId, status: assetId ? 'linked' : 'missing', assetId, note }] });
  const bind = (revision, payload) => saved('POST', `/api/novel-revisions/${revision.id}/asset-bindings`, payload);
  const register = kind => saved('POST', '/api/assets', { kind, name: `验收 ${kind}`, description: '测试链接，不代表可用素材', resourceUrl: `https://example.test/${kind}.png` });
  return { app, request, saved, source, initial, confirmed, patch, bind, register, calls: () => calls };
}

test('asset HTTP registers immutable records, validates input and enforces the local write guard', async () => {
  const f = await setup();
  try {
    const asset = await f.register('character');
    assert.deepEqual(await f.saved('GET', `/api/assets/${asset.id}`), asset);
    assert.deepEqual((await f.saved('GET', '/api/assets')).assets, [asset]);
    for (const fields of [{ resourceUrl: 'javascript:alert(1)' }, { resourceUrl: 'https://user:secret@example.test/a' },
      { resourceUrl: 'http://example.test/a' }, { kind: 'dialogue' }, { id: asset.id }, { extra: true }]) {
      const response = await f.request('POST', '/api/assets', { kind: 'prop', name: '道具', description: '',
        resourceUrl: 'https://example.test/prop', ...fields });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.body.includes('user:secret'), false);
    }
    for (const badHeaders of [{ ...headers, origin: 'https://foreign.test' }, { host: headers.host, origin: headers.origin }]) {
      const response = await f.app.inject({ method: 'POST', url: '/api/assets', headers: badHeaders,
        payload: { kind: 'prop', name: '不应创建', description: '', resourceUrl: 'https://example.test/prop' } });
      assert.equal(response.statusCode, 403);
    }
    assert.equal((await f.saved('GET', '/api/assets')).assets.length, 1);
    assert.equal(f.calls(), 0);
  } finally { await f.app.close(); }
});

test('linking three confirmed entity kinds saves a new chapter version without changing novel facts', async () => {
  const f = await setup();
  try {
    const assets = await Promise.all(['character', 'location', 'prop'].map(f.register));
    const linked = await f.bind(f.confirmed, { expectedRevisionId: f.confirmed.id,
      bindings: ['person', 'place', 'object'].map((itemId, index) => ({ itemId, status: 'linked', assetId: assets[index].id, note: '人工选定' })) });
    assert.deepEqual(linked.content.items, f.confirmed.content.items);
    assert.deepEqual(linked.content.warnings, f.confirmed.content.warnings);
    assert.deepEqual(linked.content.assetBindings.map(binding => binding.asset), assets);
    assert.equal(linked.parentRevisionId, f.confirmed.id);
    const history = (await f.saved('GET', `/api/novel-chapters/${linked.chapterId}/revisions`)).revisions;
    assert.deepEqual(history, [f.initial, f.confirmed, linked]);
    const read = await f.saved('GET', `/api/novels/${f.source.id}`);
    assert.equal(read.rawText, RAW);
    assert.deepEqual(read.chapters.map(chapter => chapter.latestRevisionId), [linked.id, null]);
    const missing = await f.bind(linked, f.patch(linked, 'object', null, '暂无合适道具，待补'));
    assert.deepEqual(missing.content.assetBindings[2], { itemId: 'object', status: 'missing', asset: null, note: '暂无合适道具，待补' });
    assert.deepEqual(missing.content.assetBindings.slice(0, 2), linked.content.assetBindings.slice(0, 2));
    const stale = await f.request('POST', `/api/novel-revisions/${linked.id}/asset-bindings`, f.patch(linked, 'person'));
    assert.equal(stale.statusCode, 409);
    assert.equal(json(stale).error.code, 'NOVEL_REVISION_CONFLICT');
    assert.equal(f.calls(), 0);
  } finally { await f.app.close(); }
});

test('asset binding HTTP refuses unconfirmed, wrong-kind, missing, dialogue and forged snapshots', async () => {
  const f = await setup();
  try {
    const asset = await f.register('location');
    const cases = [
      [f.patch(f.confirmed, 'person', asset.id), 400, 'NOVEL_ASSET_KIND_MISMATCH'],
      [f.patch(f.confirmed, 'person', 'missing'), 404, 'NOVEL_ASSET_NOT_FOUND'],
      [f.patch(f.confirmed, f.confirmed.content.items[0].id), 400, 'NOVEL_ASSET_ITEM_INVALID'],
      [f.patch(f.confirmed, 'foreign_chapter_item'), 400, 'NOVEL_ASSET_ITEM_INVALID'],
      [f.patch(f.confirmed, 'place', asset.id, 'invalid\u0000note'), 400, 'INVALID_NOVEL_ASSET_BINDINGS'],
      [f.patch(f.confirmed, 'place', asset.id, 'invalid\ud800note'), 400, 'INVALID_NOVEL_ASSET_BINDINGS'],
      [{ expectedRevisionId: f.confirmed.id, bindings: [{ ...f.patch(f.confirmed, 'place', asset.id).bindings[0], asset }] }, 400, 'INVALID_NOVEL_ASSET_BINDINGS'],
    ];
    for (const [payload, status, code] of cases) {
      const response = await f.request('POST', `/api/novel-revisions/${f.confirmed.id}/asset-bindings`, payload);
      assert.equal(response.statusCode, status, response.body);
      assert.equal(json(response).error.code, code);
    }
    const items = structuredClone(f.confirmed.content.items);
    items.find(item => item.id === 'person').review = 'unreviewed';
    const unconfirmed = await f.saved('POST', `/api/novel-revisions/${f.confirmed.id}/corrections`, { expectedRevisionId: f.confirmed.id, items });
    const response = await f.request('POST', `/api/novel-revisions/${unconfirmed.id}/asset-bindings`, f.patch(unconfirmed, 'person'));
    assert.equal(response.statusCode, 400);
    assert.equal(json(response).error.code, 'NOVEL_ASSET_ITEM_UNCONFIRMED');
    assert.equal(f.calls(), 0);
  } finally { await f.app.close(); }
});

test('editing a linked entity invalidates only its asset decision, and concurrent saves cannot overwrite each other', async () => {
  const f = await setup();
  try {
    const asset = await f.register('character');
    const linked = await f.bind(f.confirmed, f.patch(f.confirmed, 'person', asset.id));
    const items = structuredClone(linked.content.items);
    items.find(item => item.id === 'person').description = '原文里拿着铜钥匙的人物';
    const edited = await f.saved('POST', `/api/novel-revisions/${linked.id}/corrections`, { expectedRevisionId: linked.id, items });
    assert.equal(edited.content.assetBindings[0].status, 'needsReview');
    assert.deepEqual(edited.content.assetBindings[0].asset, asset);
    const races = await Promise.all([
      f.request('POST', `/api/novel-revisions/${edited.id}/asset-bindings`, f.patch(edited, 'person', asset.id)),
      f.request('POST', `/api/novel-revisions/${edited.id}/asset-bindings`, f.patch(edited, 'person', null, '暂缓使用')),
    ]);
    assert.deepEqual(races.map(response => response.statusCode).sort(), [201, 409]);
    const history = (await f.saved('GET', `/api/novel-chapters/${linked.chapterId}/revisions`)).revisions;
    assert.deepEqual(history[2], linked);
    assert.equal(history.length, 5);
    assert.equal(f.calls(), 0);
  } finally { await f.app.close(); }
});

test('an unmigrated asset catalog fails closed while novel reading and proofreading remain available', async () => {
  const f = await setup(false);
  try {
    for (const [method, url, payload] of [['GET', '/api/assets'],
      ['POST', `/api/novel-revisions/${f.confirmed.id}/asset-bindings`, f.patch(f.confirmed, 'person')]]) {
      const response = await f.request(method, url, payload);
      assert.equal(response.statusCode, 503);
      assert.equal(json(response).error.code, 'ASSET_PERSISTENCE_UNAVAILABLE');
    }
    assert.equal((await f.saved('GET', `/api/novels/${f.source.id}`)).rawText, RAW);
    const items = structuredClone(f.confirmed.content.items);
    items[1].description = '目录不可用时仍能校对';
    await f.saved('POST', `/api/novel-revisions/${f.confirmed.id}/corrections`, { expectedRevisionId: f.confirmed.id, items });
    assert.equal(f.calls(), 0);
  } finally { await f.app.close(); }
});
