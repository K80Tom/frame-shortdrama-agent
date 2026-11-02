import { createHash } from 'node:crypto';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { PostgresDatabase } from '../db/client';
import { NovelError, validateNovelContent, novelContentValidatorForBook, type NovelChapter, type NovelRevision, type NovelSource } from '@lyra/shared';

export interface NovelSourceSummary { id: string; title: string; createdAt: string; chapterCount: number }
export interface NovelAttempt {
  id: string; chapterId: string; expectedRevisionId: string | null; model: string;
  status: 'submitted' | 'succeeded' | 'failed' | 'unknown'; startedAt: string; endedAt: string | null;
  errorCode: string | null; usage: unknown; revisionId: string | null;
}
export type BeginNovelAttempt = Pick<NovelAttempt, 'id' | 'chapterId' | 'expectedRevisionId' | 'model' | 'startedAt'>;
export interface FinishNovelAttempt {
  status: 'succeeded' | 'failed' | 'unknown'; errorCode: string | null;
  usage: unknown; endedAt: string; revisionId: string | null;
}
export interface NovelRepository {
  listSources(): Promise<NovelSourceSummary[]>;
  createSource(source: NovelSource): Promise<NovelSource>;
  getSource(id: string): Promise<NovelSource | null>;
  getChapterSource(chapterId: string): Promise<NovelSource | null>;
  listRevisions(chapterId: string): Promise<NovelRevision[]>;
  getRevision(id: string): Promise<NovelRevision | null>;
  getSourceRevisions(source: NovelSource, ids: string[]): Promise<Map<string, NovelRevision>>;
  saveRevision(revision: NovelRevision, expectedRevisionId: string | null): Promise<NovelRevision>;
  beginAttempt(input: BeginNovelAttempt): Promise<void>;
  finishAttempt(id: string, result: FinishNovelAttempt): Promise<void>;
  listAttempts(chapterId: string): Promise<NovelAttempt[]>;
}

const clone = <T>(value: T): T => structuredClone(value);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100;
const nullableId = (value: unknown): boolean => value === null || validId(value);
const validTime = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const nonempty = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
function invalid(message = '小说保存记录格式无效。'): never { throw new NovelError(400, 'INVALID_NOVEL_RECORD', message); }
function conflict(): never { throw new NovelError(409, 'NOVEL_REVISION_CONFLICT', '本章版本已变化，请重新读取后校对；未覆盖现有修改。'); }
function chapterMissing(): never { throw new NovelError(404, 'NOVEL_CHAPTER_NOT_FOUND', '找不到此小说章节。'); }
function pending(): never { throw new NovelError(409, 'NOVEL_ATTEMPT_PENDING', '本章已有未结束或结果未知的模型请求，请先核对，不能重复调用。'); }
function stored<T>(work: () => T): T {
  try { return work(); } catch { throw new NovelError(500, 'NOVEL_STORED_DATA_INVALID', '保存的小说记录校验失败，请先检查数据；未尝试修复或覆盖。'); }
}

/** Immutable text and chapter ranges are checked on both writes and reads. */
function validateSource(source: NovelSource, creating = false): void {
  if (!source || !validId(source.id) || !nonempty(source.title, 300) || !nonempty(source.rawText, 2_000_000)
    || !validTime(source.createdAt) || !/^[a-f0-9]{64}$/.test(source.contentSha256)
    || createHash('sha256').update(source.rawText, 'utf8').digest('hex') !== source.contentSha256
    || !Array.isArray(source.chapters) || source.chapters.length === 0 || source.chapters.length > 2000) invalid();
  if (source.sourceUrl !== null) {
    if (!nonempty(source.sourceUrl, 2000)) invalid();
    let url: URL;
    try { url = new URL(source.sourceUrl); } catch { return invalid(); }
    if (url.protocol !== 'https:' || url.username || url.password) invalid();
  }
  const points = Array.from(source.rawText);
  const ids = new Set<string>();
  source.chapters.forEach((chapter, index) => {
    if (!chapter || !validId(chapter.id) || ids.has(chapter.id) || chapter.documentId !== source.id
      || chapter.order !== index + 1 || !nonempty(chapter.title, 300)
      || !Number.isSafeInteger(chapter.start) || !Number.isSafeInteger(chapter.end)
      || chapter.start < 0 || chapter.end <= chapter.start || chapter.end > points.length
      || !nullableId(chapter.latestRevisionId) || (creating && chapter.latestRevisionId !== null)
      || (index > 0 && chapter.start !== source.chapters[index - 1]!.end)
      || (index === source.chapters.length - 1 && chapter.end !== points.length)) invalid();
    const firstLine = points.slice(chapter.start, chapter.end).join('').split(/\r\n|\r|\n/u)[0]!.trim();
    if (firstLine !== chapter.title) invalid('章节标题或边界与原文不匹配。');
    ids.add(chapter.id);
  });
}

