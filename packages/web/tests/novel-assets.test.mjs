import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const helpers = await server.ssrLoadModule('/src/asset-library.ts');
const { default: NovelAssetPanel } = await server.ssrLoadModule('/src/NovelAssetPanel.tsx');
const { default: AssetLibrary, AssetRecordCard, AssetRecordDetails } = await server.ssrLoadModule('/src/AssetLibrary.tsx');
const { ItemEditor } = await server.ssrLoadModule('/src/NovelBreakdown.tsx');
const person = { id: 'person', kind: 'character', label: '小林', description: '', sourceRefs: [], speakerId: null,
  classification: null, uncertainty: null, review: 'confirmed', origin: 'user' };
const asset = { id: 'asset_1', kind: 'character', name: '青年演员', description: '深色外套', resourceUrl: 'https://example.org/actor.png', createdAt: '2026-10-22T00:00:00.000Z' };
const location = { ...asset, id: 'asset_2', kind: 'location', name: '林间小屋' };
const prop = { ...asset, id: 'asset_3', kind: 'prop', name: '油灯' };
const revision = { id: 'revision', content: { items: [person], warnings: [] } };
const linked = { itemId: person.id, status: 'linked', asset, note: '服装待下游适配' };

test('asset filtering never mixes entity kinds or automatically matches names', () => {
  const assets = [asset, location, prop];
  assert.deepEqual(helpers.filterAssets(assets, 'character', ''), [asset]);
  assert.deepEqual(helpers.filterAssets(assets, 'location', '青年'), []);
  assert.deepEqual(helpers.filterAssets(assets, 'all', 'ASSET_3'), [prop]);
  assert.deepEqual(helpers.filterAssets(assets, 'all', ' 林间 '), [location]);
});

test('only saved confirmed latest entities permit binding; dirty, busy, history and dialogue block', () => {
  const ready = { editable: true, dirty: false, busy: false };
  assert.equal(helpers.bindingBlock(person, ready), null);
  assert.match(helpers.bindingBlock(person, { ...ready, dirty: true }), /先保存/);
  assert.match(helpers.bindingBlock(person, { ...ready, busy: true }), /稍候/);
  assert.match(helpers.bindingBlock(person, { ...ready, editable: false }), /历史版本只读/);
  assert.match(helpers.bindingBlock({ ...person, review: 'unreviewed' }, ready), /确认/);
  assert.match(helpers.bindingBlock({ ...person, uncertainty: '身份不明' }, ready), /确认/);
  assert.match(helpers.bindingBlock({ ...person, kind: 'dialogue' }, ready), /对白不关联/);
});

test('old content without bindings derives missing only for confirmed entities, not dialogue', () => {
  assert.deepEqual(helpers.bindingFor({}, person), { itemId: person.id, status: 'missing', asset: null, note: '' });
  assert.equal(helpers.bindingFor({}, { ...person, review: 'unreviewed' }), null);
  assert.equal(helpers.bindingFor({}, { ...person, kind: 'dialogue' }), null);
  assert.deepEqual(revision.content, { items: [person], warnings: [] });
});

test('needsReview stays invalid even after entity re-confirmation; summary separates it', () => {
  const needsReview = { ...linked, status: 'needsReview' };
  assert.equal(helpers.bindingFor({ assetBindings: [needsReview] }, person), needsReview);
  const items = [person, { ...person, id: 'missing' }, { ...person, id: 'pending', review: 'unreviewed' }, { ...person, id: 'linked' }, { ...person, id: 'speech', kind: 'dialogue' }];
  assert.deepEqual(helpers.assetBindingSummary({ items, warnings: [], assetBindings: [needsReview, { ...linked, itemId: 'linked' }] }), {
    linked: 1, missing: 1, needsReview: 1, unconfirmed: 1,
  });
});

test('binding payload contains registry ID only; missing clears asset explicitly', () => {
  assert.deepEqual(helpers.buildAssetBinding(person, 'linked', asset.id, '  人工选定  ', [asset]), {
    itemId: person.id, status: 'linked', assetId: asset.id, note: '人工选定',
  });
  assert.deepEqual(helpers.buildAssetBinding(person, 'missing', asset.id, '服装不符', [asset]), {
    itemId: person.id, status: 'missing', assetId: null, note: '服装不符',
  });
  assert.throws(() => helpers.buildAssetBinding(person, 'linked', location.id, '', [location]), /同类型/);
  assert.throws(() => helpers.buildAssetBinding(person, 'linked', 'unknown', '', [asset]), /同类型/);
  assert.throws(() => helpers.buildAssetBinding({ ...person, review: 'unreviewed' }, 'missing', null, '', []), /已确认/);
  assert.throws(() => helpers.buildAssetBinding(person, 'missing', null, 'x'.repeat(2001), []), /2000/);
});

test('registration accepts HTTPS only and rejects credentials or repaired URLs without fetching', () => {
  assert.deepEqual(helpers.assetRegistrationErrors({ kind: 'prop', name: '灯', description: '', resourceUrl: 'https://example.org/light.png' }), []);
  for (const url of ['javascript:alert(1)', 'data:image/png;base64,xx', 'file:///tmp/a.png', 'http://example.org/x', 'https://user:secret@example.org/x', 'https://@example.org/x', 'https:example.org', 'https:\\example.org/x', 'https://example.org/\nx']) {
    assert.equal(helpers.assetLink(url), null, url);
    assert.ok(helpers.assetRegistrationErrors({ kind: 'prop', name: '灯', description: '', resourceUrl: url }).length, url);
  }
});

