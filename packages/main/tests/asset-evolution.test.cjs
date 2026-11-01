const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  DEFAULT_ASSET_RETRIEVAL_POLICY, DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY,
  assetRetrievalPolicyDigest, freezeAssetRetrievalPolicy,
} = require('@lyra/shared');
const { compileProductionRun } = require('../dist/production/blueprint');
const { MemoryProductionRepository } = require('../dist/production/repository');
const { ProductionService } = require('../dist/production/service');
const { MemoryEvolutionRepository } = require('../dist/evolution/repository');
const { AssetEvolutionService } = require('../dist/evolution/service');
const { runAssetRetrievalProbe } = require('../dist/evolution/probe');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');

const input = (changes = {}) => ({
  projectId: 'project_0123456789abcdef0123456789abcdef', scriptVersionId: 'script_0123456789abcdef0123456789abcdef',
  ratio: '9:16', targetDurationSec: 90, visualStyle: '现实主义悬疑，冷色雨夜', qualityPreset: 'balanced',
  automationMode: 'auto', candidatePolicy: 'direct', candidateLimit: 1, directorPolicy: 'auto',
  budgetMicros: 50_000_000, currency: 'CNY', allowPaid: true, clientRequestId: 'evolution-request-1', ...changes,
});
const NOW = '2026-10-24T12:00:00.000Z';
function issue(runId, id, code, status = 'open') {
  return { id, runId, taskId: null, stage: 'assets', scope: { kind: 'episode', id: null }, severity: 'error', status,
    code, title: '资产歧义', message: '多个候选接近', impact: [], recommendedActions: [], estimatedAdditionalCostMicros: null,
    createdAt: NOW, resolvedAt: status === 'resolved' ? NOW : null };
}
function terminalRun(clientRequestId, codes = ['ASSET_MATCH_AMBIGUOUS']) {
  const run = compileProductionRun(input({ clientRequestId }), NOW);
  run.status = 'failed'; run.updatedAt = '2026-10-24T12:05:00.000Z';
  run.issues = [...codes.map((code, index) => issue(run.id, `issue_${index}`, code)), issue(run.id, 'issue_resolved', 'ASSET_MATCH_AMBIGUOUS', 'resolved')];
  run.budgetLedger = [{ id: 'budget_charge', runId: run.id, taskId: null, attemptId: null, kind: 'charge',
    amountMicros: 100_000, currency: 'CNY', note: 'test', createdAt: NOW }];
  return run;
}
async function setup(codes) {
  const production = new MemoryProductionRepository(); const repository = new MemoryEvolutionRepository();
  const evolution = new AssetEvolutionService(production, repository, { now: () => new Date(NOW) });
  const run = terminalRun(`evolution-${Math.random()}`, codes); await production.create(run);
  return { production, repository, evolution, run };
}

test('019 migration persists evidence, probes, Registry events and immutable triggers', () => {
  const sql = readFileSync(join(__dirname, '../migrations/019_asset_evolution.sql'), 'utf8');
  for (const table of ['evolution_evidence', 'evolution_proposals', 'evolution_candidates', 'evolution_probes', 'evolution_registry', 'evolution_registry_events']) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(sql, /evolution_evidence_immutable/);
  assert.match(sql, /evolution_probes_immutable/);
  assert.match(sql, /evolution_registry_events_immutable/);
});

test('P1 captures only final open issues, deduplicates signatures and keeps evidence immutable', async () => {
  const { production, repository, evolution, run } = await setup();
  const first = await evolution.captureEvidence(run.id);
  assert.equal(first.evidence.openIssues.length, 1);
  assert.equal(first.evidence.openIssues[0].issue.status, 'open');
  assert.equal(first.evidence.actualCostMicros, 100_000);
  assert.equal(first.evidence.durationMs, 300_000);
  assert.equal(first.proposals.length, 1);
  assert.equal(first.proposals[0].kind, 'asset_retrieval_policy');
  const again = await evolution.captureEvidence(run.id);
  assert.equal(again.evidence.id, first.evidence.id);
  assert.equal((await repository.listEvidence()).length, 1);
  const secondRun = terminalRun('evolution-second'); await production.create(secondRun);
  const second = await evolution.captureEvidence(secondRun.id);
  assert.equal(second.proposals[0].id, first.proposals[0].id, 'run id and attempt data do not enter the signature');
  const merged = await repository.getProposal(first.proposals[0].id);
  assert.equal(merged.evidenceIds.length, 2);
  assert.equal(merged.sourceRunIds.length, 2);
  const exposed = await repository.getEvidenceByRun(run.id); exposed.openIssues.length = 0;
  assert.equal((await repository.getEvidenceByRun(run.id)).openIssues.length, 1, 'repository returns defensive copies');
  const active = terminalRun('evolution-active'); active.status = 'running'; await production.create(active);
  await assert.rejects(evolution.captureEvidence(active.id), error => error.code === 'EVOLUTION_RUN_NOT_TERMINAL');
});

