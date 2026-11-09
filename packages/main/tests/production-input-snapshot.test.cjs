const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { parseProductionInputSnapshotDraft: parse } = require('../../shared/dist/production-input-snapshot');
const { sealProductionInputSnapshot: seal, verifyProductionInputSnapshot: verify } = require('../dist/production/input-snapshot');
const ref = () => ({ id: 'resource-one', versionId: 'version-one', digest: 'a'.repeat(64) });
function fixture() {
  return { schemaVersion: 'lyra-production-input/1', id: 'snapshot-one', workspaceId: 'ws_' + 'a'.repeat(32),
    projectId: 'project-one', episodeId: 'episode-one', baseProjectRevision: '1', state: 'draft',
    shots: [{ shotId: 'shot-one', revisionId: 'shotversion-one', contentDigest: 'b'.repeat(64) }],
    script: ref(), plan: ref(), storyboard: ref(), assetPacks: [], directorScenes: [], controls: [], methodPacks: [], promptPacks: [],
    modelConnections: [{ role: 'video', connection: ref(), capability: ref() }], retrievalPolicy: ref(), qualityGates: [],
    budgetPolicy: { version: ref(), limitMicros: 1000, currency: 'CNY', allowPaid: false }, candidatePolicy: { mode: 'direct', limit: 1 },
    automationMode: 'auto', findings: [], createdBy: 'usr-one', createdAt: '2026-11-09T00:00:00.000Z', reason: 'offline test' };
}
const rejects = f => assert.throws(f, e => e.code === 'PRODUCTION_INPUT_INVALID' && e.message === '生产输入快照契约无效。');
test('snapshot parser preserves versioned references, ordered shots, budget and private-free model metadata', () => {
  const draft = fixture(); assert.deepEqual(parse(draft), draft);
  const sealed = seal(draft); assert.deepEqual(verify(sealed), sealed);
  assert.equal(seal(Object.fromEntries(Object.entries(draft).reverse())).snapshotDigest, sealed.snapshotDigest);
});
test('snapshot content digest ignores outer audit/state but binds exact versions, tenant, ordered shots and budget', () => {
  const base = seal(fixture()), metadata = fixture();
  Object.assign(metadata, { id: 'snapshot-two', createdBy: 'usr-two', createdAt: '2026-11-10T00:00:00.000Z', reason: 'review', state: 'frozen' });
  assert.equal(seal(metadata).snapshotDigest, base.snapshotDigest);
  for (const update of [d => { d.script.versionId = 'version-two'; }, d => { d.budgetPolicy.limitMicros++; },
    d => { d.workspaceId = 'ws_' + 'b'.repeat(32); }, d => { d.shots[0].revisionId = 'shotversion-two'; }]) {
    const draft = fixture(); update(draft); assert.notEqual(seal(draft).snapshotDigest, base.snapshotDigest);
  }
  base.plan.digest = 'c'.repeat(64);
  assert.throws(() => verify(base), e => e.code === 'DIGEST_MISMATCH');
});
test('blocked requires findings and ready/frozen cannot carry findings, without pretending a ready flag proves authorization', () => {
  const draft = fixture(); draft.state = 'blocked'; rejects(() => seal(draft));
  draft.findings = [{ code: 'REFERENCE_FORBIDDEN', referenceId: 'resource-one' }]; assert.equal(seal(draft).state, 'blocked');
  for (const state of ['ready', 'frozen']) { draft.state = state; rejects(() => seal(draft)); }
});
test('closed shape rejects secrets, duplicate subjects, invalid refs, budget/policy limits and active objects without echoing errors', () => {
  const changes = [d => { d.modelConnections[0].connection.apiKey = 'secret'; }, d => { d.shots.push(d.shots[0]); },
    d => { d.budgetPolicy.limitMicros = -1; }, d => { d.candidatePolicy.limit = 2; }, d => { d.script.versionId = 'https://secret.invalid'; },
    d => { d.reason = '\ud800'; }, d => { d.modelConnections.push(d.modelConnections[0]); }];
  for (const change of changes) { const draft = fixture(); change(draft); rejects(() => seal(draft)); }
  let reads = 0; const draft = fixture(); Object.defineProperty(draft, 'reason', { enumerable: true, get() { reads++; throw new Error('secret'); } });
  rejects(() => seal(draft)); assert.equal(reads, 0);
});
test('snapshot DTO loads in a browser realm with only its browser-safe shot helper', () => {
  // Evaluate both modules in one realm so Object prototypes match, as in a real bundle.
  const context = vm.createContext({ exports: {}, input: JSON.stringify(fixture()) });
  vm.runInContext(readFileSync(join(__dirname, '../../shared/dist/shot-spec.js'), 'utf8'), context);
  context.shotExports = context.exports; context.exports = {};
  vm.runInContext('var require = () => shotExports;\n' + readFileSync(join(__dirname, '../../shared/dist/production-input-snapshot.js'), 'utf8'), context);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(exports.parseProductionInputSnapshotDraft(JSON.parse(input)))', context)), fixture());
});
