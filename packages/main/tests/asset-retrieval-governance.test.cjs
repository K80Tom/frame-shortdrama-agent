const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const {
  InMemoryAssetRetrievalGovernanceRepository,
} = require('../dist/asset-retrieval-governance/repository');
const {
  AssetRetrievalGovernanceService,
} = require('../dist/asset-retrieval-governance/service');
const {
  AssetRetrievalGovernanceController,
} = require('../dist/asset-retrieval-governance/controller');
const {
  InMemoryEvolutionGateRepository,
} = require('../dist/evolution/gate-repository');
const { EvolutionGateService } = require('../dist/evolution/gate-service');

const token = () => randomBytes(16).toString('hex');
const ws = () => 'ws_' + token();
const at = '2026-11-10T08:00:00.000Z';
const digest = value => createHash('sha256').update(value).digest('hex');

function catalog(version = 'cat/1') {
  return {
    assetCatalogVersion: version,
    indexAlias: 'lyra_assets_v1',
    indexCollection: 'lyra_assets',
    embeddingModel: 'fixture-embedding',
    embeddingRevision: 'emb-1',
    authorizationPolicyVersion: 'auth/1',
    authorizationSnapshotDigest: digest('auth-snapshot'),
  };
}

function candidate(assetId, rank, lexical, semantic) {
  const final = 0.55 * lexical + 0.45 * semantic;
  return {
    assetId,
    assetVersionId: assetId + '-v1',
    assetVersionDigest: digest(assetId + '-v1'),
    assetName: assetId,
    assetKind: 'character',
    assetStatus: 'ready',
    rank,
    lexicalScore: lexical,
    semanticScore: semantic,
    finalScore: final,
    combinedScore: final,
    matchedFields: ['name'],
    matchedTerms: [assetId],
    filterReasons: [],
    explanation: 'fixture',
    authorizationQuality: 'clean',
  };
}

function observationInput(clientRequestId, candidates, catalogVersion = 'cat/1') {
  return {
    projectId: 'project_' + 'p'.repeat(24),
    shotId: 'shot_' + 's'.repeat(24),
    requestId: 'req-' + clientRequestId,
    clientRequestId,
    query: {
      text: '主角 正面 特写',
      filters: { kinds: ['character'], statuses: ['ready'] },
      limit: 3,
    },
    strategy: {
      mode: 'hybrid',
      ruleVersion: 'retrieval-rules/1',
      policyVersion: 'asset-retrieval-policy/1',
      policy: { threshold: 0.62, ambiguityMargin: 0.08, semanticWeight: 0.95 },
      catalog: catalog(catalogVersion),
      retrievalLimit: 3,
    },
    candidates,
    degradedReason: null,
    latencyMs: 30,
    costMicros: 0,
  };
}

function decisionInput(observationId, clientRequestId, quality = 'clean',
  selectedAssetId = 'asset_a', selectedAssetVersionId = 'asset_a-v1') {
  return {
    observationId,
    clientRequestId,
    decision: 'accept',
    selectedAssetId,
    selectedAssetVersionId,
    reason: '符合角色正面角度',
    actorId: 'user_fixture',
    authorization: { quality, verifiedAt: at, note: '' },
    outcome: { status: 'success', runId: 'run_fixture' },
  };
}

function serviceFixture() {
  const repository = new InMemoryAssetRetrievalGovernanceRepository();
  const gate = new EvolutionGateService(new InMemoryEvolutionGateRepository(), () => new Date(at));
  const service = new AssetRetrievalGovernanceService(repository, {
    now: () => new Date(at), gate,
    // Explicit trusted test double for ranking/governance fixtures, not PG authorization evidence.
    verifyAuthorization: async () => true,
  });
  return { repository, gate, service };
}

async function recordPair(service, workspaceId, clientRequestId, candidates, catalogVersion = 'cat/1') {
  const observation = await service.recordObservation(workspaceId, observationInput(clientRequestId, candidates, catalogVersion));
  const decision = await service.recordDecision(workspaceId, decisionInput(observation.observationId, clientRequestId));
  return { observation, decision };
}

