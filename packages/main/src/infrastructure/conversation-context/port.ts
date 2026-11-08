import type { TenantContext } from '../../tenancy/context';
import { parseWorkspaceId } from '../../tenancy/context';

export type ConversationScope = Pick<TenantContext, 'workspaceId'>;
export const CONVERSATION_CONTEXT_SCHEMA = 'conversation-context/1' as const;

export class ConversationContextError extends Error {
  constructor(public readonly code: string, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ConversationContextError';
  }
}

/** Rebuildable hot context; complete messages and the authoritative version remain in PostgreSQL. */
export interface ConversationContextSnapshot<TMessage = unknown> {
  schemaVersion: typeof CONVERSATION_CONTEXT_SCHEMA;
  workspaceId: string;
  sessionId: string;
  version: number;
  messages: TMessage[];
  tokenCount: number;
  summary?: string;
  createdAt: string;
}

export interface ConversationContextStore<TMessage = unknown> {
  get(scope: ConversationScope, sessionId: string): Promise<ConversationContextSnapshot<TMessage> | null>;
  /** Returns false only when a newer snapshot already exists. */
  put(snapshot: ConversationContextSnapshot<TMessage>, ttlSeconds: number): Promise<boolean>;
  delete(scope: ConversationScope, sessionId: string): Promise<void>;
}

/** Safe rollback adapter: every read misses and callers rebuild from PostgreSQL. */
export class NoopConversationContextStore<TMessage = unknown> implements ConversationContextStore<TMessage> {
  async get(_scope: ConversationScope, _sessionId: string): Promise<null> { return null; }
  async put(_snapshot: ConversationContextSnapshot<TMessage>, _ttlSeconds: number): Promise<boolean> { return true; }
  async delete(_scope: ConversationScope, _sessionId: string): Promise<void> { /* no-op */ }
}

/**
 * Redis failures and stale versions are cache misses. The loader must read the
 * complete, tenant-checked conversation from PostgreSQL.
 */
export class ConversationContextCache<TMessage = unknown> {
  constructor(private readonly store: ConversationContextStore<TMessage>, private readonly ttlSeconds = 1800) {
    validateTtl(ttlSeconds);
  }

  async readThrough(scope: ConversationScope, sessionId: string, expectedVersion: number,
    loadFromPostgres: () => Promise<ConversationContextSnapshot<TMessage>>):
  Promise<ConversationContextSnapshot<TMessage>> {
    const identity = conversationIdentity(scope, sessionId);
    validateVersion(expectedVersion);
    try {
      const cached = await this.store.get(scope, identity.sessionId);
      if (cached && cached.version === expectedVersion) return cached;
    } catch { /* Redis is rebuildable; continue with the fact source. */ }
    const loaded = validateSnapshot(await loadFromPostgres());
    if (loaded.workspaceId !== identity.workspaceId || loaded.sessionId !== identity.sessionId
      || loaded.version !== expectedVersion) {
      throw new ConversationContextError('CONTEXT_SOURCE_MISMATCH',
        'PostgreSQL 返回的对话快照与请求的工作区、会话或版本不一致。');
    }
    try { await this.store.put(loaded, this.ttlSeconds); }
    catch { /* A cache write must never turn a successful PostgreSQL read into a failure. */ }
    return loaded;
  }

  /** PostgreSQL has already committed; cache failure is reported as false and never rolls business state back. */
  async writeBestEffort(input: ConversationContextSnapshot<TMessage>): Promise<boolean> {
    const snapshot = validateSnapshot(input);
    try { return await this.store.put(snapshot, this.ttlSeconds); }
    catch { return false; }
  }

  async invalidateBestEffort(scope: ConversationScope, sessionId: string): Promise<void> {
    try { await this.store.delete(scope, sessionId); } catch { /* rebuild from PostgreSQL on the next read */ }
  }
}

export function conversationIdentity(scope: ConversationScope, sessionIdValue: unknown):
{ workspaceId: string; sessionId: string } {
  const workspaceId = parseWorkspaceId(scope?.workspaceId);
  if (typeof sessionIdValue !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{1,127}$/u.test(sessionIdValue)) {
    throw new ConversationContextError('CONTEXT_SESSION_INVALID', '对话会话标识无效。');
  }
  return { workspaceId, sessionId: sessionIdValue };
}

export function validateSnapshot<TMessage>(value: ConversationContextSnapshot<TMessage>):
ConversationContextSnapshot<TMessage> {
  if (!value || typeof value !== 'object' || value.schemaVersion !== CONVERSATION_CONTEXT_SCHEMA) {
    throw new ConversationContextError('CONTEXT_SNAPSHOT_INVALID', '对话上下文快照格式无效。');
  }
  const identity = conversationIdentity({ workspaceId: value.workspaceId }, value.sessionId);
  validateVersion(value.version);
  if (!Array.isArray(value.messages) || value.messages.length > 10_000
    || !Number.isSafeInteger(value.tokenCount) || value.tokenCount < 0
    || value.tokenCount > 100_000_000 || (value.summary !== undefined
      && (typeof value.summary !== 'string' || value.summary.length > 100_000))
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString() !== value.createdAt) {
    throw new ConversationContextError('CONTEXT_SNAPSHOT_INVALID', '对话上下文快照格式无效。');
  }
  return structuredClone({ ...value, ...identity });
}

export function validateTtl(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 30 || (value as number) > 86_400) {
    throw new ConversationContextError('CONTEXT_TTL_INVALID', '对话上下文 TTL 必须为 30–86400 秒。');
  }
  return value as number;
}

function validateVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ConversationContextError('CONTEXT_VERSION_INVALID', '对话上下文版本无效。');
  }
  return value as number;
}
