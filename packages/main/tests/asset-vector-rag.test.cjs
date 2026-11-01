const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DoubaoAssetEmbeddingClient } = require('../dist/assets/vector/embedding');
const { AssetVectorError, AssetVectorContractError } = require('../dist/assets/vector/errors');
const { MilvusAssetVectorStore } = require('../dist/assets/vector/milvus');
const { HybridAssetRetriever } = require('../dist/assets/vector/hybrid');
const { AssetVectorProjector } = require('../dist/assets/vector/projection');
const { readAssetVectorConfig } = require('../dist/assets/vector/config');

function asset(id, kind, name, description) {
  return { id, kind, name, description, resourceUrl: `https://assets.test/${id}.png`,
    mimeType: 'image/png', sizeBytes: 100, sha256: 'a'.repeat(64), createdAt: '2026-11-01T00:00:00.000Z' };
}
function query() {
  return { kind: 'character', name: '新角色', aliases: [], description: '雨夜撑伞的人', sourceQuotes: [] };
}
function retriever(store, embedding) {
  return new HybridAssetRetriever({ embedding: embedding ?? { async embedText() { return [0.2, 0.8]; } },
    store, model: 'embedding-test', revision: 'revision-test', queryCostMicros: 7_000 });
}

test('embedding client uses the configured multimodal text contract without leaking credentials', async () => {
  let request;
  const client = new DoubaoAssetEmbeddingClient({ endpoint: 'https://embedding.test/v3/embeddings/multimodal',
    model: 'embedding-test', apiKey: 'secret-key', timeoutMs: 10_000 }, async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ data: { embedding: [0.1, -0.2] } }), { status: 200 });
    });
  assert.deepEqual(await client.embedText(' 雨夜巷口 '), [0.1, -0.2]);
  assert.equal(request.url, 'https://embedding.test/v3/embeddings/multimodal');
  assert.deepEqual(JSON.parse(request.init.body), { model: 'embedding-test', input: [{ type: 'text', text: '雨夜巷口' }] });
  const malformed = new DoubaoAssetEmbeddingClient({ endpoint: 'https://embedding.test/v3/embeddings/multimodal',
    model: 'embedding-test', apiKey: 'secret-key', timeoutMs: 10_000 }, async () =>
    new Response(JSON.stringify({ data: { embedding: [0.1, 'bad'] } }), { status: 200 }));
  await assert.rejects(malformed.embedText('测试'), AssetVectorContractError);
  const failing = new DoubaoAssetEmbeddingClient({ endpoint: 'https://embedding.test/v3/embeddings/multimodal',
    model: 'embedding-test', apiKey: 'secret-key', timeoutMs: 10_000 }, async () => {
      throw new Error('secret-key must not escape');
    });
  await assert.rejects(failing.embedText('测试'), error => error instanceof AssetVectorError
    && !error.message.includes('secret-key'));
});

test('Milvus upsert provisions the vector dimension while search never provisions a missing collection', async () => {
  let created;
  let upserted;
  const store = new MilvusAssetVectorStore({ uri: 'milvus.test:19530', user: '', password: '', collection: 'test_vectors' }, {
    moduleValue: { DataType: {}, MetricType: {} },
    client: {
      hasCollection: async () => false,
      loadCollection: async () => undefined,
      createCollection: async input => { created = input; },
      upsert: async input => { upserted = input; },
      search: async () => [],
      deleteEntities: async () => undefined,
    },
  });
  await assert.rejects(store.search([0.1, 0.2], 'character'), AssetVectorError);
  assert.equal(created, undefined);
  await store.upsert({ assetId: 'asset_1', kind: 'character', vector: [0.1, 0.2, 0.3], text: '角色',
    textHash: 'a'.repeat(64), embeddingModel: 'embedding-test' });
  const vector = created.fields.find(field => field.name === 'vector');
  assert.equal(vector.dim, 3);
  assert.equal(upserted.data[0].asset_id, 'asset_1');
  assert.equal(upserted.data[0].kind, 'character');
});

