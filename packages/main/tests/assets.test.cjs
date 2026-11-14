const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AssetError, parseAssetInput, createAssetRecord, validateAssetRecord } = require('@lyra/shared');
const { InMemoryAssetRepository, PostgresAssetRepository } = require('../dist/assets/repository');
const { AssetService } = require('../dist/assets/service');

const input = (changes = {}) => ({ kind: 'character', name: '阿澄立绘', description: '已有素材，仅登记，不作原文事实。',
  resourceUrl: 'https://example.org/media/actor.png?signature=keep%2Fcase', ...changes });
const invalid = error => error instanceof AssetError && error.status === 400 && error.code === 'INVALID_ASSET_INPUT';
const row = record => ({ id: record.id, kind: record.kind, name: record.name, description: record.description,
  resource_url: record.resourceUrl, created_at: new Date(record.createdAt) });

test('asset input trims strings without rewriting a signed URL, and supports only three entity kinds', () => {
  const address = 'HTTPS://Example.org:443/a%2Fb?sig=a%2fb&order=z+a#section';
  assert.deepEqual(parseAssetInput(input({ kind: ' character ', name: ' 阿澄立绘 ', description: '\n说明\t', resourceUrl: ` ${address} ` })),
    input({ description: '说明', resourceUrl: address }));
  for (const kind of ['character', 'location', 'prop']) assert.equal(parseAssetInput(input({ kind })).kind, kind);
  for (const kind of ['dialogue', 'scene', '', null, 1]) assert.throws(() => parseAssetInput(input({ kind })), invalid);
});

test('asset input rejects missing or extra keys, invalid types and overlong Unicode text', () => {
  for (const value of [null, [], 'text', { ...input(), extra: true }, { ...input(), id: 'forged' }]) {
    assert.throws(() => parseAssetInput(value), invalid);
  }
  for (const key of ['kind', 'name', 'description', 'resourceUrl']) {
    const missing = input(); delete missing[key];
    assert.throws(() => parseAssetInput(missing), invalid);
    assert.throws(() => parseAssetInput(input({ [key]: null })), invalid);
  }
  assert.throws(() => parseAssetInput(input({ name: ' \t\n ' })), invalid);
  assert.throws(() => parseAssetInput(input({ name: '字'.repeat(201) })), invalid);
  assert.throws(() => parseAssetInput(input({ description: '字'.repeat(2001) })), invalid);
  assert.throws(() => parseAssetInput(input({ description: 'text\0secret' })), invalid);
  assert.equal(parseAssetInput(input({ name: '😀'.repeat(200), description: '' })).name, '😀'.repeat(200));
});

test('asset URL is HTTPS-only without credentials or parser repairs; nothing is fetched', () => {
  const addresses = [
    'http://example.org/a', 'javascript:alert(1)', 'file:///tmp/a', 'data:image/png,aaaa', '//example.org/a',
    'https://user:secret@example.org/a', 'https://user@example.org/a', 'https://@example.org/a',
    'https:example.org/a', 'https:///example.org/a', 'https://example.org/a b', 'https://example.org/a\nb',
    'https://example.org\\secret', 'https://', 'https://example.org/' + 'x'.repeat(2000),
  ];
  for (const resourceUrl of addresses) assert.throws(() => parseAssetInput(input({ resourceUrl })), invalid, resourceUrl);
  // The fragment and query are references, not requests; public availability is deliberately not claimed.
  assert.equal(parseAssetInput(input({ resourceUrl: 'https://example.org/path?x=1#note' })).resourceUrl,
    'https://example.org/path?x=1#note');
});

test('asset strings reject unpaired UTF-16 surrogates before UTF-8 persistence without rejecting emoji', () => {
  for (const malformed of ['\ud800', '\udfff', '\ud800x', 'x\udc00', '\ud800\ud800\udc00', '\udc00\ud800\udc00']) {
    for (const key of ['name', 'description', 'resourceUrl']) {
      const value = key === 'resourceUrl' ? `https://example.org/${malformed}.png` : `素材${malformed}`;
      assert.throws(() => parseAssetInput(input({ [key]: value })), invalid);
    }
  }
  const valid = input({ name: '人物😀', description: '钥匙🗝️', resourceUrl: 'https://example.org/😀.png' });
  assert.deepEqual(parseAssetInput(valid), valid);
  assert.doesNotThrow(() => validateAssetRecord(createAssetRecord(valid)));
});

test('asset registration creates an immutable-ID snapshot and validates canonical time and metadata', () => {
  const record = createAssetRecord(input());
  assert.match(record.id, /^asset_[a-f0-9]{32}$/);
  assert.equal(new Date(record.createdAt).toISOString(), record.createdAt);
  assert.doesNotThrow(() => validateAssetRecord(record));
  for (const changes of [{ id: 'asset_bad' }, { createdAt: '2026-02-30T00:00:00.000Z' },
    { createdAt: '2026-10-22' }, { createdAt: '2026-10-22T00:00:00Z' }, { name: ' 阿澄 ' },
    { resourceUrl: 'javascript:alert(1)' }, { extra: true }]) {
    assert.throws(() => validateAssetRecord({ ...record, ...changes }), invalid);
  }
});

