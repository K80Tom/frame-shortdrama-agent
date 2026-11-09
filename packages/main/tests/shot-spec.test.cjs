const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { parseShotSpecV2, parseShotSpecV2Draft } = require('../../shared/dist/shot-spec');
const { sealShotSpecV2: seal, verifyShotSpecV2: verify, compareShotSpecRevisions: compare } = require('../dist/production/shot-spec');
const ref = () => ({ id: 'asset-one', versionId: 'version-one', digest: 'a'.repeat(64) });
function draft() {
  const quote = '甲😀乙';
  return { schemaVersion: 'lyra-shot-spec/2', revisionId: 'shotspec-one', workspaceId: 'ws_' + 'a'.repeat(32),
    projectId: 'project-one', episodeId: 'episode-one', scriptVersionId: 'script-one', planRevisionId: 'plan-one', storyboardRevisionId: 'board-one',
    shotId: 'shot-one', sceneId: 'scene-one', order: 1, durationMs: 5000, ratio: '9:16', shotSize: 'close',
    camera: { description: null, movement: 'still', focalLengthMm: 35, composition: null },
    dialogue: [{ id: 'line-one', speakerEntityId: 'character-one', text: quote, tone: null,
      sourceRef: { scriptVersionId: 'script-one', start: 0, end: 3, quote } }],
    actions: [{ id: 'action-one', origin: 'design', text: 'look toward the window', sourceRefs: [] }],
    assetPacks: [{ entityId: 'character-one', kind: 'character', pack: ref(), media: [{ role: 'front', objectId: 'object-front', objectVersionId: 'ov-one', checksum: 'b'.repeat(64) }] }],
    controls: [{ kind: 'first_frame', artifact: ref(), objectId: 'object-one', timeMs: 0 },
      { kind: 'director_scene', artifact: ref(), objectId: null, timeMs: null }],
    visualStyle: 'realistic', negativeConstraints: ['do not add dialogue'],
    continuity: { before: [{ entityId: 'character-one', field: 'costume', value: 'coat' }], after: [] },
    timeline: [{ id: 'cue-one', kind: 'dialogue', startMs: 0, endMs: 4000, dialogueId: 'line-one',
      entityId: 'character-one', text: quote, asset: null }],
    generation: { methodPackRevisions: [], promptPackRevision: ref(), modelCapabilityRevision: ref(), candidatePolicy: { mode: 'direct', limit: 1 } },
    sourceRefs: [{ scriptVersionId: 'script-one', start: 0, end: 3, quote }],
    source: { kind: 'user', actor: 'usr-one', sourceRevisionId: null }, createdAt: '2026-11-08T08:00:00.000Z' };
}
const rejects = work => assert.throws(work, e => e.code === 'SHOT_SPEC_INVALID' && e.message === '镜头输入契约无效。');
function changed(update) { const value = draft(); value.revisionId = 'shotspec-two'; update(value); return seal(value); }