function validateRevision(revision: NovelRevision, source: NovelSource, chapter: NovelChapter,
  validateContent = (content: unknown, item: NovelChapter) => validateNovelContent(content, source, item)): void {
  if (!revision || !validId(revision.id) || revision.chapterId !== chapter.id
    || !nullableId(revision.parentRevisionId) || revision.parentRevisionId === revision.id
    || !['model', 'user', 'program'].includes(revision.createdBy) || !validTime(revision.createdAt)) invalid();
  validateContent(revision.content, chapter);
}
function validateBegin(input: BeginNovelAttempt): void {
  if (!input || !validId(input.id) || !validId(input.chapterId) || !nullableId(input.expectedRevisionId)
    || !nonempty(input.model, 200) || !validTime(input.startedAt)) invalid();
}
function validateFinish(result: FinishNovelAttempt): void {
  if (!result || !['succeeded', 'failed', 'unknown'].includes(result.status)
    || !validTime(result.endedAt) || !nullableId(result.revisionId)
    || (result.errorCode !== null && (typeof result.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(result.errorCode)))
    || (result.status === 'succeeded' && (result.revisionId === null || result.errorCode !== null))) invalid();
  // Only structured usage metadata, never a raw supplier response or error text.
  if (result.usage !== null) {
    if (!result.usage || typeof result.usage !== 'object' || Array.isArray(result.usage)) invalid();
    for (const [key, value] of Object.entries(result.usage)) {
      if (!['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens'].includes(key)
        || (value !== null && (!Number.isSafeInteger(value) || (value as number) < 0))) invalid();
    }
  }
}
function newAttempt(input: BeginNovelAttempt): NovelAttempt {
  return { ...clone(input), status: 'submitted', endedAt: null, errorCode: null, usage: null, revisionId: null };
}

export class InMemoryNovelRepository implements NovelRepository {
  private readonly sources = new Map<string, NovelSource>();
  private readonly revisions = new Map<string, NovelRevision>();
  private readonly attempts = new Map<string, NovelAttempt>();

