const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { PostgresDatabase } = require('../dist/db/client');
const { PostgresAgentRuntimeStore } = require('../dist/agent-runtime/postgres-store');
const { createAgentTooling } = require('../dist/agent-runtime/services');
const { AgentRuntime, ToolRegistry } = require('@lyra/agent');
const { defineTool, digestOf } = require('@lyra/shared');

const connectionString = process.env.DATABASE_URL;
const workspaceId = 'ws_00000000000000000000000000000000';
const digest = 'a'.repeat(64);
const token = () => randomBytes(16).toString('hex');

test('041 Agent runtime store persists run, step, approval and events under tenant scope', {
  skip: connectionString ? false : 'DATABASE_URL is required',
}, async t => {
  const database = new PostgresDatabase({ connectionString }, { unscopedAccess: 'deny' });
  const runId = `run_${token()}`;
  const userId = `usr_${token()}`;
  const requestId = `agent-db:${token()}`;
  const now = new Date('2026-01-01T00:00:00.000Z');
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  t.after(() => database.close());

  const snapshot = {
    workspaceId, projectId: null, userId, role: 'member',
    agent: { agentId: 'db-test-agent', version: '1.0.0', manifestDigest: digest },
    inputRevisions: [], prompt: { revisionId: 'pmt_db_test', digest },
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
    await runtime.transition(runId, 'running', { summary: 'run' });
    const step = await runtime.startStep(runId, 'db step');
    assert.match(step.stepId, /^stp_[a-f0-9]{16}$/u);

    const definition = defineTool({
      toolId: 'db.test.read', version: '1.0.0', displayName: 'DB 读取', description: 'DB 读取测试',
      ownerDomain: 'test',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      outputSchema: { type: 'object', properties: {}, additionalProperties: true },
      sideEffect: 'none', executionOwner: 'agent_selectable', requiredPermission: 'workspace_read',
      allowedAgentIds: ['db-test-agent'], allowedWorkflowIds: [],
      sensitivity: { input: 'internal', output: 'internal' }, cost: null,
      idempotency: { strategy: 'tool_call_id', keyVersion: 1 },
      retry: { timeoutMs: 5000, maxAttempts: 1, backoffMs: 0, retryableCodes: [], unknownCodes: [] },
      capability: { async: false, reconcile: false, cancel: false },
      providers: { hosts: [], modelConnections: [] },
      limits: { maxInputBytes: 4096, maxOutputBytes: 4096, maxItems: 50 },
      produces: { entities: [], revisions: [], artifacts: [], evidence: [], events: [] },
      adapterDigest: digestOf({ adapter: 'db-test' }), status: 'frozen', frozenAt: now.toISOString(),
    });
    const registry = new ToolRegistry();
    registry.register(definition, { execute: async () => ({ summary: 'DB 读取成功' }) });
    const tooling = createAgentTooling(database, registry);
    const executionContext = {
      workspaceId, projectId: null, userId, role: 'member', runId, stepId: step.stepId,
      toolCallId: 'call_db_1', requestId, grantedPermissions: ['workspace_read'], now,
    };
    const proposal = {
      proposalId: 'prop_db_1', runId, stepId: step.stepId, toolId: definition.toolId,
      version: definition.version, manifestDigest: definition.manifestDigest,
      arguments: { id: 'db-row' }, reasonSummary: 'DB 测试调用',
    };
    const prepared = await tooling.toolKernel.prepare({
      workspaceId, agentId: 'db-test-agent', agentRunId: runId, stepId: step.stepId,
      proposal, context: executionContext, role: 'member', grantedPermissions: ['workspace_read'], workflow: null,
    });
    assert.equal(prepared.kind, 'ready');
    const outcome = await tooling.toolKernel.execute(prepared.invocation, executionContext, { validateOutput: true });
    assert.equal(outcome.result.status, 'succeeded');
    const invocations = await tooling.invocationStore.listByRun(runId);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].state, 'succeeded');
    assert.equal(invocations[0].attemptCount, 1);

    const approvalId = `apr_${randomBytes(12).toString('hex')}`;
    const approval = await runtime.createApproval({
      approvalId, runId, state: 'pending', requestedAt: now.toISOString(), expiresAt,
      kind: 'tool_confirmation', summary: '确认只读工具', proposalDigest: digest,
      estimateMicros: 0, currency: 'CNY', requestedBy: userId,
    });
    assert.equal(approval.approvalId, approvalId);

    const decided = await runtime.decideApproval({
      approvalId, decision: 'approved', actor: `usr_${randomBytes(16).toString('hex')}`, note: 'db test',
    });
    assert.equal(decided.approval.state, 'approved');
    const events = await runtime.replay(runId);
    assert.ok(events.length >= 6);
    assert.equal(events[0].sequence, 1);
  });
});
