const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PostgresDatabase } = require('../dist/db/client');
const { readDatabaseConfig } = require('../dist/db/config');
const { createAssetRecord } = require('@lyra/shared');
const { PostgresAssetRepository } = require('../dist/assets/repository');
const { AssetService } = require('../dist/assets/service');

// Explicit opt-in only: no .env loading, no migrations and no broad cleanup.
const connectionString = process.env.ASSET_TEST_DATABASE_URL;
test('PostgreSQL asset registrations persist independently and reject duplicate overwrite', {
  skip: connectionString ? false : 'Set ASSET_TEST_DATABASE_URL to an isolated database with migration 009 applied.',
}, async () => {
  const database = new PostgresDatabase(readDatabaseConfig({ DATABASE_URL: connectionString }));
  const ids = [];
  try {
    assert.equal(await database.hasMigrations(['009']), true, 'Apply 009 explicitly to the isolated test database first.');
    const repository = new PostgresAssetRepository(database);
    const records = ['character', 'location', 'prop'].map((kind, index) => ({ ...createAssetRecord({ kind,
      name: `asset-db-test-${kind}-😀`, description: 'Test-owned immutable HTTPS registration.',
      resourceUrl: `https://example.org/test/${kind}.png?version=1` }), createdAt: `2026-10-2${index}T00:00:00.000Z` }));
    for (const record of records) {
      assert.deepEqual(await repository.create(record), record);
      ids.push(record.id);
    }
    const refreshed = new PostgresAssetRepository(database);
    for (const record of records) assert.deepEqual(await refreshed.get(record.id), record);
    const ownRecords = (await refreshed.list()).filter(record => ids.includes(record.id));
    assert.deepEqual(ownRecords, [...records].reverse());
    await assert.rejects(refreshed.create({ ...records[0], description: 'must not overwrite' }), error => error.code === 'ASSET_ALREADY_EXISTS');
    assert.deepEqual(await refreshed.get(records[0].id), records[0]);
    const invalid = { ...createAssetRecord({ kind: 'prop', name: 'invalid', description: '', resourceUrl: 'https://example.org/a' }),
      resourceUrl: 'http://example.org/a' };
    await assert.rejects(refreshed.create(invalid), error => error.code === 'INVALID_ASSET_INPUT');
    assert.equal(await refreshed.get(invalid.id), null);
    // The DB allows text types; re-read still checks full URL safety and fails closed.
    await database.query('UPDATE asset_catalog SET resource_url = $1 WHERE id = $2', ['https://account:private@example.org/a', records[1].id]);
    await assert.rejects(refreshed.get(records[1].id), error => error.code === 'ASSET_STORED_DATA_INVALID');
  } finally {
    for (const id of ids) await database.query('DELETE FROM asset_catalog WHERE id = $1', [id]);
    await database.close();
  }
});

test('PostgreSQL local images persist bytes, retry idempotently, and remain loadable in a fresh service', {
  skip: connectionString ? false : 'Set ASSET_TEST_DATABASE_URL to an isolated database with migration 010 applied.',
}, async () => {
  const database = new PostgresDatabase(readDatabaseConfig({ DATABASE_URL: connectionString }));
  let id;
  try {
    assert.equal(await database.hasMigrations(['009', '010']), true, 'Apply 010 explicitly to the isolated database first.');
    const bytes = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
    const payload = { kind: 'prop', name: `local-media-db-${require('node:crypto').randomUUID()}`, description: 'Test-owned local media', contentBase64: bytes.toString('base64') };
    const service = new AssetService(new PostgresAssetRepository(database));
    const asset = await service.importImage(payload); id = asset.id;
    const refreshed = new AssetService(new PostgresAssetRepository(database));
    assert.deepEqual(await refreshed.importImage(payload), asset);
    assert.deepEqual(await refreshed.get(id), asset);
    assert.deepEqual((await refreshed.content(id)).bytes, bytes);
    const count = await database.query('SELECT count(*)::int AS count FROM asset_media WHERE asset_id = $1', [id]);
    assert.equal(count.rows[0].count, 1);
  } finally {
    if (id) await database.query('DELETE FROM asset_catalog WHERE id = $1', [id]);
    await database.close();
  }
});
