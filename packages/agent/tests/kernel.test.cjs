const test = require('node:test');
const assert = require('node:assert/strict');
const { defineTool, digestOf } = require('@lyra/shared');
const {
  ToolRegistry, ToolKernel, InMemoryToolInvocationStore, InMemoryBudgetLedger,
  ToolAdapterError, WAITING_CONFIRMATION, validateToolArguments, decideToolPermission,
} = require('../dist/index.js');

const BASE_DEF = {
  toolId: 'demo.read', version: '1.0.0', displayName: '读取演示', description: '读取演示数据', ownerDomain: 'test',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  outputSchema: { type: 'object', properties: {}, additionalProperties: true },
  sideEffect: 'none', executionOwner: 'agent_selectable', requiredPermission: 'workspace_read',
  allowedAgentIds: ['demo-agent'], allowedWorkflowIds: [],
  sensitivity: { input: 'internal', output: 'internal' },
  cost: null, idempotency: { strategy: 'tool_call_id', keyVersion: 1 },
  retry: { timeoutMs: 5000, maxAttempts: 1, backoffMs: 0, retryableCodes: [], unknownCodes: [] },
  capability: { async: false, reconcile: false, cancel: false },
  providers: { hosts: [], modelConnections: [] },
  limits: { maxInputBytes: 4096, maxOutputBytes: 4096, maxItems: 50 },
  produces: { entities: [], revisions: [], artifacts: [], evidence: [], events: [] },
  adapterDigest: digestOf({ adapter: 'demo' }), status: 'frozen', frozenAt: '2024-01-01T00:00:00.000Z',
};

function makeTool(overrides = {}) { return defineTool({ ...BASE_DEF, ...overrides }); }

function context(overrides = {}) {
  return {
    workspaceId: 'ws_demo', projectId: null, userId: 'usr_demo', role: 'member',
    runId: 'run_demo', stepId: 'stp_demo', toolCallId: 'call_1', requestId: 'req_1',
    grantedPermissions: ['workspace_read'], now: new Date(), ...overrides,
  };
}

function proposal(definition, overrides = {}) {
  return {
    proposalId: 'prop_1', runId: 'run_demo', stepId: 'stp_demo',
    toolId: definition.toolId, version: definition.version, manifestDigest: definition.manifestDigest,
    arguments: { id: 'a1' }, reasonSummary: '测试调用', ...overrides,
  };
}

test('工具参数按 Schema 拒绝缺省必填、额外字段与超限值', () => {
  const schema = BASE_DEF.inputSchema;
  assert.throws(() => validateToolArguments(schema, {}), error => error.code === 'AGENT_TOOL_INPUT_INVALID');
  assert.throws(() => validateToolArguments(schema, { id: 'a', extra: 1 }), error => error.code === 'AGENT_TOOL_INPUT_INVALID');
  assert.throws(() => validateToolArguments({ type: 'object', properties: { n: { type: 'integer', maximum: 3 } } }, { n: 4 }),
    error => error.code === 'AGENT_TOOL_INPUT_INVALID');
});

test('权限判定：只读放行，写操作必须确认，查看者越权直接拒绝', () => {
  const read = makeTool();
  const write = makeTool({ toolId: 'demo.write', sideEffect: 'internal_write', requiredPermission: 'workspace_write' });
  const readonlyMode = decideToolPermission({
    definition: write, role: 'member', grantedPermissions: ['workspace_write'], workflow: null,
    mode: 'read_only_only',
  });
  assert.equal(readonlyMode.decision, 'deny');
  assert.equal(readonlyMode.reasonCode, 'AGENT_TOOL_READ_ONLY_MODE');

  const viewer = decideToolPermission({
    definition: write, role: 'viewer', grantedPermissions: ['workspace_write'], workflow: null, mode: 'default',
  });
  assert.equal(viewer.decision, 'deny');

  const memberWrite = decideToolPermission({
    definition: write, role: 'member', grantedPermissions: ['workspace_write'], workflow: null, mode: 'default',
  });
  assert.equal(memberWrite.decision, 'require_confirmation');
  assert.equal(memberWrite.sideEffect, 'internal_write');

  const readOk = decideToolPermission({
    definition: read, role: 'member', grantedPermissions: ['workspace_read'], workflow: null, mode: 'default',
  });
  assert.equal(readOk.decision, 'allow');
});

test('未授权 Agent 的提案在 Runtime 第三层被拒绝', async () => {
  const definition = makeTool({ allowedAgentIds: ['another-agent'] });
  const registry = new ToolRegistry();
  registry.register(definition, { execute: async () => ({ summary: 'ok' }) });
  const kernel = new ToolKernel(registry, new InMemoryToolInvocationStore(), new InMemoryBudgetLedger({}));
  await assert.rejects(() => kernel.prepare({
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    proposal: proposal(definition), context: context(), role: 'member',
    grantedPermissions: ['workspace_read'], workflow: null,
  }), error => error.code === 'AGENT_TOOL_NOT_ALLOWED_FOR_AGENT');
});

