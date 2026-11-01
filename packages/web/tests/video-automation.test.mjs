import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const api = await server.ssrLoadModule('/src/video-automation.ts');
const { default: VideoAutomationPage, VideoRunProgress } = await server.ssrLoadModule('/src/VideoAutomationPage.tsx');
const { routeFromHash, commands, creationNavigation } = await server.ssrLoadModule('/src/navigation.ts');
const { applyHashNavigation } = await server.ssrLoadModule('/src/navigation-guard.ts');
const status = { available: true, code: 'ready', message: '就绪', model: 'video-model', connectionRevision: 'model-revision-1', busy: false };
const form = { ...api.defaultVideoForm, prompt: '  雨巷中的人物缓缓转身。  ' };
function run(changes = {}) {
  return { id: 'run-1', status: 'generating', clientRequestId: 'request-123', modelConnectionRevision: 'model-revision-1',
    prompt: '雨巷中的人物缓缓转身。', model: 'video-model', createdAt: '2026-10-23T10:00:00.000Z', updatedAt: '2026-10-23T10:01:00.000Z',
    progress: { completed: 3, total: 5 }, result: null,
    nodes: api.videoNodeKeys.map((key, index) => ({ key, label: ['输入', '模型', '提交', '生成', '交付'][index],
      state: index < 3 ? 'succeeded' : index === 3 ? 'waitingExternal' : 'pending', message: index === 3 ? '等待视频服务返回' : '' })), ...changes };
}

test('automation is a real navigation destination and unsaved input is protected before unmount', () => {
  assert.deepEqual(routeFromHash('#/automation'), { page: 'automation', step: 1 });
  assert.ok(commands.some(item => item.id === 'automation'));
  assert.ok(creationNavigation.some(item => item.id === 'automation' && item.label === '自动成片'));
  const current = { route: { page: 'automation' }, hash: '#/automation' };
  const restored = [];
  assert.equal(applyHashNavigation(current, { route: { page: 'studio' }, hash: '#/studio' }, {
    hasUnsavedProduction: false, hasUnsavedAutomation: true, confirmLeave: () => false,
    restoreHash: hash => restored.push(hash), commitRoute: () => assert.fail('keep the form mounted'),
  }), current);
  assert.deepEqual(restored, ['#/automation']);
});

test('submission freezes reviewed model revision and accepts only exposed video settings', () => {
  assert.deepEqual(api.videoSubmission(form, status, 'request-123'), {
    prompt: form.prompt.trim(), ratio: '9:16', duration: 5, resolution: '720p', generateAudio: false,
    clientRequestId: 'request-123', expectedModelConnectionRevision: 'model-revision-1', allowPaid: true,
  });
  for (const invalid of [{ prompt: '  ' }, { prompt: 'a'.repeat(8001) }, { ratio: '1:1' }, { resolution: '480p' }, { duration: 4 }, { generateAudio: 'yes' }]) {
    assert.ok(api.validateVideoForm({ ...form, ...invalid }));
  }
  for (const invalidStatus of [{ available: false }, { busy: true }, { connectionRevision: '' }]) {
    assert.throws(() => api.videoSubmission(form, { ...status, ...invalidStatus }, 'request-123'));
  }
  assert.equal(api.parseVideoStatus({ ...status, available: false, model: null, connectionRevision: null }).model, '');
});

test('progress uses complete server nodes and does not accept malformed histories as recovery evidence', () => {
  assert.deepEqual(api.parseVideoRun({ ...run(), nodes: [...run().nodes].reverse() }).nodes.map(node => node.key), api.videoNodeKeys);
  for (const invalid of [null, {}, { ...run(), nodes: run().nodes.slice(1) }, { ...run(), nodes: [...run().nodes.slice(1), run().nodes[1]] },
    { ...run(), progress: { completed: 6, total: 5 } }, { ...run(), status: 'pretendComplete' }]) assert.throws(() => api.parseVideoRun(invalid));
  assert.throws(() => api.parseVideoRuns({ runs: [run(), {}] }));
});

