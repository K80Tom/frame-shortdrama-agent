import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const helpers = await server.ssrLoadModule('/src/desktop-asset-generation.ts');
const { default: DesktopAssetGeneration, DesktopTaskCard, DesktopVisualBriefView } = await server.ssrLoadModule('/src/DesktopAssetGeneration.tsx');
const item = { id: 'person', kind: 'character', label: '小林', description: '身穿普通外套。',
  sourceRefs: [{ documentId: 'source', start: 0, end: 6, quote: '小林走进门。' }],
  speakerId: null, classification: null, uncertainty: null, review: 'confirmed', origin: 'user' };
const revision = { id: 'revision', chapterId: 'chapter', content: { items: [item], warnings: [] } };
const status = { available: true, code: 'ready', message: '生图 API 连接可用', model: 'Seedream5.0Pro', busy: false, connectionRevision: 'connection-revision-1' };
const task = { id: 'desktop_1', sourceId: 'source', chapterId: 'chapter', itemId: 'person', inputRevisionId: 'revision',
  label: '小林', kind: 'character', status: 'generating', phase: 'wait', message: '正在生成', assetId: null,
  linkedRevisionId: null, createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:01:00.000Z' };
const visualBrief = { schemaVersion: 'asset-visual-brief/v1', itemId: 'person', kind: 'character', name: '小林',
  confirmedFacts: ['身穿普通外套'], evidence: [{ evidenceId: 'evidence-1', documentId: 'source', start: 0, end: 6, quote: '小林走进门。' }],
  designVariables: [{ field: 'presentation', guidance: '单一人物完整展示。' }], negativeConstraints: ['不得改变已确认服装'],
  confidence: 1, pendingConfirmations: ['鞋子样式待确认'] };
const candidate = { id: 'candidate_1', assetId: 'asset_1', status: 'awaitingReview', brief: visualBrief,
  result: { sha256: 'a'.repeat(64), mimeType: 'image/png', bytes: 2048 }, reviewNote: '', acceptedRevisionId: null,
  createdAt: '2026-10-23T00:02:00.000Z', updatedAt: '2026-10-23T00:02:00.000Z',
  provenance: { promptVersion: 'asset-generation-prompt/v1', provider: 'api', model: 'Seedream5.0Pro',
    modelConnectionRevision: 'connection-revision-1', inputRevisionId: 'revision',
    result: { sha256: 'a'.repeat(64), mimeType: 'image/png', bytes: 2048 } } };
const ready = { editable: true, dirty: false, busy: false, assetDraftDirty: false, status, task: null, loading: false };

test('desktop generation requires latest saved confirmed entities, evidence preserved unchanged', () => {
  for (const kind of ['character', 'location', 'prop']) assert.equal(helpers.desktopGenerationBlock({ ...item, kind }, revision, ready), null);
  for (const [options, expression] of [[{ editable: false }, /历史版本/], [{ dirty: true }, /先保存/],
    [{ busy: true }, /稍候/], [{ assetDraftDirty: true }, /引用草稿/]]) {
    assert.match(helpers.desktopGenerationBlock(item, revision, { ...ready, ...options }), expression);
  }
  assert.match(helpers.desktopGenerationBlock({ ...item, kind: 'dialogue' }, revision, ready), /对白/);
  assert.match(helpers.desktopGenerationBlock({ ...item, review: 'unreviewed' }, revision, ready), /确认/);
  assert.match(helpers.desktopGenerationBlock({ ...item, uncertainty: '外观不明' }, revision, ready), /确认/);
  assert.equal(item.sourceRefs[0].quote, '小林走进门。');
});

test('linked or stale asset binding does not incur another generation', () => {
  for (const [bindingStatus, expression] of [['linked', /已有资产/], ['needsReview', /核对旧引用/]]) {
    const boundRevision = { ...revision, content: { ...revision.content, assetBindings: [{ itemId: item.id, status: bindingStatus, asset: null, note: '' }] } };
    assert.match(helpers.desktopGenerationBlock(item, boundRevision, ready), expression);
  }
});

test('image connection availability and only active or unknown task history blocks a new candidate', () => {
  assert.match(helpers.desktopGenerationBlock(item, revision, { ...ready, loading: true }), /检查/);
  assert.match(helpers.desktopGenerationBlock(item, revision, { ...ready, status: null }), /模型连接不可用/);
  assert.match(helpers.desktopGenerationBlock(item, revision, { ...ready, status: { ...status, available: false, message: '凭据无效' } }), /模型连接不可用/);
  assert.match(helpers.desktopGenerationBlock(item, revision, { ...ready, status: { ...status, busy: true } }), /其他任务/);
  for (const taskStatus of ['queued', 'submitting', 'generating', 'importing', 'unknown']) {
    assert.ok(helpers.desktopGenerationBlock(item, revision, { ...ready, task: { ...task, status: taskStatus } }), taskStatus);
  }
  for (const taskStatus of ['awaitingReview', 'rejected', 'failed', 'needsReview', 'accepted', 'completed']) {
    assert.equal(helpers.desktopGenerationBlock(item, revision, { ...ready, task: { ...task, status: taskStatus } }), null,
      `${taskStatus} history permits only a fresh explicit consent and click when the current binding is missing`);
  }
});

test('newest task matches stable entity ID instead of its label', () => {
  const newer = { ...task, id: 'desktop_2', createdAt: '2026-10-23T01:00:00.000Z' };
  assert.equal(helpers.taskForItem([newer, task, { ...newer, id: 'other', itemId: 'other' }], 'person'), newer);
  assert.equal(helpers.taskForItem([task], 'missing'), null);
  assert.deepEqual(helpers.tasksForItem([task, newer, { ...newer, id: 'other', itemId: 'other' }], 'person'), [newer, task]);
  assert.deepEqual(['queued', 'submitting', 'generating', 'importing', 'awaitingReview', 'accepted', 'rejected', 'unknown', 'completed']
    .map(value => helpers.desktopTaskActive({ ...task, status: value })), [true, true, true, true, false, false, false, false, false]);
});

test('same-ID retry and subsequent polling replace a stale local failed snapshot by updatedAt', () => {
  const failed = { ...task, status: 'failed', updatedAt: '2026-10-23T00:01:00.000Z' };
  const queued = { ...failed, status: 'queued', updatedAt: '2026-10-23T00:02:00.000Z' };
  const generating = { ...queued, status: 'generating', updatedAt: '2026-10-23T00:03:00.000Z' };
  assert.equal(helpers.freshestDesktopTask(queued, failed), queued);
  assert.equal(helpers.freshestDesktopTask(generating, queued), generating);
  assert.equal(helpers.freshestDesktopTask(failed, queued), queued, 'a late stale poll cannot replace a newer POST receipt');
  const equalTimestampServer = { ...queued, status: 'submitting' };
  assert.equal(helpers.freshestDesktopTask(equalTimestampServer, queued), equalTimestampServer, 'poll wins a timestamp tie');
});

test('lost POST response recovers from a matching persisted task, never from unrelated or stale records', () => {
  const failed = { ...task, status: 'failed' };
  const retry = { ...task, status: 'queued', updatedAt: '2026-10-23T01:00:00.000Z' };
  assert.equal(helpers.desktopSubmissionRecovered(task, null, item.id, revision.id), true);
  assert.equal(helpers.desktopSubmissionRecovered(retry, failed, item.id, revision.id), true);
  assert.equal(helpers.desktopSubmissionRecovered(failed, failed, item.id, revision.id), false);
  assert.equal(helpers.desktopSubmissionRecovered(null, null, item.id, revision.id), false);
  assert.equal(helpers.desktopSubmissionRecovered({ ...retry, itemId: 'other' }, failed, item.id, revision.id), false);
  assert.equal(helpers.desktopSubmissionRecovered({ ...retry, inputRevisionId: 'other' }, failed, item.id, revision.id), false);
  const unknown = { ...retry, status: 'unknown' };
  assert.equal(helpers.desktopSubmissionRecovered(unknown, failed, item.id, revision.id), true, 'recover display even when server reports unknown');
  assert.ok(helpers.desktopGenerationBlock(item, revision, { ...ready, task: unknown }), 'server unknown still prevents generation');
});

test('accepted and legacy completion reload never replaces dirty fact/binding drafts or historical view', () => {
  const completed = { ...task, status: 'completed', linkedRevisionId: 'new-revision' };
  assert.equal(helpers.desktopCompletionNeedsRefresh(completed, 'chapter', [revision]), true);
  assert.equal(helpers.desktopCompletionNeedsRefresh(completed, 'other-chapter', [revision]), false);
  assert.equal(helpers.desktopCompletionNeedsRefresh(completed, 'chapter', [revision, { id: 'new-revision' }]), false);
  assert.equal(helpers.desktopCompletionNeedsRefresh({ ...completed, status: 'needsReview' }, 'chapter', []), false);
  assert.equal(helpers.desktopCompletionNeedsRefresh({ ...completed, linkedRevisionId: null }, 'chapter', []), false);
  const accepted = { ...task, status: 'accepted', candidate: { ...candidate, status: 'accepted', acceptedRevisionId: 'accepted-revision' } };
  assert.equal(helpers.desktopCompletionNeedsRefresh(accepted, 'chapter', [revision]), true);
  assert.equal(helpers.desktopCompletionNeedsRefresh(accepted, 'chapter', [revision, { id: 'accepted-revision' }]), false);
  const recoveredCandidate = { ...accepted, status: 'failed', linkedRevisionId: null };
  assert.equal(helpers.desktopCompletionNeedsRefresh(recoveredCandidate, 'chapter', [revision]), true,
    'candidate acceptance recovers refresh even if the task status write failed');
  for (const options of [{ dirty: true, editable: true, busy: false }, { dirty: false, editable: false, busy: false }, { dirty: false, editable: true, busy: true }]) assert.equal(helpers.desktopReloadAllowed(options), false);
  assert.equal(helpers.desktopReloadAllowed({ dirty: false, editable: true, busy: false }), true);
});

test('unavailable image connection directs user to model settings without desktop permissions', () => {
  assert.match(helpers.desktopPermissionHelp({ ...status, available: false, code: 'invalid_credentials' }), /工作台设置.*模型连接.*API 地址/);
  assert.equal(helpers.desktopPermissionHelp(status), null);
  assert.doesNotMatch(helpers.desktopPermissionHelp({ ...status, available: false, code: 'invalid_credentials' }), /macOS|辅助功能|工作台已登录/);
});

test('candidate UI starts with per-image unchecked credit consent and never claims automatic linking', () => {
  const html = renderToStaticMarkup(createElement(DesktopAssetGeneration, {
    item, revision, editable: true, dirty: false, busy: false, assetDraftDirty: false,
    desktop: { status, tasks: [], loading: false, error: '', refresh() {} },
  }));
  assert.match(html, /生成候选，确认后关联/);
  assert.match(html, /生成候选图片/);
  assert.match(html, /发送到设置中选定的生图 API/);
  assert.match(html, /可能消耗 API 额度并计费/);
  assert.match(html, /不自动购买套餐，不自动重试/);
  assert.match(html, /每张图都需要单独勾选授权/);
  assert.match(html, /候选图不会自动关联/);
  assert.doesNotMatch(html, /一键生图并关联/);
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
  assert.match(html, /button[^>]*desktop-asset-start[^>]*disabled=""/);
  assert.doesNotMatch(html, /<img|<iframe|<video|api-key|Authorization/);
  assert.doesNotMatch(html, /辅助功能|桌面助手|已登录豆包工作台|豆包窗口/);
});

test('structured visual brief exposes facts, evidence IDs, design boundaries and pending confirmations', () => {
  const html = renderToStaticMarkup(createElement(DesktopVisualBriefView, { brief: visualBrief }));
  assert.match(html, /asset-visual-brief\/v1/); assert.match(html, /置信度 100%/);
  assert.match(html, /身穿普通外套/); assert.match(html, /evidence-1/); assert.match(html, /小林走进门/);
  assert.match(html, /presentation/); assert.match(html, /单一人物完整展示/);
  assert.match(html, /不得改变已确认服装/); assert.match(html, /鞋子样式待确认/);
  assert.doesNotMatch(html, /undefined/);
});

test('unavailable image connection is visibly blocked and dialogue has no asset generation UI', () => {
  const props = { item, revision, editable: true, dirty: false, busy: false, assetDraftDirty: false,
    desktop: { status: { ...status, available: false, code: 'invalid_credentials' }, tasks: [], loading: false, error: '', refresh() {} } };
  const html = renderToStaticMarkup(createElement(DesktopAssetGeneration, props));
  assert.match(html, /生图连接未就绪/); assert.match(html, /工作台设置/);
  assert.equal(renderToStaticMarkup(createElement(DesktopAssetGeneration, { ...props, item: { ...item, kind: 'dialogue' } })), '');
});

test('unknown/failed and needsReview task cards are honest about reconciliation and conflicts', () => {
  for (const taskStatus of ['unknown', 'failed']) {
    const html = renderToStaticMarkup(createElement(DesktopTaskCard, { task: { ...task, status: taskStatus }, busy: false, onReconcile() {} }));
    assert.match(html, /未自动重试/);
    if (taskStatus === 'unknown') {
      assert.match(html, /检查已有结果并导回/); assert.match(html, /只核对本次任务，不重新生图/);
    } else assert.doesNotMatch(html, /检查已有结果并导回/);
    assert.doesNotMatch(html, /已导回并关联/);
    if (taskStatus === 'failed') assert.match(html, /仅提交前停止可再次尝试；已有提交记录不重发/);
  }
  const review = renderToStaticMarkup(createElement(DesktopTaskCard, { task: { ...task, status: 'needsReview', assetId: 'asset_1' }, busy: false, onReconcile() {} }));
  assert.match(review, /小说版本.*资产关联可能已变化/); assert.match(review, /上次接受未能在原基准完成/);
  assert.match(review, /旧候选.*不能直接关联/); assert.match(review, /重新生成候选/);
  assert.match(review, /另行导入或登记/); assert.doesNotMatch(review, /手动关联/);
});

test('awaiting-review candidate shows local pixels, provenance and explicit accept/reject controls', () => {
  const html = renderToStaticMarkup(createElement(DesktopTaskCard, {
    task: { ...task, status: 'awaitingReview', assetId: candidate.assetId, candidate }, busy: false,
    onReconcile() {}, onDecision() {},
  }));
  assert.match(html, /src="\/api\/assets\/asset_1\/content"/);
  assert.match(html, /Seedream5\.0Pro/); assert.match(html, /asset-generation-prompt\/v1/);
  assert.match(html, /image\/png/); assert.match(html, /2\.0 KB/); assert.match(html, /SHA-256 a{16}…/);
  assert.match(html, /确认并关联/); assert.match(html, /拒绝此候选/);
  assert.match(html, /只有确认后才会关联/);
  assert.doesNotMatch(html, /已导回并关联/);
});

test('accepted and rejected candidate cards retain history but expose no second decision', () => {
  for (const taskStatus of ['accepted', 'rejected']) {
    const html = renderToStaticMarkup(createElement(DesktopTaskCard, {
      task: { ...task, status: taskStatus, assetId: candidate.assetId,
        candidate: { ...candidate, status: taskStatus, reviewNote: '已审核' } },
      busy: false, onReconcile() {}, onDecision() {},
    }));
    assert.match(html, /审核备注：已审核/);
    assert.doesNotMatch(html, /<textarea/);
  }
  for (const mismatched of [
    { ...task, status: 'awaitingReview', candidate: { ...candidate, status: 'needsReview' } },
    { ...task, status: 'accepted', candidate: { ...candidate, status: 'awaitingReview' } },
  ]) {
    const html = renderToStaticMarkup(createElement(DesktopTaskCard, {
      task: mismatched, busy: false, onReconcile() {}, onDecision() {},
    }));
    assert.doesNotMatch(html, /<textarea/); assert.doesNotMatch(html, />确认并关联</);
  }
});

test('image requests use explicit local POST and do not retry failures', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, options) => { calls.push([path, options]); return { ok: false, status: 409, json: async () => ({ error: { message: '基准已变化' } }) }; };
  try {
    await assert.rejects(() => helpers.desktopAssetApi('/api/novel-revisions/revision/asset-generation', {
      itemId: item.id, expectedRevisionId: revision.id, intentId: 'intent-1', allowExistingCredits: true,
    }), /基准已变化/);
    assert.equal(calls.length, 1); assert.equal(calls[0][1].method, 'POST');
    assert.equal(calls[0][1].headers['X-Shortdrama-Call'], '1');
    assert.deepEqual(JSON.parse(calls[0][1].body), { itemId: 'person', expectedRevisionId: 'revision', intentId: 'intent-1', allowExistingCredits: true });
  } finally { globalThis.fetch = originalFetch; }
});

