import type { PostgresDatabase } from '../db/client';
import {
  AssistantError, contextKeyOf, newAssistantId,
  type AssistantContext, type AssistantMessage, type AssistantQuote, type AssistantQuoteStatus,
  type AssistantRepository, type AssistantSession,
} from '@lyra/agent';

function requireSession(session: AssistantSession | undefined, id: string): AssistantSession {
  if (!session) throw new AssistantError(404, 'ASSISTANT_SESSION_NOT_FOUND', '助手会话不存在或已过期，请重新打开 AI 工作区。');
  return session;
}

interface SessionRow {
  id: string; context_key: string; context_json: AssistantContext; title: string;
  created_at: Date | string; updated_at: Date | string;
}
interface ConversationVersionRow {
  conversation_version: string | number;
  last_message_seq: string | number;
}
interface MessageRow {
  id: string; session_id: string; seq: string | number; role: AssistantMessage['role']; content: string; thinking: string;
  status: AssistantMessage['status']; tool_name: string | null; payload_json: Record<string, unknown> | null; created_at: Date | string;
}
interface QuoteRow {
  id: string; session_id: string; kind: 'production_run'; request_json: Record<string, unknown>; summary: string;
  estimate_cost_micros: string | number; currency: string; status: AssistantQuoteStatus; submitted_run_id: string | null;
  expires_at: Date | string; created_at: Date | string;
}

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const sessionOf = (row: SessionRow): AssistantSession => ({
  id: row.id, contextKey: row.context_key, context: row.context_json, title: row.title,
  createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
});
const messageOf = (row: MessageRow): AssistantMessage => ({
  id: row.id, sessionId: row.session_id, seq: Number(row.seq), role: row.role, content: row.content, thinking: row.thinking,
  status: row.status, ...(row.tool_name ? { toolName: row.tool_name } : {}), ...(row.payload_json ? { payload: row.payload_json } : {}),
  createdAt: iso(row.created_at),
});
const quoteOf = (row: QuoteRow): AssistantQuote => ({
  id: row.id, sessionId: row.session_id, kind: row.kind, request: row.request_json, summary: row.summary,
  estimateCostMicros: Number(row.estimate_cost_micros), currency: row.currency, status: row.status,
  ...(row.submitted_run_id ? { submittedRunId: row.submitted_run_id } : {}), expiresAt: iso(row.expires_at), createdAt: iso(row.created_at),
});

