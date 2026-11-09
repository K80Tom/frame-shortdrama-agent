const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { LINEAGE_MIGRATIONS } = require('../dist/db/readiness');

test('026 建立血缘节点/边/事件台账、唯一约束与双向索引，且不动 024/evaluator', () => {
  const sql = readFileSync(join(__dirname, '../migrations/026_unified_lineage.sql'), 'utf8');
  for (const table of ['lineage_nodes', 'lineage_edges', 'lineage_events']) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}`));
  }
  // 节点权威身份唯一（revision 可空时归并）
  assert.match(sql, /CREATE UNIQUE INDEX lineage_node_identity/);
  // 边防重复
  assert.match(sql, /lineage_edge_unique UNIQUE \(edge_type, from_node_id, to_node_id\)/);
  // 双向索引
  assert.match(sql, /CREATE INDEX lineage_edge_forward_idx/);
  assert.match(sql, /CREATE INDEX lineage_edge_reverse_idx/);
  // 不可变触发器
  assert.match(sql, /CREATE TRIGGER lineage_node_immutable_trigger/);
  assert.match(sql, /CREATE TRIGGER lineage_edge_immutable_trigger/);
  for (const kind of ['derived-from', 'used-by', 'generated-by', 'validated-by', 'supersedes', 'delivered-as']) {
    assert.match(sql, new RegExp(`'${kind}'`));
  }
  for (const gap of ['unknown', 'orphan', 'digest', 'permission']) {
    assert.match(sql, new RegExp(`'${gap}'`));
  }
  // 不复制正文：节点只有引用/摘要，不出现 content/raw_text/media_bytes 列。
  assert.doesNotMatch(sql, /\b(raw_text|content|media_bytes|prompt_snapshot)\b/u);
  assert.deepEqual([...LINEAGE_MIGRATIONS], ['026']);
});