test('generation approval is bound to the exact image model connection when status provides a revision', () => {
  assert.deepEqual(helpers.desktopGenerationRequest(item.id, revision.id, status, 'intent-1'), {
    itemId: 'person', expectedRevisionId: 'revision', intentId: 'intent-1', allowExistingCredits: true,
    expectedModelConnectionRevision: 'connection-revision-1',
  });
  assert.deepEqual(helpers.desktopGenerationRequest(item.id, revision.id, { ...status, connectionRevision: undefined }, 'intent-2'), {
    itemId: 'person', expectedRevisionId: 'revision', intentId: 'intent-2', allowExistingCredits: true,
  });
  assert.deepEqual(helpers.desktopDecisionRequest('accept', revision.id, '  符合人物设定  '), {
    decision: 'accept', expectedRevisionId: 'revision', note: '符合人物设定',
  });
  const firstIntent = helpers.createDesktopGenerationIntentId();
  const secondIntent = helpers.createDesktopGenerationIntentId();
  assert.match(firstIntent, /^asset-generation-[a-f0-9-]+$/); assert.notEqual(firstIntent, secondIntent);
});

test('a missing POST response times out into reconciliation without sending a second request', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_path, options) => {
    requests += 1;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  try {
    const pending = helpers.desktopAssetApi('/api/novel-revisions/revision/asset-generation', {
      itemId: 'person', expectedRevisionId: 'revision', intentId: 'intent-stable', allowExistingCredits: true,
    });
    context.mock.timers.tick(20000);
    await assert.rejects(() => pending, /提交结果需通过已保存任务核对/);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = originalFetch; context.mock.timers.reset(); }
});