test('asset cards open local details without linking to or loading remote media', () => {
  const html = renderToStaticMarkup(createElement(AssetRecordCard, { asset }));
  assert.match(html, /青年演员/);
  assert.match(html, /asset_1/);
  assert.match(html, /查看人物资产/);
  assert.doesNotMatch(html, /href=|<img|<video|<iframe|<audio|url\(/);
});

test('asset details expose only validated click-to-open links and preserve registry metadata', () => {
  const html = renderToStaticMarkup(createElement(AssetRecordDetails, { asset }));
  assert.match(html, /asset_1/);
  assert.match(html, /深色外套/);
  assert.match(html, /href="https:\/\/example.org\/actor.png"/);
  assert.match(html, /rel="noreferrer noopener"/);
  assert.doesNotMatch(html, /<img|<video|<iframe|<audio|url\(/);
  const invalid = renderToStaticMarkup(createElement(AssetRecordDetails, { asset: { ...asset, resourceUrl: 'javascript:alert(1)' } }));
  assert.match(invalid, /素材链接无效/);
  assert.doesNotMatch(invalid, /href=|<img|<video|<iframe|<audio/);
});

test('panel shows fixed binding snapshot and readonly/history explanation', () => {
  const html = renderToStaticMarkup(createElement(NovelAssetPanel, { item: person, revision: { ...revision, content: { ...revision.content, assetBindings: [linked] } }, editable: false, dirty: false, busy: false, onSave() {} }));
  assert.match(html, /已保存的固定资产登记/);
  assert.match(html, /青年演员/);
  assert.match(html, /asset_1/);
  assert.match(html, /历史版本只读/);
  assert.match(html, /button[^>]*disabled=""[^>]*>.*?保存资产引用/);
  assert.doesNotMatch(html, /<img|<video/);
});

test('panel displays missing and stale states honestly; dialogue has no binding controls', () => {
  const props = { item: person, revision, editable: true, dirty: false, busy: false, onSave() {} };
  const missing = renderToStaticMarkup(createElement(NovelAssetPanel, props));
  assert.match(missing, /待补资产/);
  const stale = renderToStaticMarkup(createElement(NovelAssetPanel, { ...props, revision: { ...revision, content: { ...revision.content, assetBindings: [{ ...linked, status: 'needsReview' }] } } }));
  assert.match(stale, /引用待重核/);
  assert.match(stale, /不是当前有效引用/);
  assert.match(stale, /旧引用不能继续视为有效/);
  assert.equal(renderToStaticMarkup(createElement(NovelAssetPanel, { ...props, item: { ...person, kind: 'dialogue' } })), '');
});

test('asset registration page offers local import without implying generation or quality review', () => {
  const html = renderToStaticMarkup(createElement(AssetLibrary));
  assert.match(html, /个人资产库/);
  assert.match(html, /上传本地图片/);
  assert.match(html, /不生成、不自动质检/);
  assert.match(html, /链接仅作为记录，不保证可达或永久有效/);
  assert.match(html, /登记记录不可覆盖/);
  assert.doesNotMatch(html, /<img|<video|<iframe/);
  assert.match(html, /关闭弹窗会保留尚未登记的输入/);
  assert.match(html, /<dialog[^>]*aria-label="新建资产"/);
  assert.doesNotMatch(html, /<dialog[^>]*\sopen(?:=|\s|>)/);
});

test('local imported images preview and download only from exact server-owned paths', () => {
  const url = '/api/assets/asset_' + 'a'.repeat(32) + '/content';
  const local = { ...asset, id: 'asset_' + 'a'.repeat(32), resourceUrl: url };
  assert.equal(helpers.assetLink(url), url);
  assert.match(renderToStaticMarkup(createElement(AssetRecordCard, { asset: local })), /<img/);
  const detail = renderToStaticMarkup(createElement(AssetRecordDetails, { asset: local }));
  assert.match(detail, /下载本地原图/); assert.match(detail, /\?download=1/);
  for (const bad of ['/api/assets/../../secret', '//foreign.test/image.png', url + '?source=https://foreign.test', 'file:///private/a.png']) assert.equal(helpers.assetLink(bad), null);
  assert.ok(helpers.assetRegistrationErrors({ ...local }).length, 'link registration cannot forge local imports');
  assert.equal(helpers.assetFileError({ size: 100, type: 'image/png' }), null);
  assert.ok(helpers.assetFileError({ size: 0, type: 'image/png' }));
  assert.ok(helpers.assetFileError({ size: 7 * 1024 * 1024, type: 'image/png' }));
  assert.ok(helpers.assetFileError({ size: 10, type: 'image/svg+xml' }));
});

test('asset and dialogue selects expose stable explicit accessible names', () => {
  const library = renderToStaticMarkup(createElement(AssetLibrary));
  assert.match(library, /<select aria-label="资产类型"/);
  assert.match(library, /<select aria-label="筛选资产类型"/);
  const panel = renderToStaticMarkup(createElement(NovelAssetPanel, {
    item: person, revision, editable: true, dirty: false, busy: false, onSave() {},
  }));
  assert.match(panel, /<select aria-label="选择关联资产"/);
  const dialogue = { ...person, id: 'dialogue', kind: 'dialogue', label: '门开了。',
    speakerId: person.id, classification: 'speech' };
  const editor = renderToStaticMarkup(createElement(ItemEditor, {
    item: dialogue, items: [person, dialogue], source: {}, chapter: { start: 0, end: 20 },
    selection: null, disabled: false, onChange() {}, onLocate() {}, onDelete() {},
  }));
  assert.match(editor, /<select aria-label="文本类型"/);
  assert.match(editor, /<select aria-label="说话人 \/ 心理活动所属人物"/);
});