test('observation and decision are immutable, idempotent by clientRequestId, and workspace scoped', async () => {
  const { service } = serviceFixture();
  const workspaceA = ws();
  const workspaceB = ws();
  const candidates = [candidate('asset_a', 1, 0.92, 0.96), candidate('asset_b', 2, 0.75, 0.8)];
  const input = observationInput('client-observation-1', candidates);
  const first = await service.recordObservation(workspaceA, input);
  const replay = await service.recordObservation(workspaceA, input);
  assert.equal(replay.observationId, first.observationId);
  assert.equal(replay.contentDigest, first.contentDigest);

  await assert.rejects(
    service.recordObservation(workspaceA, observationInput('client-observation-1',
      [candidate('asset_c', 1, 0.7, 0.7)])),
    error => error.code === 'ASSET_RETRIEVAL_OBSERVATION_CONFLICT' && error.status === 409,
  );
  await assert.rejects(service.getObservation(workspaceB, first.observationId),
    error => error.code === 'ASSET_RETRIEVAL_OBSERVATION_NOT_FOUND');

  const decision = await service.recordDecision(workspaceA, decisionInput(first.observationId, 'decision-1'));
  const decisionReplay = await service.recordDecision(workspaceA,
    decisionInput(first.observationId, 'decision-1'));
  assert.equal(decisionReplay.decisionId, decision.decisionId);
  await assert.rejects(service.recordDecision(workspaceA, {
    ...decisionInput(first.observationId, 'decision-1'),
    decision: 'reject', selectedAssetId: null, selectedAssetVersionId: null,
  }), error => error.code === 'ASSET_RETRIEVAL_DECISION_CONFLICT');
  await assert.rejects(service.getDecision(workspaceB, decision.decisionId),
    error => error.code === 'ASSET_RETRIEVAL_DECISION_NOT_FOUND');

  const otherWorkspaceObservation = await service.recordObservation(workspaceB, input);
  assert.notEqual(otherWorkspaceObservation.observationId, first.observationId);
});

test('dataset revision is deterministic, filters unsafe positives, and detects snapshot mismatch', async () => {
  const { service } = serviceFixture();
  const workspaceId = ws();
  const safe = await recordPair(service, workspaceId, 'obs-safe',
    [candidate('asset_a', 1, 0.95, 0.94), candidate('asset_b', 2, 0.7, 0.72)]);
  const unsafe = await service.recordObservation(workspaceId, observationInput('obs-unsafe',
    [candidate('asset_x', 1, 0.99, 0.99)]));
  await service.recordDecision(workspaceId, decisionInput(unsafe.observationId, 'dec-unsafe', 'unknown',
    'asset_x', 'asset_x-v1'));

  const revision = await service.createDatasetRevision(workspaceId, {
    purpose: 'policy_search',
    observationIds: [safe.observation.observationId, unsafe.observationId],
    createdBy: 'user_fixture',
    contentSummary: 'fixture dataset',
  });
  assert.equal(revision.sampleCount, 1);
  assert.equal(revision.labeledSampleCount, 1);
  assert.equal(revision.deduplicatedCount, 1);
  assert.deepEqual(revision.source.observationIds, [safe.observation.observationId]);
  assert.equal((await service.getDatasetRevision(workspaceId, revision.datasetRevisionId)).payloadDigest, revision.payloadDigest);

  const emptyWorkspace = ws();
  const unlabeled = await service.recordObservation(emptyWorkspace,
    observationInput('obs-unlabeled', [candidate('asset_u', 1, 0.9, 0.9)]));
  await assert.rejects(service.createDatasetRevision(emptyWorkspace, {
    purpose: 'policy_search', observationIds: [unlabeled.observationId], createdBy: 'user_fixture',
  }), error => error.code === 'ASSET_RETRIEVAL_DATASET_EMPTY');

  const otherSnapshot = await recordPair(service, workspaceId, 'obs-other-catalog',
    [candidate('asset_a', 1, 0.9, 0.9)], 'cat/2');
  await assert.rejects(service.createDatasetRevision(workspaceId, {
    purpose: 'regression',
    observationIds: [safe.observation.observationId, otherSnapshot.observation.observationId],
    filters: { labeledOnly: false }, createdBy: 'user_fixture',
  }), error => error.code === 'ASSET_RETRIEVAL_DATASET_SNAPSHOT_MISMATCH');
});

