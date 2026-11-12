import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const flow = await server.ssrLoadModule('/src/project-flow.ts');

test('项目区段顺序固定为 概览→剧本→资产→分镜→画布→制作', () => {
  assert.deepEqual(flow.PROJECT_FLOW_SECTIONS.map(item => item.id),
    ['overview', 'script', 'assets', 'storyboard', 'canvas', 'production']);
  for (const item of flow.PROJECT_FLOW_SECTIONS) {
    assert.ok(item.label && item.note, `区段 ${item.id} 缺少 label/note`);
  }
});

test('projectFlowHash 生成可解析的项目路径', () => {
  assert.equal(flow.projectFlowHash('project_demo', 'script'), '#/projects/project_demo/script');
  assert.equal(flow.projectFlowHash('story/一', 'assets'), '#/projects/story%2F%E4%B8%80/assets');
});

test('parseProjectFlowSection：新区段直出、旧区段归一、非法值返回 null', () => {
  for (const section of ['overview', 'script', 'assets', 'storyboard', 'canvas', 'production']) {
    assert.equal(flow.parseProjectFlowSection(section), section);
  }
  assert.equal(flow.parseProjectFlowSection('source'), 'script');
  assert.equal(flow.parseProjectFlowSection('screenplay'), 'script');
  assert.equal(flow.parseProjectFlowSection('director'), 'storyboard');
  assert.equal(flow.parseProjectFlowSection('review'), 'production');
  assert.equal(flow.parseProjectFlowSection('history'), 'production');
  assert.equal(flow.parseProjectFlowSection('unknown'), null);
  assert.equal(flow.parseProjectFlowSection(undefined), null);
  assert.equal(flow.parseProjectFlowSection(''), null);
});

test('旧 hash 经别名归一不出现 404：App 传入 legacy section 时也能落到主链区段', () => {
  // 模拟 App.tsx 现状传入的 ProjectSection 值。
  for (const legacy of ['overview', 'source', 'screenplay', 'storyboard', 'canvas', 'director', 'production', 'review', 'history']) {
    assert.notEqual(flow.parseProjectFlowSection(legacy), null, `legacy ${legacy} 未归一`);
  }
});
