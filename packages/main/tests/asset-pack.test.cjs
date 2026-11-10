const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  ASSET_PACK_SCHEMA_VERSION, AssetError, assetPackContentDigest, parseAssetPackVersion,
} = require('@lyra/shared');
const { InMemoryAssetPackRepository } = require('../dist/assets/asset-pack-repository');
const {
  retrieveAssetForGeneration, assetConstraintEvaluation, assetAuthorizationDecision,
} = require('../dist/assets/retrieval');
const { HybridAssetRetriever } = require('../dist/assets/vector/hybrid');
const { AssetVectorError } = require('../dist/assets/vector/errors');
const { ScopedAssetVectorStoreV2 } = require('../dist/assets/vector/scoped-v2');

const USER = `usr_${'0'.repeat(32)}`;
const WORKSPACE = `ws_${'1'.repeat(32)}`;

function id(prefix) { return `${prefix}${randomUUID().replaceAll('-', '')}`; }
function media(view = 'front', state = null, role = 'view') {
  return {
    mediaId: id('apm_'), role, view, state,
    objectId: id('object_'), objectVersionId: id('objver_'),
    checksum: 'a'.repeat(64), sizeBytes: 128, contentType: 'image/png',
    crop: null, qualityStatus: 'pass',
    provenance: { source: 'generated', provider: 'seedream', sourceRef: null },
  };
}
function pack(overrides = {}) {
  const base = {
    schemaVersion: ASSET_PACK_SCHEMA_VERSION, id: id('apv_'), workspaceId: WORKSPACE,
    projectScope: 'workspace', projectId: null, kind: 'character',
    logicalAssetId: 'character_hero', version: 1, parentVersionId: null,
    displayName: '林澜', aliases: ['澜姐'], description: '冷傲女总裁', tags: ['都市'],
    sourceType: 'generated', sourceRefs: ['script:1'], license: 'internal',
    authorizationStatus: 'allowed', authorizationReason: null,
    reviewStatus: 'approved', reviewedBy: USER, reviewedAt: '2026-11-01T00:00:00.000Z',
    validFrom: '2026-11-01T00:00:00.000Z', validUntil: null,
    allowedUsages: ['production'], restrictedProjects: [],
    mediaEntries: [media('front')], status: 'adopted', createdBy: USER,
    createdAt: '2026-11-01T00:00:00.000Z',
  };
  Object.assign(base, overrides);
  base.contentDigest = assetPackContentDigest(base);
  return parseAssetPackVersion(base);
}
function asset(idValue, name, overrides = {}) {
  return {
    id: idValue, kind: 'character', name, description: '冷傲女总裁',
    resourceUrl: `https://assets.test/${idValue}.png`, createdAt: '2026-11-01T00:00:00.000Z',
    workspaceId: WORKSPACE, authorizationStatus: 'allowed', reviewStatus: 'approved',
    views: ['front'], states: ['neutral'], traits: ['都市', '冷傲'],
    allowedUsages: ['production'], ...overrides,
  };
}
function query(overrides = {}) {
  return { kind: 'character', name: '林澜', aliases: [], workspaceId: WORKSPACE,
    authorizationRequired: true, reviewRequired: true, ...overrides };
}

test('asset pack versions are immutable, digest checked and only reference object versions', async () => {
  const parsed = pack();
  assert.equal(parsed.mediaEntries.length, 1);
  assert.ok(parsed.mediaEntries[0].objectVersionId.startsWith('objver_'));
  assert.ok(!parsed.mediaEntries.some(item => 'resourceUrl' in item || 'path' in item));

  const tampered = { ...parsed, displayName: '另一个人' };
  assert.throws(() => parseAssetPackVersion(tampered), error => error instanceof AssetError
    && error.code === 'INVALID_ASSET_PACK');

  const repository = new InMemoryAssetPackRepository();
  const first = await repository.create(parsed);
  assert.equal(first.contentDigest, parsed.contentDigest);
  assert.equal((await repository.create(parsed)).contentDigest, parsed.contentDigest);
  await assert.rejects(repository.create(pack({ id: parsed.id, description: '不同版本' })), error => error instanceof AssetError
    && error.code === 'ASSET_PACK_VERSION_EXISTS');
});

