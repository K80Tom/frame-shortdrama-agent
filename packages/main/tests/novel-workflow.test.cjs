const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../dist/config');
const { buildNovelSource, applyNovelCorrections } = require('@lyra/shared');
const { NovelReviewWorkflow } = require('../dist/novel/workflow');
const { NovelService } = require('../dist/novel/service');
const { InMemoryNovelRepository } = require('../dist/novel/repository');
const { buildEntityRegistry, proposeEntityMergeCandidates } = require('@lyra/shared');
const config = readConfig({ LLM_BASE_URL: 'https://model.test', LLM_API_KEY: 'test-only-key' });
const source = () => buildNovelSource({ title: '原创查漏练习', rawText: '第一章 港口\n周宁把铁盒放在路灯旁。\n“等一会。”周宁说。\n第二章 回家\n周宁朝家走去。\n' });
const entity = (id, label, kind = 'character') => ({ tempId: id, label, description: '',
  entityType: kind === 'character' ? 'person' : 'object', occurrence: 'present', aliases: [], canonicalEntityId: null,
  evidenceParagraphIds: ['p0002'], uncertainty: null });
const draft = () => ({ entities: [entity('e1', '周宁'), entity('e2', '铁盒', 'prop')],
  quotes: [['q1', 'e1', 'speech', ['p0003'], null]] });
const scan = () => ({ entities: [entity('s1', '周宁'), entity('s2', '路灯', 'prop')],
  paragraphs: [['p0001', []], ['p0002', ['s1', 's2']], ['p0003', []]] });
