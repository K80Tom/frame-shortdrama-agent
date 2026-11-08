import {
  ConversationContextError, conversationIdentity, validateSnapshot, validateTtl,
  type ConversationContextSnapshot, type ConversationContextStore, type ConversationScope,
} from './port';

/** Matches node-redis primitives without coupling the port to a package version. */
export interface RedisConversationClient {
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

const PUT_IF_NOT_STALE = `
local current = redis.call('GET', KEYS[1])
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok and tonumber(decoded.version) and tonumber(decoded.version) > tonumber(ARGV[1]) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

export class RedisConversationContextStore<TMessage = unknown> implements ConversationContextStore<TMessage> {
  constructor(private readonly client: RedisConversationClient, private readonly prefix = 'lyra:context') {
    if (!/^[A-Za-z0-9:_-]{1,64}$/u.test(prefix)) {
      throw new ConversationContextError('CONTEXT_REDIS_CONFIG_INVALID', 'Redis 对话 key 前缀无效。');
    }
  }

  async get(scope: ConversationScope, sessionId: string): Promise<ConversationContextSnapshot<TMessage> | null> {
    const identity = conversationIdentity(scope, sessionId);
    const key = this.key(identity.workspaceId, identity.sessionId);
    let raw: string | null;
    try { raw = await this.client.get(key); }
    catch (error) { throw unavailable(error); }
    if (raw === null) return null;
    try {
      const snapshot = validateSnapshot(JSON.parse(raw) as ConversationContextSnapshot<TMessage>);
      if (snapshot.workspaceId !== identity.workspaceId || snapshot.sessionId !== identity.sessionId) {
        throw new Error('identity mismatch');
      }
      return snapshot;
    } catch {
      await this.client.del(key).catch(() => 0);
      return null;
    }
  }

  async put(input: ConversationContextSnapshot<TMessage>, ttlSeconds: number): Promise<boolean> {
    const snapshot = validateSnapshot(input);
    const ttl = validateTtl(ttlSeconds);
    let serialized: string;
    try { serialized = JSON.stringify(snapshot); }
    catch { throw new ConversationContextError('CONTEXT_SNAPSHOT_INVALID', '对话上下文快照无法序列化。'); }
    let result: unknown;
    try {
      result = await this.client.eval(PUT_IF_NOT_STALE, {
        keys: [this.key(snapshot.workspaceId, snapshot.sessionId)],
        arguments: [String(snapshot.version), serialized, String(ttl)],
      });
    } catch (error) { throw unavailable(error); }
    return Number(result) === 1;
  }

  async delete(scope: ConversationScope, sessionId: string): Promise<void> {
    const identity = conversationIdentity(scope, sessionId);
    try { await this.client.del(this.key(identity.workspaceId, identity.sessionId)); }
    catch (error) { throw unavailable(error); }
  }

  private key(workspaceId: string, sessionId: string): string {
    // The hash tag keeps one workspace's conversation keys colocated in Redis Cluster.
    return `${this.prefix}:{${workspaceId}}:assistant:${sessionId}`;
  }
}

function unavailable(cause: unknown): ConversationContextError {
  return new ConversationContextError('CONTEXT_REDIS_UNAVAILABLE', 'Redis 对话上下文暂时不可用。', cause);
}
