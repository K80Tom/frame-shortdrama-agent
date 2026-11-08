import {
  ConversationContextCache, NoopConversationContextStore,
  type ConversationContextStore,
} from './port';
import { RedisConversationContextStore, type RedisConversationClient } from './redis';
import {
  NoopRequestRateLimiter,
  RedisRequestRateLimiter,
  type RequestRateLimiter,
} from '../rate-limit';

interface NodeRedisClient extends RedisConversationClient {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  ping(): Promise<string>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}
interface NodeRedisModule {
  createClient(options: Record<string, unknown>): NodeRedisClient;
}

export interface ConversationContextRuntime<TMessage = unknown> {
  mode: 'noop' | 'redis';
  store: ConversationContextStore<TMessage>;
  cache: ConversationContextCache<TMessage>;
  rateLimiter: RequestRateLimiter;
  probe(): Promise<boolean>;
  close(): Promise<void>;
}

export interface ConversationContextRuntimeOptions {
  redisModule?: NodeRedisModule;
  onRedisError?: (error: unknown) => void;
}

/** Connects only when REDIS_URL is explicitly configured; otherwise returns the PG-only rollback path. */
export async function createConversationContextRuntime<TMessage = unknown>(env: NodeJS.ProcessEnv,
  options: ConversationContextRuntimeOptions = {}): Promise<ConversationContextRuntime<TMessage>> {
  const ttl = integer(env.CONVERSATION_CONTEXT_TTL_SECONDS, 1800, 30, 86_400,
    'CONVERSATION_CONTEXT_TTL_SECONDS');
  const rawUrl = env.REDIS_URL?.trim();
  if (!rawUrl) {
    const store = new NoopConversationContextStore<TMessage>();
    return { mode: 'noop', store, cache: new ConversationContextCache(store, ttl),
      rateLimiter: new NoopRequestRateLimiter(),
      async probe() { return false; }, async close() {} };
  }
  const url = validateRedisUrl(rawUrl, env.REDIS_HOST_ALLOWLIST);
  const redis = options.redisModule ?? loadRedisModule();
  const client = redis.createClient({ url,
    socket: { connectTimeout: integer(env.REDIS_CONNECT_TIMEOUT_MS, 5000, 250, 60_000,
      'REDIS_CONNECT_TIMEOUT_MS') } });
  client.on('error', options.onRedisError ?? (() => undefined));
  try { await client.connect(); }
  catch {
    throw new Error('Redis 对话上下文连接失败。');
  }
  const store = new RedisConversationContextStore<TMessage>(client,
    env.REDIS_CONTEXT_PREFIX?.trim() || 'lyra:context');
  return { mode: 'redis', store, cache: new ConversationContextCache(store, ttl),
    rateLimiter: new RedisRequestRateLimiter(client, env.REDIS_RATE_LIMIT_PREFIX?.trim() || 'lyra:rate'),
    async probe() { return (await client.ping()) === 'PONG'; },
    async close() { await client.quit(); } };
}

function validateRedisUrl(raw: string, allowlistRaw: string | undefined): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error('REDIS_URL 格式无效。'); }
  if (!['redis:', 'rediss:'].includes(url.protocol) || url.search || url.hash || !url.hostname
    || (url.pathname !== '' && url.pathname !== '/' && !/^\/\d+$/u.test(url.pathname))) {
    throw new Error('REDIS_URL 格式无效。');
  }
  const allowed = new Set(['localhost', '127.0.0.1', '[::1]',
    ...(allowlistRaw ?? '').split(',').map(value => value.trim()).filter(Boolean)]);
  if (!allowed.has(url.hostname)) throw new Error('REDIS_URL 主机不在 REDIS_HOST_ALLOWLIST 中。');
  return url.toString();
}

function integer(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}-${max} 的整数。`);
  return value;
}

function loadRedisModule(): NodeRedisModule {
  try { return require('redis') as NodeRedisModule; }
  catch { throw new Error('Redis 已配置，但缺少 redis 运行依赖。'); }
}
