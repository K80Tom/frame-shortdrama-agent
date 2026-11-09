const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { EVALUATION_RESULTS_MIGRATIONS } = require('../dist/db/readiness');

test('047 建立租户化追加式评估结果表、证据/指标 jsonb 与 append-only 触发器', () => {
  const sql = readFileSync(join(__dirname, '../migrations/047_evaluator_protocol.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE evaluation_results/);
  assert.match(sql, /CREATE FUNCTION evaluation_results_append_only/);
  assert.match(sql, /CREATE TRIGGER evaluation_results_append_only_trigger/);
  // 幂等身份只在租户内唯一
  assert.match(sql, /evaluation_result_digest_workspace UNIQUE \(workspace_id, result_digest\)/);
  // 严格五态约束
  assert.match(sql, /status TEXT NOT NULL CHECK \(status IN \('pass', 'fail', 'uncertain', 'skipped', 'evaluator_error'\)\)/i);
  // 评估器自身异常与 error_json 同生共死
  assert.match(sql, /evaluation_result_error_state/);
  // 定位嵌套约束
  assert.match(sql, /evaluation_result_locator_nesting/);
  // 复用 023 的运行表，不新建第二套运行
  assert.match(sql, /evaluation_runs_workspace_run_uid ON evaluation_runs \(workspace_id, run_id\)/);
  assert.match(sql, /evaluation_result_run_ref FOREIGN KEY \(workspace_id, run_id\)/);
  // 租户四件套
  assert.match(sql, /ADD COLUMN workspace_id/);
  assert.match(sql, /lyra_workspace_scope_guard/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE POLICY lyra_workspace_isolation/);
  // 不触碰生产域
  assert.doesNotMatch(sql, /REFERENCES production_/);
  assert.doesNotMatch(sql, /CREATE TABLE (production_|novel_|plan_|storyboard_)/);
  assert.deepEqual([...EVALUATION_RESULTS_MIGRATIONS], ['047']);
});