test('bounded grid search is deterministic, produces a payload, and binds a #135 candidate', async () => {
  const { service, gate } = serviceFixture();
  const workspaceId = ws();
  await recordPair(service, workspaceId, 'search-1',
    [candidate('asset_a', 1, 0.92, 0.96), candidate('asset_b', 2, 0.7, 0.76)]);
  const revision = await service.createDatasetRevision(workspaceId, {
    purpose: 'policy_search',
    observationIds: (await service.listObservations(workspaceId)).items.map(item => item.observationId),
    createdBy: 'user_fixture',
  });
  const first = await service.searchPolicy(workspaceId, revision.datasetRevisionId);
  const second = await service.searchPolicy(workspaceId, revision.datasetRevisionId);
  assert.deepEqual(first, second);
  assert.deepEqual(first.searchSpace, {
    threshold: { min: 0.45, max: 0.85, step: 0.05 },
    ambiguityMargin: { min: 0, max: 0.16, step: 0.04 },
    semanticWeight: { min: 0.6, max: 1, step: 0.1 },
  });
  assert.equal(first.evaluatedPoints, 9 * 5 * 5);
  assert.equal(first.bestMetrics.recallAtK, 1);
  assert.equal(first.bestMetrics.firstCorrectRank, 1);
  assert.equal(first.bestMetrics.latencyP50, 30);
  assert.equal(first.bestMetrics.latencyP95, 30);
  assert.equal(first.bestMetrics.embeddingCostMicros, 0);

  const payload = await service.createPolicyPayload(workspaceId, {
    basePolicyVersion: 'asset-retrieval-policy/1',
    basePolicy: { threshold: 0.62, ambiguityMargin: 0.08, semanticWeight: 0.95 },
    assetRetrievalDatasetRevisionId: revision.datasetRevisionId,
    policy: first.bestPolicy,
    searchSpace: first.searchSpace,
    createdBy: 'user_fixture',
  });
  assert.equal(payload.workspaceId, workspaceId);
  assert.equal(payload.boundsProof.onlyRankingParametersChanged, true);
  assert.equal(payload.boundsProof.authorizationFilterChanged, false);
  assert.deepEqual(payload.basePolicy, { threshold: 0.62, ambiguityMargin: 0.08, semanticWeight: 0.95 });
  assert.equal(payload.assetRetrievalDatasetRevisionDigest, revision.payloadDigest);

  const registered = await service.registerPolicyCandidate(workspaceId, payload.payloadId, { actorId: 'user_fixture' });
  assert.equal(registered.candidate.domain, 'AssetRetrievalPolicy');
  assert.equal(registered.candidate.baselineDigest, payload.basePolicyDigest);
  assert.equal(registered.candidate.candidateRevision, payload.payloadId);
  assert.equal(registered.refs.candidateVersionId, registered.candidate.candidateId);
  assert.equal((await gate.history(workspaceId, registered.candidate.candidateId)).length > 0, true);

  await assert.rejects(service.createPolicyPayload(ws(), {
    basePolicyVersion: 'asset-retrieval-policy/1',
    basePolicy: { threshold: 0.62, ambiguityMargin: 0.08, semanticWeight: 0.95 },
    assetRetrievalDatasetRevisionId: revision.datasetRevisionId,
    policy: first.bestPolicy, createdBy: 'user_fixture',
  }), error => error.code === 'ASSET_RETRIEVAL_DATASET_NOT_FOUND');
  await assert.rejects(service.createPolicyPayload(workspaceId, {
    basePolicyVersion: 'asset-retrieval-policy/1',
    basePolicy: { threshold: 0.62, ambiguityMargin: 0.08, semanticWeight: 0.95 },
    assetRetrievalDatasetRevisionId: revision.datasetRevisionId,
    policy: { ...first.bestPolicy, threshold: 0.2 }, createdBy: 'user_fixture',
  }), error => error.code === 'ASSET_RETRIEVAL_POLICY_OUT_OF_BOUNDS');
  await assert.rejects(service.createPolicyPayload(workspaceId, {
    basePolicyVersion: 'asset-retrieval-policy/1',
    basePolicy: first.bestPolicy, assetRetrievalDatasetRevisionId: revision.datasetRevisionId,
    policy: first.bestPolicy, createdBy: 'user_fixture',
  }), error => error.code === 'ASSET_RETRIEVAL_PAYLOAD_NO_CHANGE');
});

