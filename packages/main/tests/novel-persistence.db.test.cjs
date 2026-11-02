const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PostgresDatabase } = require('../dist/db/client');
const { readDatabaseConfig } = require('../dist/db/config');
const { PostgresNovelRepository } = require('../dist/novel/repository');
const { buildNovelSource, createReviewSeed } = require('@lyra/shared');
const { NovelService } = require('../dist/novel/service');
const { PostgresBreakdownRepository } = require('../dist/breakdown/repository');

// Deliberately opt in with a dedicated test database, never load local .env or
// migrate as part of a test. The harness owns and removes only its own source.
const connectionString = process.env.NOVEL_TEST_DATABASE_URL;
test('PostgreSQL novel chapters persist exact evidence, histories, CAS, and an unknown-call lock', {
  skip: connectionString ? false : 'Set NOVEL_TEST_DATABASE_URL to an isolated database with migration 008 applied.',
}, async () => {
  const database = new PostgresDatabase(readDatabaseConfig({ DATABASE_URL: connectionString }));
  let documentId;
  try {
    assert.equal(await database.hasMigrations(['008']), true, 'Apply 008 explicitly to the isolated test database first.');
    const repository = new PostgresNovelRepository(database);
    const document = buildNovelSource({ title: `novel-db-test-${randomUUID()}`,
      rawText: '第一章 灯塔\n阿澄拿着铜钥匙。😀\n“等雨停。”\n第二章 长廊\n夏禾放下木匣。\n“谁在那里？”\n第三章 渡口\n纸船浮在水上。\n“也许是他。”\n' });
    await repository.createSource(document);
    documentId = document.id;
    const [first, second, third] = document.chapters;
    const initial = await repository.saveRevision(revision(document, first), null);
    const secondRevision = await repository.saveRevision(revision(document, second), null);
    const thirdRevision = await repository.saveRevision(revision(document, third), null);
    const competing = await Promise.allSettled([
      repository.saveRevision(revision(document, first, initial.id, 'user'), initial.id),
      repository.saveRevision(revision(document, first, initial.id, 'user'), initial.id),
    ]);
    assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(competing.find(result => result.status === 'rejected').reason.code, 'NOVEL_REVISION_CONFLICT');
    const edited = competing.find(result => result.status === 'fulfilled').value;
    const refreshed = new PostgresNovelRepository(database);
    assert.deepEqual(await refreshed.getRevision(initial.id), initial);
    assert.deepEqual((await refreshed.listRevisions(first.id)).map(value => value.id), [initial.id, edited.id]);
    assert.deepEqual((await refreshed.getSource(document.id)).chapters.map(chapter => chapter.latestRevisionId), [edited.id, secondRevision.id, thirdRevision.id]);
    assert.equal((await refreshed.getChapterSource(second.id)).rawText, document.rawText);
    const evidence = (await refreshed.getRevision(initial.id)).content.items[0].sourceRefs[0];
    assert.equal(Array.from(document.rawText).slice(evidence.start, evidence.end).join(''), evidence.quote);

    const broken = revision(document, second, secondRevision.id, 'user');
    broken.content.items[0].sourceRefs = structuredClone(initial.content.items[0].sourceRefs);
    broken.content.items[0].label = broken.content.items[0].sourceRefs[0].quote;
    await assert.rejects(refreshed.saveRevision(broken, secondRevision.id), error => error.code === 'NOVEL_EVIDENCE_MISMATCH');
    assert.deepEqual(await refreshed.listRevisions(second.id), [secondRevision]);

    const input = attempt(first, edited.id);
    await repository.beginAttempt(input);
    await assert.rejects(refreshed.beginAttempt(attempt(first, edited.id)), error => error.code === 'NOVEL_ATTEMPT_PENDING');
    const manual = await refreshed.saveRevision(revision(document, first, edited.id, 'user'), edited.id);
    await assert.rejects(repository.saveRevision(revision(document, first, edited.id, 'model'), edited.id), error => error.code === 'NOVEL_REVISION_CONFLICT');
    await repository.finishAttempt(input.id, { status: 'failed', errorCode: 'NOVEL_REVISION_CONFLICT',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, endedAt: new Date().toISOString(), revisionId: null });
    assert.equal((await refreshed.listAttempts(first.id))[0].usage.totalTokens, 15);
    assert.equal((await refreshed.getSource(document.id)).chapters[0].latestRevisionId, manual.id);

    const unknown = attempt(second, secondRevision.id);
    await refreshed.beginAttempt(unknown);
    await refreshed.finishAttempt(unknown.id, { status: 'unknown', errorCode: 'UPSTREAM_TIMEOUT', usage: null,
      endedAt: new Date().toISOString(), revisionId: null });
    await assert.rejects(new PostgresNovelRepository(database).beginAttempt(attempt(second, secondRevision.id)), error => error.code === 'NOVEL_ATTEMPT_PENDING');
    const otherCall = attempt(third, thirdRevision.id);
    await refreshed.beginAttempt(otherCall);
    const modelRevision = await refreshed.saveRevision(revision(document, third, thirdRevision.id, 'model'), thirdRevision.id);
    await refreshed.finishAttempt(otherCall.id, { status: 'succeeded', errorCode: null, usage: { totalTokens: 12 },
      endedAt: new Date().toISOString(), revisionId: modelRevision.id });
    assert.equal((await refreshed.listAttempts(third.id))[0].revisionId, modelRevision.id);

    // A corrupted, test-owned persisted snapshot fails closed when reread.
    await database.query("UPDATE novel_revisions SET content_json = '{\"items\":[],\"warnings\":[],\"extra\":true}'::jsonb WHERE id = $1", [initial.id]);
    await assert.rejects(refreshed.getRevision(initial.id), error => error.code === 'NOVEL_STORED_DATA_INVALID');
  } finally {
    if (documentId) await database.query('DELETE FROM novel_sources WHERE id = $1', [documentId]);
    await database.close();
  }
});

