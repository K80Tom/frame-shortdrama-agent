import { RuntimeWorkerError } from './contracts';

export interface RedisLeaseHandle {
  readonly client: RedisLeaseClient;
  close(): Promise<void>;
}

export interface RedisLeaseClientOptions {
  readonly redisModule?: {
    createClient(options: Record<string, unknown>): {
      connect(): Promise<unknown>;
      quit(): Promise<unknown>;
      on(event: 'error', listener: (error: unknown) => void): unknown;
      set(key: string, value: string, options?: Record<string, unknown>): Promise<unknown>;
      eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
      del(key: string): Promise<unknown>;
    };
  };
  readonly onError?: (error: unknown) => void;
}

function validateLeaseRedisUrl(raw: string, allowlistRaw: string | undefined): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new RuntimeWorkerError('LEASE_CONFIG_INVALID', 'REDIS_URL 格式无效。'); }
  if (!['redis:', 'rediss:'].includes(url.protocol) || url.search || url.hash || !url.hostname
    || (url.pathname !== '' && url.pathname !== '/' && !/^\/\d+$/u.test(url.pathname))) {
    throw new RuntimeWorkerError('LEASE_CONFIG_INVALID', 'REDIS_URL 格式无效。');
  }
  const allowed = new Set(['localhost', '127.0.0.1', '[::1]',
    ...(allowlistRaw ?? '').split(',').map(value => value.trim()).filter(Boolean)]);
  if (!allowed.has(url.hostname)) {
    throw new RuntimeWorkerError('LEASE_CONFIG_INVALID', 'REDIS_URL 主机不在 REDIS_HOST_ALLOWLIST 中。');
  }
  return url.toString();
}

/**
 * 为租约锁创建独立的 Redis 连接（不与对话快照共享生命周期）。
 * PostgreSQL 是租约权威：连接失败返回 undefined，调用方降级为纯 PG 租约。
 */
export async function createRedisLeaseClientFromEnv(env: NodeJS.ProcessEnv,
  options: RedisLeaseClientOptions = {}): Promise<RedisLeaseHandle | undefined> {
  const rawUrl = env.REDIS_URL?.trim();
  if (!rawUrl) return undefined;
  const url = validateLeaseRedisUrl(rawUrl, env.REDIS_HOST_ALLOWLIST);
  const module = options.redisModule ?? loadRedisModule();
  const client = module.createClient({ url });
  client.on('error', options.onError ?? (() => undefined));
  try {
    await client.connect();
  } catch {
    return undefined;
  }
  return { client: nodeRedisLeaseClient(client), async close() { await client.quit(); } };
}

function loadRedisModule(): NonNullable<RedisLeaseClientOptions['redisModule']> {
  try { return require('redis') as NonNullable<RedisLeaseClientOptions['redisModule']>; }
  catch { throw new RuntimeWorkerError('LEASE_CONFIG_INVALID', 'REDIS_URL 已配置，但缺少 redis 运行依赖。'); }
}

/**
 * Redis 快速互斥锁（移植自融光 worker 的 Redis 锁语义）。
 * 只做 SET NX PX 获取 + Lua 比对 owner 续约/释放；Redis 故障由上层回退
 * 到 PostgreSQL CAS，不影响租约正确性。
 */
export interface RedisLeaseClient {
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface NodeRedisLeaseLike {
  set(key: string, value: string, options?: Record<string, unknown>): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** node-redis v4+ 客户端适配。 */
export function nodeRedisLeaseClient(client: NodeRedisLeaseLike): RedisLeaseClient {
  return {
    async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
      const result = await client.set(key, value, { NX: true, PX: ttlMs });
      return result === 'OK' || result === true;
    },
    eval(script: string, keys: string[], args: string[]): Promise<unknown> {
      return client.eval(script, { keys, arguments: args });
    },
    del(key: string): Promise<unknown> {
      return client.del(key);
    },
  };
}

const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  return 0
end
`;
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

export interface RedisLeaseLockOptions {
  readonly role: string;
  readonly client: RedisLeaseClient;
  readonly keyPrefix?: string;
}

export class RedisLeaseLock {
  private readonly key: string;

  constructor(private readonly options: RedisLeaseLockOptions) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(options.role)) {
      throw new RuntimeWorkerError('LEASE_CONFIG_INVALID', 'Worker role 名称无效。');
    }
    this.key = `${options.keyPrefix ?? 'lyra:worker-lease'}:${options.role}`;
  }

  get lockKey(): string {
    return this.key;
  }

  /** 快速互斥获取：key 已被他人持有时返回 false（不会覆盖他人锁）。 */
  async tryAcquire(ownerInstanceId: string, ttlMs: number): Promise<boolean> {
    return this.options.client.setIfAbsent(this.key, ownerInstanceId, ttlMs);
  }

  /** 仅锁的持有者可以续约；返回 false 表示锁已易主或过期。 */
  async renew(ownerInstanceId: string, ttlMs: number): Promise<boolean> {
    const result = await this.options.client.eval(RENEW_SCRIPT, [this.key], [ownerInstanceId, String(ttlMs)]);
    return result === 1 || result === true;
  }

  /** 仅锁的持有者可以释放。 */
  async release(ownerInstanceId: string): Promise<boolean> {
    const result = await this.options.client.eval(RELEASE_SCRIPT, [this.key], [ownerInstanceId]);
    return result === 1 || result === true;
  }

  async forceDelete(): Promise<void> {
    await this.options.client.del(this.key);
  }
}