test('只读工具执行成功并可按幂等键复用', async () => {
  const definition = makeTool();
  const registry = new ToolRegistry();
  const calls = [];
  registry.register(definition, { execute: async (args) => { calls.push(args); return { summary: '读取成功', data: { count: 1 } }; } });
  const store = new InMemoryToolInvocationStore();
  const kernel = new ToolKernel(registry, store, new InMemoryBudgetLedger({}), { now: () => new Date('2026-01-01T00:00:00Z') });
  const prepared = await kernel.prepare({
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    proposal: proposal(definition), context: context(), role: 'member', grantedPermissions: ['workspace_read'], workflow: null,
  });
  assert.equal(prepared.kind, 'ready');
  const outcome = await kernel.execute(prepared.invocation, context(), { validateOutput: true });
  assert.equal(outcome.result.status, 'succeeded');
  assert.equal(outcome.result.summary, '读取成功');
  assert.equal(calls.length, 1);

  const again = await kernel.prepare({
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    proposal: proposal(definition), context: context(), role: 'member', grantedPermissions: ['workspace_read'], workflow: null,
  });
  assert.equal(again.kind, 'reused');
  assert.equal(again.result.status, 'succeeded');
});

test('付费工具必须挂 Workflow、先估价再人工确认，不能由模型直接执行', async () => {
  const definition = makeTool({
    toolId: 'demo.pay', sideEffect: 'paid_external', executionOwner: 'workflow_only',
    requiredPermission: 'workspace_write', allowedWorkflowIds: ['wf_paid'],
    cost: { estimatorRevision: 'quote-v1', budgetDimension: 'money', estimateMicros: 5000, currency: 'CNY' },
  });
  const registry = new ToolRegistry();
  registry.register(definition, { execute: async () => ({ summary: '付费完成', costMicros: 4200 }) });
  const store = new InMemoryToolInvocationStore();
  const ledger = new InMemoryBudgetLedger({ ws_demo: 100000 });
  const kernel = new ToolKernel(registry, store, ledger, { now: () => new Date('2026-01-01T00:00:00Z') });
  const paidContext = context({ grantedPermissions: ['workspace_write'] });
  const prepared = await kernel.prepare({
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    proposal: proposal(definition), context: paidContext, role: 'member', grantedPermissions: ['workspace_write'],
    workflow: { workflowId: 'wf_paid', stage: 'render', approvedPaidMicros: 0 },
    budgetRemainingMicros: 100000,
  });
  assert.equal(prepared.kind, 'awaiting_confirmation');
  assert.equal(prepared.confirmationState, WAITING_CONFIRMATION);
  assert.equal(prepared.approval.estimateMicros, 5000);
  assert.equal(store.listByRunSync?.().length ?? 1, 1);

  const approved = await kernel.prepare({
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    proposal: proposal(definition), context: paidContext, role: 'member', grantedPermissions: ['workspace_write'],
    workflow: { workflowId: 'wf_paid', stage: 'render', approvedPaidMicros: 5000 },
    budgetRemainingMicros: 100000, approvedInvocation: true,
  });
  assert.equal(approved.kind, 'ready');
  const outcome = await kernel.execute(approved.invocation, paidContext, { validateOutput: true });
  assert.equal(outcome.result.status, 'succeeded');
  assert.equal(ledger.balanceOf('ws_demo'), 100000 - 4200);
});

test('可重试失败按策略重试，外部结果未知进入 reconciling 而非失败', async () => {
  const retryDefinition = makeTool({
    toolId: 'demo.retry',
    retry: { timeoutMs: 1000, maxAttempts: 3, backoffMs: 1, retryableCodes: ['E_TEMP'], unknownCodes: [] },
  });
  let attempts = 0;
  const registry = new ToolRegistry();
  registry.register(retryDefinition, {
    execute: async () => {
      attempts += 1;
      if (attempts < 2) throw new ToolAdapterError('E_TEMP', '临时失败', { retryable: true });
      return { summary: '重试成功' };
    },
  });
  const kernel = new ToolKernel(registry, new InMemoryToolInvocationStore(), new InMemoryBudgetLedger({}), { now: () => new Date() });
  const prepared = await kernel.prepare({
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    proposal: proposal(retryDefinition), context: context(), role: 'member', grantedPermissions: ['workspace_read'], workflow: null,
  });
  const outcome = await kernel.execute(prepared.invocation, context(), { sleep: async () => undefined });
  assert.equal(outcome.result.status, 'succeeded');
  assert.equal(attempts, 2);
  assert.equal(outcome.invocation.attemptCount, 2);

  const unknownDefinition = makeTool({ toolId: 'demo.unknown' });
  const unknownRegistry = new ToolRegistry();
  unknownRegistry.register(unknownDefinition, {
    execute: async () => { throw new ToolAdapterError('E_UNKNOWN', '远端超时', { unknown: true }); },
  });
  const unknownKernel = new ToolKernel(unknownRegistry, new InMemoryToolInvocationStore(), new InMemoryBudgetLedger({}));
  const unknown = await unknownKernel.prepare({
    workspaceId: 'ws_demo', agentId: 'demo-agent', agentRunId: 'run_demo', stepId: 'stp_demo',
    proposal: proposal(unknownDefinition), context: context(), role: 'member', grantedPermissions: ['workspace_read'], workflow: null,
  });
  const unknownOutcome = await unknownKernel.execute(unknown.invocation, context());
  assert.equal(unknownOutcome.result.status, 'inconclusive');
  assert.equal(unknownOutcome.invocation.state, 'reconciling');
});
