const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ProductionInputCandidateCompiler } = require('../dist/production/input-compiler');
const { sealShotSpecV2 } = require('../dist/production/shot-spec');
function fixture() {
  const tenant = { userId: 'usr_' + '1'.repeat(32), workspaceId: 'ws_' + '2'.repeat(32), role: 'owner', requestId: 'input-compiler-test' };
  const ref = id => ({ id, versionId: id, digest: 'a'.repeat(64) });
  const shotDraft = { schemaVersion: 'lyra-shot-spec/2', revisionId: 'shotversion-one', workspaceId: tenant.workspaceId,
    projectId: 'project-one', episodeId: 'episode-one', scriptVersionId: 'script-one', planRevisionId: 'plan-one',
    storyboardRevisionId: 'board-one', shotId: 'shot-one', sceneId: 'scene-one', order: 1, durationMs: 5000, ratio: '9:16', shotSize: 'wide',
    camera: { description: null, movement: 'still', focalLengthMm: null, composition: null }, dialogue: [], actions: [], assetPacks: [], controls: [],
    visualStyle: 'offline', negativeConstraints: [], continuity: { before: [], after: [] }, timeline: [], sourceRefs: [],
    generation: { methodPackRevisions: [], promptPackRevision: ref('prompt-one'), modelCapabilityRevision: ref('capability-one'), candidatePolicy: { mode: 'direct', limit: 1 } },
    source: { kind: 'user', actor: tenant.userId, sourceRevisionId: null }, createdAt: '2026-11-09T00:00:00.000Z' };
  const frame = { projectId: 'project-one', workspaceId: tenant.workspaceId, episodeId: 'episode-one', projectRevision: '7',
    versions: { scriptVersionId: 'script-one', planRevisionId: 'plan-one', storyboardRevisionId: 'board-one' },
    script: { id: 'script-one', rawText: 'private source', digest: 'a'.repeat(64) },
    plan: { id: 'plan-one', content: {}, digest: 'a'.repeat(64) }, storyboard: { id: 'board-one', content: {}, digest: 'a'.repeat(64) },
    shotVersions: [sealShotSpecV2(shotDraft)], inputSetDigest: 'a'.repeat(64) };
  const profile = { id: 'snapshot-one', createdAt: shotDraft.createdAt, reason: 'offline', modelConnections: [{ role: 'video', connection: ref('model-one'), capability: ref('capability-one') }],
    retrievalPolicy: ref('retrieval-one'), qualityGates: [ref('gate-one')], budgetPolicy: { version: ref('budget-one'), limitMicros: 0, currency: 'CNY', allowPaid: false },
    candidatePolicy: { mode: 'direct', limit: 1 }, automationMode: 'auto' };
  const compiler = new ProductionInputCandidateCompiler({ async readCurrentProjectInputs() { return structuredClone(frame); } });
  return { tenant, shotDraft, frame, profile, compiler, compile: () => compiler.compile(tenant, frame.projectId, frame.episodeId, profile) };
}
test('compiler derives source and shot refs from server view, never promotes a candidate to ready/frozen', async () => {
  const f = fixture(), before = JSON.stringify(f.frame), result = await f.compile();
  assert.equal(result.state, 'draft'); assert.equal(result.candidate.state, 'draft');
  assert.equal(result.candidate.baseProjectRevision, '7'); assert.equal(result.candidate.createdBy, f.tenant.userId);
  assert.equal(result.candidate.shots[0].revisionId, 'shotversion-one');
  assert.equal(JSON.stringify(result).includes('private source'), false);
  assert.equal(JSON.stringify(f.frame), before);
});
test('missing adopted sources or empty/oversize formal shot set returns blocked, not fabricated versions', async () => {
  for (const edit of [f => { f.frame.plan = null; }, f => { f.frame.shotVersions = []; }, f => { f.frame.shotVersions = Array(2001).fill(f.frame.shotVersions[0]); }]) {
    const f = fixture(); edit(f); const result = await f.compile(); assert.equal(result.state, 'blocked'); assert.equal(result.candidate, null);
  }
});
test('foreign shot and mixed versions of the same prompt resource cannot compile', async () => {
  const f = fixture(); f.frame.shotVersions = [sealShotSpecV2({ ...f.shotDraft, workspaceId: 'ws_' + '3'.repeat(32) })];
  await assert.rejects(f.compile(), e => e.code === 'REFERENCE_NOT_FOUND');
  const g = fixture(), next = structuredClone(g.shotDraft); next.shotId = 'shot-two'; next.revisionId = 'shotversion-two';
  next.generation.promptPackRevision.versionId = 'prompt-two';
  g.frame.shotVersions.push(sealShotSpecV2(next)); await assert.rejects(g.compile(), e => e.code === 'DIGEST_MISMATCH');
});
