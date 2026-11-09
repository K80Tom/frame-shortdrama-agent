const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { randomBytes, createHash } = require('node:crypto');
const { PostgresDatabase } = require('../dist/db/client');
const { PostgresProductionInputSourceReader } = require('../dist/production/input-source-reader');
const { PostgresShotSpecRepository } = require('../dist/production/shot-spec-repository');
const { sealShotSpecV2 } = require('../dist/production/shot-spec');
const { ProductionInputCandidateCompiler } = require('../dist/production/input-compiler');
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
  assert.equal(first.projectRevision, '1');
  await admin.query('UPDATE projects SET title=$1,input_revision=999 WHERE id=$2', ['Display-only change', projectId]);
  assert.equal((await reader.readCurrentProjectInputs(a, projectId)).projectRevision, '1');
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
  assert.equal(second.projectRevision, '2');
  assert.notEqual(second.inputSetDigest, first.inputSetDigest);
  assert.equal(first.script.rawText, raw); // previously captured view is not a live pointer
  assert.equal(await reader.checkSource(a, projectId, ref), null); // exact historical version
  await admin.query('UPDATE script_versions SET content_sha256=$1 WHERE id=$2', ['0'.repeat(64), newer]);
  await assert.rejects(reader.readCurrentProjectInputs(a, projectId), e => e.code === 'DIGEST_MISMATCH');
  assert.equal(await reader.checkSource(a, projectId, { scriptVersionId: newer, start: 0, end: 1, quote: '新' }), 'DIGEST_MISMATCH');
  const episodeId = 'episode_' + token(), versionId = 'shotspec_' + token(), shotId = 'shot_' + token();
  await db.runWithTenant(a, () => db.query(`INSERT INTO production_episodes(workspace_id,id,project_id,title,created_by,created_at)
    VALUES($1,$2,$3,'Test episode',$4,now())`, [a.workspaceId, episodeId, projectId, a.userId]));
  // SQL-level envelope constraints tested separately from the full DTO parser.
  const envelope = { schemaVersion: 'lyra-shot-spec/2', workspaceId: a.workspaceId, projectId, episodeId,
    shotId, revisionId: versionId, contentDigest: 'a'.repeat(64) };
  const insert = (id, json) => db.query(`INSERT INTO shot_spec_versions(workspace_id,id,project_id,episode_id,shot_id,
    content_digest,spec_json,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())`,
  [a.workspaceId, id, projectId, episodeId, shotId, 'a'.repeat(64), json, a.userId]);
  await db.runWithTenant(a, () => insert(versionId, envelope));
  await assert.rejects(db.runWithTenant(a, () => insert('invalid_' + token(), { ...envelope, revisionId: null })), e => e.code === '23514');
  assert.equal((await db.runWithTenant(b, () => db.query('SELECT id FROM shot_spec_versions WHERE id=$1', [versionId]))).rowCount, 0);
  await assert.rejects(db.runWithTenant(a, () => db.query('UPDATE shot_spec_versions SET spec_json=spec_json WHERE id=$1', [versionId])), e => e.code === '55000');
  await assert.rejects(db.runWithTenant(a, () => db.query(`INSERT INTO shot_spec_heads(workspace_id,project_id,episode_id,shot_id,
    current_version_id,adopted_by,adopted_at,reason) VALUES($1,$2,$3,$4,$5,$6,now(),'bad target')`,
  [a.workspaceId, projectId, episodeId, 'shot_wrong', versionId, a.userId])), e => e.code === '23503');
  const repository = new PostgresShotSpecRepository(db), realId = 'shotspec_' + token();
  const version = { id: 'resource-one', versionId: 'version-one', digest: 'a'.repeat(64) };
  const spec = sealShotSpecV2({ schemaVersion: 'lyra-shot-spec/2', revisionId: realId, workspaceId: a.workspaceId,
    projectId, episodeId, scriptVersionId: scriptId, planRevisionId: 'plan-one', storyboardRevisionId: 'board-one',
    shotId, sceneId: 'scene-one', order: 1, durationMs: 5000, ratio: '9:16', shotSize: 'wide',
    camera: { description: null, movement: 'still', focalLengthMm: null, composition: null }, dialogue: [], actions: [], assetPacks: [], controls: [],
    visualStyle: 'offline', negativeConstraints: [], continuity: { before: [], after: [] }, timeline: [], sourceRefs: [],
    generation: { methodPackRevisions: [], promptPackRevision: version, modelCapabilityRevision: version, candidatePolicy: { mode: 'direct', limit: 1 } },
    source: { kind: 'user', actor: a.userId, sourceRevisionId: null }, createdAt: '2026-11-09T00:00:00.000Z' });
  await repository.create(a, spec); await repository.create(a, spec);
  assert.equal(await repository.get(b, realId), null);
  const createdEvents = await admin.query('SELECT event_id FROM data_outbox_events WHERE workspace_id=$1 AND aggregate_id=$2', [a.workspaceId, realId]);
  assert.equal(createdEvents.rowCount, 1, 'duplicate create must not duplicate event');
  const adoption = { revisionId: realId, expectedCurrentVersion: null, expectedProjectRevision: '2', reason: 'offline CAS test', at: spec.createdAt };
  await assert.rejects(repository.adopt(a, adoption, async () => { throw new Error('validation failed'); }));
  assert.equal((await admin.query('SELECT input_revision::text FROM projects WHERE id=$1', [projectId])).rows[0].input_revision, '2');
  // Read-only validator is stubbed here: this test proves transaction/CAS, not production reference authorization.
  const results = await Promise.allSettled([0, 1].map(() => repository.adopt(a, adoption, async () => {})));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  assert.equal((await admin.query('SELECT input_revision::text FROM projects WHERE id=$1', [projectId])).rows[0].input_revision, '3');
  const adoptedEvents = await admin.query("SELECT event_id FROM data_outbox_events WHERE workspace_id=$1 AND event_type='shot_spec.adopted.v2'", [a.workspaceId]);
  assert.equal(adoptedEvents.rowCount, 1);
  const replay = await repository.adopt(a, { ...adoption, expectedCurrentVersion: realId, expectedProjectRevision: '3' }, async () => {});
  assert.equal(replay.projectRevision, '3', 'same-head no-op must not advance project');
  await admin.query('UPDATE script_versions SET content_sha256=$1 WHERE id=$2', [hash(newRaw), newer]);
  const adoptedView = await reader.readCurrentProjectInputs(a, projectId, episodeId);
  assert.equal(adoptedView.projectRevision, '3'); assert.equal(adoptedView.shotVersions[0].revisionId, realId);
  assert.equal(await reader.readCurrentProjectInputs(b, projectId, episodeId), null);
  assert.equal(await reader.readCurrentProjectInputs(a, projectId, 'episode_missing'), null);
  const compiled = await new ProductionInputCandidateCompiler(reader).compile(a, projectId, episodeId, {});
  assert.equal(compiled.state, 'blocked'); assert.equal(compiled.candidate, null); // real project has no adopted plan/board
  await assert.rejects(repository.create({ ...a, role: 'viewer' }, spec), e => e.code === 'REFERENCE_FORBIDDEN');
});