const issue = { code: 'wrongName', targetId: 'e1', paragraphIds: ['p0002'], reason: '核对人物名称边界。' };
function transport(outputs, inspect = () => {}) {
  let count = 0;
  const fn = async (url, request) => {
    const body = JSON.parse(request.body); inspect(body, count);
    const output = outputs[count++];
    if (output instanceof Error) throw output;
    assert.notEqual(output, undefined, 'unexpected model call');
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  };
  return { fn, count: () => count };
}
test('three-stage workflow independently scans every paragraph, supplements entities and preserves exact quotes', async () => {
  const s = source(); const checkpoints = [];
  const t = transport([draft(), scan(), { issues: [] }], (body, n) => {
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.deepEqual(body.response_format, { type: 'json_object' });
    const input = JSON.parse(body.messages[1].content);
    if (n === 1) assert.equal(input.draft, undefined, 'scan must be blind to initial draft');
  });
  const result = await new NovelReviewWorkflow(config, t.fn).extract(s, s.chapters[0], [], [], async c => checkpoints.push(c));
  assert.equal(t.count(), 3); assert.equal(result.usage.totalTokens, 45);
  assert.equal(result.content.analysis.status, 'reviewed');
  assert.equal(result.content.analysis.paragraphCoverage.length, 3);
  assert.deepEqual(result.content.items.filter(i => i.kind !== 'dialogue').map(i => i.label), ['周宁', '铁盒', '路灯']);
  assert.ok(result.content.items.every(i => i.review === 'unreviewed'));
  assert.equal(checkpoints[0].analysis.calls.length, 1);
  assert.ok(result.content.items.every(i => i.sourceRefs.every(r => Array.from(s.rawText).slice(r.start, r.end).join('') === r.quote)));
});
test('one repair/recheck only, with unresolved findings preserved and unrelated entities unchanged', async () => {
  const s = source(); const outputs = [draft(), scan(), { issues: [issue] },
    { entities: [{ ...entity('e1', '周宁'), aliases: ['小周'] }], removeEntityIds: [], quotes: [] }, { issues: [issue] }];
  const t = transport(outputs); const checkpoints = [];
  const result = await new NovelReviewWorkflow(config, t.fn).extract(s, s.chapters[0], [], [], async c => checkpoints.push(c));
  assert.equal(t.count(), 5); assert.equal(result.content.analysis.status, 'needsReview');
  assert.ok(result.content.items[0].uncertainty.includes(issue.reason));
  assert.deepEqual(checkpoints[0].items.find(i => i.label === '铁盒'), result.content.items.find(i => i.label === '铁盒'));
  const base = { id: 'revision', chapterId: s.chapters[0].id, content: result.content };
  const edited = applyNovelCorrections(base, s, s.chapters[0], { expectedRevisionId: 'revision', items: result.content.items.map(i => ({ ...i, occurrence: i.kind === 'prop' ? 'mentioned' : i.occurrence })) });
  assert.equal(edited.analysis.status, 'humanEdited');
  assert.equal(edited.items.find(i => i.label === '铁盒').origin, 'user');
});
test('out-of-scope patch rejected without a sixth call or loss of the valid draft', async () => {
  const s = source(); const checkpoints = [];
  const t = transport([draft(), scan(), { issues: [issue] },
    { entities: [entity('e2', '假铁盒', 'prop')], removeEntityIds: [], quotes: [] }]);
  await assert.rejects(new NovelReviewWorkflow(config, t.fn).extract(s, s.chapters[0], [], [], async c => checkpoints.push(c)), { code: 'NOVEL_WORKFLOW_INVALID' });
  assert.equal(t.count(), 4); assert.equal(checkpoints.at(-1).analysis.status, 'partial');
  assert.equal(checkpoints.at(-1).items.find(i => i.kind === 'prop').label, '铁盒');
});
test('invalid final reviewer IDs cannot clear findings or discard a valid patch', async () => {
  const s = source();
  const t = transport([draft(), scan(), { issues: [issue] }, { entities: [], removeEntityIds: [], quotes: [] },
    { issues: [{ ...issue, targetId: 'invented-id' }] }]);
  const result = await new NovelReviewWorkflow(config, t.fn).extract(s, s.chapters[0], []);
  assert.equal(t.count(), 5); assert.equal(result.content.analysis.status, 'needsReview');
  assert.ok(result.content.analysis.issues.some(i => i.reason.includes('无效依据')));
});
test('concurrent human edit stops further paid stages and remains latest', async () => {
  const r = new InMemoryNovelRepository(); const s = await r.createSource(source());
  const originalSave = r.saveRevision.bind(r); let manual;
  r.saveRevision = async (revision, expectedId) => {
    const saved = await originalSave(revision, expectedId);
    if (!manual) manual = await originalSave({ ...structuredClone(saved), id: 'manual', parentRevisionId: saved.id, createdBy: 'user' }, saved.id);
    return saved;
  };
  const t = transport([draft(), scan()]);
  await assert.rejects(new NovelService(r, config, t.fn).extract(s.chapters[0].id,
    { expectedRevisionId: null, allowPaid: true, mode: 'reviewed' }), { code: 'NOVEL_REVISION_CONFLICT' });
  assert.equal(t.count(), 1);
  assert.equal((await r.getSource(s.id)).chapters[0].latestRevisionId, manual.id);
});
test('missing paragraph mapping stops scan and keeps completed work', async () => {
  const s = source(); const incomplete = scan(); incomplete.paragraphs.pop();
  const t = transport([draft(), incomplete]); const saved = [];
  await assert.rejects(new NovelReviewWorkflow(config, t.fn).extract(s, s.chapters[0], [], [], async c => saved.push(c)), { code: 'NOVEL_WORKFLOW_INVALID' });
  assert.equal(t.count(), 2); assert.equal(saved.at(-1).analysis.status, 'partial');
});
test('service persists stage checkpoints and aggregate usage; uncertain transport blocks duplicate spend', async () => {
  const r = new InMemoryNovelRepository(); const s = await r.createSource(source());
  const t = transport([draft(), new Error('network disconnected')]);
  const service = new NovelService(r, config, t.fn);
  await assert.rejects(service.extract(s.chapters[0].id, { expectedRevisionId: null, allowPaid: true, mode: 'reviewed' }), { code: 'PROXY_UNAVAILABLE' });
  const revisions = await r.listRevisions(s.chapters[0].id);
  assert.ok(revisions.length >= 1); assert.equal(revisions.at(-1).content.analysis.status, 'partial');
  const [attempt] = await r.listAttempts(s.chapters[0].id);
  assert.equal(attempt.status, 'unknown'); assert.equal(attempt.usage.totalTokens, null);
  await assert.rejects(service.extract(s.chapters[0].id, { expectedRevisionId: revisions.at(-1).id, allowPaid: true, mode: 'reviewed' }), { code: 'NOVEL_ATTEMPT_PENDING' });
  assert.equal(t.count(), 2);
});
test('registry survives storage, reuses supported identities and does not name-merge different people', async () => {
  const s = source(); const t = transport([draft(), scan(), { issues: [] }]);
  const content = (await new NovelReviewWorkflow(config, t.fn).extract(s, s.chapters[0], [])).content;
  const rev = { id: 'r1', chapterId: s.chapters[0].id, content };
  const entries = buildEntityRegistry(s, [rev]);
  const sameName = structuredClone(rev); sameName.id = 'r2'; sameName.chapterId = s.chapters[1].id;
  sameName.content.items = [{ ...content.items[0], id: 'other-person', canonicalEntityId: undefined }];
  const separate = buildEntityRegistry(s, [rev, sameName]);
  assert.equal(separate.filter(e => e.name === '周宁').length, 2);
  const hinted = proposeEntityMergeCandidates(separate);
  assert.equal(hinted.length, 1);
  assert.equal(hinted[0].relation, 'shared-name');
  assert.deepEqual(hinted[0].entityIds, separate.filter(entry => entry.name === '周宁').map(entry => entry.id).sort());
  sameName.content.items[0].canonicalEntityId = entries[0].id;
  const linked = buildEntityRegistry(s, [rev, sameName]);
  assert.equal(linked.filter(e => e.name === '周宁').length, 1);
  assert.deepEqual(proposeEntityMergeCandidates(linked), []);
});
test('merge candidates keep different people, different types, and mere name containment independent', () => {
  const occurrence = (chapterId, itemId, quote) => ({ chapterId, revisionId: `rev_${chapterId}`, itemId, confirmed: true,
    sourceRefs: [{ documentId: 'novel', start: 0, end: Array.from(quote).length, quote }] });
  const entry = (id, name, extra = {}) => ({ id, kind: 'character', entityType: 'person', name, aliases: [name],
    occurrences: [occurrence('chapter_a', id, name)], ...extra });
  const sameName = [entry('entity_b', '周宁'), entry('entity_a', '周 宁')];
  const spaced = proposeEntityMergeCandidates(sameName);
  assert.equal(spaced.length, 1);
  assert.equal(spaced[0].relation, 'shared-name');
  assert.deepEqual(spaced[0].entityIds, ['entity_a', 'entity_b']);
  assert.deepEqual(sameName.map(item => item.name), ['周宁', '周 宁']);
  const alias = proposeEntityMergeCandidates([
    entry('entity_luo', '罗峰', { occurrences: [occurrence('chapter_a', 'item_luo', '罗峰把铁盒放下')] }),
    entry('entity_feng', '峰哥', { aliases: ['峰哥', '罗峰'], occurrences: [occurrence('chapter_b', 'item_feng', '峰哥是罗峰')] }),
  ]);
  assert.equal(alias.length, 1);
  assert.equal(alias[0].relation, 'shared-alias');
  assert.deepEqual(alias[0].names, ['峰哥', '罗峰']);
  assert.deepEqual(alias[0].evidence.map(item => item.quote), ['峰哥是罗峰', '罗峰把铁盒放下']);
  assert.deepEqual(proposeEntityMergeCandidates([
    entry('entity_person', '周宁'),
    entry('entity_beast', '周宁', { entityType: 'creature' }),
  ]), []);
  assert.deepEqual(proposeEntityMergeCandidates([
    entry('entity_short', '陆'),
    entry('entity_long', '陆行远'),
    { ...entry('entity_place', '周宁'), kind: 'location', entityType: 'place' },
  ]), []);
  const book = source();
  const duplicate = buildEntityRegistry(book, [{ id: 'rev_dup', chapterId: book.chapters[0].id, content: { items: [
    { id: 'cup_a', kind: 'prop', label: '塑料杯', description: '', sourceRefs: [{ documentId: 'x', start: 0, end: 3, quote: '塑料杯' }],
      speakerId: null, classification: null, entityType: 'object', occurrence: 'present', canonicalEntityId: 'entity_cup',
      aliases: ['大塑料杯'], uncertainty: null, review: 'unreviewed', origin: 'model' },
    { id: 'cup_b', kind: 'prop', label: '大塑料杯', description: '', sourceRefs: [{ documentId: 'x', start: 0, end: 4, quote: '大塑料杯' }],
      speakerId: null, classification: null, entityType: 'object', occurrence: 'present', canonicalEntityId: 'entity_cup',
      aliases: [], uncertainty: null, review: 'unreviewed', origin: 'model' },
  ], warnings: [] } }]);
  assert.equal(duplicate.length, 1);
  const repeated = proposeEntityMergeCandidates(duplicate);
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].relation, 'duplicate-chapter');
  assert.deepEqual(repeated[0].evidence.map(item => item.itemId), ['cup_a', 'cup_b']);
  assert.equal(duplicate[0].occurrences.length, 2);
});
function locateQuote(raw, quote, nth) {
  const points = Array.from(raw);
  let cursor = 0;
  for (let seen = 1; seen <= nth; seen += 1) {
    const rest = points.slice(cursor);
    const index = rest.join('').indexOf(quote);
    assert.ok(index >= 0, quote);
    const start = cursor + Array.from(rest.join('').slice(0, index)).length;
    if (seen === nth) return { start, end: start + Array.from(quote).length, quote };
    cursor = start + Array.from(quote).length;
  }
  throw new Error('unreachable');
}
test('registry API returns same-name candidates and leaves both chapter identities in place', async () => {
  const r = new InMemoryNovelRepository(); const s = await r.createSource(source());
  const service = new NovelService(r, config, async () => { throw new Error('no model'); });
  const person = (id, canonicalEntityId, evidence) => ({ id, kind: 'character', label: '周宁', description: '',
    sourceRefs: [{ documentId: s.id, ...evidence }], speakerId: null, classification: null, entityType: 'person',
    occurrence: 'present', canonicalEntityId, aliases: [], uncertainty: null, review: 'confirmed', origin: 'user' });
  const first = locateQuote(s.rawText, '周宁', 1);
  const third = locateQuote(s.rawText, '周宁', 3);
  assert.ok(first.start >= s.chapters[0].start && first.end <= s.chapters[0].end);
  assert.ok(third.start >= s.chapters[1].start && third.end <= s.chapters[1].end);
  const seed1 = await service.seed(s.chapters[0].id, { expectedRevisionId: null });
  await service.correct(seed1.id, { expectedRevisionId: seed1.id, items: [person('person_ch1', 'entity_zhou_ch1', first)] });
  const seed2 = await service.seed(s.chapters[1].id, { expectedRevisionId: null });
  await service.correct(seed2.id, { expectedRevisionId: seed2.id, items: [person('person_ch2', 'entity_zhou_ch2', third)] });
  const registry = await service.registry(s.id);
  assert.equal(registry.entries.filter(entry => entry.name === '周宁').length, 2);
  assert.equal(registry.mergeCandidates.length, 1);
  assert.equal(registry.mergeCandidates[0].relation, 'shared-name');
  assert.deepEqual(registry.mergeCandidates[0].entityIds, ['entity_zhou_ch1', 'entity_zhou_ch2']);
  assert.deepEqual(registry.mergeCandidates[0].evidence.map(item => item.quote), ['周宁', '周宁']);
});
test('explicit scan-checkpoint resume preserves IDs and charges only newly submitted stages', async () => {
  const s = source(); const checkpoints = [];
  await new NovelReviewWorkflow(config, transport([draft(), scan(), { issues: [] }]).fn)
    .extract(s, s.chapters[0], [], [], async c => checkpoints.push(c));
  const resume = checkpoints[1];
  const t = transport([{ issues: [{ code: 'unsupported', targetId: resume.items[0].id, paragraphIds: ['p0002'], reason: '补核依据。', reason_alt: 'discard-only-commentary' }] },
    { entities: [], removeEntityIds: [], quotes: [] }, { issues: [] }]);
  const result = await new NovelReviewWorkflow(config, t.fn).extract(s, s.chapters[0], [], [], undefined, undefined, resume);
  assert.equal(t.count(), 3); assert.equal(result.usage.totalTokens, 45);
  assert.equal(result.content.analysis.calls.length, 5);
  assert.deepEqual(result.content.items.map(i => i.id), resume.items.map(i => i.id));
  assert.ok(!JSON.stringify(result).includes('discard-only-commentary'));
});
