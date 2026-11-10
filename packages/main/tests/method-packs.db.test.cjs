const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { PostgresDatabase } = require('../dist/db/client');
const { PostgresMethodPackRepository } = require('../dist/method-packs/postgres-repository');
const { MethodPackService } = require('../dist/method-packs/service');

const connectionString = process.env.DATABASE_URL;
const adminConnectionString = process.env.DATABASE_ADMIN_URL;

test('method pack governance persists admission, validation, adoption and immutable run snapshot', {
  skip: connectionString ? false : 'DATABASE_URL is required',
}, async t => {
  const suffix = randomBytes(16).toString('hex');
  const workspaceId = `ws_${suffix}`;
  const userId = `usr_${randomBytes(16).toString('hex')}`;
  const projectId = `project_${suffix}`;
  const database = new PostgresDatabase({ connectionString }, { unscopedAccess: 'deny' });
  const repository = new PostgresMethodPackRepository(database);
  const service = new MethodPackService(repository);
  const tenant = { workspaceId, userId, role: 'owner', requestId: `method-db:${suffix}` };
  const at = new Date().toISOString();

  t.after(async () => {
    await database.close().catch(() => undefined);
    const admin = adminConnectionString ? new Client({ connectionString: adminConnectionString }) : null;
    if (admin) await admin.connect().catch(() => undefined);
    const cleanup = admin ?? database;
    try {
      if (admin) await admin.query('SET session_replication_role = replica');
      await cleanup.query('DELETE FROM project_method_bindings WHERE workspace_id = $1', [workspaceId]).catch(() => undefined);
      await cleanup.query('DELETE FROM project_method_profile_revisions WHERE workspace_id = $1', [workspaceId]).catch(() => undefined);
      await cleanup.query('DELETE FROM workspace_method_pack_access WHERE workspace_id = $1', [workspaceId]).catch(() => undefined);
      await cleanup.query('DELETE FROM method_pack_versions WHERE workspace_id = $1', [workspaceId]).catch(() => undefined);
      await cleanup.query('DELETE FROM method_packs WHERE workspace_id = $1', [workspaceId]).catch(() => undefined);
      await cleanup.query('DELETE FROM projects WHERE workspace_id = $1', [workspaceId]).catch(() => undefined);
      await cleanup.query('DELETE FROM workspace_members WHERE workspace_id = $1', [workspaceId]).catch(() => undefined);
      await cleanup.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]).catch(() => undefined);
      await cleanup.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined);
    } finally {
      if (admin) await admin.query('SET session_replication_role = origin').catch(() => undefined);
      await admin?.end().catch(() => undefined);
    }
  });

  await database.runAsSystem('method_pack.db_setup', async () => {
    await database.query(`INSERT INTO users (id, subject, display_name, kind, status, created_at, updated_at)
      VALUES ($1, $2, '方法包 DB 测试', 'human', 'active', $3, $3)`, [userId, `method-db:${suffix}`, at]);
    await database.query(`INSERT INTO workspaces (id, slug, name, status, created_by_user_id, created_at, updated_at)
      VALUES ($1, $2, '方法包 DB 测试', 'active', $3, $4, $4)`, [workspaceId, `method-db-${suffix}`, userId, at]);
    await database.query(`INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
      VALUES ($1, $2, 'owner', 'active', $3, $3)`, [workspaceId, userId, at]);
    await database.query(`INSERT INTO projects (id, workspace_id, title, created_at)
      VALUES ($1, $2, '方法包测试项目', $3)`, [projectId, workspaceId, at]);
  });

  const result = await database.runWithTenant(tenant, async () => {
    const imported = await service.import(tenant, workspaceId, {
      name: '数据库方法包', summary: '真实 PostgreSQL 持久化', version: '1.0.0',
      content: '## script-adaptation\n### 规则\n坚持三幕结构。',
      nodes: ['script-adaptation'], licenseCode: 'MIT', commercialUseAllowed: true,
      qualityStatus: 'evaluated',
    }, `method-db-import-${suffix}`);
    await service.decideAdmission(tenant, workspaceId, imported.version.id, {
      decision: 'approved', reason: 'db integration', expectedStatus: null,
    }, `method-db-admission-${suffix}`);
    const profile = await service.createProfile(tenant, workspaceId, projectId, {
      bindings: [{ node: 'script-adaptation', role: 'primary', packVersionId: imported.version.id, tokenBudget: 8_000 }],
    }, `method-db-profile-${suffix}`);
    const validated = await service.validate(tenant, workspaceId, projectId, profile.id);
    await service.adopt(tenant, workspaceId, projectId, profile.id, {
      expectedVersion: validated.profile.version, expectedDigest: validated.profile.digest,
      clientRequestId: `method-db-adopt-${suffix}`, reason: 'db integration',
    });
    return service.freezeForRun(workspaceId, projectId);
  });

  assert.match(result.profileRevisionId, /^mpr_[a-f0-9]{32}$/);
  assert.match(result.manifestDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.workspaceId, workspaceId);
  assert.equal(result.projectId, projectId);
  assert.equal(result.manifest.profileRevisionId, result.profileRevisionId);
  assert.equal(result.manifest.profileDigest, result.profileDigest);
  assert.deepEqual(result.manifest.nodes.map(node => node.node), ['script-adaptation']);
});