test('registerEvaluationDataset delegates to #134 adapter and only stores typed reference', async () => {
  const { service } = serviceFixture();
  const workspaceId = ws();
  await recordPair(service, workspaceId, 'eval-1',
    [candidate('asset_a', 1, 0.93, 0.91), candidate('asset_b', 2, 0.7, 0.7)]);
  const revision = await service.createDatasetRevision(workspaceId, {
    purpose: 'evaluation',
    observationIds: (await service.listObservations(workspaceId)).items.map(item => item.observationId),
    createdBy: 'user_fixture',
  });
  const payload = await service.createPolicyPayload(workspaceId, {
    basePolicyVersion: 'asset-retrieval-policy/1',
    basePolicy: { threshold: 0.62, ambiguityMargin: 0.08, semanticWeight: 0.95 },
    assetRetrievalDatasetRevisionId: revision.datasetRevisionId,
    policy: { threshold: 0.6, ambiguityMargin: 0.08, semanticWeight: 0.9 },
    createdBy: 'user_fixture',
  });
  let registeredInput;
  const registrar = {
    async register(input) {
      registeredInput = input;
      return {
        datasetId: 'evalds_' + token(),
        revisionId: 'evaldsrev_' + token(),
        digest: digest('evaluation-revision'),
        caseCount: input.cases.length,
        schemaVersion: 'lyra-evaluation-dataset/1',
      };
    },
  };
  const delegated = new AssetRetrievalGovernanceService(
    new InMemoryAssetRetrievalGovernanceRepository(),
    { now: () => new Date(at), evaluationRegistrar: registrar, verifyAuthorization: async () => true },
  );
  const obs = await delegated.recordObservation(workspaceId,
    observationInput('eval-2', [candidate('asset_a', 1, 0.93, 0.91), candidate('asset_b', 2, 0.7, 0.7)]));
  await delegated.recordDecision(workspaceId, decisionInput(obs.observationId, 'dec-2'));
  const ds = await delegated.createDatasetRevision(workspaceId, {
    purpose: 'evaluation', observationIds: [obs.observationId], createdBy: 'user_fixture',
  });
  const p = await delegated.createPolicyPayload(workspaceId, {
    basePolicyVersion: 'asset-retrieval-policy/1',
    basePolicy: { threshold: 0.62, ambiguityMargin: 0.08, semanticWeight: 0.95 },
    assetRetrievalDatasetRevisionId: ds.datasetRevisionId,
    policy: { threshold: 0.6, ambiguityMargin: 0.08, semanticWeight: 0.9 },
    createdBy: 'user_fixture',
  });
  const authorization = {
    status: 'granted', basis: 'internal approval', scope: 'asset retrieval evaluation',
    grantedBy: 'fixture-owner', grantedAt: '2026-11-01', expiresAt: '2027-11-01', restrictions: [],
  };
  const result = await delegated.registerEvaluationDataset(workspaceId, ds.datasetRevisionId, { authorization });
  assert.equal(registeredInput.cases.length, 1);
  assert.equal(registeredInput.cases[0].kind, 'asset_retrieval');
  assert.equal(registeredInput.authorization.status, 'granted');
  assert.equal(result.evaluation.caseCount, 1);
  assert.equal(result.refs.evaluationDatasetVersionId, result.evaluation.revisionId);
  assert.equal(result.refs.evaluationDatasetRevisionDigest, result.evaluation.digest);
  assert.equal(p.payloadDigest.startsWith('arpayload'), false);
  assert.equal(payload.payloadId.startsWith('arpayload_'), true);
});

