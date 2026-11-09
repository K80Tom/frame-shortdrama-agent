const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ProductionInputObjectVerifier } = require('../dist/production/input-object-verifier');
function fixture() {
  const tenant = { userId: 'usr_' + 'a'.repeat(32), workspaceId: 'ws_' + 'b'.repeat(32), role: 'owner', requestId: 'test-object-input' };
  const expected = { objectId: 'obj_' + 'c'.repeat(32), versionId: 'objectversion-one', checksum: 'd'.repeat(64) };
  const row = { workspace_id: tenant.workspaceId, provider: 's3', bucket: 'private-test', object_key: 'media/immutable-one',
    version_id: expected.versionId, sha256: expected.checksum, size_bytes: '100', content_type: 'image/png', status: 'ready',
    verified_at: '2026-11-09T00:00:00.000Z', deleted_at: null };
  const head = { provider: 's3', bucket: row.bucket, key: row.object_key, versionId: expected.versionId, sha256: expected.checksum,
    size: 100, contentType: row.content_type, etag: null };
  const calls = [];
  const client = { async query(sql, params) {
    assert.match(sql, /workspace_id=\$1 AND id=\$2 FOR SHARE/);
    assert.deepEqual(params, [tenant.workspaceId, expected.objectId]); calls.push('db'); return { rows: row.absent ? [] : [row] };
  } };
  const storage = { provider: 's3', bucket: row.bucket, async head(scope, key) {
    assert.equal(scope.workspaceId, tenant.workspaceId); assert.equal(key, row.object_key); calls.push('head'); return head;
  } };
  return { tenant, expected, row, head, calls, storage, client, check() { return new ProductionInputObjectVerifier(client, storage).check(tenant, expected); } };
}
test('exact ready metadata and matching versioned HEAD are both required, without writes or bytes upload', async () => {
  const f = fixture(); assert.equal(await f.check(), null); assert.deepEqual(f.calls, ['db', 'head']);
});
test('missing, foreign, pending, deleted and versionless rows stop before a storage call', async () => {
  for (const [edit, code] of [[r => { r.absent = true; }, 'REFERENCE_NOT_FOUND'], [r => { r.workspace_id = 'other'; }, 'REFERENCE_FORBIDDEN'],
    [r => { r.status = 'uploading'; }, 'SNAPSHOT_NOT_READY'], [r => { r.deleted_at = 'deleted'; }, 'SNAPSHOT_NOT_READY'],
    [r => { r.version_id = null; }, 'CAPABILITY_INCOMPATIBLE'], [r => { r.sha256 = '0'.repeat(64); }, 'DIGEST_MISMATCH']]) {
    const f = fixture(); edit(f.row); assert.equal(await f.check(), code); assert.deepEqual(f.calls, ['db']);
  }
});
test('a changed physical version/checksum/size/type or storage identity cannot pass using PostgreSQL metadata alone', async () => {
  for (const [field, value] of [['versionId', 'new-version'], ['sha256', '0'.repeat(64)], ['size', 101], ['contentType', 'text/html'], ['bucket', 'other'], ['key', 'different']]) {
    const f = fixture(); f.head[field] = value; assert.equal(await f.check(), 'DIGEST_MISMATCH');
  }
});
test('storage and database exceptions never leak raw provider URLs or diagnostics', async () => {
  const f = fixture(); f.storage.head = async () => { throw new Error('https://secret.invalid?token=private'); };
  assert.equal(await f.check(), 'SNAPSHOT_NOT_READY');
  f.client.query = async () => { throw new Error('database-secret'); }; assert.equal(await f.check(), 'SNAPSHOT_NOT_READY');
});
