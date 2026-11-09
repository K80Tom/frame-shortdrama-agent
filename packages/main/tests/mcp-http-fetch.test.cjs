const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createPinnedMcpFetch } = require('../dist/agent-runtime/mcp-http-fetch');

test('pinned MCP transport connects to verified peer IP while preserving Host', async () => {
  const fetch = createPinnedMcpFetch();
  let receivedHost = '';
  const server = createServer((request, response) => {
    receivedHost = request.headers.host ?? '';
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, body: Buffer.concat(chunks).toString('utf8') }));
    });
  });
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  const port = address.port;
  try {
    const response = await fetch({
      url: `http://mcp.example.test:${port}/rpc?x=1`,
      protocol: 'http:',
      hostname: 'mcp.example.test',
      port,
      address: '127.0.0.1',
      addresses: ['127.0.0.1'],
      servername: 'mcp.example.test',
      maxResponseBytes: 1024,
    }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ping":1}' });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).ok, true);
    // 若 transport 重新解析 hostname，mcp.example.test 无法连接；Host 仍必须是原始域名。
    assert.equal(receivedHost, `mcp.example.test:${port}`);
  } finally {
    await new Promise(resolvePromise => server.close(resolvePromise));
  }
});

test('pinned MCP transport rejects oversized responses', async () => {
  const fetch = createPinnedMcpFetch();
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('x'.repeat(2048));
  });
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  const port = server.address().port;
  try {
    await assert.rejects(() => fetch({
      url: `http://mcp.example.test:${port}/rpc`,
      protocol: 'http:',
      hostname: 'mcp.example.test',
      port,
      address: '127.0.0.1',
      addresses: ['127.0.0.1'],
      servername: 'mcp.example.test',
      maxResponseBytes: 1024,
    }, { method: 'GET', headers: {} }), error => error.code === 'MCP_RESPONSE_TOO_LARGE');
  } finally {
    await new Promise(resolvePromise => server.close(resolvePromise));
  }
});
