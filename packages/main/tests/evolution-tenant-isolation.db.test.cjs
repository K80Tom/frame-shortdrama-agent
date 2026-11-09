const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { Client } = require('pg');
const { PostgresDatabase } = require('../dist/db/client');
const { PostgresEvolutionRepository } = require('../dist/evolution/postgres-repository');
const { AssetEvolutionService } = require('../dist/evolution/service');
const { tenantExecutionScope } = require('../dist/tenancy/scope');
const { compileProductionRun } = require('../dist/production/blueprint');
const { DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY } = require('@lyra/shared');
const { AuthService } = require('../dist/auth/service');
const { PostgresAuthRepository } = require('../dist/auth/repository');
const { readConfig } = require('../dist/config');
const { createApp } = require('../dist/app');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { migrationSqlForExecution } = require('../dist/db/migrate');
const token = () => randomBytes(16).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const at = '2026-11-08T08:00:00.000Z';

test('045 upgrades populated legacy registry/audit records without rewriting immutable JSON', {
  skip: adminUrl ? false : 'DATABASE_ADMIN_URL is required',
}, async () => {
  const admin = new Client({ connectionString: adminUrl }); await admin.connect();
  try {
    await admin.query('BEGIN');
    const schema = 'evolution_upgrade_' + token();
    await admin.query('CREATE SCHEMA ' + schema);
    await admin.query('SET LOCAL search_path TO ' + schema + ',public');
    await admin.query('CREATE TABLE workspaces(id text PRIMARY KEY)');
    const legacyWorkspace = 'ws_' + '0'.repeat(32);
    await admin.query('INSERT INTO workspaces(id) VALUES($1)', [legacyWorkspace]);
    const sql = name => migrationSqlForExecution(name, readFileSync(join(__dirname, '../migrations', name), 'utf8'));
    await admin.query(sql('019_asset_evolution.sql'));
    const policy = structuredClone(DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY);
    const event = { revision: 7, action: 'adopt', reason: 'original immutable audit' };
    await admin.query(`INSERT INTO evolution_registry(domain,policy_json,updated_at,reason)
      VALUES('AssetRetrievalPolicy',$1::jsonb,$2,'original policy')`, [policy, at]);
    await admin.query(`INSERT INTO evolution_registry_events(id,domain,revision,event_json,created_at)
      VALUES('event-original','AssetRetrievalPolicy',7,$1::jsonb,$2)`, [event, at]);
    await admin.query(sql('045_evolution_registry_tenancy.sql'));
    const registry = (await admin.query('SELECT * FROM evolution_registry')).rows[0];
    const audit = (await admin.query('SELECT * FROM evolution_registry_events')).rows[0];
    assert.equal(registry.workspace_id, legacyWorkspace); assert.deepEqual(registry.policy_json, policy);
    assert.equal(registry.reason, 'original policy');
    assert.equal(audit.workspace_id, legacyWorkspace); assert.deepEqual(audit.event_json, event);
    assert.equal(audit.id, 'event-original'); assert.equal(audit.revision, 7);
    const policies = await admin.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE relnamespace=$1::regnamespace AND relname=ANY($2::text[])`, [schema, ['evolution_registry', 'evolution_registry_events']]);
    assert.equal(policies.rowCount, 2);
    assert.ok(policies.rows.every(row => row.relrowsecurity && row.relforcerowsecurity));
    await admin.query('SAVEPOINT immutable_check');
    await assert.rejects(admin.query('UPDATE evolution_registry_events SET event_json=event_json'), error => error.code === 'P0001');
    await admin.query('ROLLBACK TO SAVEPOINT immutable_check');
  } finally { await admin.query('ROLLBACK'); await admin.end(); }
});

// Run only against a disposable migrated database. Immutable audit fixtures are
// deliberately not deleted or rewritten; the test owner disposes the database.
test('workspace policy registry: real RLS, Service, authenticated HTTP, concurrent CAS and rollback', {
  skip: appUrl && adminUrl ? false : 'DATABASE_URL and DATABASE_ADMIN_URL are required',
}, async t => {
  const admin = new Client({ connectionString: adminUrl }); await admin.connect();
  const database = new PostgresDatabase({ connectionString: appUrl }, { unscopedAccess: 'deny' });
  t.after(async () => { await database.close(); await admin.end(); });
  await database.verifyTenantRole(); // A superuser test would not prove RLS.
  const repository = new PostgresEvolutionRepository(database);
  const contexts = [0, 1].map(() => { const id = token(); return { userId: 'usr_' + id,
    workspaceId: 'ws_' + id, role: 'owner', requestId: 'evolution-test:' + id }; });
  for (const ctx of contexts) {
    await admin.query(`INSERT INTO users(id,subject,display_name,kind,status,created_at,updated_at)
      VALUES($1,$2,'Evolution test','human','active',$3,$3)`, [ctx.userId, 'evolution-test:' + token(), at]);
    await admin.query(`INSERT INTO workspaces(id,slug,name,status,created_by_user_id,created_at,updated_at)
      VALUES($1,$2,'Evolution test','active',$3,$4,$4)`, [ctx.workspaceId, 'evo-' + token(), ctx.userId, at]);
    await admin.query(`INSERT INTO workspace_members(workspace_id,user_id,role,status,created_at,updated_at)
      VALUES($1,$2,'owner','active',$3,$3)`, [ctx.workspaceId, ctx.userId, at]);
  }
  const [a, b] = contexts;
  const scoped = (ctx, work) => database.runWithTenant(ctx, work);
  const runs = new Map();
  for (const ctx of contexts) {
    const run = compileProductionRun({ projectId: 'project_' + token(), scriptVersionId: 'script_' + token(),
      ratio: '9:16', targetDurationSec: 90, visualStyle: 'offline fixture', qualityPreset: 'balanced',
      automationMode: 'auto', candidatePolicy: 'direct', candidateLimit: 1, directorPolicy: 'auto',
      budgetMicros: 50000000, currency: 'CNY', allowPaid: false, clientRequestId: 'evolution-' + token() }, at);
    run.status = 'failed';
    run.issues = [{ id: 'issue_' + token(), runId: run.id, taskId: null, stage: 'assets',
      scope: { kind: 'episode', id: null }, severity: 'error', status: 'open', code: 'ASSET_MATCH_AMBIGUOUS',
      title: 'Same failure', message: 'Offline fixture', impact: [], recommendedActions: [],
      estimatedAdditionalCostMicros: null, createdAt: at, resolvedAt: null }];
    runs.set(ctx.workspaceId, run);
  }
  const service = new AssetEvolutionService({ async get(id) {
    const scope = tenantExecutionScope.current();
    const run = scope?.kind === 'tenant' ? runs.get(scope.tenant.workspaceId) : undefined;
    return run?.id === id ? structuredClone(run) : null;
  } }, repository, { now: () => new Date(at) });
  let candidateA, candidateB;

  await t.test('identical failures in different workspaces create independent proposals/candidates', async () => {
    const captures = [];
    for (const ctx of contexts) {
      const capture = await scoped(ctx, () => service.captureEvidence(runs.get(ctx.workspaceId).id));
      assert.equal(capture.proposals.length, 1);
      const repeated = await scoped(ctx, () => service.captureEvidence(runs.get(ctx.workspaceId).id));
      assert.deepEqual(repeated, capture);
      captures.push(capture);
    }
    assert.equal(captures[0].proposals[0].failureSignature, captures[1].proposals[0].failureSignature);
    assert.notEqual(captures[0].proposals[0].id, captures[1].proposals[0].id);
    candidateA = await scoped(a, () => service.createCandidate(captures[0].proposals[0].id));
    candidateB = await scoped(b, () => service.createCandidate(captures[1].proposals[0].id));
    assert.notEqual(candidateA.id, candidateB.id);
    for (const [ctx, candidate] of [[a, candidateA], [b, candidateB]]) {
      const probe = await scoped(ctx, () => service.runProbe(candidate.id));
      assert.equal(probe.verdict, 'pass'); assert.equal(probe.modelCalls, 0);
    }
    const adopted = await scoped(b, () => service.adopt(candidateB.id, candidateB.basePolicyDigest, 'offline fixture'));
    assert.equal(adopted.revision, 1);
    assert.equal((await scoped(a, () => service.currentAssetRetrievalPolicy())).registryRevision, 0);
  });

  await t.test('owner/admin/member of A cannot read or mutate B via RLS or Service', async () => {
    for (const role of ['owner', 'admin', 'member']) {
      const ctx = { ...a, role };
      await scoped(ctx, async () => {
        assert.equal((await database.query('SELECT * FROM evolution_registry WHERE workspace_id=$1', [b.workspaceId])).rowCount, 0);
        assert.equal((await database.query('SELECT * FROM evolution_registry_events WHERE workspace_id=$1', [b.workspaceId])).rowCount, 0);
        assert.equal((await database.query("UPDATE evolution_registry SET reason='attack' WHERE workspace_id=$1", [b.workspaceId])).rowCount, 0);
        assert.equal((await database.query('DELETE FROM evolution_registry_events WHERE workspace_id=$1', [b.workspaceId])).rowCount, 0);
        await assert.rejects(service.adopt(candidateB.id, candidateB.basePolicyDigest, 'attack'),
          error => error.code === 'EVOLUTION_CANDIDATE_NOT_FOUND');
        await assert.rejects(database.query(`INSERT INTO evolution_registry(workspace_id,domain,policy_json,updated_at,reason)
          VALUES($1,'AssetRetrievalPolicy',$2::jsonb,$3,'attack')`, [b.workspaceId, DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY, at]),
        error => error.code === '42501');
        await assert.rejects(database.query(`INSERT INTO evolution_registry_events(workspace_id,id,domain,revision,event_json,created_at)
          VALUES($1,$2,'AssetRetrievalPolicy',9,$3::jsonb,$4)`, [b.workspaceId, 'attack-' + token(), { revision: 9, action: 'adopt' }, at]),
        error => error.code === '42501');
      });
    }
    const registryB = await scoped(b, () => repository.getRegistry());
    assert.equal(registryB.revision, 1); assert.equal(registryB.reason, 'offline fixture');
  });

  await t.test('real database sessions carry A into HTTP and reject B IDs and unauthorized workspace headers', async () => {
    const authRepository = new PostgresAuthRepository(database), session = randomBytes(32).toString('base64url'),
      csrf = randomBytes(32).toString('base64url');
    await authRepository.createSession({ id: 'ses_' + token(), tokenHash: hash(session), csrfHash: hash(csrf),
      userId: a.userId, currentWorkspaceId: a.workspaceId, createdAt: at, expiresAt: '2030-01-01T00:00:00.000Z' });
    const authService = new AuthService(authRepository, { sessionTtlSeconds: 3600, now: () => new Date(at) });
    const app = await createApp(readConfig({ LYRA_AUTH_MODE: 'session' }), fetch, { authService, evolutionService: service });
    try {
      const headers = { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:5173', 'x-shortdrama-call': '1',
        'x-csrf-token': csrf, cookie: 'lyra_session=' + session + '; lyra_csrf=' + csrf };
      for (const role of ['owner', 'admin', 'member']) {
        await admin.query('UPDATE workspace_members SET role=$1 WHERE workspace_id=$2 AND user_id=$3', [role, a.workspaceId, a.userId]);
        const response = await app.inject({ method: 'POST', url: '/api/evolution/assets/candidates/' + candidateB.id + '/adopt',
          headers, payload: { expectedPolicyDigest: candidateB.basePolicyDigest, reason: 'attack' } });
        assert.equal(response.statusCode, 404, response.body);
        assert.equal(response.json().error.code, 'EVOLUTION_CANDIDATE_NOT_FOUND');
        const summary = await app.inject({ url: '/api/evolution/assets', headers });
        assert.equal(summary.statusCode, 200); assert.equal(summary.json().registry.revision, 0);
        assert.equal(summary.body.includes(candidateB.id), false);
        const rollback = await app.inject({ method: 'POST', url: '/api/evolution/assets/registry/rollback', headers,
          payload: { expectedPolicyDigest: candidateB.policyDigest, reason: 'attack' } });
        assert.equal(rollback.statusCode, 409); assert.equal(rollback.json().error.code, 'EVOLUTION_REGISTRY_STALE');
        const unauthorized = await app.inject({ url: '/api/evolution/assets', headers: { ...headers, 'x-workspace-id': b.workspaceId } });
        assert.equal(unauthorized.statusCode, 404);
      }
    } finally { await app.close(); }
    assert.equal((await scoped(b, () => repository.getRegistry())).revision, 1);
  });

  await t.test('concurrent same-workspace adoption has one winner and preserves the other workspace', async () => {
    const outcomes = await Promise.allSettled([0, 1].map(() => scoped(a, () => service.adopt(candidateA.id, candidateA.basePolicyDigest, 'CAS'))));
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
    const failure = outcomes.find(r => r.status === 'rejected');
    assert.equal(failure.reason.code, 'EVOLUTION_REGISTRY_STALE');
    assert.equal((await scoped(a, () => repository.getRegistry())).revision, 1);
    assert.equal((await scoped(b, () => repository.getRegistry())).revision, 1);
    assert.equal((await scoped(a, () => repository.listRegistryEvents())).length, 1);
    assert.equal((await scoped(b, () => repository.listRegistryEvents())).length, 1);
  });

  await t.test('stale rollback is rejected and successful rollback appends only within its workspace', async () => {
    await assert.rejects(scoped(a, () => service.rollback(candidateA.basePolicyDigest, 'stale')),
      error => error.code === 'EVOLUTION_REGISTRY_STALE');
    const registry = await scoped(a, () => repository.getRegistry());
    const rolled = await scoped(a, () => service.rollback(registry.policy.policyDigest, 'explicit rollback'));
    assert.equal(rolled.revision, 2); assert.equal(rolled.policy.policyDigest, candidateA.basePolicyDigest);
    const events = await scoped(a, () => repository.listRegistryEvents());
    assert.deepEqual(events.map(e => e.action), ['adopt', 'rollback']);
    assert.equal((await scoped(b, () => repository.getRegistry())).revision, 1);
    assert.equal((await scoped(b, () => repository.listRegistryEvents())).length, 1);
    await assert.rejects(scoped(a, () => database.query('UPDATE evolution_registry_events SET event_json=event_json WHERE workspace_id=$1', [a.workspaceId])),
      error => error.code === 'P0001');
  });

  await t.test('unscoped reads see no policies or audit rows and cannot fall back to another tenant', async () => {
    assert.equal(await repository.getRegistry(), null);
    assert.deepEqual(await repository.listRegistryEvents(), []);
    assert.equal((await database.query('SELECT * FROM evolution_registry')).rowCount, 0);
    assert.equal((await database.query('SELECT * FROM evolution_registry_events')).rowCount, 0);
    await assert.rejects(service.adopt(candidateB.id, candidateB.basePolicyDigest, 'unscoped'),
      error => error.code === 'EVOLUTION_CANDIDATE_NOT_FOUND');
  });
  await t.test('explicit system maintenance defaults only to the reserved workspace, not arbitrary tenant rows', async () => {
    await database.runAsSystem('test.evolution_legacy_scope', async () => {
      const candidates = await repository.listCandidates();
      assert.equal(candidates.some(c => c.id === candidateA.id || c.id === candidateB.id), false);
      const events = await repository.listRegistryEvents();
      assert.equal(events.some(e => e.candidateId === candidateA.id || e.candidateId === candidateB.id), false);
      await assert.rejects(service.adopt(candidateB.id, candidateB.basePolicyDigest, 'maintenance must not cross tenants'),
        error => error.code === 'EVOLUTION_CANDIDATE_NOT_FOUND');
    });
    assert.equal((await scoped(b, () => repository.getCandidate(candidateB.id))).status, 'adopted');
    assert.equal((await scoped(b, () => repository.getRegistry())).revision, 1);
  });
});
