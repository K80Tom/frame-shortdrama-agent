const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../dist/config');
const { buildNovelSource, applyNovelCorrections, novelCheckpointGate } = require('@lyra/shared');
const { NovelReviewWorkflow } = require('../dist/novel/workflow');
const { NovelService } = require('../dist/novel/service');
const { InMemoryNovelRepository } = require('../dist/novel/repository');
const { buildEntityRegistry } = require('@lyra/shared');
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
  assert.equal(buildEntityRegistry(s, [rev, sameName]).filter(e => e.name === '周宁').length, 2);
  sameName.content.items[0].canonicalEntityId = entries[0].id;
  assert.equal(buildEntityRegistry(s, [rev, sameName]).filter(e => e.name === '周宁').length, 1);
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

test('service refuses a fresh paid rerun after a failed review and resumes only the unfinished stage', async () => {
  const r = new InMemoryNovelRepository(); const s = await r.createSource(source());
  const failed = transport([draft(), scan(), { issues: [{ code: 'nope' }] }]);
  await assert.rejects(new NovelService(r, config, failed.fn).extract(s.chapters[0].id, {
    expectedRevisionId: null, allowPaid: true, mode: 'reviewed' }), { code: 'NOVEL_WORKFLOW_INVALID' });
  assert.equal(failed.count(), 3);
  const latest = (await r.getSource(s.id)).chapters[0].latestRevisionId;
  const revisions = await r.listRevisions(s.chapters[0].id);
  const extractOnly = revisions.find(revision => revision.content.analysis.calls.map(call => call.stage).join(',') === 'extract');
  const scanCheckpoint = revisions.find(revision => revision.content.analysis.calls.map(call => call.stage).join(',') === 'extract,scan');
  const again = transport([draft(), scan(), { issues: [] }]);
  await assert.rejects(new NovelService(r, config, again.fn).extract(s.chapters[0].id, {
    expectedRevisionId: latest, allowPaid: true, mode: 'reviewed' }), { code: 'NOVEL_CHECKPOINT_RESUME_REQUIRED' });
  await assert.rejects(new NovelService(r, config, again.fn).extract(s.chapters[0].id, {
    expectedRevisionId: latest, allowPaid: true, mode: 'single' }), { code: 'NOVEL_CHECKPOINT_RESUME_REQUIRED' });
  await assert.rejects(new NovelService(r, config, again.fn).extract(s.chapters[0].id, {
    expectedRevisionId: latest, allowPaid: true, mode: 'reviewed', resumeRevisionId: extractOnly.id }), { code: 'NOVEL_RESUME_INVALID' });
  assert.equal(again.count(), 0);
  assert.equal((await r.listAttempts(s.chapters[0].id)).length, 1);
  const resumed = transport([ { issues: [] } ], body => {
    assert.match(body.messages[0].content, /复核合并初稿/);
    assert.doesNotMatch(body.messages[0].content, /首次完整拆解|独立逐段查漏/);
  });
  const saved = await new NovelService(r, config, resumed.fn).extract(s.chapters[0].id, {
    expectedRevisionId: latest, allowPaid: true, mode: 'reviewed', resumeRevisionId: scanCheckpoint.id });
  assert.equal(resumed.count(), 1);
  assert.equal(saved.content.analysis.status, 'reviewed');
  assert.deepEqual(saved.content.items.map(item => item.id), scanCheckpoint.content.items.map(item => item.id));
});