test('P2 requires a passing probe, enforces CAS and rollback appends a new Registry revision', async () => {
  const { repository, evolution, run } = await setup(['ASSET_MATCH_AMBIGUOUS', 'SHOT_ASSET_BINDINGS_AMBIGUOUS']);
  const { proposals } = await evolution.captureEvidence(run.id);
  assert.equal(proposals.length, 2);
  const first = await evolution.createCandidate(proposals[0].id);
  const second = await evolution.createCandidate(proposals[1].id);
  assert.equal(first.basePolicy.ambiguityMargin, 0.08);
  assert.equal(first.policy.ambiguityMargin, 0.12);
  await assert.rejects(evolution.adopt(first.id, assetRetrievalPolicyDigest(DEFAULT_ASSET_RETRIEVAL_POLICY), '尚未回放'),
    error => error.code === 'EVOLUTION_PROBE_REQUIRED');
  const probe = await evolution.runProbe(first.id);
  assert.equal(probe.modelCalls, 0);
  assert.equal(probe.verdict, 'pass');
  assert.equal(probe.candidateMetrics.contractFailures, 0);
  await evolution.runProbe(second.id);
  await assert.rejects(evolution.adopt(first.id, 'sha256:0', '错误摘要'), error => error.code === 'EVOLUTION_REGISTRY_STALE');
  const adopted = await evolution.adopt(first.id, assetRetrievalPolicyDigest(DEFAULT_ASSET_RETRIEVAL_POLICY), '固定回放通过，人工采用');
  assert.equal(adopted.revision, 1);
  assert.equal(adopted.policy.sourceCandidateId, first.id);
  assert.equal((await evolution.currentAssetRetrievalPolicy()).ambiguityMargin, 0.12);
  await assert.rejects(evolution.adopt(second.id, adopted.policy.policyDigest, '陈旧基线'), error => error.code === 'EVOLUTION_REGISTRY_STALE');
  const rolledBack = await evolution.rollback(adopted.policy.policyDigest, '人工回滚');
  assert.equal(rolledBack.revision, 2);
  assert.equal(rolledBack.policy.policyDigest, assetRetrievalPolicyDigest(DEFAULT_ASSET_RETRIEVAL_POLICY));
  assert.equal(rolledBack.policy.sourceCandidateId, null);
  const events = await repository.listRegistryEvents();
  assert.deepEqual(events.map(event => event.action), ['adopt', 'rollback']);
  assert.equal(events[0].revision, 1);
  assert.equal(events[1].revision, 2);
});

test('an unsafe candidate fails false-reuse gate and cannot be adopted', async () => {
  const repository = new MemoryEvolutionRepository();
  const proposalId = 'eproposal_manual';
  const unsafe = { id: 'evocand_unsafe', proposalId, basePolicy: { ...DEFAULT_ASSET_RETRIEVAL_POLICY },
    basePolicyDigest: assetRetrievalPolicyDigest(DEFAULT_ASSET_RETRIEVAL_POLICY),
    policy: { ...DEFAULT_ASSET_RETRIEVAL_POLICY, threshold: 0 }, policyDigest: assetRetrievalPolicyDigest({ ...DEFAULT_ASSET_RETRIEVAL_POLICY, threshold: 0 }),
    status: 'draft', createdAt: NOW };
  await repository.createCandidate(unsafe);
  const probe = await runAssetRetrievalProbe(unsafe, NOW);
  assert.equal(probe.verdict, 'fail');
  assert.ok(probe.gate.falseReuseDelta > 0);
  await repository.recordProbe(probe);
  await assert.rejects(repository.adopt(unsafe.id, unsafe.basePolicyDigest, '不得采用'), error => error.code === 'EVOLUTION_PROBE_REQUIRED');
});

test('new runs freeze current policy while idempotent and historical runs never change', async () => {
  const repository = new MemoryProductionRepository();
  let current = DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY;
  const service = new ProductionService(repository, { pollIntervalMs: 60_000, assetRetrievalPolicy: async () => current });
  const first = await service.create(input());
  assert.equal(first.assetRetrievalPolicy.policyDigest, current.policyDigest);
  current = freezeAssetRetrievalPolicy({ ...DEFAULT_ASSET_RETRIEVAL_POLICY, ambiguityMargin: 0.12 }, 7, 'evocand_test');
  const replay = await service.create(input());
  assert.equal(replay.id, first.id);
  assert.equal(replay.assetRetrievalPolicy.policyDigest, DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY.policyDigest);
  const second = await service.create(input({ clientRequestId: 'evolution-request-2' }));
  assert.equal(second.assetRetrievalPolicy.registryRevision, 7);
  assert.equal(second.assetRetrievalPolicy.ambiguityMargin, 0.12);
  assert.equal((await repository.get(first.id)).assetRetrievalPolicy.registryRevision, 0);
});

