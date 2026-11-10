const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { PostgresDatabase } = require('../dist/db/client');
const { PostgresMethodPackRepository } = require('../dist/method-packs/postgres-repository');
const { MethodPackService } = require('../dist/method-packs/service');

const connectionString = process.env.DATABASE_URL;
const adminConnectionString = process.env.DATABASE_ADMIN_URL;

test('method pack catalog isolates private packs between workspaces under RLS', {
  skip: connectionString ? false : 'DATABASE_URL is required',
}, async t => {
  const suffix = randomBytes(16).toString('hex');
  const workspaceA = `ws_${suffix}`;
  const workspaceB = `ws_${suffix.split('').reverse().join('')}`;
  const userA = `usr_${randomBytes(16).toString('hex')}`;
  const userB = `usr_${randomBytes(16).toString('hex')}`;
  const database = new PostgresDatabase({ connectionString }, { unscopedAccess: 'deny' });
  const service = new MethodPackService(new PostgresMethodPackRepository(database));
  const at = new Date().toISOString();

  t.after(async () => {
    await database.close().catch(() => undefined);
    if (!adminConnectionString) return;
    const admin = new Client({ connectionString: adminConnectionString });
    await admin.connect();
    try {
      await admin.query('SET session_replication_role = replica');
      await admin.query('DELETE FROM method_pack_versions WHERE workspace_id = ANY($1)', [[workspaceA, workspaceB]]).catch(() => undefined);
      await admin.query('DELETE FROM method_packs WHERE workspace_id = ANY($1)', [[workspaceA, workspaceB]]).catch(() => undefined);
      await admin.query('DELETE FROM workspace_members WHERE workspace_id = ANY($1)', [[workspaceA, workspaceB]]).catch(() => undefined);
      await admin.query('DELETE FROM workspaces WHERE id = ANY($1)', [[workspaceA, workspaceB]]).catch(() => undefined);
      await admin.query('DELETE FROM users WHERE id = ANY($1)', [[userA, userB]]).catch(() => undefined);
    } finally {
      await admin.query('SET session_replication_role = origin').catch(() => undefined);
      await admin.end();
    }
  });

  await database.runAsSystem('method_pack.rls_setup', async () => {
    await database.query(`INSERT INTO users (id, subject, display_name, kind, status, created_at, updated_at)
      VALUES ($1, $2, '方法包 RLS A', 'human', 'active', $5, $5), ($3, $4, '方法包 RLS B', 'human', 'active', $5, $5)`,
    [userA, `method-rls:${suffix}:a`, userB, `method-rls:${suffix}:b`, at]);
    await database.query(`INSERT INTO workspaces (id, slug, name, status, created_by_user_id, created_at, updated_at)
      VALUES ($1, $2, '方法包 RLS A', 'active', $3, $7, $7), ($4, $5, '方法包 RLS B', 'active', $6, $7, $7)`,
    [workspaceA, `method-rls-${suffix}-a`, userA, workspaceB, `method-rls-${suffix}-b`, userB, at]);
    await database.query(`INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
      VALUES ($1, $2, 'owner', 'active', $5, $5), ($3, $4, 'owner', 'active', $5, $5)`,
    [workspaceA, userA, workspaceB, userB, at]);
  });

  const actorA = { workspaceId: workspaceA, userId: userA, role: 'owner', requestId: `method-rls:${suffix}:a` };
  const actorB = { workspaceId: workspaceB, userId: userB, role: 'owner', requestId: `method-rls:${suffix}:b` };
  const imported = await database.runWithTenant(actorA, () => service.import(actorA, workspaceA, {
    name: 'A 工作区私有方法包', summary: 'RLS', version: '1.0.0',
    content: '## script-adaptation\n### 规则\nA 规则。',
    nodes: ['script-adaptation'], licenseCode: 'MIT', commercialUseAllowed: true, qualityStatus: 'evaluated',
  }, `method-rls-import-${suffix}`));

  const seenByB = await database.runWithTenant(actorB, () =>
    database.query('SELECT id FROM method_packs WHERE id = $1', [imported.pack.id]));
  assert.equal(seenByB.rowCount, 0, 'B 工作区不能读取 A 工作区的私有方法包');

  const seenByA = await database.runWithTenant(actorA, () =>
    database.query('SELECT id FROM method_packs WHERE id = $1', [imported.pack.id]));
  assert.equal(seenByA.rowCount, 1, 'A 工作区必须能读取自己的私有方法包');

  await database.runWithTenant(actorA, async () => {
    await assert.rejects(
      database.query(`INSERT INTO method_packs
        (id, name, summary, origin, workspace_id, created_by, created_at, client_request_id)
        VALUES ($1, 'cross', 'cross', 'workspace_import', $2, $3, $4, $5)`,
      [`mpk_cross-${suffix}`, workspaceB, userA, at, `method-rls-cross-${suffix}`]),
      error => String(error.message).includes('LYRA_CROSS_TENANT_WRITE_DENIED'),
    );
  });

  // B 不能把版本写进 A 的 pack：版本 workspace_id 写 B 不能绕过归属校验。
  await database.runWithTenant(actorB, async () => {
    await assert.rejects(
      database.query(`INSERT INTO method_pack_versions
        (id, pack_id, workspace_id, version, content, content_digest, manifest_json, manifest_digest,
         license_code, commercial_use_allowed, quality_status, approval_status, compatibility_json, nodes_json,
         created_by, created_at)
        VALUES ($1, $2, $3, '1.0.0', 'A 规则', $4, '{}'::jsonb, $4, 'MIT', true, 'evaluated', 'published',
                '{}'::jsonb, '["script-adaptation"]'::jsonb, $5, $6)`,
      [`mpv_${'0'.repeat(32)}`, imported.pack.id, workspaceB, 'e'.repeat(64), userB, at]),
      error => /LYRA_CROSS_TENANT_WRITE_DENIED|METHOD_PACK_NOT_FOUND/u.test(error.message),
    );
  });
});
