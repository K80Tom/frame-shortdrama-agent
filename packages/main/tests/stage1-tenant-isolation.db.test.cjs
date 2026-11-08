const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { PostgresDatabase } = require('../dist/db/client');
const { PostgresJobQueueRepository } = require('../dist/jobs/repository');

const applicationConnectionString = process.env.DATABASE_URL;
const administratorConnectionString = process.env.DATABASE_ADMIN_URL;
const token = () => randomBytes(16).toString('hex');

function tenant(userId, workspaceId, requestId) {
  return { userId, workspaceId, role: 'owner', requestId };
}

function jobInput(label, at) {
  return {
    queueName: 'rls_test',
    kind: 'tenant.isolation_probe',
    aggregateType: 'tenant_probe',
    aggregateId: `probe:${label}`,
    idempotencyKey: `tenant-isolation:${label}`,
    payload: { label },
    availableAt: at,
  };
}

test('non-privileged application role enforces unscoped and cross-workspace RLS', {
  skip: applicationConnectionString && administratorConnectionString
    ? false : 'DATABASE_URL and DATABASE_ADMIN_URL are required',
}, async t => {
  const administrator = new Client({ connectionString: administratorConnectionString });
  await administrator.connect();
  const suffixA = token();
  const suffixB = token();
  const userA = `usr_${suffixA}`;
  const userB = `usr_${suffixB}`;
  const workspaceA = `ws_${suffixA}`;
  const workspaceB = `ws_${suffixB}`;
  const requestA = `rls-test:${suffixA}`;
  const requestB = `rls-test:${suffixB}`;
  const createdAt = new Date().toISOString();

  await administrator.query('BEGIN');
  try {
    await administrator.query(`
      INSERT INTO users (id, subject, display_name, kind, status, created_at, updated_at)
      VALUES ($1, $2, 'RLS test A', 'human', 'active', $5, $5),
             ($3, $4, 'RLS test B', 'human', 'active', $5, $5)
    `, [userA, `test:rls:${suffixA}`, userB, `test:rls:${suffixB}`, createdAt]);
    await administrator.query(`
      INSERT INTO workspaces (id, slug, name, status, created_by_user_id, created_at, updated_at)
      VALUES ($1, $2, 'RLS workspace A', 'active', $3, $7, $7),
             ($4, $5, 'RLS workspace B', 'active', $6, $7, $7)
    `, [workspaceA, `rls-a-${suffixA}`, userA, workspaceB, `rls-b-${suffixB}`, userB, createdAt]);
    await administrator.query(`
      INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
      VALUES ($1, $2, 'owner', 'active', $5, $5),
             ($3, $4, 'owner', 'active', $5, $5)
    `, [workspaceA, userA, workspaceB, userB, createdAt]);
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    await administrator.end();
    throw error;
  }

  const database = new PostgresDatabase({ connectionString: applicationConnectionString }, {
    unscopedAccess: 'deny',
  });
  const jobs = new PostgresJobQueueRepository(database);
  t.after(async () => {
    await database.close().catch(() => undefined);
    await administrator.query('DELETE FROM jobs WHERE workspace_id = ANY($1::text[])',
      [[workspaceA, workspaceB]]).catch(() => undefined);
    await administrator.query('DELETE FROM workspace_members WHERE workspace_id = ANY($1::text[])',
      [[workspaceA, workspaceB]]).catch(() => undefined);
    await administrator.query('DELETE FROM workspaces WHERE id = ANY($1::text[])',
      [[workspaceA, workspaceB]]).catch(() => undefined);
    await administrator.query('DELETE FROM users WHERE id = ANY($1::text[])',
      [[userA, userB]]).catch(() => undefined);
    await administrator.end().catch(() => undefined);
  });

  await database.verifyTenantRole();
  const now = new Date(Date.now() + 1_000).toISOString();
  const queuedA = await database.runWithTenant(tenant(userA, workspaceA, requestA), () =>
    jobs.enqueue({ workspaceId: workspaceA }, jobInput(suffixA, now)));
  const queuedB = await database.runWithTenant(tenant(userB, workspaceB, requestB), () =>
    jobs.enqueue({ workspaceId: workspaceB }, jobInput(suffixB, now)));

  const unscoped = await database.query('SELECT id FROM jobs WHERE id = ANY($1::text[])',
    [[queuedA.job.id, queuedB.job.id]]);
  assert.equal(unscoped.rowCount, 0, 'an unscoped API query must see no tenant rows');

  const own = await database.runWithTenant(tenant(userA, workspaceA, requestA), () =>
    jobs.get({ workspaceId: workspaceA }, queuedA.job.id));
  assert.equal(own?.id, queuedA.job.id);
  const crossRead = await database.runWithTenant(tenant(userA, workspaceA, requestA), () =>
    jobs.get({ workspaceId: workspaceB }, queuedB.job.id));
  assert.equal(crossRead, null, 'workspace A must not read a workspace B job even with its exact id');

  await assert.rejects(
    database.runWithTenant(tenant(userA, workspaceA, requestA), () =>
      jobs.enqueue({ workspaceId: workspaceB }, jobInput(`cross-${suffixB}`, now))),
    error => error?.code === '42501',
  );

  const rows = await administrator.query(
    'SELECT workspace_id, id FROM jobs WHERE id = ANY($1::text[]) ORDER BY workspace_id',
    [[queuedA.job.id, queuedB.job.id]],
  );
  assert.equal(rows.rowCount, 2, 'the administrator fixture confirms both tenant rows exist');
});
