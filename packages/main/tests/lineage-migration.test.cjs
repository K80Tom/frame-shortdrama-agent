const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { LINEAGE_MIGRATIONS } = require('../dist/db/readiness');

test('048 建立租户化血缘节点/边/事件台账、唯一约束与双向索引，且不动 024/evaluator', () => {
  const sql = readFileSync(join(__dirname, '../migrations/048_unified_lineage.sql'), 'utf8');
  for (const table of ['lineage_nodes', 'lineage_edges', 'lineage_events']) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}`));
  }
  // 节点权威身份唯一（revision 可空时归并）
  assert.match(sql, /CREATE UNIQUE INDEX lineage_node_identity/);
  // 边防重复
  assert.match(sql, /lineage_edge_unique UNIQUE \(workspace_id, edge_type, from_node_id, to_node_id\)/);
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
  assert.deepEqual([...LINEAGE_MIGRATIONS], ['048']);
  // 租户化四件套：workspace 列、复合幂等键、scope guard 与 FORCE RLS 隔离策略。
  for (const table of ['lineage_nodes', 'lineage_edges', 'lineage_events']) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table}\\n  ADD COLUMN workspace_id`));
  }
  assert.match(sql, /lyra_workspace_scope_guard/);
  assert.match(sql, /ALTER TABLE %I FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE POLICY lyra_workspace_isolation/);
  assert.match(sql, /PRIMARY KEY \(workspace_id, consumer_name, event_id\)/);
  assert.match(sql, /lineage_nodes_workspace_node_identity UNIQUE \(workspace_id, node_id\)/);
  assert.match(sql, /lineage_edge_from_workspace FOREIGN KEY \(workspace_id, from_node_id\)/);
  // 镜头与生产输入是 #133 剧本→镜头→资产→成片链的必要节点类型。
  for (const kind of ['shot_spec', 'production_input']) {
    assert.match(sql, new RegExp(`'${kind}'`));
  }
});
