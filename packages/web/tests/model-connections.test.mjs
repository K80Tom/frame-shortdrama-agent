import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { connectionDraft, connectionDirty, connectionPayload, validateConnectionDraft, modelRoles } = await server.ssrLoadModule('/src/model-connections.ts');
const { routeFromHash } = await server.ssrLoadModule('/src/navigation.ts');
const { applyHashNavigation } = await server.ssrLoadModule('/src/navigation-guard.ts');
const { default: ModelConnections } = await server.ssrLoadModule('/src/ModelConnections.tsx');
const saved = { role: 'general', endpoint: 'https://example.test/v1/chat/completions', model: 'GPT-5.6 Sol',
  authType: 'bearer', revision: 'test-revision', hasApiKey: true, configured: true, maxOutputTokens: 8192, timeoutMs: 180000 };

test('drafts never contain the saved secret; only explicit replacement or clear intent enters save payload', () => {
  const draft = connectionDraft(saved);
  assert.equal(draft.apiKey, ''); assert.equal(connectionDirty(saved, draft), false);
  assert.equal(connectionDirty(saved, { ...draft, model: 'GPT-5.6 Terra' }), true);
  assert.deepEqual(connectionPayload(saved, { ...draft, model: ' kimi-k3 ' }), { expectedRevision: 'test-revision', ...draft, model: 'kimi-k3' });
  assert.equal(connectionPayload(saved, { ...draft, clearApiKey: true }).clearApiKey, true);
  assert.equal(validateConnectionDraft('general', { ...draft, apiKey: 'new-test-only', clearApiKey: true }), '不能同时替换和清除密钥。');
});

test('per-role validation accepts accurate spaced model IDs but rejects unsafe URLs, keys and budgets', () => {
  const draft = connectionDraft(saved);
  assert.equal(validateConnectionDraft('general', draft), null);
  assert.equal(validateConnectionDraft('breakdown', { ...draft, model: 'kimi-k3' }), null);
  assert.equal(validateConnectionDraft('image', { ...draft, endpoint: 'https://example.test/v1/images/generations' }), null);
  for (const patch of [{ endpoint: 'http://example.test/v1/chat/completions' }, { endpoint: 'https://secret@example.test/v1/chat/completions' },
    { endpoint: 'https://example.test/v1/chat/completions?token=secret' }, { endpoint: 'https://example.test/v1' },
    { apiKey: 'test\nunsafe' }, { timeoutMs: 0 }, { maxOutputTokens: 20 }]) assert.ok(validateConnectionDraft('general', { ...draft, ...patch }));
});

test('dedicated models route protects unsaved configurations before unmounting, including return to settings', () => {
  const current = { route: routeFromHash('#/settings/models'), hash: '#/settings/models' };
  assert.equal(current.route.resourceId, 'models');
  let restored = '';
  const result = applyHashNavigation(current, { route: routeFromHash('#/settings'), hash: '#/settings' }, {
    hasUnsavedProduction: false, hasUnsavedModelConnections: true, confirmLeave: () => false,
    restoreHash: hash => { restored = hash; }, commitRoute: () => assert.fail('must not discard credential draft'),
  });
  assert.equal(result, current); assert.equal(restored, current.hash);
});

test('model page exposes four independent roles, no paid test button and honest media capability boundaries', () => {
  const html = renderToStaticMarkup(createElement(ModelConnections));
  for (const role of modelRoles) assert.ok(html.includes(`model-tab-${role}`));
  assert.ok(html.includes('不自动回退')); assert.ok(html.includes('重新读取'));
  assert.equal(html.includes('测试连接'), false);
});

test('text consumers read their own catalogs; credentials are not persisted in browser storage', async () => {
  const sources = await Promise.all(['ModelConnections.tsx', 'ModelLibrary.tsx', 'model-connections.ts', 'NovelBreakdown.tsx', 'production.tsx'].map(file => readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')));
  assert.equal(sources.slice(0, 3).some(source => /localStorage|sessionStorage|indexedDB/.test(source)), false);
  assert.ok(sources[3].includes('/api/models?role=breakdown'));
  assert.ok(sources[4].includes('/api/models?role=general'));
  assert.ok(sources[4].includes('!generalReady'));
});
