const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const { ToolRegistryViewService, ProductionToolService } = require('../dist/tool-registry/service');
const { McpManagementService } = require('../dist/mcp-management/service');
const { createAssistantToolRegistry, attachProductionTools } = require('@lyra/agent');

const HEADERS = { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:5173', 'x-shortdrama-call': '1' };

function management() {
  const registry = createAssistantToolRegistry({});
  attachProductionTools(registry, new ProductionToolService({
    projects: { async getProject(id) { return { title: `项目 ${id}`, currentScriptVersionId: 'script_1',
      activeStoryboardRevisionId: 'board_1' }; } },
    productionRuns: { async list() { return { runs: [{ id: 'run_1', projectId: 'project_1' }] }; },
      async get() { return { status: 'running', issues: [] }; } },
    assets: { async list() { return []; }, async get() { return {}; } },
  }));
  return new ToolRegistryViewService(() => registry.all(), definition => registry.publicView(definition));
}

test('GET /api/tools exposes 23 frozen definitions with schemas and no adapter internals', async t => {
  const app = await createApp(readConfig({}), fetch, { toolRegistryView: management() });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/tools', headers: { host: HEADERS.host } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.total, 23);
  assert.equal(body.tools.filter(tool => tool.ownerDomain === 'video').length, 2);
  const video = body.tools.find(tool => tool.toolId === 'generate_video');
  assert.equal(video.sideEffect, 'paid_external');
  assert.equal(video.executionOwner, 'workflow_only');
  assert.equal(video.schema.input.type, 'object');
  assert.equal('adapterDigest' in video, false);
  assert.equal('modelConnections' in video.providers, false);
  const filtered = await app.inject({ method: 'GET', url: '/api/tools?domain=video', headers: { host: HEADERS.host } });
  assert.equal(filtered.json().total, 2);
  const detail = await app.inject({ method: 'GET', url: '/api/tools/generate_video/1.0.0', headers: { host: HEADERS.host } });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().toolId, 'generate_video');
  const missing = await app.inject({ method: 'GET', url: '/api/tools/generate_video/9.9.9', headers: { host: HEADERS.host } });
  assert.equal(missing.statusCode, 404);
});

test('GET /api/tools fails closed when the registry view is not wired', async t => {
  const app = await createApp(readConfig({}));
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/tools', headers: { host: HEADERS.host } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'TOOL_REGISTRY_UNAVAILABLE');
});

test('MCP config rejects private or credential-bearing URLs and stores only secret references', async t => {
  const mcp = new McpManagementService({ resolveHost: async () => ['93.184.216.34'],
    now: () => new Date('2026-11-09T00:00:00.000Z') });
  const app = await createApp(readConfig({}), fetch, { toolRegistryView: management(), mcpManagement: mcp });
  t.after(() => app.close());
  const base = { name: '内部检索', slug: 'internal-search', transport: 'sse',
    url: 'https://mcp.example.test/sse', headerSecretRefs: ['MCP_TOKEN'], queryParams: {},
    protocolVersions: ['2025-06-18'], timeoutMs: 30_000, initializationTimeoutMs: 15_000,
    maxResponseBytes: 1_000_000 };
  const created = await app.inject({ method: 'POST', url: '/api/mcp/servers', headers: HEADERS, payload: base });
  assert.equal(created.statusCode, 201);
  const server = created.json();
  assert.match(server.serverId, /^mcp_[a-f0-9]{32}$/);
  assert.deepEqual(server.headerSecretRefs, ['MCP_TOKEN']);
  assert.equal(JSON.stringify(server).includes('secret-value'), false);

  const privateUrl = await app.inject({ method: 'POST', url: '/api/mcp/servers', headers: HEADERS,
    payload: { ...base, slug: 'private', url: 'https://127.0.0.1/sse' } });
  assert.equal(privateUrl.statusCode, 400);
  assert.equal(privateUrl.json().error.code, 'MCP_ADDRESS_FORBIDDEN');

  const credentialUrl = await app.inject({ method: 'POST', url: '/api/mcp/servers', headers: HEADERS,
    payload: { ...base, slug: 'credentials', url: 'https://user:pass@mcp.example.test/sse' } });
  assert.equal(credentialUrl.statusCode, 400);
  assert.equal(credentialUrl.json().error.code, 'MCP_URL_CREDENTIALS_FORBIDDEN');

  const querySecret = await app.inject({ method: 'POST', url: '/api/mcp/servers', headers: HEADERS,
    payload: { ...base, slug: 'query-secret', queryParams: { api_key: 'plaintext' } } });
  assert.equal(querySecret.statusCode, 400);
  assert.equal(querySecret.json().error.code, 'MCP_URL_SECRET_IN_QUERY');

  const listed = await app.inject({ method: 'GET', url: '/api/mcp', headers: { host: HEADERS.host } });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().servers.length, 1);
  assert.equal(listed.json().policy.secretStorage, 'reference-only');

  const disabled = await app.inject({ method: 'POST', url: `/api/mcp/servers/${server.serverId}/disable`,
    headers: HEADERS, payload: { expectedRevision: 1 } });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().status, 'disabled');
  assert.equal(disabled.json().revision, 2);
  const stale = await app.inject({ method: 'POST', url: '/api/integrations/mcp/servers/' + server.serverId + '/disable',
    headers: HEADERS, payload: { expectedRevision: 1 } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, 'MCP_SERVER_REVISION_MISMATCH');
});

test('production read adapters use injected services instead of returning fabricated data', async () => {
  const service = new ProductionToolService({
    projects: { async getProject() { return { title: '雨夜', currentScriptVersionId: 'script_1',
      activeStoryboardRevisionId: 'board_1' }; } },
    productionRuns: { async list() { return { runs: [{ id: 'run_1', projectId: 'project_1' }] }; },
      async get() { return { status: 'failed', issues: [{ code: 'BUDGET_EXCEEDED' }] }; } },
    assets: { async list() { return [{}, {}]; }, async get() { return {}; } },
  });
  const context = { workspaceId: 'workspace_1', projectId: 'project_1', userId: 'user_1', role: 'owner',
    runId: 'run_1', stepId: 'step_1', toolCallId: 'call_1', requestId: 'request_1',
    grantedPermissions: ['workspace_read'], now: new Date() };
  const project = await service.execute('get_project_context', { projectId: 'project_1' }, context);
  assert.equal(project.title, '雨夜');
  assert.equal(project.assetCount, 2);
  const issues = await service.execute('get_run_issues', { runId: 'run_1' }, context);
  assert.equal(issues.issues[0].code, 'BUDGET_EXCEEDED');
  await assert.rejects(() => service.execute('generate_video', {}, context),
    error => error.code === 'PRODUCTION_TOOL_SOURCE_UNAVAILABLE');
});
