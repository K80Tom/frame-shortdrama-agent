import { createServer } from 'vite';
import { chromium } from 'playwright';
import { writeFile, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { PlatformPreflightService } = require('../../main/dist/platform/preflight');
const { PLATFORM_CHECK_IDS } = require('../../shared/dist/platform-preflight');
const root = fileURLToPath(new URL('..', import.meta.url));
const path = new URL('../.codex-preflight-harness.html', import.meta.url);
await writeFile(path, '<div id="root"></div><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{PlatformReadinessPanel}from"/src/PlatformReadinessPanel.tsx";createRoot(document.getElementById("root")).render(React.createElement(PlatformReadinessPanel));</script>', { flag: 'wx' });
let server, browser;
try {
  server = await createServer({ root, server: { host: '127.0.0.1', port: 0 } }); await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.LYRA_BROWSER_EXECUTABLE
    ? { executablePath: process.env.LYRA_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const errors = []; let posts = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST') posts++; });
  const probes = Object.fromEntries(PLATFORM_CHECK_IDS.map(id => [id, () => true]));
  let report = await new PlatformPreflightService(probes).check();
  await page.route('**/api/platform/preflight', route => route.fulfill({ json: report }));
  await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/.codex-preflight-harness.html');
  await page.waitForFunction(() => document.querySelectorAll('li').length === 12);
  assert.equal(await page.getByRole('status').textContent(), '本地检查通过');
  probes.vector = () => false;
  report = await new PlatformPreflightService(probes).check();
  await page.getByRole('button').click();
  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === '部分能力降级');
  probes.database = () => false;
  report = await new PlatformPreflightService(probes).check();
  await page.getByRole('button').click();
  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === '发现阻断项');
  report = { apiKey: 'secret-not-rendered' };
  await page.getByRole('button').click();
  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('未取得有效检查结果'));
  assert.equal((await page.locator('body').textContent()).includes('secret-not-rendered'), false);
  assert.equal(posts, 0); assert.deepEqual(errors, []);
  console.log('PASS: real browser ready/degraded/blocked/invalid, refresh, zero POST and zero page errors');
} finally {
  await browser?.close(); await server?.close(); await unlink(path);
}
