const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { lineageNodeId } = require('@lyra/shared');
const { createDataEvent } = require('../dist/data/event');
const { InMemoryLineageStore } = require('../dist/lineage/store');
const { LineageProjector } = require('../dist/lineage/projector');
const { LineageQueryService } = require('../dist/lineage/query');

const d64 = s => crypto.createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------------------
// 夹具：一条 小说 revision -> 剧本 -> 计划/分镜 -> 资产 -> run/task/attempt/
// external op -> artifact -> quality/review -> timeline -> delivery 的权威链。
// ---------------------------------------------------------------------------
function input(kind, businessId, edgeType, overrides = {}) {
  return {
    kind, businessId, revisionId: null, edgeType,
    factIsTo: true, present: true, digest: d64(businessId),
    ref: { kind: `${kind}s`, id: businessId, revisionId: null },
    ...overrides,
  };
}

function fact(kind, id, inputs = [], overrides = {}) {
  return {
    kind, businessId: id, revisionId: null,
    ref: { kind: `${kind}s`, id, revisionId: null },
    digest: d64(id),
    occurredAt: '2026-11-03T00:00:00.000Z',
    recordedAt: '2026-11-03T00:00:01.000Z',
    retention: 'project_lifetime', visibility: 'internal',
    authorization: 'project:read',
    inputs,
    ...overrides,
  };
}

const FACT = {};
FACT.novel = fact('novel_revision', 'novelrev_0001');
FACT.script = fact('script_version', 'script_0001',
  [input('novel_revision', 'novelrev_0001', 'derived-from')]);
FACT.plan = fact('plan_revision', 'plan_0001',
  [input('script_version', 'script_0001', 'derived-from')]);
FACT.storyboard = fact('storyboard_revision', 'storyboard_0001', [
  input('plan_revision', 'plan_0001', 'derived-from'),
  // 缺失上游：形成 unknown gap，不猜关系
  input('novel_revision', 'missing_novel', 'derived-from', { present: false, digest: undefined }),
]);
FACT.asset = fact('asset', 'asset_0001', [], { authorization: 'asset:read' });
FACT.run = fact('production_run', 'run_0001', [
  input('storyboard_revision', 'storyboard_0001', 'used-by'),
  input('asset', 'asset_0001', 'used-by'),
]);
FACT.task = fact('production_task', 'task_0001',
  [input('production_run', 'run_0001', 'derived-from')]);
FACT.attempt = fact('production_attempt', 'attempt_0001',
  [input('production_task', 'task_0001', 'derived-from')]);
FACT.op = fact('external_operation', 'op_0001',
  [input('production_attempt', 'attempt_0001', 'derived-from')]);
FACT.artifact = fact('artifact', 'artifact_0001',
  [input('external_operation', 'op_0001', 'generated-by')]);
FACT.check = fact('quality_check', 'check_0001',
  [input('artifact', 'artifact_0001', 'validated-by', { factIsTo: false })]);
FACT.review = fact('review_decision', 'review_0001',
  [input('artifact', 'artifact_0001', 'validated-by', { factIsTo: false })],
  { digestMismatch: { expected: d64('review_0001'), actual: d64('review_changed') } });
FACT.timeline = fact('timeline_revision', 'timeline_0001',
  [input('artifact', 'artifact_0001', 'used-by')]);
FACT.delivery = fact('delivery', 'delivery_0001', [
  input('timeline_revision', 'timeline_0001', 'derived-from'),
  input('artifact', 'artifact_0001', 'delivered-as'),
]);
// orphan：声明了上游但全部缺失
FACT.ghost = fact('quality_check', 'ghost_check_0001',
  [input('artifact', 'missing_artifact', 'validated-by', { factIsTo: false, present: false, digest: undefined })]);

class FixtureReader {
  async resolve(event) {
    return FACT[event.aggregateId] ?? null;
  }
}

let version = 0;
function makeEvent(id) {
  version += 1;
  return createDataEvent({
    eventType: 'lineage.fact.recorded',
    aggregateType: 'production_run',
    aggregateId: id,
    aggregateVersion: version,
    occurredAt: '2026-11-03T00:00:00.000Z',
    recordedAt: '2026-11-03T00:00:01.000Z',
    correlationId: `corr-${id}-${version}`,
    authoritativeRef: { kind: 'fixture', id, revisionId: null, digest: d64(id) },
    payload: {},
  });
}