export class PostgresAssistantRepository implements AssistantRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async createSession(context: AssistantContext): Promise<AssistantSession> {
    const id = newAssistantId('asst');
    const result = await this.database.query<SessionRow>(
      `INSERT INTO assistant_sessions (id, context_key, context_json) VALUES ($1, $2, $3::jsonb) RETURNING *`,
      [id, contextKeyOf(context), JSON.stringify(context)]);
    const row = result.rows[0];
    if (!row) throw new AssistantError(500, 'ASSISTANT_PERSISTENCE_ERROR', '会话写入失败，请重试。');
    return sessionOf(row);
  }

  async getSession(id: string): Promise<AssistantSession> {
    const result = await this.database.query<SessionRow>(`SELECT * FROM assistant_sessions WHERE id = $1`, [id]);
    return requireSession(result.rows[0] ? sessionOf(result.rows[0]) : undefined, id);
  }

  async listMessages(sessionId: string): Promise<AssistantMessage[]> {
    await this.getSession(sessionId);
    const result = await this.database.query<MessageRow>(`SELECT * FROM assistant_messages WHERE session_id = $1 ORDER BY seq`, [sessionId]);
    return result.rows.map(messageOf);
  }

  async appendMessage(message: Omit<AssistantMessage, 'seq' | 'createdAt'>): Promise<AssistantMessage> {
    return this.database.transaction(async client => {
      const locked = await client.query<ConversationVersionRow>(`
        SELECT conversation_version, last_message_seq
        FROM assistant_sessions WHERE id = $1 FOR UPDATE
      `, [message.sessionId]);
      const state = locked.rows[0];
      if (!state) throw new AssistantError(404, 'ASSISTANT_SESSION_NOT_FOUND', '助手会话不存在或已过期，请重新打开 AI 工作区。');
      const seq = Number(state.last_message_seq) + 1;
      if (!Number.isSafeInteger(seq) || seq < 1) {
        throw new AssistantError(500, 'ASSISTANT_PERSISTENCE_ERROR', '对话版本异常，请稍后重试。');
      }
      const result = await client.query<MessageRow>(`
        INSERT INTO assistant_messages
          (id, session_id, seq, role, content, thinking, status, tool_name, payload_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING *
      `, [message.id, message.sessionId, seq, message.role, message.content, message.thinking, message.status,
        message.toolName ?? null, message.payload ? JSON.stringify(message.payload) : null]);
      await client.query(`
        UPDATE assistant_sessions
        SET conversation_version = conversation_version + 1,
            last_message_seq = $2,
            updated_at = now(),
            title = CASE WHEN title = '' AND $3 = 'user' THEN $4 ELSE title END
        WHERE id = $1
      `, [message.sessionId, seq, message.role, message.content.slice(0, 40)]);
      const row = result.rows[0];
      if (!row) throw new AssistantError(500, 'ASSISTANT_PERSISTENCE_ERROR', '消息写入失败，请重试。');
      return messageOf(row);
    });
  }

  async conversationVersion(sessionId: string): Promise<number> {
    const result = await this.database.query<ConversationVersionRow>(`
      SELECT conversation_version, last_message_seq FROM assistant_sessions WHERE id = $1
    `, [sessionId]);
    const row = result.rows[0];
    if (!row) throw new AssistantError(404, 'ASSISTANT_SESSION_NOT_FOUND', '助手会话不存在或已过期，请重新打开 AI 工作区。');
    const version = Number(row.conversation_version);
    const lastMessageSeq = Number(row.last_message_seq);
    if (!Number.isSafeInteger(version) || version < 0 || !Number.isSafeInteger(lastMessageSeq)
      || lastMessageSeq < 0 || version !== lastMessageSeq) {
      throw new AssistantError(500, 'ASSISTANT_PERSISTENCE_ERROR', '对话版本异常，请稍后重试。');
    }
    return version;
  }

  async conversationSnapshot(sessionId: string): Promise<{ version: number; messages: AssistantMessage[] }> {
    return this.database.transaction(async client => {
      const stateResult = await client.query<ConversationVersionRow>(`
        SELECT conversation_version, last_message_seq
        FROM assistant_sessions WHERE id = $1 FOR SHARE
      `, [sessionId]);
      const state = stateResult.rows[0];
      if (!state) throw new AssistantError(404, 'ASSISTANT_SESSION_NOT_FOUND', '助手会话不存在或已过期，请重新打开 AI 工作区。');
      const version = Number(state.conversation_version);
      const lastMessageSeq = Number(state.last_message_seq);
      if (!Number.isSafeInteger(version) || version < 0 || version !== lastMessageSeq) {
        throw new AssistantError(500, 'ASSISTANT_PERSISTENCE_ERROR', '对话版本异常，请稍后重试。');
      }
      const result = await client.query<MessageRow>(`
        SELECT * FROM assistant_messages WHERE session_id = $1 ORDER BY seq
      `, [sessionId]);
      const messages = result.rows.map(messageOf);
      if ((messages.at(-1)?.seq ?? 0) !== lastMessageSeq || messages.length !== lastMessageSeq) {
        throw new AssistantError(500, 'ASSISTANT_PERSISTENCE_ERROR', '对话消息序列不完整，请稍后重试。');
      }
      return { version, messages };
    });
  }

  async listQuotes(sessionId: string): Promise<AssistantQuote[]> {
    await this.getSession(sessionId);
    const result = await this.database.query<QuoteRow>(`SELECT * FROM assistant_quotes WHERE session_id = $1 ORDER BY created_at`, [sessionId]);
    return result.rows.map(quoteOf);
  }

  async createQuote(quote: Omit<AssistantQuote, 'createdAt'>): Promise<AssistantQuote> {
    const result = await this.database.query<QuoteRow>(
      `INSERT INTO assistant_quotes (id, session_id, kind, request_json, summary, estimate_cost_micros, currency, status, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9) RETURNING *`,
      [quote.id, quote.sessionId, quote.kind, JSON.stringify(quote.request), quote.summary,
        quote.estimateCostMicros, quote.currency, quote.status, quote.expiresAt]);
    const row = result.rows[0];
    if (!row) throw new AssistantError(500, 'ASSISTANT_PERSISTENCE_ERROR', '估价卡写入失败，请重试。');
    return quoteOf(row);
  }

  async getQuote(sessionId: string, quoteId: string): Promise<AssistantQuote> {
    const result = await this.database.query<QuoteRow>(`SELECT * FROM assistant_quotes WHERE id = $1 AND session_id = $2`, [quoteId, sessionId]);
    if (!result.rows[0]) throw new AssistantError(404, 'ASSISTANT_QUOTE_NOT_FOUND', '估价确认卡不存在或不属于当前会话。');
    return quoteOf(result.rows[0]);
  }

  async updateQuoteStatus(id: string, status: AssistantQuoteStatus, submittedRunId?: string): Promise<AssistantQuote> {
    const result = await this.database.query<QuoteRow>(
      `UPDATE assistant_quotes SET status = $2, submitted_run_id = COALESCE($3, submitted_run_id), updated_at = now() WHERE id = $1 RETURNING *`,
      [id, status, submittedRunId ?? null]);
    if (!result.rows[0]) throw new AssistantError(404, 'ASSISTANT_QUOTE_NOT_FOUND', '估价确认卡不存在。');
    return quoteOf(result.rows[0]!);
  }
}
