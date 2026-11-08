import { createHash } from 'node:crypto';

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RequestRateLimiter {
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision>;
}

export class RateLimiterUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RateLimiterUnavailableError';
  }
}

interface RedisEvalClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

const FIXED_WINDOW = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

function positiveInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

/** Distributed fixed-window limiter. Redis loss fails closed at the HTTP edge. */
export class RedisRequestRateLimiter implements RequestRateLimiter {
  constructor(private readonly client: RedisEvalClient, private readonly prefix = 'lyra:rate') {
    if (!/^[A-Za-z0-9:_-]{1,64}$/u.test(prefix)) throw new Error('Invalid rate limit key prefix');
  }

  async consume(key: string, limitValue: number, windowValue: number): Promise<RateLimitDecision> {
    if (!/^[A-Za-z0-9:._-]{1,160}$/u.test(key)) throw new Error('Invalid rate limit key');
    const limit = positiveInteger(limitValue, 1, 100_000, 'rate limit');
    const windowSeconds = positiveInteger(windowValue, 1, 86_400, 'rate limit window');
    let result: unknown;
    try {
      result = await this.client.eval(FIXED_WINDOW, {
        keys: [`${this.prefix}:${key}`], arguments: [String(windowSeconds)],
      });
    } catch (cause) {
      throw new RateLimiterUnavailableError('Redis rate limiter unavailable', { cause });
    }
    if (!Array.isArray(result) || result.length < 2) {
      throw new RateLimiterUnavailableError('Invalid Redis rate limiter response');
    }
    const count = Number(result[0]);
    const ttl = Math.max(1, Number(result[1]));
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(ttl)) {
      throw new RateLimiterUnavailableError('Invalid Redis rate limiter response');
    }
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSeconds: ttl };
  }
}

export class NoopRequestRateLimiter implements RequestRateLimiter {
  async consume(_key: string, limit: number): Promise<RateLimitDecision> {
    return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: 0 };
  }
}

/** Never stores a raw IP/session/user identifier in Redis keys. */
export function rateLimitIdentity(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
