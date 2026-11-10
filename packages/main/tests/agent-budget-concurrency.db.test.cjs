const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { PostgresDatabase } = require('../dist/db/client');
const { PostgresAgentRuntimeStore } = require('../dist/agent-runtime/postgres-store');
const {
  PostgresBudgetLedger, PostgresToolInvocationStore, createAgentTooling,
} = require('../dist/agent-runtime/index');
const { AgentRuntime, ToolKernel, ToolRegistry, ToolAdapterError } = require('@lyra/agent');
const { defineTool, digestOf } = require('@lyra/shared');

const connectionString = process.env.DATABASE_URL;
const workspaceId = 'ws_00000000000000000000000000000000';
const digest = 'b'.repeat(64);
const token = () => randomBytes(16).toString('hex');
const hex = (bytes = 16) => randomBytes(bytes).toString('hex');

function paidTool(toolId) {
  return defineTool({
    toolId, version: '1.0.0', displayName: 'DB 付费工具', description: '用于预算并发测试',
    ownerDomain: 'test',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    outputSchema: { type: 'object', properties: {}, additionalProperties: true },
    sideEffect: 'paid_external', executionOwner: 'workflow_only', requiredPermission: 'workspace_write',
    allowedAgentIds: ['db-test-agent'], allowedWorkflowIds: ['wf_db_paid'],
    sensitivity: { input: 'internal', output: 'internal' },
    cost: { estimatorRevision: 'quote-db-v1', budgetDimension: 'money', estimateMicros: 5000, currency: 'CNY' },
    idempotency: { strategy: 'tool_call_id', keyVersion: 1 },
    retry: { timeoutMs: 5000, maxAttempts: 1, backoffMs: 0, retryableCodes: [], unknownCodes: [] },
    capability: { async: false, reconcile: false, cancel: true },
    providers: { hosts: [], modelConnections: [] },
    limits: { maxInputBytes: 4096, maxOutputBytes: 4096, maxItems: 50 },
    produces: { entities: [], revisions: [], artifacts: [], evidence: [], events: [] },
    adapterDigest: digestOf({ adapter: toolId }), status: 'frozen', frozenAt: '2026-01-01T00:00:00.000Z',
  });
}

function snapshot(userId) {
  return {
    workspaceId, projectId: null, userId, role: 'member',
    parentRunId: null, productionRunId: null, workflowTaskId: null,
    agent: { agentId: 'db-test-agent', version: '1.0.0', manifestDigest: digest },
    inputRevisions: [], prompt: { revisionDigest: digest },
    method: { profileRevisionId: null, profileDigest: null, packVersionIds: [] },
    model: { connectionRevision: 'mc_db', model: 'stub' }, tools: [],
    workflow: null, code: { buildDigest: digest }, budget: { maxMicros: 100000, currency: 'CNY' },
    timeout: { stepMs: 30000, runMs: 120000 }, maxSteps: 4, seed: null,
    contextSnapshotDigest: digest, createdAt: '2026-01-01T00:00:00.000Z',
  };
}

