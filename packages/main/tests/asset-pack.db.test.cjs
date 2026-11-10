const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  ASSET_PACK_SCHEMA_VERSION, assetPackContentDigest, parseAssetPackVersion,
} = require('@lyra/shared');
const { PostgresDatabase } = require('../dist/db/client');
const { readDatabaseConfig } = require('../dist/db/config');
const { PostgresAssetPackRepository } = require('../dist/assets/asset-pack-repository');
const { LEGACY_WORKSPACE_ID } = require('../dist/tenancy/context');

const connectionString = process.env.ASSET_TEST_DATABASE_URL || process.env.DATABASE_URL;
const TEST_USER = `usr_${'a'.repeat(32)}`;
const TEST_WORKSPACE = `ws_${'a'.repeat(32)}`;

function id(prefix) { return `${prefix}${randomUUID().replaceAll('-', '')}`; }
function media(view = 'front', state = null, role = 'view') {
  return { mediaId: id('apm_'), role, view, state, objectId: id('object_'),
    objectVersionId: id('objver_'), checksum: 'a'.repeat(64), sizeBytes: 128, contentType: 'image/png',
    crop: null, qualityStatus: 'pass', provenance: { source: 'generated', provider: 'seedream', sourceRef: null } };
}
function pack(overrides = {}) {
  const base = { schemaVersion: ASSET_PACK_SCHEMA_VERSION, id: id('apv_'), workspaceId: overrides.workspaceId ?? TEST_WORKSPACE,
    projectScope: 'workspace', projectId: null, kind: 'character', logicalAssetId: `character_db_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
    version: 1, parentVersionId: null, displayName: '林澜', aliases: ['澜姐'], description: '冷傲女总裁',
    tags: ['都市'], sourceType: 'generated', sourceRefs: ['script:1'], license: 'internal',
    authorizationStatus: 'allowed', authorizationReason: null, reviewStatus: 'approved',
    reviewedBy: overrides.createdBy ?? TEST_USER, reviewedAt: '2026-11-01T00:00:00.000Z',
    validFrom: '2026-11-01T00:00:00.000Z', validUntil: null, allowedUsages: ['production'],
    restrictedProjects: [], mediaEntries: [media('front')], status: 'adopted',
    createdBy: overrides.createdBy ?? TEST_USER, createdAt: '2026-11-01T00:00:00.000Z' };
  Object.assign(base, overrides);
  base.contentDigest = assetPackContentDigest(base);
  return parseAssetPackVersion(base);
}

test('PostgreSQL asset pack versions are immutable, tenant-scoped and idempotent', {
  skip: connectionString ? false : 'Set ASSET_TEST_DATABASE_URL (migration 051 applied) to run this test.',
}, async () => {
  const database = new PostgresDatabase(readDatabaseConfig({ DATABASE_URL: connectionString }));
  try {
    assert.equal(await database.hasMigrations(['051']), true, 'Apply migration 051 explicitly first.');
    await database.query(`INSERT INTO users (id,subject,display_name,kind,status,created_at,updated_at)
      VALUES ($1,$2,$3,'human','active',now(),now()) ON CONFLICT (id) DO NOTHING`,
      [TEST_USER, `asset-pack-test-${TEST_USER}`, '资产包测试用户']);
    await database.query(`INSERT INTO workspaces (id,slug,name,status,created_by_user_id,created_at,updated_at)
      VALUES ($1,$2,$3,'active',$4,now(),now()) ON CONFLICT (id) DO NOTHING`,
      [TEST_WORKSPACE, 'asset-pack-test-ws', '资产包测试工作区', TEST_USER]);
    const repository = new PostgresAssetPackRepository(database);
    const first = pack({ mediaEntries: [media('back'), media('front'), media('side_left')] });
    const created = await database.runWithTenant({ userId: TEST_USER,
      workspaceId: TEST_WORKSPACE, role: 'owner', requestId: 'asset-pack-db-test:0001' },
    async () => repository.create(first));
    assert.equal(created.id, first.id);
    assert.equal(created.mediaEntries.length, 3);
    const reread = await database.runWithTenant({ userId: TEST_USER,
      workspaceId: TEST_WORKSPACE, role: 'owner', requestId: 'asset-pack-db-test:0002' },
    async () => repository.get(TEST_WORKSPACE, first.id));
    assert.equal(reread.contentDigest, first.contentDigest);

    const second = pack({ id: id('apv_'), version: 2, parentVersionId: first.id,
      logicalAssetId: first.logicalAssetId });
    await database.runWithTenant({ userId: TEST_USER, workspaceId: TEST_WORKSPACE,
      role: 'owner', requestId: 'asset-pack-db-test:0003' }, async () => repository.create(second));
    const adoption = { workspaceId: TEST_WORKSPACE, adoptionId: id('apa_'),
      logicalAssetId: first.logicalAssetId, versionId: second.id, adoptedBy: TEST_USER,
      reason: '导演确认', createdAt: '2026-11-02T00:00:00.000Z' };
    await database.runWithTenant({ userId: TEST_USER, workspaceId: TEST_WORKSPACE,
      role: 'owner', requestId: 'asset-pack-db-test:0004' }, async () => repository.adopt(adoption));
    const latest = await database.runWithTenant({ userId: TEST_USER,
      workspaceId: TEST_WORKSPACE, role: 'owner', requestId: 'asset-pack-db-test:0005' },
    async () => repository.latestAdopted(TEST_WORKSPACE, first.logicalAssetId));
    assert.equal(latest.id, second.id);

    await assert.rejects(database.query('UPDATE asset_pack_versions SET display_name=$1 WHERE version_id=$2',
      ['不可变测试', first.id]), error => String(error.code) === '23514' && String(error.message).includes('ASSET_PACK_IMMUTABLE'));
    const rls = await database.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('asset_pack_versions','asset_pack_media','asset_pack_adoptions')
      ORDER BY c.relname`);
    assert.equal(rls.rows.length, 3);
    assert.ok(rls.rows.every(row => row.relrowsecurity === true && row.relforcerowsecurity === true));
    const policies = await database.query(`SELECT count(*)::int AS count FROM pg_policies
      WHERE schemaname='public' AND tablename IN ('asset_pack_versions','asset_pack_media','asset_pack_adoptions')
      AND policyname='lyra_workspace_isolation'`);
    assert.equal(policies.rows[0].count, 3);
  } finally {
    await database.close();
  }
});
