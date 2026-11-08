import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());

const deployment = await server.ssrLoadModule('/src/deployment.ts');
const { SystemStatusView, unavailableSystemStatus } = await server.ssrLoadModule('/src/SystemStatusPanel.tsx');

test('workspace directory parsing resolves a stored selection and preserves legacy compatibility', () => {
  const directory = deployment.parseWorkspaceDirectory({
    items: [
      { id: 'workspace-main', name: 'Main studio', slug: 'main' },
      { id: 'workspace-legacy', name: 'Legacy studio', legacy: true },
      { id: 'workspace-main', name: 'Duplicate is ignored' },
      { id: '../invalid', name: 'Invalid is ignored' },
    ],
    currentWorkspaceId: 'workspace-main',
    legacyMode: false,
  });
  assert.equal(directory.items.length, 2);
  assert.equal(directory.currentWorkspaceId, 'workspace-main');
  assert.equal(deployment.resolveActiveWorkspace(directory, 'workspace-legacy').id, 'workspace-legacy');
  assert.equal(deployment.resolveActiveWorkspace(directory, 'missing').id, 'workspace-main');

  const legacy = deployment.parseWorkspaceDirectory({ items: [], legacyMode: true });
  assert.deepEqual(legacy, deployment.legacyWorkspaceDirectory());
  assert.equal(deployment.resolveActiveWorkspace(legacy, null).legacy, true);
});

test('system status parser normalizes every service and marks missing services unavailable', () => {
  const status = deployment.parseSystemStatus({
    generatedAt: '2026-11-08T08:00:00.000Z',
    runtimeRole: 'api',
    services: [
      { id: 'api', label: 'API', status: 'healthy', required: true, detail: 'Ready' },
      { id: 'redis', label: 'Redis', status: 'degraded', required: true, detail: 'Session protection failed closed' },
      { id: 'milvus', label: 'Milvus', status: 'unconfigured', required: false, detail: 'Search disabled' },
      { id: 'objectStorage', label: 'Object storage', status: 'healthy', required: true, detail: 'Configured', provider: 's3' },
    ],
  });
  assert.equal(status.services.length, 6);
  assert.equal(status.services.find(service => service.id === 'redis').status, 'degraded');
  assert.equal(status.services.find(service => service.id === 'redis').required, true);
  assert.equal(status.services.find(service => service.id === 'milvus').status, 'unconfigured');
  assert.equal(status.services.find(service => service.id === 'worker').status, 'unavailable');
  assert.equal(status.services.find(service => service.id === 'worker').required, true);
  assert.equal(status.services.find(service => service.id === 'objectStorage').provider, 's3');
});

test('workspace headers merge without overwriting an explicit request context', () => {
  const attached = deployment.headersForWorkspace({ Accept: 'application/json' }, 'workspace-main');
  assert.equal(attached.get('Accept'), 'application/json');
  assert.equal(attached.get('X-Workspace-Id'), 'workspace-main');

  const explicit = deployment.headersForWorkspace({ 'X-Workspace-Id': 'workspace-override' }, 'workspace-main');
  assert.equal(explicit.get('X-Workspace-Id'), 'workspace-override');
  assert.equal(deployment.headersForWorkspace(undefined, null).has('X-Workspace-Id'), false);
});

test('system status view renders six services and honest probe boundaries', () => {
  const status = deployment.parseSystemStatus({
    generatedAt: '2026-11-08T08:00:00.000Z',
    runtimeRole: 'all',
    services: [
      { id: 'api', status: 'healthy', detail: 'Ready' },
      { id: 'worker', status: 'healthy', detail: 'Ready' },
      { id: 'postgres', status: 'healthy', detail: 'Authoritative' },
      { id: 'redis', status: 'degraded', detail: 'Bypassed' },
      { id: 'milvus', status: 'unconfigured', detail: 'Disabled' },
      { id: 'objectStorage', status: 'healthy', detail: 'Ready', provider: 's3' },
    ],
  });
  const html = renderToStaticMarkup(createElement(SystemStatusView, { status, loading: false, error: '', onRetry() {} }));
  for (const label of ['API', 'Worker', 'PostgreSQL', 'Redis', 'Milvus', '对象存储']) assert.match(html, new RegExp(label));
  assert.match(html, /Degraded/);
  assert.match(html, /Unconfigured/);
  assert.match(html, /队列已清空/);
  assert.match(html, /Redis 的职责与失败边界/);
  assert.match(html, /SSE fan-out 尚未接入/);
  assert.match(html, /Milvus 投影需要显式启用/);
  assert.match(html, /ASSET_VECTOR_ENABLED/);
  assert.match(html, /对象存储能力与签名边界/);
  assert.match(html, /历史对象已全部投影/);
  assert.match(html, /签名 URL 已能从公网浏览器访问/);
  assert.match(html, /Worker 状态来自数据库心跳/);
  assert.match(html, />s3</);
});

test('unavailable view is honest when the backend cannot report status', () => {
  const html = renderToStaticMarkup(createElement(SystemStatusView, {
    status: unavailableSystemStatus(), loading: false, error: '当前后端尚未提供系统状态接口。', onRetry() {},
  }));
  assert.match(html, /状态未验证/);
  assert.match(html, /当前后端尚未提供系统状态接口/);
  assert.equal((html.match(/Unavailable/g) ?? []).length, 6);
  assert.match(html, /运行角色：尚未确认/);
  assert.equal(unavailableSystemStatus().runtimeRole, null);
  assert.doesNotMatch(html, /探针均正常/);
});
