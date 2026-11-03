const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { EVALUATION_RUN_PERSISTENCE_MIGRATIONS } = require('../dist/db/readiness');

test('023 建立运行、attempt、sample 与 append-only 事件表', () => {
  const sql = readFileSync(join(__dirname, '../migrations/023_evaluation_run.sql'), 'utf8');
  for (const table of ['evaluation_runs', 'evaluation_case_attempts', 'evaluation_sample_attempts', 'evaluation_run_events']) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}`));
  }
  for (const trigger of ['evaluation_run_guard', 'evaluation_case_attempt_guard', 'evaluation_sample_attempt_guard',
    'evaluation_run_event_append_only']) {
    assert.match(sql, new RegExp(`CREATE FUNCTION ${trigger}`));
    assert.match(sql, new RegExp(`CREATE TRIGGER ${trigger}`));
  }
  assert.match(sql, /evaluation_run_idempotency UNIQUE \(idempotency_key\)/);
  assert.match(sql, /evaluation_case_attempt_identity UNIQUE \(run_id, case_id, attempt_number\)/);
  assert.match(sql, /evaluation_sample_attempt_identity UNIQUE \(case_attempt_id, sample_index\)/);
  assert.match(sql, /evaluation_run_event_identity UNIQUE \(run_id, sequence\)/);
  assert.doesNotMatch(sql, /REFERENCES production_/);
  assert.deepEqual([...EVALUATION_RUN_PERSISTENCE_MIGRATIONS], ['023']);
});
