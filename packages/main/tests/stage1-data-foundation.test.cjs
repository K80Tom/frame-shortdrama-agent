const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { dataEventDigest } = require('@lyra/shared');
const { createDataEvent } = require('../dist/data/event');
const {
  TENANT_DATA_EVENT_SCHEMA_VERSION,
  createDataEventV2,
  parseDataEventV2,
  parseTenantDataEvent,
  tenantDataEventDigest,
} = require('../dist/data/tenant-event');
const { InMemoryProjectionStore } = require('../dist/data/checkpoint');
const { DataProjector } = require('../dist/data/projector');
const {
  LEGACY_WORKSPACE_ID,
  TenantContextError,
  parseTenantContext,
} = require('../dist/tenancy/context');

const workspace = char => `ws_${char.repeat(32)}`;
const aggregateId = `production_${'b'.repeat(32)}`;
const authority = { kind: 'production_run', id: aggregateId, revisionId: null, digest: 'c'.repeat(64) };

function v1Fixture() {
  return createDataEvent({
    eventId: `evt_${'a'.repeat(32)}`,
    eventType: 'production.run.status_changed',
    aggregateType: 'production_run',
    aggregateId,
    aggregateVersion: 1,
    occurredAt: '2026-11-08T00:00:00.000Z',
    recordedAt: '2026-11-08T00:00:01.000Z',
    correlationId: 'corr-stage1-0001',
    causationId: null,
    idempotencyKey: 'production:golden:v1:0001',
    authoritativeRef: authority,
    payload: { status: 'queued' },
  });
}

function v2Fixture(workspaceId, status = 'queued') {
  return createDataEventV2({
    workspaceId,
    eventType: 'production.run.status_changed',
    aggregateType: 'production_run',
    aggregateId,
    aggregateVersion: 1,
    occurredAt: '2026-11-08T00:00:00.000Z',
    recordedAt: '2026-11-08T00:00:01.000Z',
    correlationId: `corr-${workspaceId.slice(-8)}`,
    authoritativeRef: authority,
    payload: { status },
  });
}

test('DataEventV1 golden digest remains unchanged after V2 is introduced', () => {
  const event = v1Fixture();
  assert.equal(dataEventDigest(event), 'f2c2cf759619626789fbe1c4df4498405a9060bb1c403f2835c9cc74435378b6');
  assert.equal(tenantDataEventDigest(parseTenantDataEvent(event)), dataEventDigest(event));
  assert.equal('workspaceId' in event, false);
});

test('DataEventV2 signs workspaceId and rejects unknown fields', () => {
  const one = v2Fixture(workspace('1'));
  const two = { ...one, workspaceId: workspace('2') };
  assert.equal(one.schemaVersion, TENANT_DATA_EVENT_SCHEMA_VERSION);
  assert.notEqual(tenantDataEventDigest(one), tenantDataEventDigest(parseDataEventV2(two)));
  assert.throws(() => parseDataEventV2({ ...one, surprise: true }), /契约校验失败/u);
  assert.equal(createDataEventV2({ ...one, workspaceId: LEGACY_WORKSPACE_ID }).workspaceId,
    LEGACY_WORKSPACE_ID);
});

test('projector versions the same aggregate independently in two workspaces', async () => {
  const store = new InMemoryProjectionStore();
  const projector = new DataProjector('stage1-tenant-projector', store);
  const one = v2Fixture(workspace('1'));
  const two = v2Fixture(workspace('2'));
  assert.equal((await projector.deliver(one)).status, 'projected');
  assert.equal((await projector.deliver(two)).status, 'projected');
  const rows = await store.listProjections('stage1-tenant-projector');
  assert.deepEqual(rows.map(row => row.workspaceId).sort(), [workspace('1'), workspace('2')]);
});

test('runtime TenantContext allows an adopted legacy workspace but rejects the migration principal', () => {
  const valid = parseTenantContext({
    userId: `usr_${'1'.repeat(32)}`,
    workspaceId: workspace('1'),
    role: 'owner',
    requestId: 'request-stage1-0001',
  });
  assert.equal(valid.workspaceId, workspace('1'));
  assert.equal(parseTenantContext({ ...valid, workspaceId: LEGACY_WORKSPACE_ID }).workspaceId,
    LEGACY_WORKSPACE_ID);
  assert.throws(() => parseTenantContext({ ...valid,
    userId: `usr_${'0'.repeat(32)}`, workspaceId: LEGACY_WORKSPACE_ID }), error => {
    assert.ok(error instanceof TenantContextError);
    assert.equal(error.code, 'TENANT_ACCESS_DENIED');
    return true;
  });
});

test('025-030 migrations preserve history and close the tenant contract', () => {
  const migration = name => readFileSync(join(__dirname, `../migrations/${name}`), 'utf8');
  const tenancy = migration('025_workspace_tenancy_expand.sql');
  for (const table of ['users', 'workspaces', 'workspace_members']) {
    assert.match(tenancy, new RegExp(`CREATE TABLE ${table} \\(`));
  }
  assert.match(tenancy, /'projects'[\s\S]*'assistant_sessions'/u);
  assert.match(tenancy, /ADD COLUMN workspace_id text NULL DEFAULT %L REFERENCES workspaces\(id\)/u);
  assert.match(tenancy, /ALTER TABLE %I ALTER COLUMN workspace_id DROP DEFAULT/u);
  assert.doesNotMatch(tenancy, /UPDATE evaluation_run_events SET workspace_id/u,
    'immutable history must be backfilled without firing row-update triggers');

  const outbox = migration('026_tenant_data_outbox.sql');
  assert.match(outbox, /ALTER TABLE data_outbox_events[\s\S]*ADD COLUMN workspace_id/u);
  assert.match(outbox, /UNIQUE \(workspace_id, aggregate_type, aggregate_id, aggregate_version\)/u);
  assert.match(outbox, /NEW\.workspace_id IS DISTINCT FROM OLD\.workspace_id/u);
  assert.doesNotMatch(outbox, /UPDATE data_outbox_events[\s\S]{0,200}event_digest\s*=/u);

  const jobs = migration('027_persistent_jobs.sql');
  for (const table of ['jobs', 'job_attempts', 'job_steps']) {
    assert.match(jobs, new RegExp(`CREATE TABLE ${table} \\(`));
  }
  assert.match(jobs, /fencing_token bigint NOT NULL/u);
  assert.match(jobs, /jobs_claim_idx/u);
  assert.match(jobs, /jobs_expired_lease_idx/u);

  const contract = migration('030_workspace_tenancy_contract.sql');
  assert.match(contract, /CREATE OR REPLACE FUNCTION lyra_enforce_workspace_scope/u);
  assert.match(contract, /IF NEW\.workspace_id IS NULL[\s\S]*ws_00000000000000000000000000000000/u);
  assert.match(contract, /LYRA_TENANT_SCOPE_REQUIRED/u);
  assert.match(contract, /ALTER TABLE %I FORCE ROW LEVEL SECURITY/u);
  assert.match(contract, /CREATE POLICY lyra_workspace_isolation/u);
  assert.match(contract, /ALTER TABLE %I ALTER COLUMN workspace_id SET NOT NULL/u);
});
