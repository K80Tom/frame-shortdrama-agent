const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sealShotSpecV2 } = require('../dist/production/shot-spec');
const { sealProductionInputSnapshot } = require('../dist/production/input-snapshot');
const { validateProductionInputCandidate: validate } = require('../dist/production/input-validation');
function fixture() {
  const tenant = { userId: 'usr_' + '1'.repeat(32), workspaceId: 'ws_' + '2'.repeat(32), role: 'owner', requestId: 'test-input-validation' };
  const ref = id => ({ id, versionId: id, digest: 'a'.repeat(64) });
  const shotDraft = { schemaVersion: 'lyra-shot-spec/2', revisionId: 'shotversion-one', workspaceId: tenant.workspaceId,
    projectId: 'project-one', episodeId: 'episode-one', scriptVersionId: 'script-one', planRevisionId: 'plan-one',
    storyboardRevisionId: 'board-one', shotId: 'shot-one', sceneId: 'scene-one', order: 1, durationMs: 5000, ratio: '9:16', shotSize: 'wide',
    camera: { description: null, movement: 'still', focalLengthMm: null, composition: null }, dialogue: [], actions: [], assetPacks: [], controls: [],
    visualStyle: 'offline', negativeConstraints: [], continuity: { before: [], after: [] }, timeline: [],
    generation: { methodPackRevisions: [], promptPackRevision: ref('prompt-one'), modelCapabilityRevision: ref('capability-one'), candidatePolicy: { mode: 'direct', limit: 1 } },
    sourceRefs: [{ scriptVersionId: 'script-one', start: 0, end: 1, quote: '甲' }],
    source: { kind: 'user', actor: tenant.userId, sourceRevisionId: null }, createdAt: '2026-11-09T00:00:00.000Z' };
  let shot = sealShotSpecV2(shotDraft);
  const draft = { schemaVersion: 'lyra-production-input/1', id: 'input-one', workspaceId: tenant.workspaceId,
    projectId: 'project-one', episodeId: 'episode-one', baseProjectRevision: 'projectrevision-one', state: 'frozen',
    shots: [{ shotId: shot.shotId, revisionId: shot.revisionId, contentDigest: shot.contentDigest }],
    script: ref('script-one'), plan: ref('plan-one'), storyboard: ref('board-one'), assetPacks: [], directorScenes: [], controls: [], methodPacks: [],
    promptPacks: [ref('prompt-one')], modelConnections: [{ role: 'video', connection: ref('connection-one'), capability: ref('capability-one') }],
    retrievalPolicy: ref('retrieval-one'), qualityGates: [ref('gate-one')], budgetPolicy: { version: ref('budget-one'), limitMicros: 0, currency: 'CNY', allowPaid: false },
    candidatePolicy: { mode: 'direct', limit: 1 }, automationMode: 'auto', findings: [], createdBy: tenant.userId,
    createdAt: '2026-11-09T00:00:00.000Z', reason: 'offline test' };
  const calls = [];
  const ports = { async authorizeProject() { calls.push('project'); return true; }, async loadShot() { calls.push('shot'); return shot; },
    async checkVersion(ctx, kind) { assert.equal(ctx.workspaceId, tenant.workspaceId); calls.push(kind); return null; },
    async checkObject() { calls.push('object'); return null; }, async checkSource() { calls.push('source'); return null; },
    async checkAssetBinding() { calls.push('asset-binding'); return null; }, async checkControl() { calls.push('control-binding'); return null; },
    async checkCapabilities() { calls.push('capabilities'); return []; } };
  return { tenant, draft, shotDraft, ports, calls, setShot(v) { shot = v; }, snapshot() { return sealProductionInputSnapshot(draft); } };
}
test('read-only validation traverses authenticated exact versions, source and capabilities without writes or provider calls', async () => {
  const f = fixture(), result = await validate(f.tenant, f.snapshot(), f.ports);
  assert.equal(result.state, 'ready'); assert.equal(result.checkedShotCount, 1); assert.deepEqual(result.findings, []);
  for (const kind of ['project', 'script', 'plan', 'storyboard', 'prompt_pack', 'quality_gate', 'model_connection', 'model_capability', 'source', 'capabilities']) assert.ok(f.calls.includes(kind));
});
test('foreign workspace and unauthorized project stop before reference reads even if input claims frozen', async () => {
  const f = fixture(); f.draft.workspaceId = 'ws_' + '3'.repeat(32);
  await assert.rejects(validate(f.tenant, f.snapshot(), f.ports), e => e.code === 'REFERENCE_NOT_FOUND'); assert.deepEqual(f.calls, []);
  f.draft.workspaceId = f.tenant.workspaceId; f.ports.authorizeProject = async () => false;
  await assert.rejects(validate(f.tenant, f.snapshot(), f.ports), e => e.code === 'REFERENCE_NOT_FOUND'); assert.deepEqual(f.calls, []);
});
test('missing, corrupted and foreign shot records are distinct blocked results', async () => {
  for (const [make, code] of [[() => null, 'REFERENCE_NOT_FOUND'], [f => ({ ...sealShotSpecV2(f.shotDraft), contentDigest: '0'.repeat(64) }), 'DIGEST_MISMATCH'],
    [f => sealShotSpecV2({ ...f.shotDraft, workspaceId: 'ws_' + '3'.repeat(32) }), 'REFERENCE_FORBIDDEN']]) {
    const f = fixture(); f.setShot(make(f)); const result = await validate(f.tenant, f.snapshot(), f.ports);
    assert.equal(result.state, 'blocked'); assert.equal(result.findings[0].code, code); assert.equal(f.calls.includes('capabilities'), false);
  }
});
test('unlisted prompt and mismatched lineage cannot yield ready', async () => {
  const f = fixture(); f.draft.promptPacks = []; f.draft.plan.versionId = 'plan-other';
  const result = await validate(f.tenant, f.snapshot(), f.ports);
  assert.ok(result.findings.some(x => x.code === 'REFERENCE_NOT_FOUND' && x.referenceId === 'prompt-one'));
  assert.ok(result.findings.some(x => x.code === 'DIGEST_MISMATCH'));
});
test('a listed artifact and authorized object still require exact asset-pack and control-object binding checks', async () => {
  const f = fixture(), ref = { id: 'asset-one', versionId: 'assetversion-one', digest: 'a'.repeat(64) };
  f.shotDraft.assetPacks = [{ entityId: 'character-one', kind: 'character', pack: ref,
    media: [{ role: 'front', objectId: 'object-one', objectVersionId: 'objectversion-one', checksum: 'b'.repeat(64) }] }];
  f.shotDraft.controls = [{ kind: 'first_frame', artifact: ref, objectId: 'object-one', timeMs: 0 }];
  const shot = sealShotSpecV2(f.shotDraft); f.setShot(shot); f.draft.shots[0].contentDigest = shot.contentDigest;
  f.draft.assetPacks = [ref]; f.draft.controls = [ref];
  f.ports.checkAssetBinding = async () => { f.calls.push('asset-binding'); return 'DIGEST_MISMATCH'; };
  f.ports.checkControl = async () => { f.calls.push('control-binding'); return 'REFERENCE_FORBIDDEN'; };
  const result = await validate(f.tenant, f.snapshot(), f.ports);
  assert.equal(result.state, 'blocked');
  for (const call of ['asset-binding', 'control-binding', 'object']) assert.ok(f.calls.includes(call));
  assert.ok(result.findings.some(f => f.code === 'DIGEST_MISMATCH'));
  assert.ok(result.findings.some(f => f.code === 'REFERENCE_FORBIDDEN'));
});
test('reference authorization failures, capability mismatches and unexpected adapter errors fail closed without raw diagnostics', async () => {
  const f = fixture(); f.ports.checkVersion = async () => 'REFERENCE_FORBIDDEN';
  f.ports.checkSource = async () => { throw new Error('secret-source'); };
  f.ports.checkCapabilities = async () => { throw new Error('secret-provider'); };
  const result = await validate(f.tenant, f.snapshot(), f.ports);
  assert.equal(result.state, 'blocked'); assert.ok(result.findings.some(x => x.code === 'CAPABILITY_INCOMPATIBLE'));
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