test('adoption is append-only and latestAdopted follows explicit adoption evidence', async () => {
  const repository = new InMemoryAssetPackRepository();
  const first = await repository.create(pack());
  const second = await repository.create(pack({ id: id('apv_'), version: 2, parentVersionId: first.id }));
  assert.deepEqual((await repository.listByLogical(WORKSPACE, 'character_hero')).map(item => item.version), [2, 1]);
  assert.equal(await repository.latestAdopted(WORKSPACE, 'character_hero'), null);
  const adoption = { workspaceId: WORKSPACE, adoptionId: id('apa_'), logicalAssetId: 'character_hero',
    versionId: second.id, adoptedBy: USER, reason: '导演确认', createdAt: '2026-11-02T00:00:00.000Z' };
  assert.equal((await repository.adopt(adoption)).versionId, second.id);
  assert.equal((await repository.latestAdopted(WORKSPACE, 'character_hero')).id, second.id);
  assert.equal((await repository.adopt(adoption)).adoptionId, adoption.adoptionId);
  assert.equal((await repository.listAdoptions(WORKSPACE, 'character_hero')).length, 1);
});

test('workspace and authorization are hard gates, not display-only metadata', () => {
  const allowed = asset(`asset_${'a'.repeat(32)}`, '林澜');
  const crossTenant = asset(`asset_${'b'.repeat(32)}`, '林澜', { workspaceId: `ws_${'2'.repeat(32)}` });
  const revoked = asset(`asset_${'c'.repeat(32)}`, '林澜', { authorizationStatus: 'revoked', authorizationReason: '作者撤回' });
  const result = retrieveAssetForGeneration(query(), [crossTenant, revoked, allowed]);
  assert.equal(result.status, 'unique');
  assert.equal(result.asset.id, allowed.id);
  assert.equal(result.requirementGaps.length, 2);
  assert.ok(result.requirementGaps.every(gap => gap.code === 'ASSET_PACK_AUTHORIZATION_DENIED'));
  assert.equal(result.candidates[0].authorizationDecision.status, 'allowed');
});

test('a front-only pack never claims a missing back view and exposes the explicit gap', () => {
  const frontOnly = asset(`asset_${'d'.repeat(32)}`, '林澜');
  const result = retrieveAssetForGeneration(query({ requiredView: 'back' }), [frontOnly]);
  assert.equal(result.status, 'below_threshold');
  assert.equal(result.asset, null);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].missingRequirements, ['view:back']);
  assert.equal(result.candidates[0].constraintScore, 0);
  assert.ok(result.requirementGaps.some(gap => gap.code === 'ASSET_PACK_MEDIA_MISSING' && gap.requiredView === 'back'));
  assert.ok(result.candidates[0].explanation.includes('角度 0.00'));
  assert.ok(result.candidates[0].explanation.includes('缺失 view:back'));
});

test('view/state constraints produce a transparent constraint and combined score', () => {
  const complete = asset(`asset_${'e'.repeat(32)}`, '林澜', {
    views: ['front', 'side_left', 'side_right', 'back'], states: ['neutral', 'smile'], qualityScore: 0.9,
  });
  const result = retrieveAssetForGeneration(query({ requiredView: 'back', requiredState: 'smile' }), [complete]);
  assert.equal(result.status, 'unique');
  assert.equal(result.candidates[0].constraintScore, 1);
  assert.ok(result.candidates[0].combinedScore >= result.threshold);
  assert.deepEqual(result.candidates[0].matchedTraits, ['都市', '冷傲']);
  assert.ok(result.candidates[0].explanation.includes('角度 1.00'));
  assert.ok(result.candidates[0].explanation.includes('约束 1.00'));
});

