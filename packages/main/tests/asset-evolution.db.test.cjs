const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DEFAULT_ASSET_RETRIEVAL_POLICY, assetRetrievalPolicyDigest } = require('@lyra/shared');
const { PostgresDatabase } = require('../dist/db/client');
const { readDatabaseConfig } = require('../dist/db/config');
const { compileProductionRun } = require('../dist/production/blueprint');
const { buildAssetRunEvidence, buildDeterministicProposals } = require('../dist/evolution/evidence');
const { PostgresEvolutionRepository } = require('../dist/evolution/postgres-repository');
const { runAssetRetrievalProbe } = require('../dist/evolution/probe');

const connectionString = process.env.EVOLUTION_TEST_DATABASE_URL;
const NOW = '2026-10-24T12:00:00.000Z';
const request = clientRequestId => ({ projectId: 'project_0123456789abcdef0123456789abcdef',
  scriptVersionId: 'script_0123456789abcdef0123456789abcdef', ratio: '9:16', targetDurationSec: 90,
  visualStyle: 'test', qualityPreset: 'balanced', automationMode: 'auto', candidatePolicy: 'direct', candidateLimit: 1,
  directorPolicy: 'auto', budgetMicros: 1_000_000, currency: 'CNY', allowPaid: false, clientRequestId });
const makeCandidate = (id, proposalId, basePolicy, policy) => ({ id, proposalId, basePolicy,
  basePolicyDigest: assetRetrievalPolicyDigest(basePolicy), policy, policyDigest: assetRetrievalPolicyDigest(policy),
  status: 'draft', createdAt: NOW });

// Runs only in the disposable database created by scripts/test-evolution-db.mjs.
test('PostgreSQL evolution persists the full workflow and enforces immutable records', {
  skip: connectionString ? false : 'Run npm run test:evolution-db to create an isolated migrated database.',
}, async () => {
  const database = new PostgresDatabase(readDatabaseConfig({ DATABASE_URL: connectionString }));
  try {
    assert.equal(await database.hasMigrations(['019']), true);
    const repository = new PostgresEvolutionRepository(database);
    const run = compileProductionRun(request(`db-evolution-${randomUUID()}`), NOW);
    run.status = 'failed'; run.updatedAt = '2026-10-24T12:05:00.000Z';
    run.issues = ['ASSET_MATCH_AMBIGUOUS', 'SHOT_ASSET_BINDINGS_AMBIGUOUS'].map((code, index) => ({
      id: `issue_${index}`, runId: run.id, taskId: null, stage: 'assets', scope: { kind: 'episode', id: null },
      severity: 'error', status: 'open', code, title: '资产歧义', message: 'test', impact: [], recommendedActions: [],
      estimatedAdditionalCostMicros: null, createdAt: NOW, resolvedAt: null,
    }));
    const evidence = buildAssetRunEvidence(run, NOW); const proposals = buildDeterministicProposals(evidence);
    assert.equal(proposals.length, 2);
    await repository.recordEvidence(evidence, proposals); await repository.recordEvidence(evidence, proposals);
    assert.equal((await repository.listEvidence()).filter(item => item.runId === run.id).length, 1);
    assert.equal((await repository.getProposal(proposals[0].id)).evidenceIds.length, 1);
    await assert.rejects(database.query('DELETE FROM evolution_evidence WHERE id=$1', [evidence.id]), /immutable evolution record/);

    const policyA = { ...DEFAULT_ASSET_RETRIEVAL_POLICY, ambiguityMargin: 0.12 };
    const policyB = { ...policyA, threshold: 0.63 };
    const duplicate = makeCandidate('evocand_db_duplicate', proposals[1].id, DEFAULT_ASSET_RETRIEVAL_POLICY, policyA);
    const first = makeCandidate('evocand_db_first', proposals[0].id, DEFAULT_ASSET_RETRIEVAL_POLICY, policyA);
    const second = makeCandidate('evocand_db_second', proposals[1].id, policyA, policyB);
    await repository.createCandidate(duplicate); await repository.createCandidate(first); await repository.createCandidate(second);
    const deduplicated = await repository.createCandidate({ ...first, id: 'evocand_db_same_content' });
    assert.equal(deduplicated.id, first.id);
    const probeA = await repository.recordProbe(await runAssetRetrievalProbe(first, NOW));
    await repository.recordProbe(await runAssetRetrievalProbe(second, NOW));
    assert.equal(probeA.modelCalls, 0); assert.equal(probeA.verdict, 'pass');
    await assert.rejects(database.query('UPDATE evolution_probes SET probe_json=$2::jsonb WHERE id=$1', [probeA.id, probeA]), /immutable evolution record/);
    await assert.rejects(repository.adopt(first.id, '0'.repeat(64), '错误基线', NOW), error => error.code === 'EVOLUTION_REGISTRY_STALE');
    const adoptedA = await repository.adopt(first.id, assetRetrievalPolicyDigest(DEFAULT_ASSET_RETRIEVAL_POLICY), '采用 A', NOW);
    assert.equal(adoptedA.revision, 1);
    const adoptedB = await repository.adopt(second.id, adoptedA.policy.policyDigest, '采用 B', '2026-10-24T12:01:00.000Z');
    assert.equal(adoptedB.revision, 2);
    const restored = await repository.rollback(adoptedB.policy.policyDigest, '回到 A', '2026-10-24T12:02:00.000Z');
    assert.equal(restored.revision, 3);
    assert.equal(restored.policy.sourceCandidateId, first.id);
    assert.notEqual(restored.policy.sourceCandidateId, duplicate.id);
    const events = await repository.listRegistryEvents();
    assert.deepEqual(events.map(event => event.action), ['adopt', 'adopt', 'rollback']);
    await assert.rejects(database.query('DELETE FROM evolution_registry_events WHERE id=$1', [events[0].id]), /immutable evolution record/);
    await assert.rejects(repository.rollback(restored.policy.policyDigest, '重复回滚', NOW), error => error.code === 'EVOLUTION_ROLLBACK_UNAVAILABLE');
  } finally { await database.close(); }
});
