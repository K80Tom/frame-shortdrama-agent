import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { default: Home } = await server.ssrLoadModule('/src/WorkspaceHome.tsx');
const { default: Production } = await server.ssrLoadModule('/src/production.tsx');
const { default: Picker } = await server.ssrLoadModule('/src/ProjectEntryPicker.tsx');
const { readDraft } = await server.ssrLoadModule('/src/model.ts');
const draft = readDraft().draft;
const noop = () => {};

test('home is a project-first loading view, not a grid of repeated creation tools or sample projects', () => {
  const html = renderToStaticMarkup(createElement(Home, { draft, go: noop, onNew: noop, onAdvanced: noop,
    onOpenProject: noop, onOpenNovel: noop }));
  assert.match(html, /<h1>工作台<\/h1>/);
  assert.equal((html.match(/>新建项目<\/button>/g) ?? []).length, 1);
  assert.match(html, /继续最近项目/); assert.match(html, /更多\/高级工具/);
  for (const removed of ['快捷创作工具', '特色功能', '创作参考', '赴约 · 分镜练习']) assert.equal(html.includes(removed), false);
});

test('new-project form has no editor/project picker until a project is created', () => {
  const html = renderToStaticMarkup(createElement(Production, { initialProjectId: 'new', onProjectCreated: noop }));
  assert.match(html, /新项目名称/);
  assert.doesNotMatch(html, /aria-label="选择项目"/);
  assert.doesNotMatch(html, /id="production-script"/);
});

test('project-scoped editor cannot silently change project and does not show another create form', () => {
  const html = renderToStaticMarkup(createElement(Production, { initialProjectId: 'project_test' }));
  assert.match(html, /id="production-script"/);
  assert.doesNotMatch(html, /aria-label="选择项目"/);
  assert.doesNotMatch(html, /id="new-project-title"/);
});

test('old global production entrypoints ask for an actual project without a local-practice fallback', () => {
  for (const section of ['source', 'canvas', 'production']) {
    const html = renderToStaticMarkup(createElement(Picker, { section, draft, onNew: noop }));
    assert.match(html, /正在读取项目/);
    assert.doesNotMatch(html, /赴约/);
    assert.doesNotMatch(html, /local-practice/);
    assert.match(html, /新建项目/);
  }
});