  async listSources(): Promise<NovelSourceSummary[]> {
    return [...this.sources.values()].map(source => ({ id: source.id, title: source.title,
      createdAt: source.createdAt, chapterCount: source.chapters.length }));
  }
  async createSource(input: NovelSource): Promise<NovelSource> {
    const source = clone(input);
    validateSource(source, true);
    if (this.sources.has(source.id) || source.chapters.some(chapter => this.findChapter(chapter.id))) conflict();
    this.sources.set(source.id, source);
    return clone(source);
  }
  async getSource(id: string): Promise<NovelSource | null> { return clone(this.sources.get(id) ?? null); }
  async getChapterSource(chapterId: string): Promise<NovelSource | null> { return clone(this.findChapter(chapterId)?.source ?? null); }
  async listRevisions(chapterId: string): Promise<NovelRevision[]> {
    return clone([...this.revisions.values()].filter(revision => revision.chapterId === chapterId));
  }
  async getRevision(id: string): Promise<NovelRevision | null> { return clone(this.revisions.get(id) ?? null); }
  async getSourceRevisions(source: NovelSource, ids: string[]) {
    const chapterIds = new Set(source.chapters.map(item => item.id));
    const result = new Map<string, NovelRevision>();
    for (const id of ids) {
      const revision = this.revisions.get(id);
      if (revision && chapterIds.has(revision.chapterId)) result.set(id, clone(revision));
    }
    return result;
  }
  async saveRevision(input: NovelRevision, expectedRevisionId: string | null): Promise<NovelRevision> {
    const revision = clone(input);
    const { source, chapter } = this.findChapter(revision.chapterId) ?? chapterMissing();
    validateRevision(revision, source, chapter);
    if (!nullableId(expectedRevisionId) || revision.parentRevisionId !== expectedRevisionId
      || chapter.latestRevisionId !== expectedRevisionId || this.revisions.has(revision.id)) conflict();
    if (expectedRevisionId !== null && this.revisions.get(expectedRevisionId)?.chapterId !== chapter.id) conflict();
    this.revisions.set(revision.id, revision);
    chapter.latestRevisionId = revision.id;
    return clone(revision);
  }
  async beginAttempt(input: BeginNovelAttempt): Promise<void> {
    validateBegin(input);
    const { chapter } = this.findChapter(input.chapterId) ?? chapterMissing();
    if (chapter.latestRevisionId !== input.expectedRevisionId || this.attempts.has(input.id)) conflict();
    if ([...this.attempts.values()].some(attempt => attempt.chapterId === chapter.id
      && (attempt.status === 'submitted' || attempt.status === 'unknown'))) pending();
    this.attempts.set(input.id, newAttempt(input));
  }
  async finishAttempt(id: string, input: FinishNovelAttempt): Promise<void> {
    const result = clone(input);
    validateFinish(result);
    const attempt = this.attempts.get(id);
    if (!attempt) throw new NovelError(404, 'NOVEL_ATTEMPT_NOT_FOUND', '找不到小说模型调用记录。');
    if (attempt.status !== 'submitted') throw new NovelError(409, 'NOVEL_ATTEMPT_FINISHED', '调用记录已结束，不能覆盖其结果。');
    if (Date.parse(result.endedAt) < Date.parse(attempt.startedAt)) invalid();
    if (result.revisionId !== null && this.revisions.get(result.revisionId)?.chapterId !== attempt.chapterId) invalid();
    this.attempts.set(id, { ...attempt, ...result });
  }
  async listAttempts(chapterId: string): Promise<NovelAttempt[]> {
    return clone([...this.attempts.values()].filter(attempt => attempt.chapterId === chapterId));
  }
  private findChapter(id: string): { source: NovelSource; chapter: NovelChapter } | undefined {
    for (const source of this.sources.values()) {
      const chapter = source.chapters.find(candidate => candidate.id === id);
      if (chapter) return { source, chapter };
    }
    return undefined;
  }
}

interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
}
interface SourceRow extends QueryResultRow {
  id: string; title: string; raw_text: string; content_sha256: string; source_url: string | null; created_at: Date;
}
interface ChapterRow extends QueryResultRow {
  id: string; document_id: string; chapter_order: number; title: string;
  start_offset: number; end_offset: number; latest_revision_id: string | null;
}
interface RevisionRow extends QueryResultRow {
  id: string; chapter_id: string; parent_revision_id: string | null;
  created_by: NovelRevision['createdBy']; created_at: Date; content_json: NovelRevision['content'];
}
interface AttemptRow extends QueryResultRow {
  id: string; chapter_id: string; expected_revision_id: string | null; model: string; status: NovelAttempt['status'];
  started_at: Date; ended_at: Date | null; error_code: string | null; usage_json: unknown; revision_id: string | null;
}
function mapChapter(row: ChapterRow): NovelChapter {
  return { id: row.id, documentId: row.document_id, order: row.chapter_order, title: row.title,
    start: row.start_offset, end: row.end_offset, latestRevisionId: row.latest_revision_id };
}
function mapRevision(row: RevisionRow): NovelRevision {
  return { id: row.id, chapterId: row.chapter_id, parentRevisionId: row.parent_revision_id,
    createdBy: row.created_by, createdAt: row.created_at.toISOString(), content: clone(row.content_json) };
}
function mapAttempt(row: AttemptRow): NovelAttempt {
  const attempt: NovelAttempt = { id: row.id, chapterId: row.chapter_id, expectedRevisionId: row.expected_revision_id,
    model: row.model, status: row.status, startedAt: row.started_at.toISOString(), endedAt: row.ended_at?.toISOString() ?? null,
    errorCode: row.error_code, usage: clone(row.usage_json), revisionId: row.revision_id };
  validateBegin(attempt);
  if (attempt.status === 'submitted') {
    if (attempt.endedAt !== null || attempt.errorCode !== null || attempt.revisionId !== null || attempt.usage !== null) invalid();
  } else {
    validateFinish({ ...attempt, status: attempt.status, endedAt: attempt.endedAt! });
    if (Date.parse(attempt.endedAt!) < Date.parse(attempt.startedAt)) invalid();
  }
  return attempt;
}