function revision(document, chapter, parentRevisionId = null, createdBy = 'program') {
  return { id: randomUUID(), chapterId: chapter.id, parentRevisionId, createdBy,
    createdAt: new Date().toISOString(), content: createReviewSeed(document, chapter) };
}
function attempt(chapter, expectedRevisionId) {
  return { id: randomUUID(), chapterId: chapter.id, expectedRevisionId,
    model: 'test-only-text-model', startedAt: new Date().toISOString() };
}

test('PostgreSQL concurrent adoption of a multi-chapter adaptation commits one canonical project and script', {
  skip: !connectionString && 'Set NOVEL_TEST_DATABASE_URL to a migrated isolated test database.',
}, async () => {
  const database = new PostgresDatabase(readDatabaseConfig({ DATABASE_URL: connectionString }));
  let documentId, projectId;
  try {
    const novels = new PostgresNovelRepository(database);
    const scripts = new PostgresBreakdownRepository(database);
    const service = new NovelService(novels, {}, () => assert.fail('unexpected model call'), undefined, undefined, scripts);
    const doc = await service.create({ title: '改编测试', rawText: '第一章 夜雨\n“走吧。”\n第二章 渡口\n“船来了。”\n' });
    documentId = doc.id;
    const chapters = [];
    for (const chapter of doc.chapters) {
      const saved = await novels.saveRevision(revision(doc, chapter, null, 'model'), null);
      chapters.push({ chapterId: chapter.id, revisionId: saved.id });
    }
    await assert.rejects(service.previewAdaptation(doc.id, { chapters: [...chapters].reverse() }), /连续且不重复/);
    const draft = await service.previewAdaptation(doc.id, { chapters });
    assert.match(draft.rawText, /第1场[\s\S]+第2场/);
    assert.match(draft.rawText, /△ “船来了。”/);
    const entries = await Promise.all(Array.from({ length: 3 }, () => service.adoptAdaptation(doc.id, { chapters, digest: draft.digest })));
    projectId = entries[0].projectId;
    assert.deepEqual(entries, [entries[0], entries[0], entries[0]]);
    assert.equal((await scripts.listScriptVersions(projectId)).length, 1);
    assert.equal((await scripts.getScriptVersion(projectId, entries[0].scriptVersionId)).rawText, draft.rawText);
    assert.deepEqual((await scripts.getProject(projectId)).source.chapters, chapters);
  } finally {
    if (projectId) await database.query('DELETE FROM projects WHERE id = $1', [projectId]);
    if (documentId) await database.query('DELETE FROM novel_sources WHERE id = $1', [documentId]);
    await database.close();
  }
});
