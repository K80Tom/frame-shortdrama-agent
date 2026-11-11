import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Real browser + controlled HTTP fixtures. No backend, provider credentials or paid calls.
const output = join(tmpdir(), 'lyra-project-entrypoints-browser');
await mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, clearScreen: false });
let browser;
const writes = [];
const errors = [];
const projects = [
  { id: 'project_recent', title: '回声之外', createdAt: '2026-11-10T00:00:00Z', currentScriptVersionId: null, activePlanRevisionId: null, activeStoryboardRevisionId: null, source: null },
  { id: 'project_earlier', title: '旧城来信', createdAt: '2026-11-09T00:00:00Z', currentScriptVersionId: null, activePlanRevisionId: null, activeStoryboardRevisionId: null, source: null },
];
let failed = false;
let failNovels = false;
let empty = false;
try {
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true,
    ...(process.platform === 'win32' ? { channel: process.env.LYRA_BROWSER_CHANNEL ?? 'msedge' } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'lyra_csrf', value: 'test-csrf-only', url: origin, sameSite: 'Lax' }]);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin && !['data:', 'blob:'].includes(url.protocol)) return route.abort();
    return route.continue();
  });
  await context.route('**/api/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    assert.equal(url.origin, origin, 'browser must not contact a provider');
    const reply = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (request.method() !== 'GET') {
      writes.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() });
      assert.equal(url.pathname, '/api/projects', 'navigation must not generate a paid write');
      assert.equal(request.method(), 'POST');
      assert.equal(request.headers()['x-shortdrama-call'], '1');
      assert.equal(request.headers()['x-workspace-id'], 'workspace_test');
      assert.equal(request.headers()['x-csrf-token'], 'test-csrf-only');
      const created = { ...projects[0], id: 'project_created', title: request.postDataJSON().title, createdAt: '2026-11-11T00:00:00Z' };
      projects.unshift(created);
      await new Promise(resolve => setTimeout(resolve, 100));
      return reply(created);
    }
    if (url.pathname === '/api/auth/session') return reply({ authenticated: true, user: { id: 'user_test', displayName: '离线验证' },
      workspaces: [{ id: 'workspace_test', name: '测试工作区', slug: 'test', role: 'owner' }], currentWorkspaceId: 'workspace_test' });
    if (url.pathname === '/api/auth/config') return reply({ registrationMode: 'disabled' });
    if (url.pathname === '/api/projects') return failed ? reply({ error: { message: '测试：目录不可用' } }, 503) : reply({ items: empty ? [] : projects });
    if (url.pathname === '/api/novels') return failed || failNovels ? reply({ error: { message: '测试：目录不可用' } }, 503) : reply({ novels: [] });
    if (url.pathname === '/api/models') return reply({ configured: false, provider: 'maas', defaultModel: 'offline-only', reasoningEffort: 'model-default' });
    const project = projects.find(project => url.pathname === `/api/projects/${project.id}`);
    if (project) return reply(project);
    if (/^\/api\/projects\/[^/]+\/(breakdown-runs|storyboards|plan-revisions|script-versions|canvases)$/.test(url.pathname)) return reply({ items: [] });
    return reply({ error: { code: 'TEST_FIXTURE_NOT_AVAILABLE', message: '此离线场景未配置该来源。' } }, 503);
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const dialogs = [];
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  await page.goto(`${origin}/#/studio`);
  await page.getByRole('button', { name: '继续剧本项目：回声之外' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '新建项目', exact: true }).count(), 1);
  for (const label of ['快捷创作工具', '特色功能', '创作参考']) assert.equal(await page.getByText(label, { exact: true }).count(), 0);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({ path: join(output, `home-${width}.png`), fullPage: true });
    if (width === 1440) {
      const { writeFile } = await import('node:fs/promises');
      const snapshot = (await page.content()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      await writeFile(join(output, 'home-snapshot.html'), snapshot, 'utf8');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal overflow at ${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '继续最近项目', exact: true }).click();
  await page.waitForURL('**/#/projects/project_recent/overview');
  await page.getByRole('link', { name: '添加剧本', exact: true }).click();
  await page.waitForURL('**/#/projects/project_recent/source');
  await page.locator('#production-script').waitFor();
  assert.equal(await page.getByRole('combobox', { name: '选择项目', exact: true }).count(), 0);
  await page.goBack(); await page.waitForURL('**/#/projects/project_recent/overview');
  await page.goForward(); await page.waitForURL('**/#/projects/project_recent/source');
  await page.goto(`${origin}/#/studio`);
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '先体验一个样例' }).count(), 0);
  await page.getByRole('button', { name: '从剧本开始' }).click();
  await page.getByRole('textbox', { name: '新项目名称' }).fill('新建入口验证');
  await page.locator('.workspace-nav a[href="#/projects"]').click();
  assert.equal(dialogs.length, 1, 'unsaved project title must still require confirmation');
  assert.ok(page.url().endsWith('#/projects/new/source'));
  assert.equal(await page.getByRole('textbox', { name: '新项目名称' }).inputValue(), '新建入口验证');
  const create = page.getByRole('button', { name: '创建项目', exact: true });
  await create.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(button => button.textContent === '创建项目')?.disabled);
  await create.evaluate(button => { button.click(); button.click(); });
  await page.waitForURL('**/#/projects/project_created/overview');
  await page.getByRole('link', { name: '添加剧本', exact: true }).waitFor();
  assert.equal(writes.length, 1, 'double click creates one project');
  assert.equal(dialogs.length, 1, 'successful creation clears only the already-saved title before navigation');
  assert.deepEqual(writes[0].body, { title: '新建入口验证' });
  await page.getByRole('link', { name: '添加剧本', exact: true }).click();
  await page.locator('#production-script').waitFor();
  assert.equal(await page.getByRole('combobox', { name: '选择项目', exact: true }).count(), 0);
  await page.goto(`${origin}/#/studio`);
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByRole('button', { name: '从小说开始' }).click();
  await page.waitForURL('**/#/novel/new');
  assert.equal(writes.length, 1, 'novel entry does not create a fake screenplay project');
  for (const [hash, heading, section] of [['production', '打开项目剧本', 'source'], ['canvas', '打开项目画布', 'canvas'], ['automation', '打开项目制作', 'production']]) {
    await page.goto(`${origin}/#/${hash}`);
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    const link = page.locator(`a[href="#/projects/project_created/${section}"]`);
    await link.waitFor(); assert.equal(await link.textContent(), '新建入口验证');
  }
  await page.goto(`${origin}/#/automation/video`);
  await page.getByRole('heading', { name: /视频/ }).first().waitFor();
  await page.goto(`${origin}/#/storyboard`);
  await page.getByRole('heading', { name: '分镜练习', exact: true }).waitFor();
  assert.ok(await page.getByText(/不会用于正式项目制作/).count());
  await page.goto(`${origin}/#/assets/references`);
  await page.getByRole('tab', { name: /示例参考/ }).waitFor();
  assert.equal(await page.getByRole('tab', { name: /示例参考/ }).getAttribute('aria-selected'), 'true');
  await page.goto(`${origin}/#/flow/1`);
  await page.getByRole('button', { name: '分镜练习', exact: true }).waitFor();
  await page.getByRole('button', { name: '剧本练习', exact: true }).waitFor();
  await page.goto(`${origin}/#/studio`);
  await page.getByRole('button', { name: '更多/高级工具', exact: true }).last().click();
  for (const label of ['方法库', '质量中心', '3D 导演预演', '创作指南与样例']) await page.getByRole('dialog').getByRole('link', { name: label, exact: true }).waitFor();
  await page.keyboard.press('Escape');
  failNovels = true;
  await page.reload();
  await page.getByRole('button', { name: '继续剧本项目：新建入口验证' }).waitFor();
  await page.getByRole('button', { name: '重试小说原文', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '继续最近已加载项目', exact: true }).isEnabled(), true);
  failNovels = false;
  empty = true;
  await page.reload();
  await page.getByText('还没有项目。点击上方“新建项目”，从剧本或小说开始。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '继续最近项目', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: /继续本地练习/ }).count(), 0);
  await page.screenshot({ path: join(output, 'home-empty.png'), fullPage: true });
  failed = true;
  await page.reload();
  await page.getByText('暂时无法读取项目，请重试；不会用样例代替真实项目。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '重试剧本项目', exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'home-error.png'), fullPage: true });
  assert.equal(writes.length, 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, widths: [1440, 768, 390], projectWrites: writes.length, paidWrites: 0, output }));
} finally {
  await browser?.close(); await server.close();
}