export class PostgresNovelRepository implements NovelRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listSources(): Promise<NovelSourceSummary[]> {
    const result = await this.database.query<{ id: string; title: string; created_at: Date; chapter_count: number }>(
      `SELECT s.id, s.title, s.created_at, count(c.id)::int AS chapter_count FROM novel_sources s
       JOIN novel_chapters c ON c.document_id = s.id GROUP BY s.id ORDER BY s.created_at, s.id`);
    return stored(() => result.rows.map(row => {
      const summary = { id: row.id, title: row.title, createdAt: row.created_at.toISOString(), chapterCount: row.chapter_count };
      if (!validId(summary.id) || !nonempty(summary.title, 300) || !validTime(summary.createdAt)
        || !Number.isInteger(summary.chapterCount) || summary.chapterCount < 1) invalid();
      return summary;
    }));
  }
  async createSource(input: NovelSource): Promise<NovelSource> {
    const source = clone(input);
    validateSource(source, true);
    await this.database.transaction(async client => {
      const inserted = await client.query(`INSERT INTO novel_sources(id, title, raw_text, content_sha256, source_url, created_at)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`, [source.id, source.title, source.rawText, source.contentSha256, source.sourceUrl, source.createdAt]);
      if (inserted.rowCount !== 1) conflict();
      for (const chapter of source.chapters) {
        const added = await client.query(`INSERT INTO novel_chapters(id, document_id, chapter_order, title, start_offset, end_offset)
          VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`, [chapter.id, source.id, chapter.order, chapter.title, chapter.start, chapter.end]);
        if (added.rowCount !== 1) conflict();
      }
    });
    return clone(source);
  }
  async getSource(id: string): Promise<NovelSource | null> { return this.readSource(this.database, id); }
  async getChapterSource(chapterId: string): Promise<NovelSource | null> {
    const result = await this.database.query<{ document_id: string }>('SELECT document_id FROM novel_chapters WHERE id = $1', [chapterId]);
    return result.rows[0] ? this.getSource(result.rows[0].document_id) : null;
  }
  async listRevisions(chapterId: string): Promise<NovelRevision[]> {
    const source = await this.getChapterSource(chapterId);
    if (!source) return [];
    const chapter = source.chapters.find(candidate => candidate.id === chapterId)!;
    const result = await this.database.query<RevisionRow>('SELECT * FROM novel_revisions WHERE chapter_id = $1 ORDER BY revision_order', [chapterId]);
    return stored(() => {
      const revisions = result.rows.map(row => mapRevision(row));
      let previous: string | null = null;
      for (const revision of revisions) {
        validateRevision(revision, source, chapter);
        if (revision.parentRevisionId !== previous) invalid();
        previous = revision.id;
      }
      return revisions;
    });
  }
  async getRevision(id: string): Promise<NovelRevision | null> {
    const result = await this.database.query<RevisionRow>('SELECT * FROM novel_revisions WHERE id = $1', [id]);
    const row = result.rows[0];
    if (!row) return null;
    const source = await this.getChapterSource(row.chapter_id);
    return stored(() => {
      if (!source) invalid();
      const chapter = source.chapters.find(candidate => candidate.id === row.chapter_id);
      if (!chapter) invalid();
      const revision = mapRevision(row);
      validateRevision(revision, source, chapter);
      return revision;
    });
  }
  async getSourceRevisions(source: NovelSource, ids: string[]) {
    const found = await this.database.query<RevisionRow>(`SELECT r.* FROM novel_revisions r
      JOIN novel_chapters c ON c.id=r.chapter_id WHERE c.document_id=$1 AND r.id=ANY($2::text[])`, [source.id, ids]);
    const chapters = new Map(source.chapters.map(chapter => [chapter.id, chapter]));
    const validateContent = novelContentValidatorForBook(source);
    return stored(() => new Map(found.rows.map(row => {
      const revision = mapRevision(row);
      const chapter = chapters.get(revision.chapterId);
      if (!chapter) return invalid();
      validateRevision(revision, source, chapter, validateContent);
      return [revision.id, revision];
    })));
  }
  async saveRevision(input: NovelRevision, expectedRevisionId: string | null): Promise<NovelRevision> {
    const revision = clone(input);
    return this.database.transaction(async client => {
      const chapter = await this.lockChapter(client, revision.chapterId);
      const source = (await this.readSource(client, chapter.documentId))!;
      validateRevision(revision, source, chapter);
      if (!nullableId(expectedRevisionId) || revision.parentRevisionId !== expectedRevisionId
        || chapter.latestRevisionId !== expectedRevisionId) conflict();
      const result = await client.query(`INSERT INTO novel_revisions(id, chapter_id, parent_revision_id, created_by, created_at, content_json)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (id) DO NOTHING`,
      [revision.id, chapter.id, revision.parentRevisionId, revision.createdBy, revision.createdAt, JSON.stringify(revision.content)]);
      if (result.rowCount !== 1) conflict();
      await client.query('UPDATE novel_chapters SET latest_revision_id = $2 WHERE id = $1', [chapter.id, revision.id]);
      return clone(revision);
    });
  }
  async beginAttempt(value: BeginNovelAttempt): Promise<void> {
    const input = clone(value);
    validateBegin(input);
    await this.database.transaction(async client => {
      const chapter = await this.lockChapter(client, input.chapterId);
      if (chapter.latestRevisionId !== input.expectedRevisionId) conflict();
      const unfinished = await client.query("SELECT id FROM novel_attempts WHERE chapter_id = $1 AND status IN ('submitted', 'unknown')", [chapter.id]);
      if (unfinished.rowCount) pending();
      const result = await client.query(`INSERT INTO novel_attempts(id, chapter_id, expected_revision_id, model, status, started_at)
        VALUES ($1, $2, $3, $4, 'submitted', $5) ON CONFLICT (id) DO NOTHING`,
      [input.id, chapter.id, input.expectedRevisionId, input.model, input.startedAt]);
      if (result.rowCount !== 1) conflict();
    });
  }
  async finishAttempt(id: string, input: FinishNovelAttempt): Promise<void> {
    const result = clone(input);
    validateFinish(result);
    await this.database.transaction(async client => {
      const selected = await client.query<AttemptRow>('SELECT * FROM novel_attempts WHERE id = $1 FOR UPDATE', [id]);
      if (!selected.rows[0]) throw new NovelError(404, 'NOVEL_ATTEMPT_NOT_FOUND', '找不到小说模型调用记录。');
      const attempt = stored(() => mapAttempt(selected.rows[0]!));
      if (attempt.status !== 'submitted') throw new NovelError(409, 'NOVEL_ATTEMPT_FINISHED', '调用记录已结束，不能覆盖其结果。');
      if (Date.parse(result.endedAt) < Date.parse(attempt.startedAt)) invalid();
      if (result.revisionId !== null) {
        const revision = await client.query('SELECT id FROM novel_revisions WHERE id = $1 AND chapter_id = $2', [result.revisionId, attempt.chapterId]);
        if (!revision.rowCount) invalid();
      }
      await client.query(`UPDATE novel_attempts SET status = $2, error_code = $3, usage_json = $4::jsonb,
        ended_at = $5, revision_id = $6 WHERE id = $1`,
      [id, result.status, result.errorCode, JSON.stringify(result.usage), result.endedAt, result.revisionId]);
    });
  }
  async listAttempts(chapterId: string): Promise<NovelAttempt[]> {
    const result = await this.database.query<AttemptRow>('SELECT * FROM novel_attempts WHERE chapter_id = $1 ORDER BY attempt_order', [chapterId]);
    return stored(() => result.rows.map(mapAttempt));
  }
  private async lockChapter(client: PoolClient, id: string): Promise<NovelChapter> {
    const result = await client.query<ChapterRow>('SELECT * FROM novel_chapters WHERE id = $1 FOR UPDATE', [id]);
    if (!result.rows[0]) chapterMissing();
    return stored(() => mapChapter(result.rows[0]!));
  }
  private async readSource(query: Queryable, id: string): Promise<NovelSource | null> {
    const selected = await query.query<SourceRow>('SELECT * FROM novel_sources WHERE id = $1', [id]);
    if (!selected.rows[0]) return null;
    const chapters = await query.query<ChapterRow>('SELECT * FROM novel_chapters WHERE document_id = $1 ORDER BY chapter_order', [id]);
    return stored(() => {
      const row = selected.rows[0]!;
      const source: NovelSource = { id: row.id, title: row.title, rawText: row.raw_text,
        contentSha256: row.content_sha256, sourceUrl: row.source_url, createdAt: row.created_at.toISOString(),
        chapters: chapters.rows.map(mapChapter) };
      validateSource(source);
      return source;
    });
  }
}
