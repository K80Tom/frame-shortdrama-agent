const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { DATA_OUTBOX_MIGRATIONS } = require('../dist/db/readiness');

test('024 建立统一 Outbox、聚合版本唯一与事件不可变约束', () => {
  const sql = readFileSync(join(__dirname, '../migrations/024_data_event_outbox.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE data_outbox_events/);
  for (const column of ['event_id', 'aggregate_type', 'aggregate_id', 'aggregate_version',
    'idempotency_key', 'authoritative_ref_json', 'payload_json', 'event_digest', 'legacy_source', 'legacy_event_id']) {
    assert.match(sql, new RegExp(`\\b${column}\\b`));
  }
  assert.match(sql, /data_outbox_aggregate_version_unique UNIQUE \(aggregate_type, aggregate_id, aggregate_version\)/);
  assert.match(sql, /data_outbox_legacy_identity UNIQUE \(legacy_source, legacy_event_id\)/);
  assert.match(sql, /CREATE TRIGGER data_outbox_event_immutable_trigger/);
  for (const table of ['data_consumer_records', 'data_projection_records',
    'data_consumer_checkpoints', 'data_dead_letters', 'data_quarantine_records']) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(sql, /data_projection_records[\s\S]*UNIQUE \(consumer_name, event_id\)/);
  assert.deepEqual([...DATA_OUTBOX_MIGRATIONS], ['024']);
});
