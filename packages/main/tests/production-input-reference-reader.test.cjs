const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalDigest } = require('@lyra/shared');
const { PostgresProductionInputReferenceReader } = require('../dist/production/input-reference-reader');
function fixture(row) {
  const tenant = { userId: 'usr_' + 'a'.repeat(32), workspaceId: 'ws_' + 'b'.repeat(32), role: 'owner', requestId: 'test-ref-reader' };
  let calls = 0;
  const reader = new PostgresProductionInputReferenceReader({ async query(sql, values) {
    calls++; assert.ok(sql.includes('FOR SHARE')); assert.equal(values[0], tenant.workspaceId); assert.equal(values[1], 'project-one');
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  } }, tenant, 'project-one');
  return { reader, calls: () => calls };
}
test('plan/storyboard content hashes alone cannot authorize a never-adopted candidate', async () => {
  const content = { shots: [] }, ref = { id: 'revision-one', versionId: 'revision-one', digest: canonicalDigest(content) };
  for (const kind of ['plan', 'storyboard']) {
    const row = { content_json: content, was_adopted: false }, f = fixture(row);
    assert.equal(await f.reader.checkVersion(kind, ref), 'SNAPSHOT_NOT_READY');
    row.was_adopted = true; assert.equal(await f.reader.checkVersion(kind, ref), null);
    assert.equal(await f.reader.checkVersion(kind, { ...ref, digest: '0'.repeat(64) }), 'DIGEST_MISMATCH');
  }
});
test('unknown domains are explicitly unsupported, not accepted using arbitrary content hashes', async () => {
  const f = fixture(null);
  assert.equal(await f.reader.checkVersion('model_connection', { id: 'model-one', versionId: 'model-one', digest: 'a'.repeat(64) }), 'CAPABILITY_INCOMPATIBLE');
  assert.equal(f.calls(), 0);
});
test('reference identity mismatch rejects before querying, and absent versions remain absent', async () => {
  const f = fixture(null), ref = { id: 'revision-one', versionId: 'revision-two', digest: 'a'.repeat(64) };
  assert.equal(await f.reader.checkVersion('script', ref), 'DIGEST_MISMATCH'); assert.equal(f.calls(), 0);
  assert.equal(await f.reader.checkVersion('plan', { ...ref, id: 'revision-two' }), 'REFERENCE_NOT_FOUND');
});
