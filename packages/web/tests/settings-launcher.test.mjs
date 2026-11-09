import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { default: SettingsLauncher } = await server.ssrLoadModule('/src/SettingsLauncher.tsx');

test('settings launcher preserves its accessible destination and active state', () => {
  const idle = renderToStaticMarkup(createElement(SettingsLauncher, { active: false, onOpen() {} }));
  assert.match(idle, /aria-label="打开工作台设置"/);
  assert.match(idle, /工作台设置/);
  assert.match(idle, /系统状态 · 模型连接/);
  assert.doesNotMatch(idle, /aria-current=/);

  const active = renderToStaticMarkup(createElement(SettingsLauncher, { active: true, onOpen() {} }));
  assert.match(active, /aria-current="page"/);
  assert.match(active, /settings-launcher is-active/);
});