test('in-memory assets do not overwrite and all return values are detached snapshots', async () => {
  const repository = new InMemoryAssetRepository();
  const record = createAssetRecord(input());
  const id = record.id;
  const original = structuredClone(record);
  const created = await repository.create(record);
  record.name = 'mutated input'; created.description = 'mutated return';
  const read = await repository.get(id);
  assert.deepEqual(read, original);
  read.name = 'mutated read';
  const listed = await repository.list(); listed[0].resourceUrl = 'https://example.org/changed'; listed.pop();
  assert.deepEqual(await repository.get(id), original);
  await assert.rejects(repository.create({ ...original, name: 'overwrite' }), error => error.code === 'ASSET_ALREADY_EXISTS');
  assert.deepEqual(await repository.get(id), original);
  assert.equal(await repository.get('missing'), null);
  // 元数据编辑与图片替换由受控接口提供（见 asset-update.test.cjs）；仍不提供删除。
  assert.equal(typeof repository.delete, 'undefined');
});

test('catalogue sorting is deterministic by newest createdAt and then ID, not insertion or locale', async () => {
  const repository = new InMemoryAssetRepository();
  const first = { ...createAssetRecord(input()), id: 'asset_' + '1'.repeat(32), createdAt: '2026-10-21T00:00:00.000Z' };
  const second = { ...createAssetRecord(input()), id: 'asset_' + '2'.repeat(32), createdAt: '2026-10-22T00:00:00.000Z' };
  const third = { ...createAssetRecord(input()), id: 'asset_' + '0'.repeat(32), createdAt: second.createdAt };
  for (const record of [first, second, third]) await repository.create(record);
  assert.deepEqual((await repository.list()).map(record => record.id), [third.id, second.id, first.id]);
});

test('asset service creates and finds a registration; unknown IDs are explicit and URLs never call fetch', async () => {
  const savedFetch = global.fetch;
  global.fetch = () => { throw new Error('A catalogue operation must never fetch remote media.'); };
  try {
    const service = new AssetService(new InMemoryAssetRepository());
    const record = await service.create(input({ kind: 'location' }));
    assert.deepEqual(await service.get(record.id), record);
    assert.deepEqual(await service.list(), [record]);
    await assert.rejects(service.get('asset_' + '0'.repeat(32)), error => error.status === 404 && error.code === 'ASSET_NOT_FOUND');
    await assert.rejects(service.get('../unsafe'), error => error.status === 400 && error.code === 'INVALID_ASSET_ID');
    await assert.rejects(service.create(input({ resourceUrl: 'http://example.org/a' })), invalid);
  } finally { global.fetch = savedFetch; }
});

test('PostgreSQL adapter uses parameters, preserves snapshots in flight and validates returned data', async () => {
  const record = createAssetRecord(input({ name: "O'Reilly 立绘" }));
  const original = structuredClone(record);
  const calls = [];
  let release;
  const repository = new PostgresAssetRepository({ query: async (sql, params) => {
    calls.push({ sql, params });
    await new Promise(resolve => { release = resolve; });
    return { rows: [row(original)] };
  } });
  const promise = repository.create(record);
  record.name = 'mutated during query';
  release();
  assert.deepEqual(await promise, original);
  assert.ok(calls[0].sql.startsWith('INSERT INTO asset_catalog'));
  assert.equal(calls[0].sql.includes(original.name), false);
  assert.equal(calls[0].params[2], original.name);
  const corrupted = new PostgresAssetRepository({ query: async () => ({ rows: [row({ ...original, resourceUrl: 'http://example.org/a' })] }) });
  await assert.rejects(corrupted.get(record.id), error => error.code === 'ASSET_STORED_DATA_INVALID');
  await assert.rejects(corrupted.list(), error => error.code === 'ASSET_STORED_DATA_INVALID');
  const corruptedTime = new PostgresAssetRepository({ query: async () => ({ rows: [{ ...row(original), created_at: new Date('invalid') }] }) });
  await assert.rejects(corruptedTime.get(record.id), error => error.code === 'ASSET_STORED_DATA_INVALID');
});

test('script metadata assets reuse same names or aliases and never overwrite existing media', async () => {
  const service = new AssetService(new InMemoryAssetRepository());
  const existing = await service.create(input({ name: '林澈', description: '既有定妆设定' }));
  const reused = await service.createMetadata({ kind: 'character', name: '林澈', aliases: [], description: '模型新描述' });
  const alias = await service.createMetadata({ kind: 'character', name: '阿澈', aliases: ['林澈'], description: '别名描述' });
  assert.equal(reused.id, existing.id);
  assert.equal(alias.id, existing.id);
  assert.equal(reused.description, '既有定妆设定');
  assert.equal(reused.resourceUrl, existing.resourceUrl);

  const created = await service.createMetadata({ kind: 'character', name: '路人甲', aliases: [], description: '远处经过的人' });
  assert.equal(created.resourceUrl, '');
  assert.doesNotThrow(() => validateAssetRecord(created));
  const repeated = await service.createMetadata({ kind: 'character', name: ' 路人 甲 ', aliases: [], description: '不会覆盖' });
  assert.equal(repeated.id, created.id);
  assert.equal(repeated.description, created.description);
  const location = await service.createMetadata({ kind: 'location', name: '路人甲', aliases: [], description: '' });
  assert.notEqual(location.id, created.id);
});

test('PostgreSQL driver details never escape catalogue errors and duplicate create is a conflict', async () => {
  for (const code of ['23505', 'ECONNREFUSED', '42P01']) {
    const repository = new PostgresAssetRepository({ query: async () => { throw { code, message: 'secret endpoint password raw SQL', detail: 'private-url' }; } });
    const expected = code === '23505' ? 'ASSET_ALREADY_EXISTS' : 'ASSET_PERSISTENCE_UNAVAILABLE';
    await assert.rejects(repository.create(createAssetRecord(input())), error => error instanceof AssetError
      && error.code === expected && !/secret|password|private-url|raw SQL/.test(error.message));
  }
});