const ORDER = ['novel', 'script', 'plan', 'storyboard', 'asset', 'run', 'task',
  'attempt', 'op', 'artifact', 'check', 'review', 'timeline', 'delivery', 'ghost'];

async function projectChain(store, consumer = 'lineage-test') {
  const projector = new LineageProjector(consumer, store, new FixtureReader());
  const results = [];
  for (const key of ORDER) {
    results.push(await projector.deliver(makeEvent(FACT[key].businessId)));
  }
  return { projector, results };
}

test('完整链路投影：小说->剧本->计划/分镜->资产->run/task/attempt/外部操作->产物->检查/复核->时间线->交付', async () => {
  const store = new InMemoryLineageStore();
  const { results } = await projectChain(store);
  assert.ok(results.every(r => r.status === 'projected'), results.map(r => r.status).join(','));
  const nodes = await store.listNodes();
  const edges = await store.listEdges();
  // 15 个事实节点 + 1 个 unknown 占位（missing_novel）
  assert.equal(nodes.length, ORDER.length + 1);
  assert.ok(edges.length >= 14, '至少覆盖主链每条边');
});

test('正向追踪下游与反向溯源上游都能走通整条链', async () => {
  const store = new InMemoryLineageStore();
  await projectChain(store);
  const query = new LineageQueryService(store);
  const allScopes = ['project:read', 'asset:read'];

  const novelId = lineageNodeId('novel_revision', 'novelrev_0001', null);
  const forward = await query.traverse(novelId, 'downstream', { maxDepth: 10, allowedScopes: allScopes });
  const kinds = new Set(forward.nodes.map(n => n.kind));
  for (const expected of ['script_version', 'plan_revision', 'storyboard_revision', 'production_run',
    'production_task', 'production_attempt', 'external_operation', 'artifact', 'timeline_revision', 'delivery']) {
    assert.ok(kinds.has(expected), `下游应包含 ${expected}`);
  }

  const deliveryId = lineageNodeId('delivery', 'delivery_0001', null);
  const back = await query.traverse(deliveryId, 'upstream', { maxDepth: 10, allowedScopes: allScopes });
  const backKinds = new Set(back.nodes.map(n => n.kind));
  for (const expected of ['artifact', 'external_operation', 'production_attempt', 'production_task',
    'production_run', 'storyboard_revision', 'plan_revision', 'script_version', 'novel_revision']) {
    assert.ok(backKinds.has(expected), `上游应包含 ${expected}`);
  }
});

test('重复 replay 不产生重复节点/边，历史回填按权威身份幂等', async () => {
  const store = new InMemoryLineageStore();
  await projectChain(store);
  const beforeNodes = (await store.listNodes()).length;
  const beforeEdges = (await store.listEdges()).length;

  // 同一消费者重放全部事件
  const again = await projectChain(store, 'lineage-test');
  assert.ok(again.results.every(r => r.status === 'duplicate'),
    again.results.map(r => r.status).join(','));
  assert.equal((await store.listNodes()).length, beforeNodes);
  assert.equal((await store.listEdges()).length, beforeEdges);

  // 历史回填：换一个消费者命名空间，但同一权威身份 -> 节点/边不重复
  version = 0;
  const backfill = await projectChain(store, 'lineage-backfill');
  assert.ok(backfill.results.every(r => r.status === 'projected' || r.status === 'duplicate'));
  assert.equal((await store.listNodes()).length, beforeNodes, '回填不新增节点');
  assert.equal((await store.listEdges()).length, beforeEdges, '回填不新增边');
});

test('unknown / orphan / digest gap 都可见，且不回写业务事实', async () => {
  const store = new InMemoryLineageStore();
  await projectChain(store);
  const nodes = await store.listNodes();
  const gapByKind = {};
  for (const n of nodes) if (n.gap) (gapByKind[n.gap.type] ??= []).push(n);
  assert.ok(gapByKind.unknown?.length >= 1, '应有 unknown 占位节点');
  assert.equal(gapByKind.orphan?.[0]?.businessId, 'ghost_check_0001');
  assert.equal(gapByKind.digest?.[0]?.businessId, 'review_0001');
  assert.match(gapByKind.digest[0].gap.reason, /摘要/);
});

