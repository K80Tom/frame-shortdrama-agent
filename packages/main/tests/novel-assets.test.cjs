const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildNovelSource, validateNovelContent, validateNovelAssetBindings, applyNovelCorrections, supplementNovelQuotes } = require('@ohao/shared');
const { applyNovelAssetBindings } = require('../dist/novel/assets.js');

// Original, tiny fiction only. No remote content or model calls.
const RAW = '第一章 灯塔\n林舟站在灯塔门口，手里拿着铜钥匙。\n林舟说：“门开了。”\n第二章 旧桥\n沈雨走过旧桥。';
function fixture() {
  const source = buildNovelSource({ title: '原创资产引用练习', rawText: RAW });
  const evidence = quote => {
    const offset = RAW.indexOf(quote);
    assert.notEqual(offset, -1);
    const start = Array.from(RAW.slice(0, offset)).length;
    return { documentId: source.id, start, end: start + Array.from(quote).length, quote };
  };
  const entity = (id, kind, label) => ({ id, kind, label, description: '', sourceRefs: [evidence(label)],
    speakerId: null, classification: null, uncertainty: null, review: 'confirmed', origin: 'model' });
  const items = [entity('character_1', 'character', '林舟'), entity('location_1', 'location', '灯塔'),
    entity('prop_1', 'prop', '铜钥匙'), { ...entity('dialogue_1', 'dialogue', '门开了。'), speakerId: 'character_1', classification: 'speech' }];
  const revision = { id: 'revision_1', chapterId: source.chapters[0].id, parentRevisionId: null,
    createdBy: 'model', createdAt: '2026-10-22T00:00:00.000Z', content: { items, warnings: ['原文仍需人工核对。'] } };
  const assets = ['character', 'location', 'prop'].map((kind, i) => ({ id: `asset_${String(i + 1).padStart(32, '0')}`,
    kind, name: `已有${kind}`, description: '用户登记的资源链接，不代表已下载或验证',
    resourceUrl: `https://example.test/${kind}.png`, createdAt: '2026-10-22T00:00:00.000Z' }));
  return { source, chapter: source.chapters[0], revision, assets, evidence };
}
const request = (base, itemId = 'character_1', assetId = 'asset_00000000000000000000000000000001', note = '') => ({
  expectedRevisionId: base.id, bindings: [{ itemId, status: 'linked', assetId, note }],
});
function linked(f) {
  return { ...f.revision, content: applyNovelAssetBindings(f.revision, request(f.revision), f.assets) };
}

test('legacy novel content with no assetBindings still validates; linking only adds copied snapshots', () => {
  const f = fixture();
  validateNovelContent(f.revision.content, f.source, f.chapter);
  const before = structuredClone({ source: f.source, revision: f.revision, assets: f.assets });
  const content = applyNovelAssetBindings(f.revision, request(f.revision, 'character_1', f.assets[0].id, '沿用已有素材'), f.assets);
  validateNovelContent(content, f.source, f.chapter);
  assert.deepEqual(content.items, before.revision.content.items);
  assert.deepEqual(content.warnings, before.revision.content.warnings);
  assert.deepEqual(content.assetBindings, [{ itemId: 'character_1', status: 'linked', asset: before.assets[0], note: '沿用已有素材' }]);
  assert.deepEqual({ source: f.source, revision: f.revision, assets: f.assets }, before);
  content.items[0].label = '内存副本';
  content.assetBindings[0].asset.name = '内存副本';
  assert.deepEqual({ source: f.source, revision: f.revision, assets: f.assets }, before);
});

test('unconfirmed, uncertain, foreign-chapter items and dialogue cannot receive asset decisions', () => {
  const f = fixture();
  for (const fields of [{ review: 'unreviewed' }, { uncertainty: '身份不明' }]) {
    const base = structuredClone(f.revision);
    Object.assign(base.content.items[0], fields);
    assert.throws(() => applyNovelAssetBindings(base, request(base), f.assets), { code: 'NOVEL_ASSET_ITEM_UNCONFIRMED' });
  }
  for (const itemId of ['dialogue_1', 'chapter_2_character']) {
    assert.throws(() => applyNovelAssetBindings(f.revision, request(f.revision, itemId), f.assets), { code: 'NOVEL_ASSET_ITEM_INVALID' });
  }
});