test('facade derives tenant from the authenticated session and rejects path/session mismatch', async () => {
  const { service } = serviceFixture();
  const controller = new AssetRetrievalGovernanceController(service);
  const workspaceId = ws();
  const otherWorkspaceId = ws();
  const request = { auth: { tenant: { workspaceId, userId: 'user_fixture' } } };
  await assert.rejects(async () => controller.summary(request, otherWorkspaceId),
    error => error.code === 'ASSET_RETRIEVAL_WORKSPACE_MISMATCH' && error.status === 403);
  const observation = await controller.recordObservation(request, workspaceId,
    observationInput('facade-1', [candidate('asset_a', 1, 0.9, 0.9)]));
  assert.equal(observation.workspaceId, workspaceId);
  const decision = await controller.recordDecision(request, workspaceId,
    decisionInput(observation.observationId, 'facade-decision-1'));
  assert.equal(decision.workspaceId, workspaceId);
  assert.equal((await controller.summary(request, workspaceId)).observationCount, 1);
});
test('workspace-local payload refuses candidate creation in another tenant', async () => {
  const { service } = serviceFixture();
  const workspaceId = ws();
  await recordPair(service, workspaceId, 'tenant-1', [candidate('asset_a', 1, 0.9, 0.9)]);
  const revision = await service.createDatasetRevision(workspaceId, {
    purpose: 'policy_search', observationIds: (await service.listObservations(workspaceId)).items.map(i => i.observationId),
    createdBy: 'user_fixture',
  });
  const payload = await service.createPolicyPayload(workspaceId, {
    basePolicyVersion: 'asset-retrieval-policy/1',
    basePolicy: { threshold: 0.62, ambiguityMargin: 0.08, semanticWeight: 0.95 },
    assetRetrievalDatasetRevisionId: revision.datasetRevisionId,
    policy: { threshold: 0.6, ambiguityMargin: 0.08, semanticWeight: 0.9 },
    createdBy: 'user_fixture',
  });
  await assert.rejects(service.registerPolicyCandidate(ws(), payload.payloadId, { actorId: 'intruder' }),
    error => error.code === 'ASSET_RETRIEVAL_POLICY_PAYLOAD_NOT_FOUND');
});


test('missing authority, omitted quality and forged clean cannot enter a labeled dataset', async () => {
  for (const mode of ['missing', 'omitted', 'forged', 'error']) {
    const repository = new InMemoryAssetRetrievalGovernanceRepository();
    const service = new AssetRetrievalGovernanceService(repository, { now: () => new Date(at),
      ...(mode === 'missing' ? {} : { verifyAuthorization: async () => { if (mode === 'error') throw new Error('private'); return false; } }) });
    const workspaceId = ws();
    const obs = await service.recordObservation(workspaceId, observationInput('unsafe-' + mode, [candidate('asset_a', 1, .9, .9)]));
    const input = decisionInput(obs.observationId, 'unsafe-decision-' + mode);
    if (mode === 'omitted') delete input.authorization;
    const decision = await service.recordDecision(workspaceId, input);
    assert.equal(decision.authorization.quality, 'unverified');
    await assert.rejects(service.createDatasetRevision(workspaceId, { purpose: 'evaluation', observationIds: [obs.observationId], createdBy: 'user_fixture' }), e => e.code === 'ASSET_RETRIEVAL_DATASET_EMPTY');
  }
});

test('authoritative revocation blocks freezing and all subsequent dataset consumption without rewriting history', async () => {
  let allowed = true, registered = 0;
  const repository = new InMemoryAssetRetrievalGovernanceRepository();
  const service = new AssetRetrievalGovernanceService(repository, { now: () => new Date(at), verifyAuthorization: async () => allowed,
    evaluationRegistrar: { async register() { registered++; throw new Error('must not register'); } } });
  const workspaceId = ws();
  const pair = await recordPair(service, workspaceId, 'revocation', [candidate('asset_a', 1, .9, .9)]);
  const request = { purpose: 'evaluation', observationIds: [pair.observation.observationId], createdBy: 'user_fixture' };
  const revision = await service.createDatasetRevision(workspaceId, request);
  allowed = false;
  await assert.rejects(service.createDatasetRevision(workspaceId, request), e => e.code === 'ASSET_RETRIEVAL_DATASET_EMPTY');
  await assert.rejects(service.datasetSamples(workspaceId, revision.datasetRevisionId), e => e.code === 'ASSET_RETRIEVAL_AUTHORIZATION_UNVERIFIED');
  await assert.rejects(service.searchPolicy(workspaceId, revision.datasetRevisionId), e => e.code === 'ASSET_RETRIEVAL_AUTHORIZATION_UNVERIFIED');
  await assert.rejects(service.registerEvaluationDataset(workspaceId, revision.datasetRevisionId, { authorization: { status: 'granted' } }), e => e.code === 'ASSET_RETRIEVAL_AUTHORIZATION_UNVERIFIED');
  assert.equal(registered, 0);
  assert.equal((await service.getDecision(workspaceId, pair.decision.decisionId)).authorization.quality, 'clean');
});
