const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { randomBytes, createHash } = require('node:crypto');
const { PostgresDatabase } = require('../dist/db/client');
const { PostgresProductionInputSourceReader } = require('../dist/production/input-source-reader');
const adminUrl = process.env.DATABASE_ADMIN_URL, appUrl = process.env.DATABASE_URL;
const token = () => randomBytes(16).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
test('real PostgreSQL input reader isolates tenants and reads exact historical Unicode source without following current pointers', {
  skip: adminUrl && appUrl ? false : 'DATABASE_ADMIN_URL and non-privileged DATABASE_URL are required',
}, async t => {
  const admin = new Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query("SELECT set_config('lyra.system_bypass','on',false)"); // dedicated fixture administrator only
  const db = new PostgresDatabase({ connectionString: appUrl }, { unscopedAccess: 'deny' });
  t.after(async () => { await db.close(); await admin.end(); });
  await db.verifyTenantRole();
  const tenants = [];
  for (let i = 0; i < 2; i++) {
    const suffix = token(), userId = 'usr_' + suffix, workspaceId = 'ws_' + suffix;
    await admin.query(`INSERT INTO users(id,subject,display_name,kind,status,created_at,updated_at)
      VALUES($1,$2,'Input test','human','active',now(),now())`, [userId, 'input-test:' + suffix]);
    await admin.query(`INSERT INTO workspaces(id,slug,name,status,created_by_user_id,created_at,updated_at)
      VALUES($1,$2,'Input test','active',$3,now(),now())`, [workspaceId, 'input-' + suffix, userId]);
    tenants.push({ userId, workspaceId, role: 'owner', requestId: 'input-test:' + suffix });
  }
  const [a, b] = tenants, projectId = 'project_' + token(), scriptId = 'script_' + token(), raw = '甲😀乙';
  await admin.query('INSERT INTO projects(id,title,workspace_id,created_at) VALUES($1,$2,$3,now())', [projectId, 'Input test', a.workspaceId]);
  await admin.query(`INSERT INTO script_versions(id,project_id,version,raw_text,content_sha256,source_index_json,workspace_id,created_at)
    VALUES($1,$2,1,$3,$4,'{}'::jsonb,$5,now())`, [scriptId, projectId, raw, hash(raw), a.workspaceId]);
  await admin.query('UPDATE projects SET current_script_version_id=$1 WHERE id=$2', [scriptId, projectId]);
  const reader = new PostgresProductionInputSourceReader(db);
  const first = await reader.readCurrentProjectInputs(a, projectId);
  assert.equal(first.script.rawText, raw); assert.equal(first.plan, null); assert.equal(first.storyboard, null);
  assert.equal(first.versions.scriptVersionId, scriptId);
  assert.equal(await reader.readCurrentProjectInputs(b, projectId), null);
  const ref = { scriptVersionId: scriptId, start: 1, end: 2, quote: '😀' };
  assert.equal(await reader.checkSource(a, projectId, ref), null);
  assert.equal(await reader.checkSource(b, projectId, ref), 'REFERENCE_NOT_FOUND');
  assert.equal(await reader.checkSource(a, 'project_' + token(), ref), 'REFERENCE_NOT_FOUND');
  assert.equal(await reader.checkSource(a, projectId, { ...ref, end: 3 }), 'DIGEST_MISMATCH');
  const newer = 'script_' + token(), newRaw = '新的原文';
  await admin.query(`INSERT INTO script_versions(id,project_id,version,raw_text,content_sha256,source_index_json,workspace_id,created_at)
    VALUES($1,$2,2,$3,$4,'{}'::jsonb,$5,now())`, [newer, projectId, newRaw, hash(newRaw), a.workspaceId]);
  await admin.query('UPDATE projects SET current_script_version_id=$1 WHERE id=$2', [newer, projectId]);
  const second = await reader.readCurrentProjectInputs(a, projectId);
  assert.notEqual(second.inputSetDigest, first.inputSetDigest);
  assert.equal(first.script.rawText, raw); // previously captured view is not a live pointer
  assert.equal(await reader.checkSource(a, projectId, ref), null); // exact historical version
  await admin.query('UPDATE script_versions SET content_sha256=$1 WHERE id=$2', ['0'.repeat(64), newer]);
  await assert.rejects(reader.readCurrentProjectInputs(a, projectId), e => e.code === 'DIGEST_MISMATCH');
  assert.equal(await reader.checkSource(a, projectId, { scriptVersionId: newer, start: 0, end: 1, quote: '新' }), 'DIGEST_MISMATCH');
});
