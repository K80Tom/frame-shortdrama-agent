const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  PRODUCTION_TOOL_DEFINITIONS, PRODUCTION_TOOL_IDS, createProductionToolRegistry,
  createAssistantToolRegistry,
} = require('../dist/index.js');
const { assertToolDefinition, toolVersionKey } = require('@lyra/shared');

test('the production catalog publishes exactly 19 unique, frozen, digest-valid tool versions', () => {
  assert.equal(PRODUCTION_TOOL_DEFINITIONS.length, 19);
  assert.equal(PRODUCTION_TOOL_IDS.length, 19);
  assert.equal(new Set(PRODUCTION_TOOL_IDS).size, 19);
  for (const definition of PRODUCTION_TOOL_DEFINITIONS) {
    assertToolDefinition(definition);
    assert.equal(definition.version, '1.0.0');
    assert.equal(definition.status, 'frozen');
    assert.ok(definition.frozenAt);
    assert.equal(definition.inputSchema.type, 'object');
    assert.equal(definition.outputSchema.type, 'object');
    assert.ok(definition.inputSchemaDigest.length === 64);
    assert.ok(definition.manifestDigest.length === 64);
  }
});

test('paid media tools stay workflow-only and cannot be selected directly by an Agent', () => {
  for (const toolId of ['generate_image', 'generate_video']) {
    const definition = PRODUCTION_TOOL_DEFINITIONS.find(item => item.toolId === toolId);
    assert.equal(definition.executionOwner, 'workflow_only');
    assert.equal(definition.sideEffect, 'paid_external');
    assert.notEqual(definition.cost, null);
    assert.deepEqual(definition.allowedAgentIds, []);
    assert.deepEqual(definition.allowedWorkflowIds, ['production']);
  }
});

test('registry resolves each version and routes adapter execution through the injected port only', async () => {
  const calls = [];
  const registry = createProductionToolRegistry({
    async execute(toolId, args, context) {
      calls.push({ toolId, args, context });
      return { status: 'ok', toolId };
    },
  });
  assert.equal(registry.all().length, 19);
  for (const definition of PRODUCTION_TOOL_DEFINITIONS) {
    const resolved = registry.resolve({ toolId: definition.toolId, version: definition.version,
      manifestDigest: definition.manifestDigest });
    assert.equal(resolved.toolId, definition.toolId);
  }
  const result = await registry.adapterFor({
    toolId: 'get_project_context', version: '1.0.0',
    manifestDigest: PRODUCTION_TOOL_DEFINITIONS.find(item => item.toolId === 'get_project_context').manifestDigest,
  }).execute({ projectId: 'project_1' }, { workspaceId: 'workspace_1', projectId: 'project_1',
    userId: 'user_1', role: 'owner', runId: 'run_1', stepId: 'step_1', toolCallId: 'call_1',
    requestId: 'request_1', grantedPermissions: ['workspace_read'], now: new Date() });
  assert.deepEqual(result, { status: 'ok', toolId: 'get_project_context' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolId, 'get_project_context');
});

test('assistant registry still exposes its four read tools alongside production tools', () => {
  const registry = createAssistantToolRegistry({});
  assert.equal(registry.all().length, 4);
  const keys = registry.all().map(definition => toolVersionKey(definition.toolId, definition.version));
  assert.deepEqual(keys.sort(), ['get_production_run@1.0.0', 'list_assets@1.0.0',
    'list_production_runs@1.0.0', 'list_projects@1.0.0']);
});
