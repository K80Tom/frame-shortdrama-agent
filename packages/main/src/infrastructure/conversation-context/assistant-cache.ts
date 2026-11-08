import {
  type AssistantContext,
  type AssistantMessage,
  type AssistantQuote,
  type AssistantQuoteStatus,
  type AssistantRepository,
  type AssistantSession,
} from '@lyra/agent';
import type { PostgresAssistantRepository } from '../../assistant/postgres-repository';
import { tenantExecutionScope } from '../../tenancy/scope';
import {
  CONVERSATION_CONTEXT_SCHEMA,
  ConversationContextCache,
  ConversationContextError,
  type ConversationContextSnapshot,
  type ConversationScope,
} from './port';

/**
 * Read-through acceleration for the Assistant repository. PostgreSQL remains
 * authoritative: every lookup first reads its monotonic version there, and a
 * Redis miss/failure rebuilds from a transactionally consistent PG snapshot.
 */
export class CachedAssistantRepository implements AssistantRepository {
  constructor(private readonly postgres: PostgresAssistantRepository,
    private readonly cache: ConversationContextCache<AssistantMessage>) {}

  async createSession(context: AssistantContext): Promise<AssistantSession> {
    const session = await this.postgres.createSession(context);
    const scope = this.scope();
    if (scope) await this.cache.writeBestEffort(this.snapshot(scope, session.id, 0, []));
    return session;
  }

  getSession(id: string): Promise<AssistantSession> { return this.postgres.getSession(id); }

  async listMessages(sessionId: string): Promise<AssistantMessage[]> {
    const scope = this.scope();
    if (!scope) return this.postgres.listMessages(sessionId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const version = await this.postgres.conversationVersion(sessionId);
      try {
        const value = await this.cache.readThrough(scope, sessionId, version, async () => {
          const source = await this.postgres.conversationSnapshot(sessionId);
          return this.snapshot(scope, sessionId, source.version, source.messages);
        });
        return value.messages;
      } catch (error) {
        if (!(error instanceof ConversationContextError) || error.code !== 'CONTEXT_SOURCE_MISMATCH'
          || attempt > 0) throw error;
      }
    }
    return this.postgres.listMessages(sessionId);
  }

  async appendMessage(message: Omit<AssistantMessage, 'seq' | 'createdAt'> & { createdAt?: string }):
  Promise<AssistantMessage> {
    const stored = await this.postgres.appendMessage(message);
    const scope = this.scope();
    if (scope) {
      const source = await this.postgres.conversationSnapshot(message.sessionId);
      await this.cache.writeBestEffort(this.snapshot(scope, message.sessionId, source.version, source.messages));
    }
    return stored;
  }

  listQuotes(sessionId: string): Promise<AssistantQuote[]> { return this.postgres.listQuotes(sessionId); }
  createQuote(quote: Omit<AssistantQuote, 'createdAt'>): Promise<AssistantQuote> {
    return this.postgres.createQuote(quote);
  }
  getQuote(sessionId: string, quoteId: string): Promise<AssistantQuote> {
    return this.postgres.getQuote(sessionId, quoteId);
  }
  updateQuoteStatus(id: string, status: AssistantQuoteStatus, submittedRunId?: string): Promise<AssistantQuote> {
    return this.postgres.updateQuoteStatus(id, status, submittedRunId);
  }

  private scope(): ConversationScope | null {
    const current = tenantExecutionScope.current();
    return current?.kind === 'tenant' ? { workspaceId: current.tenant.workspaceId } : null;
  }

  private snapshot(scope: ConversationScope, sessionId: string, version: number,
    messages: AssistantMessage[]): ConversationContextSnapshot<AssistantMessage> {
    const characters = messages.reduce((total, message) => total + message.content.length + message.thinking.length, 0);
    return {
      schemaVersion: CONVERSATION_CONTEXT_SCHEMA,
      workspaceId: scope.workspaceId,
      sessionId,
      version,
      messages,
      tokenCount: Math.min(100_000_000, Math.ceil(characters / 3)),
      createdAt: new Date().toISOString(),
    };
  }
}
