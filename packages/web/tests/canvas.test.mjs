import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const {
  canvasProgress, layoutCanvas, runtimeStates, summarizeDependencies, topologicalColumns,
  nodeStatusBadge, STATE_LABELS,
} = await server.ssrLoadModule('/src/canvas/view.ts');

const workspaceId = 'ws_00000000000000000000000000000000';
const projectId = 'prj_canvas_test';

function node(id, nodeType, title, x, y, extra = {}) {
  return {
    id, nodeType, title, position: { x, y }, groupId: null, collapsed: false,
    metadata: {}, resource: null, ...extra,
  };
}

const graph = {
  schemaVersion: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    node('n_shot_1', 'source', '镜头 1', 10, 10, {
      groupId: 'n_group',
      resource: { resourceType: 'shotSpec', resourceId: 'shot_1', versionId: 'sbv_1', digest: null, workspaceId, projectId },
      metadata: { shotId: 'shot_1', order: 1, durationMs: 3000 },
    }),
    node('n_gen_1', 'generation', '镜头 1 生成', 300, 10, { metadata: { order: 1 } }),
    node('n_gate_1', 'gate', '人工检查点', 600, 10, { metadata: { order: 1 } }),
    node('n_note', 'annotation', '批注', 300, 160),
    node('n_group', 'group', '第一场', 0, 0),
  ],
  edges: [
    { id: 'e_1', edgeType: 'consumes', sourceNodeId: 'n_shot_1', targetNodeId: 'n_gen_1' },
    { id: 'e_2', edgeType: 'requires', sourceNodeId: 'n_gen_1', targetNodeId: 'n_gate_1' },
  ],
};

const runtime = {
  revisionId: 'canvasrev_1', revision: 1, cursor: 'evt_1', generatedAt: '2026-11-09T00:00:00Z',
  nodes: [
    { nodeId: 'n_gen_1', state: 'running', message: null, sourceAggregateId: null, sourceRevision: null, observedAt: 'now' },
    { nodeId: 'n_gate_1', state: 'waitingHuman', message: null, sourceAggregateId: null, sourceRevision: null, observedAt: 'now' },
  ],
};

test('topological columns follow dependencies and never drop cycle members', () => {
  const columns = topologicalColumns(graph);
  assert.equal(columns.get('n_shot_1'), 0);
  assert.equal(columns.get('n_gen_1'), 1);
  assert.equal(columns.get('n_gate_1'), 2);
  assert.equal(columns.size, graph.nodes.length);

  const cyclic = {
    ...graph,
    edges: [
      { id: 'c_1', edgeType: 'consumes', sourceNodeId: 'n_shot_1', targetNodeId: 'n_gen_1' },
      { id: 'c_2', edgeType: 'consumes', sourceNodeId: 'n_gen_1', targetNodeId: 'n_shot_1' },
    ],
  };
  const cyclicColumns = topologicalColumns(cyclic);
  assert.equal(cyclicColumns.size, cyclic.nodes.length);
  assert.ok(cyclicColumns.get('n_shot_1') >= 1 && cyclicColumns.get('n_gen_1') >= 1);
});

test('layout projects the backend graph without inventing client-side state', () => {
  const layout = layoutCanvas(graph, runtime);
  assert.equal(layout.nodes.length, graph.nodes.length);
  assert.equal(layout.edges.length, graph.edges.length);
  assert.ok(layout.width >= 480 && layout.height >= 320);

  const generation = layout.nodes.find(item => item.id === 'n_gen_1');
  assert.equal(generation.x, 300);
  assert.equal(generation.state, 'running');
  assert.equal(generation.stateLabel, STATE_LABELS.running);
  assert.equal(generation.tone, 'active');
  assert.equal(generation.shotId, null);
  assert.equal(layout.nodes.find(item => item.id === 'n_shot_1').shotId, 'shot_1');

  // 没有运行覆盖的节点默认 unknown，绝不推断为成功。
  const note = layout.nodes.find(item => item.id === 'n_note');
  assert.equal(note.state, 'unknown');
  assert.equal(note.stateLabel, '未运行');

  // group 节点投影为背景框，不参与状态统计。
  assert.equal(layout.groups.length, 1);
});