test('linking rejects missing catalog assets, wrong types, stale base and fake snapshot payloads', () => {
  const f = fixture();
  assert.throws(() => applyNovelAssetBindings(f.revision, request(f.revision, 'character_1', 'missing'), f.assets), { code: 'NOVEL_ASSET_NOT_FOUND' });
  assert.throws(() => applyNovelAssetBindings(f.revision, request(f.revision, 'character_1', f.assets[1].id), f.assets), { code: 'NOVEL_ASSET_KIND_MISMATCH' });
  assert.throws(() => applyNovelAssetBindings(f.revision, { ...request(f.revision), expectedRevisionId: 'old' }, f.assets), { code: 'NOVEL_REVISION_CONFLICT' });
  for (const patch of [{ asset: f.assets[0] }, { extra: true }, { status: 'needsReview' }, { assetId: null }]) {
    const input = request(f.revision);
    Object.assign(input.bindings[0], patch);
    assert.throws(() => applyNovelAssetBindings(f.revision, input, f.assets), { code: 'INVALID_NOVEL_ASSET_BINDINGS' });
  }
  assert.throws(() => applyNovelAssetBindings(f.revision, { ...request(f.revision), items: [] }, f.assets), { code: 'INVALID_NOVEL_ASSET_BINDINGS' });
});

test('patches are nonempty and unique; unchanged decisions do not manufacture new content', () => {
  const f = fixture();
  const input = request(f.revision);
  assert.throws(() => applyNovelAssetBindings(f.revision, { expectedRevisionId: f.revision.id, bindings: [] }, f.assets), { code: 'INVALID_NOVEL_ASSET_BINDINGS' });
  assert.throws(() => applyNovelAssetBindings(f.revision, { ...input, bindings: [...input.bindings, ...input.bindings] }, f.assets), { code: 'DUPLICATE_NOVEL_ASSET_BINDING' });
  const base = linked(f);
  assert.throws(() => applyNovelAssetBindings(base, request(base), f.assets), { code: 'NOVEL_ASSET_NO_CHANGES' });
  assert.equal(applyNovelAssetBindings(base, request(base, 'character_1', f.assets[0].id, '新备注'), f.assets).assetBindings[0].note, '新备注');
});

test('binding notes reject NUL and lone surrogates before persistence but preserve valid Unicode', () => {
  const f = fixture();
  for (const note of ['x\u0000y', 'x\ud800y', 'x\udfffy', '\ud800\ud800', '\udc00\ud800']) {
    assert.throws(() => applyNovelAssetBindings(f.revision, request(f.revision, 'character_1', f.assets[0].id, note), f.assets),
      { code: 'INVALID_NOVEL_ASSET_BINDINGS' });
    const content = structuredClone(linked(f).content);
    content.assetBindings[0].note = note;
    assert.throws(() => validateNovelContent(content, f.source, f.chapter), { code: 'INVALID_NOVEL_CONTENT' });
    assert.throws(() => validateNovelAssetBindings(content), { code: 'INVALID_NOVEL_ASSET_BINDINGS' });
  }
  for (const note of ['', '保留原备注\n第二行\t😀', '😀'.repeat(2000)]) {
    const content = applyNovelAssetBindings(f.revision, request(f.revision, 'character_1', f.assets[0].id, note), f.assets);
    assert.equal(content.assetBindings[0].note, note);
    validateNovelContent(content, f.source, f.chapter);
  }
  assert.throws(() => applyNovelAssetBindings(f.revision,
    request(f.revision, 'character_1', f.assets[0].id, '😀'.repeat(2001)), f.assets), { code: 'INVALID_NOVEL_ASSET_BINDINGS' });
});

