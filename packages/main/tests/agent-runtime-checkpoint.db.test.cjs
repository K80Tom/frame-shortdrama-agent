const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { PostgresDatabase } = require('../dist/db/client');
const { PostgresAgentRuntimeStore } = require('../dist/agent-runtime/postgres-store');
const { AgentRuntime } = require('@lyra/agent');
const { digestOf } = require('@lyra/shared');

const connectionString = process.env.DATABASE_URL;
const workspaceId = 'ws_00000000000000000000000000000000';
const token = () => randomBytes(16).toString('hex');
const digest = 'a'.repeat(64);

test('053 checkpoints persist attempts, strict sequences and an Outbox projection under tenant scope', {
  skip: connectionString ? false : 'DATABASE_URL is required',
}, async t => {
  const database = new PostgresDatabase({ connectionString }, { unscopedAccess: 'deny' });
  const runId = `run_${token()}`;
  const userId = `usr_${token()}`;
  const requestId = `agent-db:${token()}`;
  const now = new Date('2026-01-01T00:00:00.000Z');
  t.after(() => database.close());

  const snapshot = {
    workspaceId, projectId: null, userId, role: 'member',
    agent: { agentId: 'db-ckpt-agent', version: '1.0.0', manifestDigest: digest },
    inputRevisions: [], prompt: { revisionId: 'pmt_db_ckpt', digest },
    method: null, model: { role: 'general', modelId: 'stub' }, tools: [],
    workflow: null, code: { digest }, budget: { maxMicros: 100_000, currency: 'CNY' },
    timeout: { runMs: 60_000 }, maxSteps: 4, seed: 1,
    contextSnapshotDigest: digest, createdAt: now.toISOString(),
  };

  await database.runWithTenant({ userId, workspaceId, role: 'member', requestId }, async () => {
    const runtime = new AgentRuntime(new PostgresAgentRuntimeStore(database), { now: () => now });
    const run = await runtime.createRun({ runId, snapshot, now: () => now });
    assert.equal(run.state, 'created');
    await runtime.transition(runId, 'planning', { summary: 'plan' });
    await runtime.transition(runId, 'queued', { summary: 'queue' });
    const claimed = await runtime.claim(runId, { leaseOwner: 'worker-db', ttlMs: 60_000 });
    assert.equal(claimed.state, 'running');
    assert.match(claimed.currentAttemptId, /^runa_[a-f0-9]{32}$/u);
    const step = await runtime.startStep(runId, 'checkpoint step');

    const checkpoint = await runtime.recordCheckpoint(runId, {
      phase: 'before_tool', stepId: step.stepId,
      payload: { version: 1, round: 1, callIndex: 0, calls: [], observations: [], awaitingPlanner: false },
      cursor: 'round:1:call:0', summary: '工具提交前',
    });
    assert.match(checkpoint.checkpointId, /^chk_[a-f0-9]{32}$/u);
    assert.equal(checkpoint.attemptId, claimed.currentAttemptId);
    assert.equal(checkpoint.sequence, 1);

    const second = await runtime.recordCheckpoint(runId, {
      phase: 'after_tool', stepId: step.stepId, payload: { version: 1, done: true }, summary: '工具结果确认',
    });
    assert.equal(second.sequence, 2);
    assert.equal(second.pendingInvocationId, null);
    assert.equal((await runtime.latestCheckpoint(runId)).checkpointId, second.checkpointId);
    assert.deepEqual((await runtime.listCheckpoints(runId)).map(item => item.phase), ['before_tool', 'after_tool']);
    assert.equal((await runtime.listAttempts(runId)).length, 1);

    // 每个 AgentEvent 都与既有 data_outbox_events 同事务投影，不另建 Outbox。
    const outbox = await database.query(`
      SELECT event_type, aggregate_type, aggregate_version FROM data_outbox_events
      WHERE workspace_id = $1 AND aggregate_id = $2 AND event_type = 'agent.run.checkpoint'
      ORDER BY aggregate_version
    `, [workspaceId, runId]);
    assert.equal(outbox.rows.length, 2);
    assert.equal(outbox.rows[0].aggregate_type, 'agent_run');
    const checkpointEvents = (await runtime.replay(runId)).filter(item => item.event.type === 'checkpoint');
    assert.equal(checkpointEvents.length, 2);
    assert.equal(Number(outbox.rows[0].aggregate_version), checkpointEvents[0].sequence);
    assert.equal(Number(outbox.rows[1].aggregate_version), checkpointEvents[1].sequence);

    // 另一个 Workspace 的裸 Run ID 读不到任何 Checkpoint（RLS + 不存在性都不泄漏）。
    // 超级用户/BYPASSRLS 角色会绕过 FORCE RLS，此时只验证表已存在，RLS 由非超管角色验证。
    const role = await database.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    if (!role.rows[0].rolsuper && !role.rows[0].rolbypassrls) {
      await database.runWithTenant({ userId, workspaceId: 'ws_ffffffffffffffffffffffffffffffff', role: 'member', requestId: `${requestId}:other` }, async () => {
        const hidden = await database.query('SELECT count(*)::int AS count FROM agent_run_checkpoints WHERE run_id = $1', [runId]);
        assert.equal(hidden.rows[0].count, 0);
      });
    }
  });
});
