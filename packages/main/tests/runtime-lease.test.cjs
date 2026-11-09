const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');

const {
  MemoryWorkerLeaseStore, WorkerInstanceLeaseManager, RedisLeaseLock, newOwnerInstanceId,
  RuntimeWorkerError,
} = require('../dist/runtime');

const now = '2026-11-09T08:00:00.000Z';
const later = (base, ms) => new Date(Date.parse(base) + ms).toISOString();
const OWNER_A = `wkri_${randomBytes(16).toString('hex')}`;
const OWNER_B = `wkri_${randomBytes(16).toString('hex')}`;

test('newOwnerInstanceId 符合 wkri_hex32 约定', () => {
  assert.match(newOwnerInstanceId(randomBytes), /^wkri_[a-f0-9]{32}$/);
});

test('实例租约：同角色互斥、续约保持 fencing、过期接管 fencing 单调递增', async () => {
  const store = new MemoryWorkerLeaseStore();
  const first = await store.acquire({ ownerInstanceId: OWNER_A, role: 'worker', leaseMs: 30_000, now });
  assert.equal(first.fencingToken, 1);
  assert.equal(await store.acquire({ ownerInstanceId: OWNER_B, role: 'worker', leaseMs: 30_000, now }), null,
    '同角色未过期租约必须互斥');
  const renewed = await store.renew({ ownerInstanceId: OWNER_A, role: 'worker', leaseMs: 30_000, now: later(now, 10_000) });
  assert.equal(renewed.fencingToken, 1, '续约不得改变 fencing token');
  assert.equal(renewed.acquiredAt, first.acquiredAt);
  // 租约过期后 B 接管：A 置 preempted，B fencing = A + 1。
  // A 于 +10s 续约后租约到 +40s，接管时点取 +41s。
  const takeover = await store.acquire({ ownerInstanceId: OWNER_B, role: 'worker', leaseMs: 30_000, now: later(now, 41_000) });
  assert.equal(takeover.fencingToken, 2);
  await assert.rejects(() => store.renew({ ownerInstanceId: OWNER_A, role: 'worker', leaseMs: 30_000, now: later(now, 42_000) }),
    error => error instanceof RuntimeWorkerError && error.code === 'LEASE_PREEMPTED');
  assert.equal((await store.activeLease('worker', later(now, 42_000)))?.ownerInstanceId, OWNER_B);
  // 事件证据链完整：acquired → renewed → preempted → acquired。
  const events = await store.events('worker', 10);
  assert.deepEqual(events.map(event => event.eventType).reverse(), ['acquired', 'renewed', 'preempted', 'acquired']);
  // B 释放后 A 可重新获取，fencing 继续递增。
  await store.release({ ownerInstanceId: OWNER_B, role: 'worker', now: later(now, 50_000) });
  const reacquired = await store.acquire({ ownerInstanceId: OWNER_A, role: 'worker', leaseMs: 30_000, now: later(now, 51_000) });
  assert.equal(reacquired.fencingToken, 3);
  await store.release({ ownerInstanceId: OWNER_A, role: 'worker', now: later(now, 52_000) });
  await store.release({ ownerInstanceId: OWNER_A, role: 'worker', now: later(now, 53_000) });
  assert.equal(await store.activeLease('worker', later(now, 53_000)), null);
});

function managerDeps(store, lock, clock) {
  return {
    ownerInstanceId: OWNER_A,
    role: 'worker',
    leaseMs: 30_000,
    store,
    lock,
    now: () => clock.value,
  };
}

test('租约管理器：被他人持有时快速失败，Redis 故障降级为纯 PG 权威', async () => {
  const store = new MemoryWorkerLeaseStore();
  const clock = { value: now };
  // B 先持有；A 的 acquire 必须 LEASE_HELD_BY_OTHER。
  const managerB = new WorkerInstanceLeaseManager({ ...managerDeps(store, undefined, clock), ownerInstanceId: OWNER_B });
  await managerB.acquire();
  const managerA = new WorkerInstanceLeaseManager(managerDeps(store, undefined, clock));
  await assert.rejects(() => managerA.acquire(), error => error instanceof RuntimeWorkerError
    && error.code === 'LEASE_HELD_BY_OTHER');
  await managerB.release();

  // Redis 故障（全部抛错）不得阻断 PG 权威流程。
  const brokenLock = {
    async tryAcquire() { throw new Error('redis down'); },
    async renew() { throw new Error('redis down'); },
    async release() { throw new Error('redis down'); },
    async forceDelete() { throw new Error('redis down'); },
  };
  const manager = new WorkerInstanceLeaseManager(managerDeps(store, brokenLock, clock));
  const snapshot = await manager.acquire();
  assert.equal(snapshot.fencingToken, manager.fencingToken);
  await manager.renew();
  assert.equal(manager.snapshot?.state, 'active');
  await manager.release();
  assert.equal(manager.fencingToken, null);
  assert.equal(await store.activeLease('worker', now), null);
});

test('Redis 租约锁：NX 获取、Lua 比对 owner 续约与释放', async () => {
  const store = new Map();
  const evals = [];
  const lock = new RedisLeaseLock({
    role: 'worker',
    client: {
      async setIfAbsent(key, value, ttlMs) {
        if (store.has(key)) return false;
        store.set(key, { value, expiresAt: Date.now() + ttlMs });
        return true;
      },
      async eval(script, keys, args) {
        evals.push({ script: script.replace(/\s+/gu, ' ').trim(), keys, args });
        const entry = store.get(keys[0]);
        if (!entry || entry.value !== args[0]) return 0;
        if (script.includes('PEXPIRE')) { entry.expiresAt = Date.now() + Number(args[1]); return 1; }
        store.delete(keys[0]);
        return 1;
      },
      async del(key) { return store.delete(key) ? 1 : 0; },
    },
  });
  assert.equal(lock.lockKey, 'lyra:worker-lease:worker');
  assert.equal(await lock.tryAcquire(OWNER_A, 30_000), true);
  assert.equal(await lock.tryAcquire(OWNER_B, 30_000), false, '锁被 A 持有时 B 不能覆盖');
  assert.equal(await lock.renew(OWNER_A, 30_000), true);
  assert.equal(await lock.renew(OWNER_B, 30_000), false, '非持有者不能续约');
  assert.equal(await lock.release(OWNER_B), false);
  assert.equal(await lock.release(OWNER_A), true);
  assert.equal(evals.length, 4, 'renew A / renew B / release B / release A 各走一次 Lua');
  assert.ok(evals[0].script.includes('PEXPIRE'));
  assert.ok(evals[3].script.includes("'DEL'"));
});
