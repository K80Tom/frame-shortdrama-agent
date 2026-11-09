const test = require('node:test');
const assert = require('node:assert/strict');
const { publicToolDefinition, digestOf, defineTool } = require('@lyra/shared');
const {
  assertMcpEndpoint, safeMcpFetch, probeMcpServer, mapMcpTool, admittedManifests,
} = require('../dist/index.js');

const policy = {
  allowedHosts: ['api.example.com', 'api2.example.com'],
  resolveHost: async () => ['93.184.216.34'],
};

function server(overrides = {}) {
  return {
    serverId: 'srv_demo', revision: 1, workspaceId: 'ws_demo', name: 'Demo', slug: 'demo',
    transport: 'http', url: 'https://api.example.com/mcp', headerSecretRefs: ['Authorization'],
    queryParams: {}, protocolVersions: ['2025-06-18'], timeoutMs: 5000,
    initializationTimeoutMs: 5000, maxResponseBytes: 65536, allowedHosts: ['api.example.com'],
    status: 'active', admission: 'approved', createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

function remoteTool(overrides = {}) {
  return {
    name: 'search_docs', title: '搜索文档', description: '搜索文档',
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 100 } }, required: ['query'] },
    outputSchema: null,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ...overrides,
  };
}

test('SSRF 防护拒绝本机、私网、非白名单与 URL 密钥', async () => {
  for (const url of [
    'https://127.0.0.1/mcp', 'http://127.0.0.1/mcp', 'https://169.254.169.254/latest',
    'https://[::1]/mcp', 'https://10.0.0.8/mcp', 'https://192.168.1.1/mcp', 'https://100.64.0.1/mcp',
  ]) {
    await assert.rejects(() => assertMcpEndpoint(url, { ...policy, allowedHosts: [new URL(url).hostname], allowHttp: true }),
      error => ['MCP_ADDRESS_FORBIDDEN', 'MCP_PLAINTEXT_FORBIDDEN'].includes(error.code));
  }
  await assert.rejects(() => assertMcpEndpoint('https://evil.example.org/mcp', policy), error => error.code === 'MCP_HOST_NOT_ALLOWED');
  await assert.rejects(() => assertMcpEndpoint('https://api.example.com/mcp?access_token=abc', policy),
    error => error.code === 'MCP_URL_SECRET_IN_QUERY');
  await assert.rejects(() => assertMcpEndpoint('https://user:pass@api.example.com/mcp', policy),
    error => error.code === 'MCP_URL_CREDENTIALS_FORBIDDEN');
  await assert.rejects(() => assertMcpEndpoint('http://api.example.com/mcp', policy),
    error => error.code === 'MCP_PLAINTEXT_FORBIDDEN');

  const dnsRebinding = await assertMcpEndpoint('https://api.example.com/mcp', {
    ...policy, resolveHost: async () => ['93.184.216.34', '10.0.0.5'],
  }).then(() => 'allowed', error => error.code);
  assert.equal(dnsRebinding, 'MCP_ADDRESS_FORBIDDEN');
  const ok = await assertMcpEndpoint('https://api.example.com/mcp', policy);
  assert.equal(ok.hostname, 'api.example.com');
});