test('hybrid retrieval hydrates only current same-kind catalog assets and discards stale vector hits', async () => {
  const current = asset('asset_hero', 'character', '林澜', '冷傲女总裁');
  const other = asset('asset_location', 'location', '巷口', '雨夜空间');
  const result = await retriever({ async search() { return [
    { assetId: 'deleted_asset', score: 0.99 },
    { assetId: other.id, score: 0.98 },
    { assetId: current.id, score: 0.91 },
  ]; } }).retrieve(query(), [current, other]);
  assert.equal(result.status, 'unique');
  assert.equal(result.asset.id, current.id);
  assert.equal(result.mode, 'hybrid_semantic_lexical');
  assert.equal(result.semantic.status, 'available');
  assert.equal(result.semantic.candidateCount, 1);
  assert.equal(result.candidates.length, 1);
  assert.ok(result.candidates[0].matchedFields.includes('semantic'));
  assert.equal(result.candidates[0].semanticScore, 0.91);
});

test('rebuildable Milvus failure degrades to lexical but malformed embedding contract remains an error', async () => {
  const current = asset('asset_hero', 'character', '林澜', '冷傲女总裁');
  const degraded = await retriever({ async search() { throw new AssetVectorError('Milvus unavailable'); } })
    .retrieve(query(), [current]);
  assert.equal(degraded.semantic.status, 'degraded');
  assert.equal(degraded.semantic.attempted, true);
  assert.equal(degraded.status, 'no_candidates');
  await assert.rejects(retriever({ async search() { return []; } }, {
    async embedText() { throw new AssetVectorContractError('bad provider payload'); },
  }).retrieve(query(), [current]), AssetVectorContractError);
});

test('projection rebuild is incremental, resumes from its manifest and deletes stale projection IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asset-vector-test-'));
  try {
    const records = [];
    const deleted = [];
    let embeddings = 0;
    const projector = new AssetVectorProjector({
      embedding: { async embedText() { embeddings++; return [0.1, 0.2]; } },
      store: { async upsert(record) { records.push(record); }, async search() { return []; },
        async deleteByAssetIds(ids) { deleted.push(...ids); } },
      model: 'embedding-test', manifestPath: join(directory, 'manifest.json'),
    });
    const first = asset('asset_1', 'character', '林澜', '冷傲');
    const second = asset('asset_2', 'location', '巷口', '雨夜');
    assert.deepEqual(await projector.sync([first, second]), {
      total: 2, indexed: 2, unchanged: 0, deleted: 0, manifestPath: join(directory, 'manifest.json'),
    });
    assert.equal(embeddings, 2);
    const resumed = await projector.sync([first, second]);
    assert.equal(resumed.indexed, 0);
    assert.equal(resumed.unchanged, 2);
    const changed = { ...first, description: '冷傲，穿灰色西装' };
    const final = await projector.sync([changed]);
    assert.equal(final.indexed, 1);
    assert.equal(final.unchanged, 0);
    assert.equal(final.deleted, 1);
    assert.deepEqual(deleted, [second.id]);
    assert.equal(records.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('vector configuration is optional by default and never exposes secrets in its revision', () => {
  assert.equal(readAssetVectorConfig({}), null);
  const config = readAssetVectorConfig({ ASSET_VECTOR_ENABLED: '1',
    ASSET_EMBEDDING_ENDPOINT: 'https://embedding.test/v3/embeddings/multimodal',
    ASSET_EMBEDDING_MODEL: 'embedding-test', ASSET_EMBEDDING_API_KEY: 'secret-key', MILVUS_URI: '127.0.0.1:19530' });
  assert.equal(config.queryCostMicros, 100_000);
  assert.equal(config.milvusCollection, 'ohao_asset_vectors_v1');
  assert.ok(!config.revision.includes('secret-key'));
  assert.throws(() => readAssetVectorConfig({ ASSET_VECTOR_ENABLED: '1' }), /缺少配置/);
});
