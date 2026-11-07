const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  RedisRequestRateLimiter,
  RateLimiterUnavailableError,
  rateLimitIdentity,
} = require('../dist/infrastructure/rate-limit');

test('Redis limiter uses an atomic expiring window and never stores raw identity in its key', async () => {
  const calls = [];
  const responses = [[1, 60], [3, 41]];
  const limiter = new RedisRequestRateLimiter({
    async eval(script, options) { calls.push({ script, options }); return responses.shift(); },
  });
  const identity = rateLimitIdentity('198.51.100.25');
  const first = await limiter.consume(`login:${identity}`, 2, 60);
  const limited = await limiter.consume(`login:${identity}`, 2, 60);
  assert.deepEqual(first, { allowed: true, remaining: 1, retryAfterSeconds: 60 });
  assert.deepEqual(limited, { allowed: false, remaining: 0, retryAfterSeconds: 41 });
  assert.match(calls[0].script, /INCR/u);
  assert.match(calls[0].script, /EXPIRE/u);
  assert.doesNotMatch(calls[0].options.keys[0], /198\.51\.100\.25/u);
});

test('Redis limiter fails closed when its atomic operation is unavailable', async () => {
  const limiter = new RedisRequestRateLimiter({ async eval() { throw new Error('down'); } });
  await assert.rejects(limiter.consume(`session:${'a'.repeat(64)}`, 10, 60), error => {
    assert.ok(error instanceof RateLimiterUnavailableError);
    return true;
  });
});

test('the Compose edge overwrites untrusted forwarding chains before API rate limiting', () => {
  const nginx = readFileSync(join(__dirname, '../../../deploy/nginx.conf'), 'utf8');
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/u);
  assert.doesNotMatch(nginx, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/u);
});