test('越权上游只形成受限 permission gap，不泄露节点详情', async () => {
  const store = new InMemoryLineageStore();
  await projectChain(store);
  const query = new LineageQueryService(store);
  const runId = lineageNodeId('production_run', 'run_0001', null);

  const restricted = await query.traverse(runId, 'upstream',
    { maxDepth: 5, allowedScopes: ['project:read'] });
  // asset 需要 asset:read：不出现详情节点，只出现受限 gap
  assert.equal(restricted.nodes.some(n => n.kind === 'asset'), false);
  assert.equal(restricted.permissionGaps.length, 1);
  assert.equal(restricted.permissionGaps[0].gap.type, 'permission');
  assert.equal(restricted.permissionGaps[0].digest, undefined, '受限 gap 不含摘要');
  assert.ok(restricted.nodes.some(n => n.kind === 'storyboard_revision'), '有权限的上游正常返回');

  const granted = await query.traverse(runId, 'upstream',
    { maxDepth: 5, allowedScopes: ['project:read', 'asset:read'] });
  assert.equal(granted.nodes.some(n => n.kind === 'asset'), true);
  assert.equal(granted.permissionGaps.length, 0);
});

test('查询有深度上限，且环不会导致无限遍历', async () => {
  const store = new InMemoryLineageStore();
  await projectChain(store);
  const query = new LineageQueryService(store);
  const novelId = lineageNodeId('novel_revision', 'novelrev_0001', null);

  const shallow = await query.traverse(novelId, 'downstream',
    { maxDepth: 2, allowedScopes: ['project:read', 'asset:read'] });
  // 深度 2：script(d1)、plan(d2)；不应到达 storyboard(d3)
  assert.equal(shallow.nodes.some(n => n.kind === 'storyboard_revision'), false);
  assert.ok(shallow.nodes.some(n => n.kind === 'plan_revision'));

  // 手工注入一个有向环 A<->B，验证 visited 防环且能终止
  const A = { nodeId: lineageNodeId('asset', 'cycle_a', null), kind: 'asset',
    ref: { kind: 'assets', id: 'cycle_a', revisionId: null }, businessId: 'cycle_a',
    revisionId: null, digest: d64('cycle_a'), schemaVersion: 'lyra.lineage.node/v1',
    occurredAt: '2026-11-03T00:00:00.000Z', recordedAt: '2026-11-03T00:00:01.000Z',
    retention: 'run_lifetime', visibility: 'internal', authorization: 'project:read', gap: null };
  const B = { ...A, nodeId: lineageNodeId('asset', 'cycle_b', null), businessId: 'cycle_b', digest: d64('cycle_b') };
  const edgeAB = { edgeId: 'le_' + crypto.createHash('sha256')
      .update('used-by:' + A.nodeId + ':' + B.nodeId).digest('hex').slice(0, 32),
    edgeType: 'used-by', fromNodeId: A.nodeId, toNodeId: B.nodeId, sourceEventId: null,
    edgeDigest: d64('ab'), recordedAt: '2026-11-03T00:00:01.000Z' };
  const edgeBA = { ...edgeAB,
    edgeId: 'le_' + crypto.createHash('sha256')
      .update('derived-from:' + B.nodeId + ':' + A.nodeId).digest('hex').slice(0, 32),
    edgeType: 'derived-from', fromNodeId: B.nodeId, toNodeId: A.nodeId };
  const loopEvent = createDataEvent({
    eventType: 'lineage.fact.recorded', aggregateType: 'asset', aggregateId: 'cycle_a',
    aggregateVersion: 1, occurredAt: '2026-11-03T00:00:00.000Z',
    recordedAt: '2026-11-03T00:00:01.000Z', correlationId: 'corr-cycle',
    authoritativeRef: { kind: 'fixture', id: 'cycle_a', revisionId: null, digest: d64('cycle_a') },
    payload: {} });
  await store.commit('lineage-test', loopEvent, { nodes: [A, B], edges: [edgeAB, edgeBA] });
  const loopTraverse = await query.traverse(A.nodeId, 'downstream',
    { maxDepth: 10, allowedScopes: ['project:read'] });
  assert.equal(loopTraverse.visitedCount, 2, '环只访问两个节点一次');
});
