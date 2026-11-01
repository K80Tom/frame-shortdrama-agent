import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
if (!process.argv.includes('--allow-paid')) throw new Error('请显式传入 --allow-paid，三章合计最多十五次配置模型请求。');
const baselinePath = process.argv.find(a => a.startsWith('--baseline='))?.slice(11);
const outputPath = process.argv.find(a => a.startsWith('--output='))?.slice(9);
if (!baselinePath || !outputPath) throw new Error('需要 --baseline=本机快照 和 --output=被忽略的输出目录。');
const out = resolve(outputPath);
if (!out.startsWith(resolve('outputs') + '/')) throw new Error('评测结果只能写入被忽略的 outputs 子目录。');
const { readConfig } = require('../dist/config');
const { readDatabaseConfig } = require('../dist/db/config');
const { PostgresDatabase } = require('../dist/db/client');
const { PostgresNovelRepository } = require('../dist/novel/repository');
const { NovelService } = require('../dist/novel/service');
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
// Select only untouched first model drafts. Human revisions are never used as model context or evaluation truth.
const originalDrafts = baseline.chapters.map(c => ({ order: c.chapter.order,
  revision: c.revisions.revisions.find(r => r.createdBy === 'model') }));
if (originalDrafts.length !== 3 || originalDrafts.some(c => !c.revision)) throw new Error('基线必须包含三份首次模型初稿。');
const dbConfig = readDatabaseConfig();
if (!dbConfig) throw new Error('未配置正常数据库。');
const db = new PostgresDatabase(dbConfig);
const repository = new PostgresNovelRepository(db);
const service = new NovelService(repository, readConfig());
const state = { startedAt: new Date().toISOString(), model: readConfig().defaultModel,
  baseline: originalDrafts, source: null, chapters: [] };
await mkdir(out, { recursive: false });
const saveState = () => writeFile(resolve(out, 'state.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
try {
  await db.verifyConnection();
  const localTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(state.startedAt));
  state.source = await service.create({ title: `${baseline.source.title} · 多阶段模型评测 ${localTime}`,
    rawText: baseline.source.rawText, ...(baseline.source.sourceUrl ? { sourceUrl: baseline.source.sourceUrl } : {}) });
  if (state.source.contentSha256 !== baseline.source.contentSha256) throw new Error('新旧原文摘要不一致。');
  await saveState();
  const originalSave = repository.saveRevision.bind(repository);
  repository.saveRevision = async (revision, expectedId) => {
    const saved = await originalSave(revision, expectedId);
    const chapterState = state.chapters.find(c => c.chapter.id === saved.chapterId);
    chapterState.revisions.push(saved);
    await saveState();
    console.log(JSON.stringify({ chapter: chapterState.chapter.order, stage: saved.content.analysis?.calls.at(-1)?.stage,
      status: saved.content.analysis?.status, items: saved.content.items.length,
      issues: saved.content.analysis?.issues.length, revisionId: saved.id }));
    return saved;
  };
  for (const chapter of state.source.chapters) {
    const entry = { chapter, revisions: [], errorCode: null, attempt: null };
    state.chapters.push(entry);
    try { await service.extract(chapter.id, { expectedRevisionId: null, allowPaid: true, mode: 'reviewed' }); }
    catch (error) { entry.errorCode = /^[A-Z][A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'EVALUATION_FAILED';
      entry.error = { message: error.message, details: error.details };
      console.log(JSON.stringify({ chapter: chapter.order, errorCode: entry.errorCode, error: entry.error, retry: false })); }
    entry.attempt = (await service.attempts(chapter.id)).at(-1);
    await saveState();
    if (entry.errorCode && !process.argv.includes('--continue-on-error')) break;
  }
  state.source = await service.get(state.source.id);
  state.endedAt = new Date().toISOString();
  await saveState();
  console.log(JSON.stringify({ sourceId: state.source.id, output: out, chapters: state.chapters.map(c => ({ order: c.chapter.order, errorCode: c.errorCode, revisions: c.revisions.length })) }));
} finally { await db.close(); }