test('explicit missing decision clears an old asset while preserving other bindings and old history', () => {
  const f = fixture();
  let base = linked(f);
  base = { ...base, content: applyNovelAssetBindings(base, request(base, 'location_1', f.assets[1].id), f.assets) };
  const before = structuredClone(base);
  const input = { expectedRevisionId: base.id, bindings: [{ itemId: 'character_1', status: 'missing', assetId: null, note: '暂无合适形象' }] };
  const result = applyNovelAssetBindings(base, input, f.assets);
  assert.deepEqual(result.assetBindings[0], { itemId: 'character_1', status: 'missing', asset: null, note: '暂无合适形象' });
  assert.deepEqual(result.assetBindings[1], before.content.assetBindings[1]);
  assert.deepEqual(base, before);
  input.bindings[0].assetId = f.assets[0].id;
  assert.throws(() => applyNovelAssetBindings(base, input, f.assets), { code: 'INVALID_NOVEL_ASSET_BINDINGS' });
});

test('snapshots use the catalog validator: unsafe URLs, malformed dates, IDs and extra fields are refused', () => {
  const f = fixture();
  for (const fields of [
    { resourceUrl: 'javascript:alert(1)' }, { resourceUrl: 'http://example.test/a' },
    { resourceUrl: 'https://name:pass@example.test/a' }, { resourceUrl: 'https://@example.test/a' },
    { resourceUrl: 'https://example.test/\na' }, { resourceUrl: 'https:\\example.test/a' },
    { createdAt: '2026-02-30T00:00:00.000Z' }, { name: ' padded ' }, { extra: true }, { id: 'arbitrary' },
  ]) {
    const asset = { ...f.assets[0], ...fields };
    assert.throws(() => applyNovelAssetBindings(f.revision, request(f.revision, 'character_1', asset.id), [asset]), { code: 'INVALID_NOVEL_ASSET_SNAPSHOT' });
    const content = structuredClone(linked(f).content);
    content.assetBindings[0].asset = asset;
    assert.throws(() => validateNovelContent(content, f.source, f.chapter));
  }
});

test('stored content rejects duplicate, dangling, dialogue, false-linked and malformed binding states', () => {
  const f = fixture();
  for (const patch of [
    { itemId: 'not_here' }, { itemId: 'dialogue_1' }, { status: 'linked', asset: null },
    { status: 'missing' }, { asset: f.assets[1] }, { future: true }, { status: 'ready' },
  ]) {
    const content = structuredClone(linked(f).content);
    Object.assign(content.assetBindings[0], patch);
    assert.throws(() => validateNovelContent(content, f.source, f.chapter));
  }
  const duplicate = linked(f).content;
  duplicate.assetBindings.push(structuredClone(duplicate.assetBindings[0]));
  assert.throws(() => validateNovelContent(duplicate, f.source, f.chapter), { code: 'DUPLICATE_NOVEL_ASSET_BINDING' });
  const unconfirmed = linked(f).content;
  unconfirmed.items[0].review = 'unreviewed';
  assert.throws(() => validateNovelContent(unconfirmed, f.source, f.chapter), { code: 'NOVEL_ASSET_ITEM_UNCONFIRMED' });
});

test('changing identity, description, evidence or entity kind makes only that binding need review', () => {
  const f = fixture();
  let base = linked(f);
  base = { ...base, content: applyNovelAssetBindings(base, request(base, 'location_1', f.assets[1].id), f.assets) };
  for (const fields of [{ label: '林舟（青年）' }, { description: '原文已校对的说明' },
    { sourceRefs: [f.evidence('林舟站在灯塔门口，手里拿着铜钥匙。')] }]) {
    const items = structuredClone(base.content.items);
    Object.assign(items[0], fields);
    const result = applyNovelCorrections(base, f.source, f.chapter, { expectedRevisionId: base.id, items });
    assert.equal(result.assetBindings[0].status, 'needsReview');
    assert.deepEqual(result.assetBindings[0].asset, f.assets[0]);
    assert.equal(result.assetBindings[1].status, 'linked');
  }
  const items = base.content.items.filter(item => item.kind !== 'dialogue').map(item => ({ ...item }));
  items[0].kind = 'prop';
  const changedKind = applyNovelCorrections(base, f.source, f.chapter, { expectedRevisionId: base.id, items });
  assert.equal(changedKind.assetBindings[0].status, 'needsReview');
  assert.equal(changedKind.assetBindings[0].asset.kind, 'character');
  validateNovelContent(changedKind, f.source, f.chapter);
});