test('multi-revision rollback restores the exact previously adopted candidate, not a duplicate policy', async () => {
  const repository = new MemoryEvolutionRepository();
  const defaultDigest = assetRetrievalPolicyDigest(DEFAULT_ASSET_RETRIEVAL_POLICY);
  const policyA = { ...DEFAULT_ASSET_RETRIEVAL_POLICY, ambiguityMargin: 0.12 };
  const policyB = { ...policyA, threshold: 0.63 };
  const makeCandidate = (id, proposalId, basePolicy, policy) => ({ id, proposalId, basePolicy,
    basePolicyDigest: assetRetrievalPolicyDigest(basePolicy), policy, policyDigest: assetRetrievalPolicyDigest(policy), status: 'draft', createdAt: NOW });
  const duplicate = makeCandidate('evocand_duplicate', 'eproposal_duplicate', DEFAULT_ASSET_RETRIEVAL_POLICY, policyA);
  const first = makeCandidate('evocand_first', 'eproposal_first', DEFAULT_ASSET_RETRIEVAL_POLICY, policyA);
  const second = makeCandidate('evocand_second', 'eproposal_second', policyA, policyB);
  await repository.createCandidate(duplicate); await repository.createCandidate(first); await repository.createCandidate(second);
  await repository.recordProbe(await runAssetRetrievalProbe(first, NOW));
  await repository.recordProbe(await runAssetRetrievalProbe(second, NOW));
  const adoptedA = await repository.adopt(first.id, defaultDigest, '采用 A', NOW);
  const adoptedB = await repository.adopt(second.id, adoptedA.policy.policyDigest, '采用 B', '2026-10-24T12:01:00.000Z');
  const restored = await repository.rollback(adoptedB.policy.policyDigest, '回到 A', '2026-10-24T12:02:00.000Z');
  assert.equal(restored.revision, 3);
  assert.equal(restored.policy.sourceCandidateId, first.id);
  assert.notEqual(restored.policy.sourceCandidateId, duplicate.id);
  assert.deepEqual(restored.policy.threshold, policyA.threshold);
  assert.deepEqual(restored.policy.ambiguityMargin, policyA.ambiguityMargin);
  assert.deepEqual((await repository.listRegistryEvents()).map(event => event.action), ['adopt', 'adopt', 'rollback']);
});

test('HTTP exposes the local-only evidence/probe/adopt/rollback workflow with no-store', async t => {
  const { evolution, run } = await setup();
  const app = await createApp(readConfig({}), fetch, { evolutionService: evolution }); t.after(() => app.close());
  const host = { host: '127.0.0.1:8788' };
  const write = { ...host, origin: 'http://127.0.0.1:5173', 'x-shortdrama-call': '1' };
  const initial = await app.inject({ method: 'GET', url: '/api/evolution/assets', headers: host });
  assert.equal(initial.statusCode, 200); assert.equal(initial.json().registry.revision, 0);
  assert.match(initial.headers['cache-control'], /no-store/);
  const denied = await app.inject({ method: 'POST', url: `/api/evolution/assets/evidence/${run.id}`, headers: host, payload: {} });
  assert.equal(denied.statusCode, 403);
  const captured = await app.inject({ method: 'POST', url: `/api/evolution/assets/evidence/${run.id}`, headers: write, payload: {} });
  assert.equal(captured.statusCode, 200);
  const proposalId = captured.json().proposals[0].id;
  const candidate = await app.inject({ method: 'POST', url: `/api/evolution/assets/proposals/${proposalId}/candidates`, headers: write, payload: {} });
  assert.equal(candidate.statusCode, 200);
  const candidateId = candidate.json().id;
  const probe = await app.inject({ method: 'POST', url: `/api/evolution/assets/candidates/${candidateId}/probes`, headers: write, payload: {} });
  assert.equal(probe.statusCode, 200); assert.equal(probe.json().modelCalls, 0); assert.equal(probe.json().verdict, 'pass');
  const adopted = await app.inject({ method: 'POST', url: `/api/evolution/assets/candidates/${candidateId}/adopt`, headers: write,
    payload: { expectedPolicyDigest: assetRetrievalPolicyDigest(DEFAULT_ASSET_RETRIEVAL_POLICY), reason: 'HTTP 人工采用' } });
  assert.equal(adopted.statusCode, 200, adopted.body); assert.equal(adopted.json().revision, 1);
  const rolledBack = await app.inject({ method: 'POST', url: '/api/evolution/assets/registry/rollback', headers: write,
    payload: { expectedPolicyDigest: adopted.json().policy.policyDigest, reason: 'HTTP 人工回滚' } });
  assert.equal(rolledBack.statusCode, 200); assert.equal(rolledBack.json().revision, 2);
});

test('legacy runs without the optional field retain the built-in baseline', async () => {
  const legacy = compileProductionRun(input(), NOW);
  delete legacy.assetRetrievalPolicy;
  legacy.status = 'cancelled';
  const repository = new MemoryProductionRepository(); await repository.create(legacy);
  const evolution = new AssetEvolutionService(repository, new MemoryEvolutionRepository(), { now: () => new Date(NOW) });
  const { evidence } = await evolution.captureEvidence(legacy.id);
  assert.equal(evidence.assetRetrievalPolicy.policyDigest, DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY.policyDigest);
  assert.equal(evidence.assetRetrievalPolicy.registryRevision, 0);
});