test('重定向逐跳校验并剥离跨 Host 鉴权头', async () => {
  const calls = [];
  const fetchPort = async (url, init) => {
    calls.push({ url, headers: { ...init.headers } });
    if (url.includes('api.example.com')) {
      return { status: 302, headers: { location: 'https://api2.example.com/mcp' }, body: '' };
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
  };
  const response = await safeMcpFetch(fetchPort, 'https://api.example.com/mcp', {
    policy, maxResponseBytes: 1024, headers: { Authorization: 'Bearer secret', 'X-Trace': '1' }, body: '{}',
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[1].headers['X-Trace'], '1');

  await assert.rejects(() => safeMcpFetch(async () => ({ status: 302, headers: { location: 'http://169.254.169.254/' }, body: '' }),
    'https://api.example.com/mcp', { policy, maxResponseBytes: 1024, headers: {}, body: '{}' }),
  error => ['MCP_ADDRESS_FORBIDDEN', 'MCP_PLAINTEXT_FORBIDDEN'].includes(error.code));

  await assert.rejects(() => safeMcpFetch(async () => ({ status: 200, headers: {}, body: 'x'.repeat(2048) }),
    'https://api.example.com/mcp', { policy, maxResponseBytes: 1024, headers: {} }),
  error => error.code === 'MCP_RESPONSE_TOO_LARGE');
});

test('MCP 握手 + 工具列表探测', async () => {
  const requests = [];
  const fetchPort = async (url, init) => {
    const payload = JSON.parse(init.body);
    requests.push(payload);
    if (payload.method === 'initialize') {
      return { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess_1' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'demo' } } }) };
    }
    if (payload.method === 'notifications/initialized') return { status: 202, headers: {}, body: '' };
    if (payload.method === 'tools/list') {
      return { status: 200, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { tools: [
          remoteTool(),
          remoteTool({ name: 'write_doc', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }),
        ] } }) };
    }
    throw new Error(`unexpected ${payload.method}`);
  };
  const result = await probeMcpServer({ server: server(), policy, fetch: fetchPort, secretHeaders: { Authorization: 'Bearer s3cret' } });
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.equal(result.sessionId, 'sess_1');
  assert.equal(result.tools.length, 2);
  assert.equal(result.tools[1].annotations.destructiveHint, true);
  assert.ok(result.capabilityDigest.length === 64);
  assert.equal(requests.length, 3);
});

test('远端 Schema 不可表达时拒绝，读工具映射为 agent_selectable，写工具强制 workflow_only', () => {
  const base = server();
  const read = mapMcpTool({ server: base, workspaceId: 'ws_demo', remote: remoteTool(), allowedAgentIds: ['demo-agent'] });
  assert.equal(read.definition.sideEffect, 'none');
  assert.equal(read.definition.executionOwner, 'agent_selectable');
  assert.deepEqual(read.definition.allowedAgentIds, ['demo-agent']);

  const write = mapMcpTool({ server: base, workspaceId: 'ws_demo', remote: remoteTool({
    name: 'write_doc', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }), allowedWorkflowIds: ['wf_doc'] });
  assert.equal(write.definition.sideEffect, 'external_write');
  assert.equal(write.definition.executionOwner, 'workflow_only');
  assert.deepEqual(write.definition.allowedAgentIds, []);

  assert.throws(() => mapMcpTool({ server: base, workspaceId: 'ws_demo', remote: remoteTool({
    inputSchema: { type: 'object', properties: { q: { anyOf: [{ type: 'string' }, { type: 'number' }] } } },
  }) }), error => error.code === 'MCP_SCHEMA_UNSUPPORTED');

  const manifests = [read, write];
  const admission = {
    workspaceId: 'ws_demo', serverId: 'srv_demo', revision: 1, status: 'approved',
    enabledTools: ['search_docs'], approvedBy: 'admin', approvedAt: null, rejectionReason: null, updatedAt: '2026-01-01T00:00:00.000Z',
  };
  assert.deepEqual(admittedManifests(manifests, admission, 'demo-agent').map(item => item.remoteName), ['search_docs']);
});

test('Lyra MCP Server 只暴露 scope 内只读工具，写工具拒绝且受速率限制', async () => {
  const { LyraMcpGateway } = require('../dist/index.js');
  const base = server();
  const read = mapMcpTool({ server: base, workspaceId: 'ws_demo', remote: remoteTool(), allowedAgentIds: ['demo-agent'] });
  const write = mapMcpTool({ server: base, workspaceId: 'ws_demo', remote: remoteTool({
    name: 'write_doc', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }), allowedWorkflowIds: ['wf_doc'] });
  let executions = 0;
  const gateway = new LyraMcpGateway({
    list: async () => [publicToolDefinition(read.definition), publicToolDefinition(write.definition)],
    execute: async toolId => { executions += 1; return { summary: `执行 ${toolId}` }; },
  }, { now: () => new Date('2026-01-01T00:00:00Z') });
  const scope = {
    workspaceId: 'ws_demo', subject: 'external-agent', permission: 'workspace_read',
    allowedToolIds: [read.definition.toolId, write.definition.toolId], requestsPerMinute: 3,
  };
  const initialize = await gateway.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' }, scope);
  assert.equal(initialize.result.serverInfo.name, 'lyra');

  const listed = await gateway.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, scope);
  assert.deepEqual(listed.result.tools.map(tool => tool.name), [read.definition.toolId.replaceAll('.', '_')]);

  const denied = await gateway.handle({
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: write.definition.toolId.replaceAll('.', '_'), arguments: {} },
  }, scope);
  assert.equal(denied.error.code, -32602);
  assert.equal(executions, 0);

  const first = await gateway.handle({
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: read.definition.toolId.replaceAll('.', '_'), arguments: { query: 'x' } },
  }, scope);
  assert.equal(first.result.isError, false);
  const second = await gateway.handle({
    jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: read.definition.toolId.replaceAll('.', '_'), arguments: { query: 'x' } },
  }, scope);
  assert.equal(second.result.isError, false);
  const third = await gateway.handle({
    jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: read.definition.toolId.replaceAll('.', '_'), arguments: { query: 'x' } },
  }, scope);
  assert.equal(third.error.code, -32029);
  assert.equal(executions, 2);
});