test('origin-only edits and unrelated additions do not invalidate a confirmed entity binding', () => {
  const f = fixture();
  const base = linked(f);
  const items = structuredClone(base.content.items);
  items[0].origin = 'user';
  items.push({ ...items[2], id: 'another_prop', label: '门', sourceRefs: [f.evidence('门')] });
  const result = applyNovelCorrections(base, f.source, f.chapter, { expectedRevisionId: base.id, items });
  assert.equal(result.assetBindings[0].status, 'linked');
  assert.equal(result.items[0].origin, 'model');
  assert.deepEqual(result.assetBindings[0], base.content.assetBindings[0]);
});

test('unconfirming then confirming does not silently restore an old linked or missing decision', () => {
  const f = fixture();
  for (const initial of ['linked', 'missing']) {
    const input = request(f.revision);
    if (initial === 'missing') Object.assign(input.bindings[0], { status: 'missing', assetId: null });
    let base = { ...f.revision, content: applyNovelAssetBindings(f.revision, input, f.assets) };
    let items = structuredClone(base.content.items);
    items[0].review = 'unreviewed';
    base = { ...base, content: applyNovelCorrections(base, f.source, f.chapter, { expectedRevisionId: base.id, items }) };
    assert.equal(base.content.assetBindings[0].status, 'needsReview');
    items = structuredClone(base.content.items);
    items[0].review = 'confirmed';
    base = { ...base, content: applyNovelCorrections(base, f.source, f.chapter, { expectedRevisionId: base.id, items }) };
    assert.equal(base.content.assetBindings[0].status, 'needsReview');
    assert.equal(applyNovelAssetBindings(base, request(base), f.assets).assetBindings[0].status, 'linked');
  }
});

test('deleting or reclassifying an entity as quoted text removes its new binding only', () => {
  const f = fixture();
  const base = linked(f);
  const before = structuredClone(base);
  const deleted = applyNovelCorrections(base, f.source, f.chapter, { expectedRevisionId: base.id,
    items: base.content.items.filter(item => !['character_1', 'dialogue_1'].includes(item.id)) });
  assert.deepEqual(deleted.assetBindings, []);
  const items = structuredClone(base.content.items.filter(item => item.id !== 'dialogue_1'));
  Object.assign(items[0], { kind: 'dialogue', label: '门开了。', sourceRefs: [f.evidence('门开了。')], classification: 'quotation', speakerId: null });
  const quotation = applyNovelCorrections(base, f.source, f.chapter, { expectedRevisionId: base.id, items });
  assert.deepEqual(quotation.assetBindings, []);
  assert.deepEqual(base, before);
});

test('binding edits preserve source and another chapter; quote supplementation preserves snapshots', () => {
  const f = fixture();
  const second = { ...f.revision, id: 'second_revision', chapterId: f.source.chapters[1].id,
    content: { items: [{ ...f.revision.content.items[0], id: 'chapter_2_character', label: '沈雨', sourceRefs: [f.evidence('沈雨')] }], warnings: [] } };
  const before = structuredClone({ source: f.source, second });
  const base = linked(f);
  const result = supplementNovelQuotes(base.content, f.source, f.chapter);
  assert.deepEqual(result.assetBindings, base.content.assetBindings);
  assert.deepEqual({ source: f.source, second }, before);
  validateNovelContent(second.content, f.source, f.source.chapters[1]);
});
