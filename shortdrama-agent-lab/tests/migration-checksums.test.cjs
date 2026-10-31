const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { acceptsRecordedChecksum, normalizeMigrationSql, readMigrations } = require('../dist/db/migrate');
const hash = sql => createHash('sha256').update(sql, 'utf8').digest('hex');
const sql = normalizeMigrationSql(readFileSync(join(__dirname, '../migrations/003_extract_facts_execution.sql'), 'utf8'));
const current = hash(sql);
const legacy = '4164f2cc048e8e4df705fe156577eaf3716dd72303d687c2f308c15fa707a780';
const migration = { version: '003', fileName: '003_extract_facts_execution.sql', sql, checksum: current };

test('003 compatibility is proven to be exactly one additional trailing LF', () => {
  assert.equal(current, '83957719239e47e6ea3ced16f0747ca80ccc5de2eb2c6690d7ec6ab7acca68c9');
  assert.equal(hash(sql + '\n'), legacy);
  assert.equal(acceptsRecordedChecksum(migration, current), true);
  assert.equal(acceptsRecordedChecksum(migration, legacy), true);
  assert.equal(acceptsRecordedChecksum({ ...migration, sql: sql + '\n', checksum: legacy }, current), true);
});

test('CRLF migrations fold to the LF checksum and still reject other edits', async t => {
  const crlf = sql.replace(/\n/g, '\r\n');
  assert.notEqual(crlf, sql);
  assert.equal(normalizeMigrationSql(crlf), sql);
  assert.equal(hash(normalizeMigrationSql(crlf)), current);
  const changed = normalizeMigrationSql(crlf.replace('CREATE TABLE', 'CREATE UNLOGGED TABLE'));
  assert.equal(acceptsRecordedChecksum({ ...migration, sql: changed, checksum: hash(changed) }, current), false);

  const dir = await mkdtemp(join(tmpdir(), 'ohao-migration-crlf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, '020_crlf_only.sql'), 'SELECT 1;\r\n');
  const [loaded] = await readMigrations(dir);
  assert.equal(loaded.sql, 'SELECT 1;\n');
  assert.equal(loaded.checksum, hash('SELECT 1;\n'));
  assert.equal(loaded.version, '020');
});

test('the exception cannot mask changed SQL, other versions, names or unknown checksums', () => {
  for (const changed of [sql + '\n\n', sql + '\nSELECT 1;', sql.replace('CREATE TABLE', 'CREATE UNLOGGED TABLE')]) {
    assert.equal(acceptsRecordedChecksum({ ...migration, sql: changed, checksum: hash(changed) }, legacy), false);
    assert.equal(acceptsRecordedChecksum({ ...migration, sql: changed }, legacy), false);
  }
  assert.equal(acceptsRecordedChecksum({ ...migration, version: '004' }, legacy), false);
  assert.equal(acceptsRecordedChecksum({ ...migration, fileName: '003_other.sql' }, legacy), false);
  assert.equal(acceptsRecordedChecksum(migration, hash('unknown')), false);
  const ordinary = { version: '009', fileName: '009_novel_assets.sql', sql: 'SELECT 1;', checksum: hash('SELECT 1;') };
  assert.equal(acceptsRecordedChecksum(ordinary, ordinary.checksum), true);
  assert.equal(acceptsRecordedChecksum(ordinary, current), false);
});

test('012 releases unknown from the global slot without weakening per-job idempotency', () => {
  const original = readFileSync(join(__dirname, '../migrations/011_desktop_asset_jobs.sql'), 'utf8');
  const release = readFileSync(join(__dirname, '../migrations/012_release_unknown_asset_slot.sql'), 'utf8');
  assert.match(original, /job_key CHAR\(64\) NOT NULL UNIQUE/);
  assert.match(release, /DROP INDEX desktop_asset_single_active;/);
  const index = release.match(/CREATE UNIQUE INDEX desktop_asset_single_active[\s\S]*?;/)?.[0];
  assert.ok(index, '012 must recreate the single-active partial index');
  for (const state of ['queued', 'submitting', 'generating', 'importing']) assert.match(index, new RegExp(`'${state}'`));
  assert.doesNotMatch(index, /'unknown'/);
});

test('013 persists review candidates and adds review-only task states without weakening the paid-work slot', () => {
  const sql = readFileSync(join(__dirname, '../migrations/013_asset_generation_candidates.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE asset_generation_candidates/);
  for (const column of ['task_id', 'asset_id', 'chapter_id', 'item_id', 'status', 'version', 'provenance_json', 'accepted_revision_id']) {
    assert.match(sql, new RegExp(`\\b${column}\\b`));
  }
  for (const state of ['awaitingReview', 'accepted', 'rejected', 'needsReview']) assert.match(sql, new RegExp(`'${state}'`));
  assert.match(sql, /asset_generation_candidate_item_status_idx/);
  assert.match(sql, /asset_generation_candidate_task_version_idx/);
  assert.doesNotMatch(sql, /CREATE UNIQUE INDEX desktop_asset_single_active/);
});
