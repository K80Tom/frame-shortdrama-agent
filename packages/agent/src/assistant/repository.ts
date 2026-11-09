import {
  AssistantError, contextKeyOf, newAssistantId,
  type AssistantContext, type AssistantMessage, type AssistantQuote, type AssistantQuoteStatus, type AssistantSession,
  type AssistantTurn,
} from './contracts';

export interface AssistantRepository {
  createSession(context: AssistantContext): Promise<AssistantSession>;
  getSession(id: string): Promise<AssistantSession>;
  listSessions(query?: { includeArchived?: boolean; limit?: number }): Promise<AssistantSession[]>;
  updateSession(id: string, patch: { title?: string; archived?: boolean }): Promise<AssistantSession>;
  listMessages(sessionId: string): Promise<AssistantMessage[]>;
  appendMessage(message: Omit<AssistantMessage, 'seq' | 'createdAt'> & { createdAt?: string }): Promise<AssistantMessage>;
  listQuotes(sessionId: string): Promise<AssistantQuote[]>;
  createQuote(quote: Omit<AssistantQuote, 'createdAt'>): Promise<AssistantQuote>;
  getQuote(sessionId: string, quoteId: string): Promise<AssistantQuote>;
  updateQuoteStatus(id: string, status: AssistantQuoteStatus, submittedRunId?: string): Promise<AssistantQuote>;
  /** 落库一个完整 turn 的事件轨迹；游标由仓储在事务内分配。 */
  createTurn(turn: AssistantTurn): Promise<AssistantTurn>;
  listTurnsAfter(sessionId: string, cursor: number, limit?: number): Promise<AssistantTurn[]>;
  lastTurnCursor(sessionId: string): Promise<number>;
}

function requireSession(session: AssistantSession | undefined, id: string): AssistantSession {
  if (!session) throw new AssistantError(404, 'ASSISTANT_SESSION_NOT_FOUND', '助手会话不存在或已过期，请重新打开 AI 工作区。');
  return session;
}

export class InMemoryAssistantRepository implements AssistantRepository {
  private readonly sessions = new Map<string, AssistantSession>();
  private readonly messages = new Map<string, AssistantMessage[]>();
  private readonly quotes = new Map<string, AssistantQuote>();
  private readonly turns = new Map<string, AssistantTurn[]>();
  private readonly cursors = new Map<string, number>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  async createSession(context: AssistantContext): Promise<AssistantSession> {
    const timestamp = this.now().toISOString();
    const session: AssistantSession = {
      id: newAssistantId('asst'), contextKey: contextKeyOf(context), context, title: '', createdAt: timestamp, updatedAt: timestamp,
    };
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    this.cursors.set(session.id, 0);
    return session;
  }

  async getSession(id: string): Promise<AssistantSession> { return requireSession(this.sessions.get(id), id); }

  async listSessions(query: { includeArchived?: boolean; limit?: number } = {}): Promise<AssistantSession[]> {
    return [...this.sessions.values()]
      .filter(session => query.includeArchived === true || !session.archivedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, query.limit ?? 50);
  }

  async updateSession(id: string, patch: { title?: string; archived?: boolean }): Promise<AssistantSession> {
    const session = await this.getSession(id);
    const updated: AssistantSession = {
      ...session,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.archived === true ? { archivedAt: this.now().toISOString() } : {}),
      ...(patch.archived === false ? { archivedAt: undefined } : {}),
      updatedAt: this.now().toISOString(),
    };
    if (patch.archived === false) delete updated.archivedAt;
    this.sessions.set(id, updated);
    return updated;
  }

  async createTurn(turn: AssistantTurn): Promise<AssistantTurn> {
    await this.getSession(turn.sessionId);
    const cursor = (this.cursors.get(turn.sessionId) ?? 0) + 1;
    this.cursors.set(turn.sessionId, cursor);
    const stored: AssistantTurn = { ...turn, cursor };
    this.turns.set(turn.sessionId, [...(this.turns.get(turn.sessionId) ?? []), stored]);
    return stored;
  }

  async listTurnsAfter(sessionId: string, cursor: number, limit = 20): Promise<AssistantTurn[]> {
    await this.getSession(sessionId);
    return (this.turns.get(sessionId) ?? [])
      .filter(turn => turn.cursor > cursor)
      .sort((a, b) => a.cursor - b.cursor)
      .slice(0, limit);
  }

  async lastTurnCursor(sessionId: string): Promise<number> {
    await this.getSession(sessionId);
    return this.cursors.get(sessionId) ?? 0;
  }

  async listMessages(sessionId: string): Promise<AssistantMessage[]> {
    await this.getSession(sessionId);
    return [...(this.messages.get(sessionId) ?? [])].sort((a, b) => a.seq - b.seq);
  }

  async appendMessage(message: Omit<AssistantMessage, 'seq' | 'createdAt'> & { createdAt?: string }): Promise<AssistantMessage> {
    const session = await this.getSession(message.sessionId);
    const items = this.messages.get(session.id)!;
    const stored: AssistantMessage = {
      ...message, seq: (items[items.length - 1]?.seq ?? 0) + 1, createdAt: message.createdAt ?? this.now().toISOString(),
    };
    items.push(stored);
    this.sessions.set(session.id, { ...session, updatedAt: stored.createdAt, title: session.title || (message.role === 'user' ? message.content.slice(0, 40) : session.title) });
    return stored;
  }

  async listQuotes(sessionId: string): Promise<AssistantQuote[]> {
    await this.getSession(sessionId);
    return [...this.quotes.values()].filter(quote => quote.sessionId === sessionId);
  }

  async createQuote(quote: Omit<AssistantQuote, 'createdAt'>): Promise<AssistantQuote> {
    await this.getSession(quote.sessionId);
    const stored: AssistantQuote = { ...quote, createdAt: this.now().toISOString() };
    this.quotes.set(stored.id, stored);
    return stored;
  }

  async getQuote(sessionId: string, quoteId: string): Promise<AssistantQuote> {
    const quote = this.quotes.get(quoteId);
    if (!quote || quote.sessionId !== sessionId) {
      throw new AssistantError(404, 'ASSISTANT_QUOTE_NOT_FOUND', '估价确认卡不存在或不属于当前会话。');
    }
    return quote;
  }

  async updateQuoteStatus(id: string, status: AssistantQuoteStatus, submittedRunId?: string): Promise<AssistantQuote> {
    const quote = this.quotes.get(id);
    if (!quote) throw new AssistantError(404, 'ASSISTANT_QUOTE_NOT_FOUND', '估价确认卡不存在。');
    const next = { ...quote, status, ...(submittedRunId ? { submittedRunId } : {}) };
    this.quotes.set(id, next);
    return next;
  }
}

