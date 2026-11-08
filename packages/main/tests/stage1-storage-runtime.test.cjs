const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createObjectStorageFromEnv, readObjectStorageConfig } = require('../dist/infrastructure/object-storage');
const { createConversationContextRuntime } = require('../dist/infrastructure/conversation-context');
const { CachedAssistantRepository, ConversationContextCache } = require('../dist/infrastructure/conversation-context');
const { createAssetVectorV2Runtime } = require('../dist/assets/vector/runtime-v2');
const { tenantExecutionScope } = require('../dist/tenancy/scope');

test('Stage 1 storage migration keeps durable object and rebuildable vector metadata in PostgreSQL', () => {
  const sql = readFileSync(join(__dirname, '../migrations/029_stage1_storage_projection.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE object_records/u);
  assert.match(sql, /workspace_id text NOT NULL REFERENCES workspaces/u);
  assert.match(sql, /sha256 char\(64\) NOT NULL/u);
  assert.match(sql, /ALTER TABLE assistant_sessions[\s\S]*conversation_version/u);
  assert.match(sql, /UPDATE assistant_sessions session[\s\S]*MAX\(seq\)[\s\S]*last_message_seq/u);
  assert.match(sql, /CREATE TABLE vector_projection_states/u);
  assert.match(sql, /status IN \('stale', 'queued', 'indexing', 'indexed', 'failed', 'deleted'\)/u);
  assert.match(sql, /CREATE TABLE runtime_heartbeats/u);
  assert.match(sql, /role IN \('api', 'worker', 'all'\)/u);
});
test('MinIO runtime is explicit and lazy while unsafe cloud HTTP endpoints are rejected', () => {
  const env = {
    OBJECT_STORAGE_PROVIDER: 'minio', OBJECT_STORAGE_ENDPOINT: 'http://minio:9000',
    OBJECT_STORAGE_BUCKET: 'lyra-media', OBJECT_STORAGE_ACCESS_KEY: 'test-access',
    OBJECT_STORAGE_SECRET_KEY: 'test-secret',
  };
  assert.equal(readObjectStorageConfig(env).provider, 'minio');
  let constructed = 0;
  class FakeClient { constructor(options) { constructed++; this.options = options; } send() { throw new Error('not called'); } }
  class Command { constructor(input) { this.input = input; } }
  const storage = createObjectStorageFromEnv(env, {
    s3Module: { S3Client: FakeClient, HeadBucketCommand: Command, PutObjectCommand: Command, GetObjectCommand: Command,
      HeadObjectCommand: Command, DeleteObjectCommand: Command },
    presignerModule: { async getSignedUrl() { return 'https://signed.example.test/upload'; } },
  });
  assert.equal(constructed, 1);
  assert.equal(storage.provider, 'minio');
  assert.throws(() => readObjectStorageConfig({ ...env, OBJECT_STORAGE_PROVIDER: 's3' }),
    /HTTP 仅允许 MinIO/u);
});
test('Redis conversation runtime connects, probes and closes only when configured', async () => {
  const calls = [];
  const client = {
    on() {}, async connect() { calls.push('connect'); }, async ping() { calls.push('ping'); return 'PONG'; },
    async quit() { calls.push('quit'); }, async get() { return null; }, async del() { return 0; }, async eval() { return 1; },
  };
  const runtime = await createConversationContextRuntime({
    REDIS_URL: 'redis://:test@redis:6379', REDIS_HOST_ALLOWLIST: 'redis',
  }, { redisModule: { createClient() { return client; } } });
  assert.equal(runtime.mode, 'redis');
  assert.equal(await runtime.probe(), true);
  await runtime.close();
  assert.deepEqual(calls, ['connect', 'ping', 'quit']);

  const fallback = await createConversationContextRuntime({});
  assert.equal(fallback.mode, 'noop');
  assert.equal(await fallback.probe(), false);
});
test('Assistant message history actually reads through the tenant Redis snapshot and refreshes after PG commit', async () => {
  const workspaceId = `ws_${'4'.repeat(32)}`;
  const messages = [];
  let versionReads = 0; let snapshotReads = 0; let cacheGets = 0; let cachePuts = 0;
  const cached = new Map();
  const store = {
    async get(_scope, sessionId) { cacheGets++; return cached.get(sessionId) ?? null; },
    async put(snapshot) { cachePuts++; cached.set(snapshot.sessionId, structuredClone(snapshot)); return true; },
    async delete(_scope, sessionId) { cached.delete(sessionId); },
  };
  const postgres = {
    async conversationVersion() { versionReads++; return messages.length; },
    async conversationSnapshot() { snapshotReads++; return { version: messages.length, messages: structuredClone(messages) }; },
    async listMessages() { throw new Error('read-through must use the versioned snapshot'); },
    async appendMessage(message) {
      const stored = { ...message, seq: messages.length + 1, createdAt: '2026-11-08T00:00:00.000Z' };
      messages.push(stored); return stored;
    },
  };
  const repository = new CachedAssistantRepository(postgres, new ConversationContextCache(store, 60));
  const tenant = { userId: `usr_${'4'.repeat(32)}`, workspaceId, role: 'owner', requestId: 'request-cache-0001' };
  await tenantExecutionScope.runWithTenant(tenant, async () => {
    assert.deepEqual(await repository.listMessages('asst_session'), []);
    assert.deepEqual(await repository.listMessages('asst_session'), []);
    await repository.appendMessage({ id: 'msg_one', sessionId: 'asst_session', role: 'user',
      content: 'hello', thinking: '', status: 'complete' });
    assert.equal((await repository.listMessages('asst_session'))[0].content, 'hello');
  });
  assert.equal(snapshotReads, 2, 'one miss and one post-commit refresh');
  assert.equal(versionReads, 3, 'each read confirms the PostgreSQL version first');
  assert.equal(cacheGets, 3);
  assert.ok(cachePuts >= 2);
  assert.equal(cached.get('asst_session').workspaceId, workspaceId);
  assert.equal(cached.get('asst_session').version, 1);
});

test('Milvus v2 runtime is lazy and always binds an explicit workspace scope', () => {
  let constructed = 0;
  const runtime = createAssetVectorV2Runtime({
    MILVUS_ENABLED: '1', MILVUS_URI: 'milvus:19530', MILVUS_COLLECTION_V2: 'lyra_asset_vectors_v2',
  }, { moduleValue: { MilvusClient: class { constructor() { constructed++; } } } });
  assert.equal(runtime.enabled, true);
  assert.equal(constructed, 0);
  assert.ok(runtime.bind({ workspaceId: `ws_${'1'.repeat(32)}` }));
  assert.equal(constructed, 0);
});