test('response loss recovers a matching client request without resubmission or clearing an in-flight request', () => {
  const pending = { clientRequestId: 'request-123', createdAt: '2026-10-23T10:00:00Z' };
  assert.equal(api.resolvePendingVideoIntent(pending, [], true).state, 'waiting');
  assert.equal(api.resolvePendingVideoIntent(pending, [run()], false).run.id, 'run-1');
  assert.equal(api.resolvePendingVideoIntent(pending, [run({ clientRequestId: 'unrelated' })], false).state, 'notFound');
  assert.deepEqual(api.readPendingVideoIntent({ getItem: () => JSON.stringify(pending) }), pending);
  assert.equal(api.readPendingVideoIntent({ getItem: () => '{broken' }), null);
  assert.equal(api.readPendingVideoIntent({ getItem: () => { throw new Error('storage disabled'); } }), null);
});

test('an unknown provider result preserves recovery but does not permanently block a new authorized intent', () => {
  const ready = { status, runs: [run({ status: 'unknown' })], pending: false, loading: false, posting: false, reconciling: false };
  assert.equal(api.videoCreationBlocked(ready), false);
  for (const blocked of [{ pending: true }, { posting: true }, { reconciling: true }, { status: { ...status, busy: true } }, { runs: [run()] }]) {
    assert.equal(api.videoCreationBlocked({ ...ready, ...blocked }), true);
  }
});

test('stale polling cannot replace newer terminal result, and video links permit only explicit safe HTTPS navigation', () => {
  const completed = run({ status: 'completed', updatedAt: '2026-10-23T10:02:00.000Z', result: { videoUrl: 'https://media.example/video.mp4?signature=abc' } });
  assert.equal(api.mergeVideoRuns([completed], [run()])[0].status, 'completed');
  assert.equal(api.videoResultLink(completed.result.videoUrl), completed.result.videoUrl);
  for (const url of ['http://media.example/a', 'javascript:alert(1)', 'data:video/mp4,a', '//media.example/a', 'https://user:pass@media.example/a', 'https://media.example/\\bad', 'https://media.example/a\n']) {
    assert.equal(api.videoResultLink(url), null);
  }
});

test('SSR shows real progress and unknown recovery without remote media or automatic API calls', () => {
  const initial = renderToStaticMarkup(React.createElement(VideoAutomationPage));
  assert.match(initial, /一键创建视频/);
  assert.match(initial, /#\/settings\/models/);
  assert.match(initial, /API 额度/);
  assert.match(initial, /disabled=""/);
  const unknown = renderToStaticMarkup(React.createElement(VideoRunProgress, { run: run({ status: 'unknown' }), reconciling: false, onReconcile() {} }));
  assert.match(unknown, /不会重新发送/);
  assert.match(unknown, /核对已有任务/);
  assert.match(unknown, /3 \/ 5 环节/);
  assert.doesNotMatch(unknown, /\d+%/);
  const completed = renderToStaticMarkup(React.createElement(VideoRunProgress, { run: run({ status: 'completed', result: { videoUrl: 'https://media.example/video.mp4' } }), reconciling: false, onReconcile() {} }));
  assert.match(completed, /href="https:\/\/media.example\/video.mp4"/);
  assert.match(completed, /rel="noopener noreferrer"/);
  assert.doesNotMatch(completed, /<video|<iframe|<img|<source/);
});

test('API preserves explicit HTTP rejection separately from network ambiguity', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (path, options) => { calls.push({ path, options }); return new Response(JSON.stringify({ error: { message: '模型版本已改变' } }), { status: 409 }); };
    await assert.rejects(api.videoAutomationApi('/api/video-automation-runs', { clientRequestId: 'request-123' }), error => error instanceof api.VideoApiError && error.status === 409);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['X-Shortdrama-Call'], '1');
    globalThis.fetch = async () => { throw new TypeError('network interrupted'); };
    await assert.rejects(api.videoAutomationApi('/api/video-automation-runs', {}), error => !(error instanceof api.VideoApiError));
  } finally { globalThis.fetch = originalFetch; }
});