test('shared draft/result DTO round-trips verbatim source and all seven control kinds without active dependencies', () => {
  const value = draft();
  value.controls.push(...['last_frame', 'pose', 'depth', 'mask', 'edge'].map((kind, i) => ({ kind,
    artifact: ref(), objectId: 'object-' + i, timeMs: kind === 'last_frame' ? 5000 : 2500 })));
  const before = JSON.stringify(value), sealed = seal(value);
  assert.deepEqual(parseShotSpecV2Draft(value), value);
  assert.deepEqual(parseShotSpecV2(sealed), sealed); assert.deepEqual(verify(sealed), sealed);
  assert.equal(JSON.stringify(value), before);
  assert.equal(sealed.dialogue[0].sourceRef.end, 3); // code points, not four UTF-16 units
  assert.equal(sealed.camera.description, null);
  assert.match(sealed.contentDigest, /^[a-f0-9]{64}$/);
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  assert.equal(seal(reordered).contentDigest, sealed.contentDigest);
});
test('new route requirements bind episode, focal length, media checksum and generation revisions without allowing endpoint credentials', () => {
  const mutations = [d => { delete d.episodeId; }, d => { d.camera.focalLengthMm = 0; },
    d => { d.camera.focalLengthMm = Infinity; }, d => { d.assetPacks[0].media[0].objectId = '/tmp/private'; },
    d => { d.assetPacks[0].media[0].checksum = 'missing'; }, d => { d.assetPacks[0].media.push(d.assetPacks[0].media[0]); },
    d => { d.generation.candidatePolicy.limit = 2; }, d => { d.generation.candidatePolicy = { mode: 'gacha', limit: 1 }; },
    d => { d.generation.modelCapabilityRevision.endpoint = 'https://secret.invalid'; }];
  for (const mutate of mutations) { const value = draft(); mutate(value); rejects(() => seal(value)); }
  const before = seal(draft()), after = changed(d => { d.generation.candidatePolicy = { mode: 'gacha', limit: 2 }; });
  assert.notEqual(before.contentDigest, after.contentDigest);
  assert.ok(compare(before, after).affectedNodes.includes('video'));
});
test('SHA-256 verification rejects stale/tampered bodies; parsing is not an integrity or authorization proof', () => {
  const value = seal(draft()); value.camera.movement = 'tampered';
  assert.equal(parseShotSpecV2(value).camera.movement, 'tampered');
  assert.throws(() => verify(value), e => e.code === 'SHOT_SPEC_DIGEST_MISMATCH');
  const sameId = draft(); sameId.durationMs = 6000;
  assert.throws(() => compare(seal(draft()), seal(sameId)), e => e.code === 'SHOT_SPEC_REVISION_REUSED');
});
test('camera changes invalidate only the target visual dependencies, never rewrite a prior revision', () => {
  const before = seal(draft()), saved = JSON.stringify(before), after = changed(d => { d.camera.movement = 'pan'; });
  const impact = compare(before, after);
  assert.deepEqual(impact.changedFields, ['camera']); assert.equal(impact.needsReview, true);
  assert.deepEqual(impact.affectedNodes, ['video', 'review', 'compose', 'delivery', 'canvas']);
  assert.equal(JSON.stringify(before), saved);
});
test('subtitle-only edits leave video/voice intact; dialogue and duration changes include their real downstream domains', () => {
  const before = seal(draft());
  const subtitle = compare(before, changed(d => { d.timeline.push({ id: 'subtitle-one', kind: 'subtitle',
    startMs: 0, endMs: 1000, dialogueId: null, entityId: null, text: 'caption', asset: null }); }));
  assert.deepEqual(subtitle.affectedNodes, ['subtitles', 'compose', 'delivery', 'canvas']);
  const dialogue = compare(before, changed(d => { d.dialogue[0].text = '乙😀甲'; d.dialogue[0].sourceRef.quote = '乙😀甲'; }));
  assert.ok(dialogue.affectedNodes.includes('voice')); assert.ok(dialogue.affectedNodes.includes('lip_sync'));
  const duration = compare(before, changed(d => { d.durationMs = 6000; }));
  assert.ok(duration.affectedNodes.includes('sfx')); assert.ok(duration.affectedNodes.includes('music'));
});
test('a new revision/provenance with identical production content does not invent invalidations', () => {
  const impact = compare(seal(draft()), changed(d => { d.source.actor = 'usr-two'; }));
  assert.equal(impact.needsReview, false); assert.deepEqual(impact.changedFields, []); assert.deepEqual(impact.affectedNodes, []);
});
test('content digest excludes version identity/time/actor but immutable record comparison still rejects an in-place metadata rewrite', () => {
  const before = seal(draft());
  const next = changed(d => { d.createdAt = '2026-11-09T08:00:00.000Z'; d.source.actor = 'usr-two'; });
  assert.equal(before.contentDigest, next.contentDigest);
  const modified = draft(); modified.source.actor = 'usr-two';
  assert.throws(() => compare(before, seal(modified)), e => e.code === 'SHOT_SPEC_REVISION_REUSED');
});
test('cross-workspace/project/shot comparison is rejected rather than leaking an unrelated diff', () => {
  for (const [field, value] of [['workspaceId', 'ws_' + 'b'.repeat(32)], ['projectId', 'project-two'], ['shotId', 'shot-two']]) {
    const after = changed(d => { d[field] = value; });
    assert.throws(() => compare(seal(draft()), after), e => e.code === 'SHOT_SPEC_NOT_FOUND');
  }
});
test('closed field sets, IDs, enums, finite integer bounds and genuine ISO dates are enforced', () => {
  const mutations = [d => { d.unknown = true; }, d => { d.camera.unknown = true; },
    d => { d.source.endpoint = 'https://secret.invalid'; }, d => { d.durationMs = NaN; },
    d => { d.durationMs = 1.5; }, d => { d.durationMs = 60001; }, d => { d.shotId = 'shot-one\n'; },
    d => { d.workspaceId += '\n'; }, d => { d.createdAt = '2026-02-30T08:00:00.000Z'; },
    d => { d.source.kind = 'plugin'; }, d => { d.ratio = '1:1'; }, d => { d.actions[0].text = '\ud800'; }];
  for (const mutate of mutations) { const value = draft(); mutate(value); rejects(() => seal(value)); }
  rejects(() => parseShotSpecV2(draft()));
  rejects(() => parseShotSpecV2Draft(seal(draft())));
});
test('source spans bind the exact script version, Unicode quote length and verbatim dialogue/action text', () => {
  const mutations = [d => { d.dialogue[0].sourceRef.scriptVersionId = 'script-two'; },
    d => { d.dialogue[0].sourceRef.end = 4; }, d => { d.dialogue[0].text = 'rewritten'; },
    d => { d.actions[0].origin = 'source'; },
    d => { d.actions[0] = { id: 'action-one', origin: 'source', text: 'wrong', sourceRefs: [d.dialogue[0].sourceRef] }; }];
  for (const mutate of mutations) { const value = draft(); mutate(value); rejects(() => seal(value)); }
});
test('duplicate bindings/controls/states/cues and dangling or out-of-bounds timeline references cannot pass', () => {
  const mutations = [d => { d.assetPacks.push(d.assetPacks[0]); }, d => { d.controls.push(d.controls[0]); },
    d => { d.dialogue.push(d.dialogue[0]); }, d => { d.timeline.push(d.timeline[0]); },
    d => { d.continuity.before.push(d.continuity.before[0]); },
    d => { d.timeline[0].dialogueId = 'line-missing'; }, d => { d.timeline[0].entityId = 'wrong-speaker'; },
    d => { d.timeline[0].endMs = 5001; }, d => { d.timeline[0].startMs = 4000; },
    d => { d.controls[0].objectId = 'https://secret.invalid/object'; }, d => { d.controls[0].objectId = null; },
    d => { d.controls[0].timeMs = 1; }, d => { d.controls[1].timeMs = 0; }];
  for (const mutate of mutations) { const value = draft(); mutate(value); rejects(() => seal(value)); }
});
test('inert bounded boundary rejects getters, symbols, hidden fields, sparse arrays, cycles and hostile Proxy exceptions safely', () => {
  let reads = 0;
  const getter = draft(); Object.defineProperty(getter.camera, 'movement', { enumerable: true, get() { reads++; throw new Error('private-secret'); } });
  rejects(() => seal(getter)); assert.equal(reads, 0);
  const symbol = draft(); symbol[Symbol('secret')] = 'secret'; rejects(() => seal(symbol));
  const hidden = draft(); Object.defineProperty(hidden, 'private-secret', { value: true }); rejects(() => seal(hidden));
  const sparse = draft(); sparse.timeline = new Array(2); rejects(() => seal(sparse));
  const cycle = draft(); cycle.camera.description = cycle; rejects(() => seal(cycle));
  const proxy = new Proxy(draft(), { ownKeys() { throw new Error('private-secret'); } }); rejects(() => seal(proxy));
  const huge = draft(); huge.visualStyle = 'x'.repeat(1000001); rejects(() => seal(huge));
});
test('browser module actually loads and parses without require, Buffer, process, Node crypto or filesystem', () => {
  const code = readFileSync(join(__dirname, '../../shared/dist/shot-spec.js'), 'utf8');
  const result = vm.runInNewContext(code + '\nJSON.stringify(exports.parseShotSpecV2Draft(JSON.parse(input)))', {
    exports: {}, input: JSON.stringify(draft()), require() { throw new Error('Node dependency'); },
  }, { timeout: 1000 });
  assert.deepEqual(JSON.parse(result), draft());
});
