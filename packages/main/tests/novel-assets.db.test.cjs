const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PostgresDatabase } = require('../dist/db/client');
const { readDatabaseConfig } = require('../dist/db/config');
const { readConfig } = require('../dist/config');
const { PostgresAssetRepository } = require('../dist/assets/repository');
const { AssetService } = require('../dist/assets/service');
const { PostgresNovelRepository } = require('../dist/novel/repository');
const { NovelService } = require('../dist/novel/service');

// Dedicated, explicitly migrated test database only. Do not load .env, run a
// migration, fetch media, call a model, or clean records outside this test.
const connectionString = process.env.ASSET_TEST_DATABASE_URL;
const RAW = '第一章 灯塔\n阿澄站在灯塔前，手里拿着铜钥匙。😀\n阿澄说：“等雨停。”\n第二章 旧桥\n夏禾在旧桥边折纸船。\n“明天再来。”\n';

test('PostgreSQL novel asset snapshots survive reload, chapter-local corrections and competing saves', {
  skip: connectionString ? false : 'Set ASSET_TEST_DATABASE_URL to an isolated database with migrations 008 and 009 applied.',
}, async () => {
  const database = new PostgresDatabase(readDatabaseConfig({ DATABASE_URL: connectionString }));
  let documentId;
  const assetIds = [];
  let networkCalls = 0;
  const noNetwork = async () => {
    networkCalls += 1;
    throw new Error('Novel asset registration and proofreading must not call a model or fetch media.');
  };
  const services = () => {
    const repository = new PostgresNovelRepository(database);
    const assets = new AssetService(new PostgresAssetRepository(database));
    return { repository, assets, novel: new NovelService(repository, readConfig({}), noNetwork, assets) };
  };
  try {
    assert.equal(await database.hasMigrations(['008', '009']), true,
      'Apply 008 and 009 explicitly to the isolated test database before running this test.');
    const first = services();
    const source = await first.novel.create({ title: `novel-assets-db-test-${randomUUID()}`, rawText: RAW });
    documentId = source.id;
    const [chapter, otherChapter] = source.chapters;
    const seed = await first.novel.seed(chapter.id, { expectedRevisionId: null });
    const otherSeed = await first.novel.seed(otherChapter.id, { expectedRevisionId: null });
    const entity = (id, kind, label) => ({ id, kind, label, description: '',
      sourceRefs: [evidence(source, '阿澄站在灯塔前，手里拿着铜钥匙。😀')],
      speakerId: null, classification: null, uncertainty: null, review: 'confirmed', origin: 'user' });
    const entities = [entity('character_test', 'character', '阿澄'), entity('location_test', 'location', '灯塔'),
      entity('prop_test', 'prop', '铜钥匙')];
    const confirmed = await first.novel.correct(seed.id, { expectedRevisionId: seed.id,
      items: [...structuredClone(seed.content.items), ...entities] });
    assert.deepEqual(confirmed.content.items.filter(item => item.kind !== 'dialogue').map(item => item.review),
      ['confirmed', 'confirmed', 'confirmed']);

    const catalog = [];
    for (const item of entities) {
      const asset = await first.assets.create({ kind: item.kind, name: `测试用${item.label}素材`,
        description: '测试拥有的素材登记，不代表原文外貌或已验证媒体。', resourceUrl: `https://example.org/test/${item.kind}.png` });
      assetIds.push(asset.id);
      catalog.push(asset);
    }
    const partlyBound = await first.novel.bindAssets(confirmed.id, { expectedRevisionId: confirmed.id,
      bindings: [selection(entities[0], catalog[0]), selection(entities[1], catalog[1]),
        { itemId: entities[2].id, status: 'missing', assetId: null, note: '先保留待补，稍后人工选择。' }] });
    assert.deepEqual(partlyBound.content.items, confirmed.content.items);
    assert.deepEqual(partlyBound.content.assetBindings[2], { itemId: entities[2].id, status: 'missing',
      asset: null, note: '先保留待补，稍后人工选择。' });

    // New service/repository instances must read from persistent state, not the
    // instances that created the source, catalogue or bindings.
    const reopened = services();
    assert.deepEqual(await reopened.repository.getRevision(partlyBound.id), partlyBound);
    assert.deepEqual((await reopened.novel.revisions(chapter.id)).map(value => value.id),
      [seed.id, confirmed.id, partlyBound.id]);
    const allBound = await reopened.novel.bindAssets(partlyBound.id, { expectedRevisionId: partlyBound.id,
      bindings: [selection(entities[2], catalog[2])] });
    assert.deepEqual(allBound.content.assetBindings.map(binding => binding.asset), catalog);
    assert.deepEqual(allBound.content.assetBindings.map(binding => binding.status), ['linked', 'linked', 'linked']);
    for (const item of allBound.content.items) {
      for (const ref of item.sourceRefs) {
        assert.equal(Array.from(RAW).slice(ref.start, ref.end).join(''), ref.quote);
      }
    }
    assert.deepEqual(await services().repository.getRevision(allBound.id), allBound);

    const history = [seed, confirmed, partlyBound, allBound].map(value => structuredClone(value));
    const editedItems = structuredClone(allBound.content.items);
    editedItems.find(item => item.id === entities[0].id).description = '重新校对：原文只明确他持有钥匙。';
    const edited = await reopened.novel.correct(allBound.id, { expectedRevisionId: allBound.id, items: editedItems });
    const changedBinding = edited.content.assetBindings.find(binding => binding.itemId === entities[0].id);
    assert.equal(changedBinding.status, 'needsReview');
    assert.deepEqual(changedBinding.asset, catalog[0], 'Keep the old choice for review, not as an active verified binding.');
    assert.deepEqual(edited.content.assetBindings.slice(1), allBound.content.assetBindings.slice(1));
    history.push(structuredClone(edited));

    // Binding and proofreading compete for the same chapter head. Exactly one
    // may append a revision; neither may silently overwrite the winner.
    const competingItems = structuredClone(edited.content.items);
    competingItems.find(item => item.id === entities[1].id).description = '校对补充：地点只依据本章文字。';
    const competitors = await Promise.allSettled([
      services().novel.bindAssets(edited.id, { expectedRevisionId: edited.id,
        bindings: [selection(entities[0], catalog[0], '重新确认已有素材')] }),
      services().novel.correct(edited.id, { expectedRevisionId: edited.id, items: competingItems }),
    ]);
    const winner = singleWinner(competitors);
    assert.equal(winner.parentRevisionId, edited.id);
    history.push(structuredClone(winner));
    assert.equal((await services().novel.get(source.id)).chapters[0].latestRevisionId, winner.id);

    // Two simultaneous asset-only changes obey the same CAS rule.
    const bindingCompetitors = await Promise.allSettled([
      services().novel.bindAssets(winner.id, { expectedRevisionId: winner.id,
        bindings: [selection(entities[2], catalog[2], '候选选择 A')] }),
      services().novel.bindAssets(winner.id, { expectedRevisionId: winner.id,
        bindings: [selection(entities[2], catalog[2], '候选选择 B')] }),
    ]);
    const latest = singleWinner(bindingCompetitors);
    assert.equal(latest.parentRevisionId, winner.id);
    history.push(structuredClone(latest));

    const finalRead = services();
    assert.deepEqual(await finalRead.novel.revisions(chapter.id), history, 'Every old snapshot remains byte-for-byte unchanged.');
    for (const original of history) assert.deepEqual(await finalRead.repository.getRevision(original.id), original);
    assert.deepEqual(await finalRead.novel.revisions(otherChapter.id), [otherSeed]);
    const storedSource = await finalRead.novel.get(source.id);
    assert.equal(storedSource.rawText, RAW);
    assert.equal(storedSource.contentSha256, source.contentSha256);
    assert.deepEqual(storedSource.chapters.map(value => ({ ...value, latestRevisionId: null })), source.chapters);
    assert.deepEqual(storedSource.chapters.map(value => value.latestRevisionId), [latest.id, otherSeed.id]);
    await assert.rejects(finalRead.novel.bindAssets(allBound.id, { expectedRevisionId: allBound.id,
      bindings: [selection(entities[0], catalog[0], '迟到的旧页面')] }), error => error.code === 'NOVEL_REVISION_CONFLICT');
    assert.deepEqual(await finalRead.novel.attempts(chapter.id), []);
    assert.deepEqual(await finalRead.novel.attempts(otherChapter.id), []);
    assert.equal(networkCalls, 0);
  } finally {
    try {
      if (documentId) await database.query('DELETE FROM novel_sources WHERE id = $1', [documentId]);
      for (const id of assetIds) await database.query('DELETE FROM asset_catalog WHERE id = $1', [id]);
    } finally { await database.close(); }
  }
});

function evidence(source, quote) {
  const offset = source.rawText.indexOf(quote);
  assert.notEqual(offset, -1);
  const start = Array.from(source.rawText.slice(0, offset)).length;
  return { documentId: source.id, start, end: start + Array.from(quote).length, quote };
}
function selection(item, asset, note = '人工选择已有素材') {
  return { itemId: item.id, status: 'linked', assetId: asset.id, note };
}
function singleWinner(results) {
  const passed = results.filter(value => value.status === 'fulfilled');
  const rejected = results.filter(value => value.status === 'rejected');
  assert.equal(passed.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'NOVEL_REVISION_CONFLICT');
  return passed[0].value;
}