test('layout falls back to a stable grid only when the backend omits positions', () => {
  const bare = {
    ...graph,
    nodes: [
      { ...graph.nodes[0], position: { x: 0, y: 0 } },
      { ...graph.nodes[1], position: { x: 0, y: 0 } },
    ],
    edges: [],
  };
  const layout = layoutCanvas(bare, null);
  for (const item of layout.nodes) {
    assert.ok(item.x > 0 && item.y > 0);
    assert.equal(item.state, 'unknown');
  }
});

test('dependency summary and progress derive strictly from persisted revision facts', () => {
  const dependencies = summarizeDependencies(graph, 'n_gen_1');
  assert.deepEqual(dependencies.upstream, ['镜头 1']);
  assert.deepEqual(dependencies.downstream, ['人工检查点']);
  assert.deepEqual(summarizeDependencies(graph, 'n_note'), { upstream: [], downstream: [] });

  const states = runtimeStates(graph, runtime);
  assert.equal(states.get('n_gen_1'), 'running');
  assert.equal(states.get('n_shot_1'), 'unknown');
  assert.deepEqual(canvasProgress(graph, runtime), { total: 5, succeeded: 0, failed: 0, running: 1, waitingHuman: 1 });
  assert.deepEqual(canvasProgress(graph, null), { total: 5, succeeded: 0, failed: 0, running: 0, waitingHuman: 0 });
});


test('layout carries backend queue, progress and artifact facts without inventing them', () => {
  const live = {
    ...runtime,
    nodes: [
      { nodeId: 'n_gen_1', state: 'running', message: '渲染进行中 62%', sourceAggregateId: 'run_1',
        sourceRevision: 1, observedAt: 'now', stage: 'video', progressPercent: 62, queuePosition: null,
        runStatus: 'running', artifact: null },
      { nodeId: 'n_gate_1', state: 'pending', message: '排队中 · 第 3 位', sourceAggregateId: 'run_1',
        sourceRevision: 1, observedAt: 'now', stage: null, progressPercent: 0, queuePosition: 3,
        runStatus: 'queued', artifact: { id: 'art_1', kind: 'video', title: '镜头 1 成片',
          uri: '/api/production-media/media_1' } },
    ],
    run: { id: 'run_1', status: 'running',
      queue: { pending: 2, ready: 0, running: 1, waitingHuman: 0, failed: 0 },
      stages: [{ key: 'video', state: 'running', completed: 3, total: 5 }],
      delivery: null },
  };
  const layout = layoutCanvas(graph, live);
  const generation = layout.nodes.find(item => item.id === 'n_gen_1');
  assert.equal(generation.stage, 'video');
  assert.equal(generation.progressPercent, 62);
  assert.equal(generation.runStatus, 'running');
  assert.equal(generation.artifact, null);
  const gate = layout.nodes.find(item => item.id === 'n_gate_1');
  assert.equal(gate.queuePosition, 3);
  assert.equal(gate.artifact.uri, '/api/production-media/media_1');
  // 后端未给出运行覆盖的节点必须保持 null，不能由前端补齐。
  const note = layout.nodes.find(item => item.id === 'n_note');
  assert.equal(note.progressPercent, null);
  assert.equal(note.queuePosition, null);
  assert.equal(note.artifact, null);
});

test('node status badge prefers the strongest backend fact', () => {
  const base = { artifact: null, queuePosition: null, progressPercent: null, stage: null,
    state: 'unknown', stateLabel: '未运行' };
  assert.equal(nodeStatusBadge({ ...base, state: 'succeeded', stateLabel: '已完成' }), '已完成');
  assert.equal(nodeStatusBadge({ ...base, state: 'pending', stateLabel: '待执行', queuePosition: 2 }), '排队第 2 位');
  assert.equal(nodeStatusBadge({ ...base, state: 'running', stateLabel: '执行中', progressPercent: 45, stage: 'video' }), '渲染 45%');
  assert.equal(nodeStatusBadge({ ...base, state: 'failed', stateLabel: '失败', artifact: { id: 'a', kind: 'video', title: 't', uri: '/u' } }), '成片可回显');
  assert.equal(nodeStatusBadge(base), '未运行');
});