test('confirmRestart is the only fresh rerun, and a later human edit blocks checkpoint resume', async () => {
  const r = new InMemoryNovelRepository(); const s = await r.createSource(source());
  const failed = transport([draft(), scan(), { issues: [{ code: 'nope' }] }]);
  await assert.rejects(new NovelService(r, config, failed.fn).extract(s.chapters[0].id, {
    expectedRevisionId: null, allowPaid: true, mode: 'reviewed' }), { code: 'NOVEL_WORKFLOW_INVALID' });
  const latest = (await r.getSource(s.id)).chapters[0].latestRevisionId;
  const restarted = transport([draft(), scan(), { issues: [] }], (body, index) => {
    if (index === 0) assert.match(body.messages[0].content, /首次完整拆解/);
  });
  const saved = await new NovelService(r, config, restarted.fn).extract(s.chapters[0].id, {
    expectedRevisionId: latest, allowPaid: true, mode: 'reviewed', confirmRestart: true });
  assert.equal(restarted.count(), 3);
  assert.equal(saved.content.analysis.status, 'reviewed');
  const checkpoint = saved;
  const edited = applyNovelCorrections(checkpoint, s, s.chapters[0], { expectedRevisionId: checkpoint.id,
    items: checkpoint.content.items.map(item => ({ ...item, description: `${item.description}人工` })) });
  await r.saveRevision({ id: 'human_after_checkpoint', chapterId: s.chapters[0].id, parentRevisionId: checkpoint.id,
    createdBy: 'user', createdAt: new Date().toISOString(), content: edited }, checkpoint.id);
  const blocked = transport([{ issues: [] }]);
  const humanLatest = (await r.getSource(s.id)).chapters[0].latestRevisionId;
  await assert.rejects(new NovelService(r, config, blocked.fn).extract(s.chapters[0].id, {
    expectedRevisionId: humanLatest, allowPaid: true, mode: 'reviewed', resumeRevisionId: checkpoint.id }), { code: 'NOVEL_RESUME_INVALID' });
  assert.equal(blocked.count(), 0);
});

test('a finished review does not hide behind an older scan checkpoint', () => {
  const item = { review: 'unreviewed', origin: 'model' };
  const scan = { id: 'scan', parentRevisionId: 'extract', createdBy: 'model', content: { items: [item], analysis: {
    status: 'partial', calls: [{ stage: 'extract' }, { stage: 'scan' }], paragraphCoverage: [{}, {}, {}] } } };
  const reviewed = { id: 'done', parentRevisionId: 'scan', createdBy: 'model', content: { items: [item], analysis: {
    status: 'reviewed', calls: [{ stage: 'extract' }, { stage: 'scan' }, { stage: 'verify' }], paragraphCoverage: [{}, {}, {}] } } };
  assert.equal(novelCheckpointGate([scan, reviewed], 'done', 3).resumeRevisionId, null);
  const failed = { id: 'fail', parentRevisionId: 'scan', createdBy: 'model', content: { items: [item], analysis: {
    status: 'partial', calls: [{ stage: 'extract' }, { stage: 'scan' }, { stage: 'verify' }], paragraphCoverage: [{}, {}, {}] } } };
  assert.equal(novelCheckpointGate([scan, failed], 'fail', 3).resumeRevisionId, 'scan');
});

test('chapter length gate counts code points and does not open an attempt', async () => {
  const repo = new InMemoryNovelRepository();
  const heading = '第一章 雨\n';
  const oversized = await repo.createSource(buildNovelSource({ title: '长章', rawText: `${heading}${'😀'.repeat(20_000)}` }));
  assert.ok(oversized.chapters[0].end - oversized.chapters[0].start > 20_000);
  let calls = 0;
  await assert.rejects(new NovelService(repo, config, async () => { calls += 1; throw new Error('should not be called'); }).extract(
    oversized.chapters[0].id, { expectedRevisionId: null, allowPaid: true, mode: 'reviewed' }), { code: 'NOVEL_CHAPTER_TOO_LONG' });
  assert.equal(calls, 0);
  assert.equal((await repo.listAttempts(oversized.chapters[0].id)).length, 0);
  const boundaryRepo = new InMemoryNovelRepository();
  const boundary = await boundaryRepo.createSource(buildNovelSource({ title: '边界', rawText: `${heading}${'😀'.repeat(20_000 - Array.from(heading).length)}` }));
  assert.equal(boundary.chapters[0].end - boundary.chapters[0].start, 20_000);
  await assert.rejects(new NovelService(boundaryRepo, config, async () => { calls += 1; throw new Error('boundary sent'); }).extract(
    boundary.chapters[0].id, { expectedRevisionId: null, allowPaid: true, mode: 'single' }), error => {
    assert.notEqual(error.code, 'NOVEL_CHAPTER_TOO_LONG');
    return true;
  });
  assert.equal(calls, 1);
});