test('041 paid calls reserve once, running cancellation retains funds and unknown replay cannot oversell', {
  skip: connectionString ? false : 'DATABASE_URL is required',
}, async t => {
  const database = new PostgresDatabase({ connectionString }, { unscopedAccess: 'deny' });
  const runtimeStore = new PostgresAgentRuntimeStore(database);
  const runtime = new AgentRuntime(runtimeStore, { now: () => new Date('2026-01-01T00:00:00.000Z') });
  const runId = `run_${token()}`;
  const userId = `usr_${token()}`;
  const requestId = `agent-budget-db:${token()}`;
  const now = new Date('2026-01-01T00:00:00.000Z');
  t.after(() => database.close());

  await database.runWithTenant({ userId, workspaceId, role: 'member', requestId }, async () => {
    await runtime.createRun({ runId, snapshot: snapshot(userId), now: () => now });
    await runtime.transition(runId, 'planning', { summary: 'plan' });
    await runtime.transition(runId, 'queued', { summary: 'queue' });
    await runtime.claim(runId, { leaseOwner: 'db-worker-1', ttlMs: 60_000 });
    const step = await runtime.startStep(runId, '预算并发测试');
    const context = {
      workspaceId, projectId: null, userId, role: 'member', runId, stepId: step.stepId,
      toolCallId: 'db-call-concurrent', requestId, grantedPermissions: ['workspace_write'], now,
    };

    const definition = paidTool('db.pay.concurrent');
    const registry = new ToolRegistry();
    let executions = 0;
    registry.register(definition, { execute: async () => { executions += 1; return { summary: '付费完成', costMicros: 4200 }; } });
    const tooling = createAgentTooling(database, registry);
    await tooling.budgetLedger.ensureAccount(workspaceId, 'CNY', 100000);
    // 测试隔离：共享本地库里先清掉同 Workspace 的历史预留并重置账户。
    await database.query('DELETE FROM agent_budget_reservations WHERE workspace_id = $1', [workspaceId]);
    await database.query(
      'UPDATE agent_budget_accounts SET available_micros = 100000, reserved_micros = 0, version = version + 1 WHERE workspace_id = $1 AND currency = $2',
      [workspaceId, 'CNY'],
    );
    // 两个 Ledger 并发预留同一 Invocation：advisory lock + 唯一约束必须只扣一次。
    const directInvocationId = `inv_${token()}`;
    const ledgerA = new PostgresBudgetLedger(database);
    const ledgerB = new PostgresBudgetLedger(database);
    const [reservationA, reservationB] = await Promise.all([
      ledgerA.reserve({ workspaceId, agentRunId: runId, invocationId: directInvocationId, amountMicros: 100, currency: 'CNY' }),
      ledgerB.reserve({ workspaceId, agentRunId: runId, invocationId: directInvocationId, amountMicros: 100, currency: 'CNY' }),
    ]);
    assert.equal(reservationA.reservationId, reservationB.reservationId);
    const directAccount = await database.query(
      'SELECT available_micros, reserved_micros FROM agent_budget_accounts WHERE workspace_id = $1 AND currency = $2',
      [workspaceId, 'CNY'],
    );
    assert.equal(Number(directAccount.rows[0].available_micros), 99900);
    await ledgerA.releaseForInvocation({ workspaceId, invocationId: directInvocationId, reason: 'direct test cleanup' });
    const cleaned = await database.query(
      'SELECT available_micros, reserved_micros FROM agent_budget_accounts WHERE workspace_id = $1 AND currency = $2',
      [workspaceId, 'CNY'],
    );
    assert.equal(Number(cleaned.rows[0].available_micros), 100000);
    assert.equal(Number(cleaned.rows[0].reserved_micros), 0);
    const proposal = {
      proposalId: 'prop_db_concurrent', runId, stepId: step.stepId,
      toolId: definition.toolId, version: definition.version, manifestDigest: definition.manifestDigest,
      arguments: { id: 'row-1' }, reasonSummary: '预算并发',
    };
    const base = {
      workspaceId, agentId: 'db-test-agent', agentRunId: runId, stepId: step.stepId,
      proposal, context, role: 'member', grantedPermissions: ['workspace_write'],
      workflow: { workflowId: 'wf_db_paid', stage: 'render', approvedPaidMicros: 5000 },
      budgetRemainingMicros: 100000,
    };
    const waiting = await tooling.toolKernel.prepare(base);
    assert.equal(waiting.kind, 'awaiting_confirmation');
    const persisted = await tooling.runtimeStore.getApproval(waiting.approval.approvalId);
    assert.equal(persisted.state, 'pending');
    const applied = await tooling.runtimeStore.updateApproval(waiting.approval.approvalId, {
      ...persisted, state: 'approved', decidedBy: 'usr_db_owner', decidedAt: now.toISOString(),
    });
    assert.equal(applied, true);
    const ready = await tooling.toolKernel.prepare({ ...base, approvalId: waiting.approval.approvalId });
    assert.equal(ready.kind, 'ready');

    const kernelA = new ToolKernel(registry, new PostgresToolInvocationStore(database), new PostgresBudgetLedger(database),
      { approvals: runtimeStore, now: () => now });
    const kernelB = new ToolKernel(registry, new PostgresToolInvocationStore(database), new PostgresBudgetLedger(database),
      { approvals: runtimeStore, now: () => now });
    const raced = await Promise.allSettled([
      kernelA.execute(ready.invocation, context),
      kernelB.execute(ready.invocation, context),
    ]);
    assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1);
    const loser = raced.find(result => result.status === 'rejected');
    assert.equal(loser.reason.code, 'AGENT_TOOL_INVOCATION_STALE');
    assert.equal(executions, 1);
    const reservationCount = await database.query(
      'SELECT count(*)::int AS count FROM agent_budget_reservations WHERE workspace_id = $1 AND invocation_id = $2',
      [workspaceId, ready.invocation.invocationId],
    );
    assert.equal(reservationCount.rows[0].count, 1);
    const account = await database.query(
      'SELECT available_micros, reserved_micros FROM agent_budget_accounts WHERE workspace_id = $1 AND currency = $2',
      [workspaceId, 'CNY'],
    );
    assert.equal(Number(account.rows[0].available_micros), 95800);
    assert.equal(Number(account.rows[0].reserved_micros), 0);

    // 取消运行中的 Invocation：CAS 成功后释放唯一预留；随后 adapter 完成也不能再提交成功。
    let startedResolve;
    let finishResolve;
    const started = new Promise(resolvePromise => { startedResolve = resolvePromise; });
    const finish = new Promise(resolvePromise => { finishResolve = resolvePromise; });
    const cancelDefinition = paidTool('db.pay.cancel');
    const cancelRegistry = new ToolRegistry();
    cancelRegistry.register(cancelDefinition, {
      execute: async () => { startedResolve(); await finish; return { summary: '完成', costMicros: 4200 }; },
    });
    const cancelContext = {
      ...context, toolCallId: 'db-call-cancel', requestId: `agent-budget-cancel:${token()}`,
    };
    const cancelTooling = createAgentTooling(database, cancelRegistry);
    const cancelBase = {
      ...base, context: cancelContext, proposal: { ...proposal, proposalId: 'prop_db_cancel', toolId: cancelDefinition.toolId,
        version: cancelDefinition.version, manifestDigest: cancelDefinition.manifestDigest },
    };
    const cancelWaiting = await cancelTooling.toolKernel.prepare(cancelBase);
    assert.equal(cancelWaiting.kind, 'awaiting_confirmation');
    const cancelPersisted = await tooling.runtimeStore.getApproval(cancelWaiting.approval.approvalId);
    await tooling.runtimeStore.updateApproval(cancelWaiting.approval.approvalId, {
      ...cancelPersisted, state: 'approved', decidedBy: 'usr_db_owner', decidedAt: now.toISOString(),
    });
    const cancelReady = await cancelTooling.toolKernel.prepare({ ...cancelBase, approvalId: cancelWaiting.approval.approvalId });
    assert.equal(cancelReady.kind, 'ready');
    const running = cancelTooling.toolKernel.execute(cancelReady.invocation, cancelContext);
    await started;
    const live = await cancelTooling.invocationStore.get(cancelReady.invocation.invocationId);
    assert.equal(live.state, 'running');
    await assert.rejects(cancelTooling.toolKernel.cancel(live,'user cancellation'),e=>e.code==='AGENT_TOOL_RECONCILIATION_REQUIRED');
    finishResolve();await running;
    const settled=await database.query('SELECT state FROM agent_budget_reservations WHERE workspace_id=$1 AND invocation_id=$2',[workspaceId,cancelReady.invocation.invocationId]);
    assert.equal(settled.rows[0].state,'settled');
    const restored=await database.query('SELECT available_micros,reserved_micros FROM agent_budget_accounts WHERE workspace_id=$1 AND currency=$2',[workspaceId,'CNY']);
    assert.equal(Number(restored.rows[0].available_micros),91600);assert.equal(Number(restored.rows[0].reserved_micros),0);

    // Authoritative test fixture funds exactly one unknown call; no provider is contacted.
    await database.query('UPDATE agent_budget_accounts SET available_micros=5000,reserved_micros=0,version=version+1 WHERE workspace_id=$1 AND currency=$2',[workspaceId,'CNY']);
    const unknownDefinition=paidTool('db.pay.unknown'),unknownRegistry=new ToolRegistry();let unknownCalls=0;
    unknownRegistry.register(unknownDefinition,{execute:async()=>{unknownCalls++;throw new ToolAdapterError('E_UNKNOWN','provider outcome unknown',{unknown:true});}});
    const unknownTooling=createAgentTooling(database,unknownRegistry);
    const unknownContext={...context,toolCallId:'unknown-'+token(),requestId:'unknown-'+token()};
    const unknownBase={...base,context:unknownContext,budgetRemainingMicros:5000,proposal:{...proposal,proposalId:'prop_unknown',toolId:unknownDefinition.toolId,version:unknownDefinition.version,manifestDigest:unknownDefinition.manifestDigest}};
    const waitingUnknown=await unknownTooling.toolKernel.prepare(unknownBase);
    const approval=await runtimeStore.getApproval(waitingUnknown.approval.approvalId);
    await runtimeStore.updateApproval(approval.approvalId,{...approval,state:'approved',decidedBy:'usr_db_owner',decidedAt:now.toISOString()});
    const readyUnknown=await unknownTooling.toolKernel.prepare({...unknownBase,approvalId:approval.approvalId});
    const outcome=await unknownTooling.toolKernel.execute(readyUnknown.invocation,unknownContext);assert.equal(outcome.invocation.state,'reconciling');
    await unknownTooling.toolKernel.recover(await unknownTooling.invocationStore.get(readyUnknown.invocation.invocationId),unknownContext);
    await assert.rejects(unknownTooling.toolKernel.cancel(outcome.invocation,'cancel unknown'),e=>e.code==='AGENT_TOOL_RECONCILIATION_REQUIRED');
    const concurrent=await Promise.allSettled([ledgerA,ledgerB].map((ledger,i)=>ledger.reserve({workspaceId,agentRunId:runId,invocationId:'inv_'+token(),amountMicros:1,currency:'CNY'})));
    assert.ok(concurrent.every(r=>r.status==='rejected'));
    const held=await database.query('SELECT available_micros,reserved_micros FROM agent_budget_accounts WHERE workspace_id=$1 AND currency=$2',[workspaceId,'CNY']);
    assert.equal(Number(held.rows[0].available_micros),0);assert.equal(Number(held.rows[0].reserved_micros),5000);assert.equal(unknownCalls,1);

    // 真实 DB 的并发 approve/reject：只有一个 CAS 能写决定，另一个必须失败。
    const approvalId = `apr_${hex(12)}`;
    const approvalRequest = {
      approvalId, runId, state: 'pending', requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      kind: 'paid_action', summary: 'DB 并发审批', proposalDigest: digest,
      estimateMicros: 5000, currency: 'CNY', requestedBy: userId,
    };
    await runtime.createApproval(approvalRequest);
    const decisions = await Promise.allSettled([
      runtime.decideApproval({ approvalId, decision: 'approved', actor: 'usr_db_owner_a' }),
      runtime.decideApproval({ approvalId, decision: 'rejected', actor: 'usr_db_owner_b' }),
    ]);
    assert.equal(decisions.filter(result => result.status === 'fulfilled').length, 1);
    const decisionLoser = decisions.find(result => result.status === 'rejected');
    assert.ok(['AGENT_APPROVAL_STALE', 'AGENT_APPROVAL_ALREADY_DECIDED'].includes(decisionLoser.reason.code));
    const decided = await tooling.runtimeStore.getApproval(approvalId);
    assert.ok(decided.state === 'approved' || decided.state === 'rejected');
  });
});
