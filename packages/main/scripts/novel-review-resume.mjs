import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const path = process.argv.find(a => a.startsWith('--state='))?.slice(8);
if (!path || !process.argv.includes('--allow-paid')) throw new Error('需要 --state=评测状态文件 --allow-paid；仅显式继续已失败、结果已知的章节。');
const state = JSON.parse(await readFile(path, 'utf8'));
const { PostgresDatabase } = require('../dist/db/client');
const { readDatabaseConfig } = require('../dist/db/config');
const { readConfig } = require('../dist/config');
const { PostgresNovelRepository } = require('../dist/novel/repository');
const { NovelService } = require('../dist/novel/service');
const db = new PostgresDatabase(readDatabaseConfig());
const repository = new PostgresNovelRepository(db);
const service = new NovelService(repository, readConfig());
const persist = () => writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
const originalSave = repository.saveRevision.bind(repository);
repository.saveRevision = async (revision, expected) => {
  const saved = await originalSave(revision, expected);
  const entry = state.chapters.find(c => c.chapter.id === saved.chapterId);
  entry.revisions.push(saved); await persist();
  console.log(JSON.stringify({ chapter: entry.chapter.order, stage: saved.content.analysis.calls.at(-1).stage,
    status: saved.content.analysis.status, items: saved.content.items.length, issues: saved.content.analysis.issues.length }));
  return saved;
};
try {
  for (const entry of state.chapters.filter(c => c.errorCode)) {
    if (entry.attempt?.status !== 'failed') throw new Error('未知或未结束调用不能直接重新提交。');
    const checkpoint = entry.revisions.filter(r => ['extract', 'extract,scan'].includes(r.content.analysis?.calls.map(c => c.stage).join(','))
      && (r.content.analysis.calls.length === 1 || r.content.analysis.paragraphCoverage.length > 0))
      .sort((a, b) => b.content.analysis.calls.length - a.content.analysis.calls.length)[0];
    if (!checkpoint) throw new Error('没有可继续的完整检查点。');
    const current = await service.get(state.source.id);
    entry.previousAttempts ??= []; entry.previousAttempts.push(entry.attempt);
    entry.previousErrors ??= []; entry.previousErrors.push({ code: entry.errorCode, details: entry.error });
    entry.errorCode = null; entry.error = null;
    try {
      await service.extract(entry.chapter.id, { expectedRevisionId: current.chapters.find(c => c.id === entry.chapter.id).latestRevisionId,
        allowPaid: true, mode: 'reviewed', resumeRevisionId: checkpoint.id });
    } catch (error) {
      entry.errorCode = error.code ?? 'RESUME_FAILED'; entry.error = { message: error.message, details: error.details };
      console.log(JSON.stringify({ chapter: entry.chapter.order, errorCode: entry.errorCode, error: entry.error }));
    }
    entry.attempt = (await service.attempts(entry.chapter.id)).at(-1); await persist();
  }
  state.source = await service.get(state.source.id); state.endedAt = new Date().toISOString(); await persist();
} finally { await db.close(); }
