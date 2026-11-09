const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  LINEAGE_EDGE_TYPES,
  LineageContractError,
  canReadNode,
  lineageEdgeDigest,
  lineageEdgeId,
  lineageNodeDigest,
  lineageNodeId,
  parseLineageEdge,
  parseLineageNode,
} = require('@lyra/shared');

const hex = value => value.repeat(64);

function nodeFixture(overrides = {}) {
  return {
    nodeId: 'ln_' + 'a'.repeat(32),
    kind: 'script_version',
    ref: { kind: 'script_versions', id: 'script_0001', revisionId: 'rev_0001' },
    businessId: 'script_0001',
    revisionId: 'rev_0001',
    digest: hex('b'),
    schemaVersion: 'lyra.lineage.node/v1',
    occurredAt: '2026-11-03T00:00:00.000Z',
    recordedAt: '2026-11-03T00:00:01.000Z',
    retention: 'project_lifetime',
    visibility: 'internal',
    authorization: 'project:read',
    gap: null,
    ...overrides,
  };
}

function edgeFixture(overrides = {}) {
  const from = 'ln_' + 'a'.repeat(32);
  const to = 'ln_' + 'b'.repeat(32);
  return {
    edgeId: lineageEdgeId('derived-from', from, to),
    edgeType: 'derived-from',
    fromNodeId: from,
    toNodeId: to,
    sourceEventId: 'evt_' + 'c'.repeat(32),
    edgeDigest: lineageEdgeDigest({ edgeType: 'derived-from', fromNodeId: from, toNodeId: to }),
    recordedAt: '2026-11-03T00:00:01.000Z',
    ...overrides,
  };
}

test('节点身份与边身份确定性复算，重复关系得到同一 ID', () => {
  const a = lineageNodeId('novel_revision', 'novel_0001', 'rev_0001');
  const b = lineageNodeId('novel_revision', 'novel_0001', 'rev_0001');
  assert.equal(a, b);
  assert.notEqual(lineageNodeId('novel_revision', 'novel_0002', null), a);
  const e1 = lineageEdgeId('derived-from', a, lineageNodeId('script_version', 's1', null));
  const e2 = lineageEdgeId('derived-from', a, lineageNodeId('script_version', 's1', null));
  assert.equal(e1, e2);
  // 反向不产生同一逻辑边（语义方向统一）
  assert.notEqual(lineageEdgeId('derived-from',
    lineageNodeId('script_version', 's1', null), a), e1);
});

test('节点/边摘要对字段顺序不敏感，越权判断按 scope', () => {
  const node = parseLineageNode(nodeFixture());
  const same = parseLineageNode({ ...nodeFixture(),
    ref: { revisionId: 'rev_0001', id: 'script_0001', kind: 'script_versions' } });
  assert.equal(lineageNodeDigest(node), lineageNodeDigest(same));
  assert.equal(canReadNode({ authorization: 'project:read' }, ['project:read']), true);
  assert.equal(canReadNode({ authorization: 'asset:read' }, ['project:read']), false);
});

test('自环边、伪造边 ID、缺摘要、未知类型都被拒绝', () => {
  assert.throws(() => parseLineageEdge(edgeFixture({ toNodeId: edgeFixture().fromNodeId })),
    /自环/);
  const badEdge = edgeFixture();
  badEdge.edgeId = 'le_' + 'd'.repeat(32);
  assert.throws(() => parseLineageEdge(badEdge), /不一致/);
  const noDigest = nodeFixture();
  delete noDigest.digest;
  noDigest.digest = null;
  assert.throws(() => parseLineageNode(noDigest), /权威摘要/);
  const badKind = nodeFixture({ kind: 'not_a_kind' });
  assert.throws(() => parseLineageNode(badKind), LineageContractError);
});

test('六种边类型与四种 gap 类型均被识别', () => {
  assert.equal(LINEAGE_EDGE_TYPES.length, 6);
  const gapNode = parseLineageNode(nodeFixture({
    digest: null,
    gap: { type: 'unknown', reason: '找不到上游。' },
  }));
  assert.equal(gapNode.gap.type, 'unknown');
  const digestGap = parseLineageNode(nodeFixture({
    digest: null,
    gap: { type: 'digest', reason: '摘要不符', expectedDigest: hex('e'), actualDigest: hex('f') },
  }));
  assert.equal(digestGap.gap.expectedDigest, hex('e'));
});
