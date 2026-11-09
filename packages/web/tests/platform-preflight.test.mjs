import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { createServer } from 'vite';
test('preflight is browser-safe, advisory and visibly loading before a response', async () => {
  const source = await readFile(new URL('../src/PlatformReadinessPanel.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes("from '@lyra/shared/dist/platform-preflight'"));
  assert.equal(source.includes("from '@lyra/shared'"), false);
  assert.ok(source.includes('controller.abort()'));
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  try {
    const { PlatformReadinessPanel } = await server.ssrLoadModule('/src/PlatformReadinessPanel.tsx');
    const html = renderToStaticMarkup(createElement(PlatformReadinessPanel));
    assert.ok(html.includes('aria-busy="true"'));
    assert.ok(html.includes('role="status"'));
    assert.ok(html.includes('不是付费授权'));
  } finally { await server.close(); }
});
