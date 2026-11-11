const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { PostgresDatabase } = require('../dist/db/client');
const { PostgresEvolutionGateRepository } = require('../dist/evolution/gate-postgres-repository');
const { EvolutionGateService } = require('../dist/evolution/gate-service');
const token = () => randomBytes(16).toString('hex');
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_APP_URL || process.env.DATABASE_URL;

test('evolution commands: real PostgreSQL rollback, CAS, revisions, RLS and concurrent promote', {
  skip: !adminUrl || !appUrl ? 'DATABASE_ADMIN_URL and a non-privileged DATABASE_APP_URL required' : false,
  timeout: 60000,
}, async t => {
  const admin = new Client({ connectionString: adminUrl }); await admin.connect();
  const db = new PostgresDatabase({ connectionString: appUrl }, { unscopedAccess: 'deny' });
  t.after(async () => { await db.close(); await admin.end(); });
  await db.verifyTenantRole();
  const id = token(), at = new Date().toISOString();
  const ctx = { workspaceId: 'ws_' + id, userId: 'usr_' + id, role: 'owner', requestId: 'atomic-' + id };
  await admin.query(`INSERT INTO users(id,subject,display_name,kind,status,created_at,updated_at)
    VALUES($1,$2,'Atomic test','human','active',$3,$3)`, [ctx.userId, 'atomic-' + id, at]);
  await admin.query(`INSERT INTO workspaces(id,slug,name,status,created_by_user_id,created_at,updated_at)
    VALUES($1,$2,'Atomic test','active',$3,$4,$4)`, [ctx.workspaceId, 'atomic-' + id, ctx.userId, at]);
  await admin.query(`INSERT INTO workspace_members(workspace_id,user_id,role,status,created_at,updated_at)
    VALUES($1,$2,'owner','active',$3,$3)`, [ctx.workspaceId, ctx.userId, at]);
  const repo = new PostgresEvolutionGateRepository(db), gate = new EvolutionGateService(repo);
  const scope = work => db.runWithTenant(ctx, work);
  const tables = ['evolution_gate_candidates', 'evolution_gate_bindings', 'evolution_gate_rollouts',
    'evolution_registry_revisions', 'evolution_gate_audit_events'];
  const snapshot = async () => {
    const rows = {};
    for (const table of tables) rows[table] = (await admin.query(
      `SELECT row_to_json(t)::text AS value FROM ${table} t WHERE workspace_id=$1 ORDER BY row_to_json(t)::text`,
      [ctx.workspaceId])).rows;
    return rows;
  };
  const actor = { actorId: ctx.userId, reason: 'explicit test approval' };
  const create = () => scope(() => gate.createCandidate(ctx.workspaceId, {
    domain: 'video-prompt', scope: 'workspace', baselineRevision: 'base-v1', baselineDigest: 'a'.repeat(64),
    candidateRevision: token(), proposalKey: token(), diff: { prompt: { from: 'old', to: 'new' } },
    summary: 'Atomic fixture', generatedBy: 'human', generatorVersion: 'test-v1',
    tokenLimit: 1000, costLimitMinor: 500, createdBy: ctx.userId,
  }));
  // Deliberately controlled evaluation fixtures: these test transactionality, NOT authoritative Gate provenance.
  const approved = async () => {
    const c = await create();
    await scope(() => gate.startEvaluation(ctx.workspaceId, c.candidateId, { ...actor, expectedVersion: 1 }));
    const result = (tag, digest) => ({ resultId: tag + token(), resultDigest: 'b'.repeat(64),
      subject: { kind: 'video_prompt_version', id: tag, revisionId: null, digest }, status: 'pass',
      metrics: [{ key: 'role_consistency', layer: 'version', value: 0.9, status: 'pass' }] });
    await scope(() => gate.bindGate(ctx.workspaceId, c.candidateId, { ...actor, expectedVersion: 2,
      baselineResults: [result('base', c.baselineDigest)], candidateResults: [result('candidate', c.candidateDigest)] }));
    return scope(() => gate.approve(ctx.workspaceId, c.candidateId, { ...actor, expectedVersion: 3 }));
  };
  const ready = async () => {
    const c = await approved();
    const { rollout } = await scope(() => gate.startCanary(ctx.workspaceId, c.candidateId,
      { ...actor, expectedVersion: 4, config: { minRuns: 1 } }));
    const observed = await scope(() => gate.observe(ctx.workspaceId, rollout.rolloutId,
      { expectedVersion: 1, anomaly: false, routedToCandidate: true }));
    return { candidate: c, rollout: observed.rollout };
  };
  const fault = async (table, operation, body, work) => {
    const name = 'fault_' + token();
    await admin.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id = '${ctx.workspaceId}' THEN ${body} END IF; RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER ${name} BEFORE ${operation} ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try { await work(); } finally {
      await admin.query(`DROP TRIGGER ${name} ON ${table}`);
      await admin.query(`DROP FUNCTION ${name}()`);
    }
  };
  const unchanged = async (work, code) => {
    const before = await snapshot();
    await assert.rejects(work, error => error.code === code);
    assert.deepEqual(await snapshot(), before);
  };

  await t.test('direct Service and Tool-style calls cannot bypass live publisher membership or forge actor', async () => {
    const invalid = 'evocand_' + token(), rollout = 'evoroll_' + token();
    const commands = [
      () => gate.bindGate(ctx.workspaceId, invalid, { ...actor, expectedVersion: 1 }),
      () => gate.approve(ctx.workspaceId, invalid, { ...actor, expectedVersion: 1 }),
      () => gate.reject(ctx.workspaceId, invalid, { ...actor, expectedVersion: 1 }),
      () => gate.startCanary(ctx.workspaceId, invalid, { ...actor, expectedVersion: 1 }),
      () => gate.observe(ctx.workspaceId, rollout, { expectedVersion: 1, anomaly: false }),
      () => gate.stopCanary(ctx.workspaceId, rollout, { ...actor, expectedVersion: 1, rolloutExpectedVersion: 1 }),
      () => gate.promote(ctx.workspaceId, rollout, { ...actor, expectedVersion: 1, rolloutExpectedVersion: 1 }),
      () => gate.rollback(ctx.workspaceId, invalid, { ...actor, expectedVersion: 1 }),
    ];
    for (const role of ['member', 'viewer']) {
      await admin.query('UPDATE workspace_members SET role=$2 WHERE workspace_id=$1 AND user_id=$3',
        [ctx.workspaceId, role, ctx.userId]);
      // The scope still claims owner. Only the live database membership is authoritative.
      for (const command of commands) await unchanged(() => scope(command), 'EVOLUTION_PUBLISHER_REQUIRED');
    }
    await admin.query("UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2", [ctx.workspaceId, ctx.userId]);
    await unchanged(commands[1], 'EVOLUTION_PUBLISHER_REQUIRED'); // no tenant context
    await unchanged(() => db.runAsSystem('evolution.auth.test', commands[1]), 'EVOLUTION_PUBLISHER_REQUIRED');
    await unchanged(() => scope(() => gate.approve(ctx.workspaceId, invalid,
      { ...actor, actorId: 'usr_' + token(), expectedVersion: 1 })), 'EVOLUTION_PUBLISHER_REQUIRED');
    await unchanged(() => scope(() => gate.approve('ws_' + token(), invalid,
      { ...actor, expectedVersion: 1 })), 'EVOLUTION_PUBLISHER_REQUIRED');
    for (const role of ['admin', 'owner']) {
      await admin.query('UPDATE workspace_members SET role=$2 WHERE workspace_id=$1 AND user_id=$3',
        [ctx.workspaceId, role, ctx.userId]);
      await scope(() => repo.atomic(scoped => scoped.authorizePublisher(ctx.workspaceId, ctx.userId)));
    }
    for (const kind of ['service', 'migration']) {
      await admin.query('UPDATE users SET kind=$2 WHERE id=$1', [ctx.userId, kind]);
      try { await unchanged(() => scope(commands[1]), 'EVOLUTION_PUBLISHER_REQUIRED'); }
      finally { await admin.query("UPDATE users SET kind='human' WHERE id=$1", [ctx.userId]); }
    }
    for (const [table, key, value, status] of [['workspace_members', 'user_id', ctx.userId, 'inactive'], ['users', 'id', ctx.userId, 'disabled'], ['workspaces', 'id', ctx.workspaceId, 'suspended']]) {
      await admin.query(`UPDATE ${table} SET status=$2 WHERE ${key}=$1`, [value, status]);
      try { await unchanged(() => scope(commands[1]), 'EVOLUTION_PUBLISHER_REQUIRED'); }
      finally { await admin.query(`UPDATE ${table} SET status='active' WHERE ${key}=$1`, [value]); }
    }
  });
  await t.test('publisher authorization holds membership lock until the command commits', async () => {
    let release, entered;
    const hold = new Promise(resolve => { release = resolve; });
    const authorized = new Promise(resolve => { entered = resolve; });
    const command = scope(() => repo.atomic(async scoped => {
      await scoped.authorizePublisher(ctx.workspaceId, ctx.userId); entered(); await hold;
    }));
    await authorized;
    const revoker = new Client({ connectionString: adminUrl }); await revoker.connect();
    const pid = (await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const revoke = revoker.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", [ctx.workspaceId, ctx.userId]);
    try {
      let blocked = false;
      for (let index = 0; index < 100; index++) {
        const state = await admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid]);
        if (state.rows[0]?.wait_event_type === 'Lock') { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, 'concurrent membership revocation must wait for the authorized command');
    } finally { release(); await command; await revoke; await revoker.end(); }
    await assert.rejects(scope(() => repo.atomic(scoped => scoped.authorizePublisher(ctx.workspaceId, ctx.userId))),
      error => error.code === 'EVOLUTION_PUBLISHER_REQUIRED');
    await admin.query("UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2", [ctx.workspaceId, ctx.userId]);
  });
  await t.test('startCanary insert failure rolls candidate and audit back', async () => {
    const c = await approved();
    await fault('evolution_gate_rollouts', 'INSERT', "RAISE EXCEPTION 'injected';", () =>
      unchanged(() => scope(() => gate.startCanary(ctx.workspaceId, c.candidateId,
        { ...actor, expectedVersion: 4 })), 'EVOLUTION_GATE_PERSISTENCE_UNAVAILABLE'));
  });
  await t.test('promote: revision conflict, audit failure and false rollout CAS undo all earlier writes', async () => {
    const { rollout } = await ready();
    const promote = () => scope(() => gate.promote(ctx.workspaceId, rollout.rolloutId,
      { ...actor, expectedVersion: 5, rolloutExpectedVersion: 2 }));
    for (const [table, op, body, code] of [
      ['evolution_registry_revisions', 'INSERT', "RAISE EXCEPTION 'conflict' USING ERRCODE='23505';", 'EVOLUTION_REVISION_CONFLICT'],
      ['evolution_gate_audit_events', 'INSERT', "IF NEW.details_json ? 'revision' THEN RAISE EXCEPTION 'injected'; END IF;", 'EVOLUTION_GATE_PERSISTENCE_UNAVAILABLE'],
      ['evolution_gate_rollouts', 'UPDATE', 'RETURN NULL;', 'EVOLUTION_STALE_STATE'],
    ]) await fault(table, op, body, () => unchanged(promote, code));
    await unchanged(() => scope(() => gate.promote(ctx.workspaceId, rollout.rolloutId,
      { ...actor, expectedVersion: 4, rolloutExpectedVersion: 2 })), 'EVOLUTION_STALE_STATE');
    const results = await Promise.allSettled([promote(), promote()]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected').length, 1);
    const current = await scope(() => repo.getRollout(ctx.workspaceId, rollout.rolloutId));
    assert.equal(current.status, 'promoted');
    const revisions = await scope(() => repo.listRegistryRevisions(ctx.workspaceId, 'video-prompt'));
    assert.equal(revisions.filter(r => r.rolloutId === rollout.rolloutId).length, 1);
  });
  await t.test('manual stop and automatic stop also roll back rollout writes on candidate failure', async () => {
    const { rollout } = await ready();
    await fault('evolution_gate_candidates', 'UPDATE', "RAISE EXCEPTION 'candidate failure';", async () => {
      await unchanged(() => scope(() => gate.stopCanary(ctx.workspaceId, rollout.rolloutId,
        { ...actor, expectedVersion: 5, rolloutExpectedVersion: 2 })), 'EVOLUTION_GATE_PERSISTENCE_UNAVAILABLE');
      const first = await scope(() => gate.observe(ctx.workspaceId, rollout.rolloutId,
        { expectedVersion: 2, anomaly: true }));
      const second = await scope(() => gate.observe(ctx.workspaceId, rollout.rolloutId,
        { expectedVersion: first.rollout.stateVersion, anomaly: true }));
      await unchanged(() => scope(() => gate.observe(ctx.workspaceId, rollout.rolloutId,
        { expectedVersion: second.rollout.stateVersion, anomaly: true })), 'EVOLUTION_GATE_PERSISTENCE_UNAVAILABLE');
    });
  });
  await t.test('rollback: revision / rollout failures leave no split state; success stops routing', async () => {
    const { candidate, rollout } = await ready();
    const rollback = () => scope(() => gate.rollback(ctx.workspaceId, candidate.candidateId,
      { ...actor, expectedVersion: 5 }));
    await fault('evolution_registry_revisions', 'INSERT', "RAISE EXCEPTION 'injected';", () =>
      unchanged(rollback, 'EVOLUTION_GATE_PERSISTENCE_UNAVAILABLE'));
    await fault('evolution_gate_rollouts', 'UPDATE', 'RETURN NULL;', () =>
      unchanged(rollback, 'EVOLUTION_STALE_STATE'));
    const result = await rollback();
    assert.equal(result.candidate.state, 'rolled_back');
    assert.equal(result.revision.activeDigest, candidate.baselineDigest);
    assert.equal((await scope(() => repo.getRollout(ctx.workspaceId, rollout.rolloutId))).status, 'paused');
    await assert.rejects(scope(() => gate.route(ctx.workspaceId, rollout.rolloutId, 'run')), e => e.status === 409);
    const other = { ...ctx, workspaceId: 'ws_' + token() };
    assert.equal(await db.runWithTenant(other, () => repo.getCandidate(ctx.workspaceId, candidate.candidateId)), null);
  });
});