test('authorization helper reports stable reason codes without throwing', () => {
  const expired = asset(`asset_${'f'.repeat(32)}`, '林澜', { authorizationStatus: 'expired' });
  const decision = assetAuthorizationDecision(query(), expired);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'ASSET_AUTHORIZATION_EXPIRED');
  const constrained = assetConstraintEvaluation(query({ requiredView: 'profile' }), expired);
  assert.deepEqual(constrained.missing, ['view:profile']);
});

test('hybrid retrieval sends only authorized PostgreSQL-prefiltered asset ids to Milvus', async () => {
  const allowed = asset(`asset_${'1'.repeat(32)}`, '林澜');
  const denied = asset(`asset_${'2'.repeat(32)}`, '林澜', { authorizationStatus: 'revoked' });
  let searchedOptions;
  const result = await new HybridAssetRetriever({
    embedding: { async embedText() { return [0.2, 0.8]; } },
    store: { async search(_vector, _kind, _limit, options) {
      searchedOptions = options; return [{ assetId: allowed.id, score: 0.94 }];
    } },
    model: 'embedding-test', revision: 'revision-test', queryCostMicros: 7_000,
  }).retrieve(query({ candidateBudget: 3 }), [allowed, denied]);
  assert.deepEqual(searchedOptions, { assetIds: [allowed.id] });
  assert.equal(result.retrievalMode, 'hybrid');
  assert.equal(result.status, 'unique');
  assert.equal(result.candidates[0].semanticScore, 0.94);
  assert.ok(result.candidates[0].explanation.includes('语义 0.94'));
});

test('unreachable Milvus degrades to lexical without blocking the production path', async () => {
  const allowed = asset(`asset_${'3'.repeat(32)}`, '林澜');
  const result = await new HybridAssetRetriever({
    embedding: { async embedText() { return [0.2, 0.8]; } },
    store: { async search() { throw new AssetVectorError('Milvus down'); } },
    model: 'embedding-test', revision: 'revision-test', queryCostMicros: 7_000,
  }).retrieve(query(), [allowed]);
  assert.equal(result.retrievalMode, 'degraded-lexical');
  assert.equal(result.degradationReason, 'milvus-unreachable');
  assert.equal(result.semantic.status, 'degraded');
  assert.equal(result.status, 'unique');
  assert.equal(result.asset.id, allowed.id);
});

test('Milvus hits that fail PostgreSQL authorization are rejected and diagnosed', async () => {
  const allowed = asset(`asset_${'4'.repeat(32)}`, '林澜');
  const denied = asset(`asset_${'5'.repeat(32)}`, '林澜', { authorizationStatus: 'revoked' });
  const result = await new HybridAssetRetriever({
    embedding: { async embedText() { return [0.2, 0.8]; } },
    store: { async search() { return [{ assetId: denied.id, score: 0.99 }]; } },
    model: 'embedding-test', revision: 'revision-test', queryCostMicros: 7_000,
  }).retrieve(query(), [allowed, denied]);
  assert.equal(result.retrievalMode, 'hybrid');
  assert.equal(result.semantic.reason, 'verification_failed');
  assert.ok(!result.candidates.some(candidate => candidate.asset.id === denied.id));
  assert.equal(result.asset.id, allowed.id);
});

test('an empty authorized asset set is preserved through the tenant scope and never widened', async () => {
  let captured;
  const store = new ScopedAssetVectorStoreV2({
    async upsert() {}, async deleteByAssetIds() {},
    async search(scope, query) { captured = { scope, query }; return []; },
  }, { workspaceId: WORKSPACE });
  await store.search([0.1], 'character', 12, { assetIds: [] });
  assert.deepEqual(captured.query.assetIds, []);
  assert.equal(captured.query.kind, 'character');
  assert.equal(captured.scope.workspaceId, WORKSPACE);
});
