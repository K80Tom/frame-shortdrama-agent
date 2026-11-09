const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');

const { MemoryWorkerLeaseStore, WorkerInstanceLeaseManager, WorkerRuntime, RuntimeWorkerError } =
  require('../dist/runtime');

const OWNER = `wkri_${randomBytes(16).toString('hex')}`;

function createHarness(clock) {
  const store = new MemoryWorkerLeaseStore();
  const lease = new WorkerInstanceLeaseManager({
    ownerInstanceId: OWNER,
    role: 'worker',
    leaseMs: 30_000,
    heartbeatIntervalMs: 10_000,
    store,
    now: () => clock.value,
  });
  const scheduled = [];
  const started = [];
  const stopped = [];
  const aborted = [];
  const makeTask = name => ({
    name,
    start(signal) { started.push(name); signal.addEventListener('abort', () => aborted.push(name)); },
    async stop() { stopped.push(name); },
  });
  const runtime = new WorkerRuntime({
    lease,
    tasks: [makeTask('task-a'), makeTask('task-b')],
    now: () => Date.parse(clock.value),
    scheduleHeartbeat: (callback, timeoutMs) => {
      const entry = { callback, timeoutMs, cancelled: false };
      scheduled.push(entry);
      return () => { entry.cancelled = true; };
    },
    onLeaseLost: error => { clock.leaseLost = error; },
  });
  return { store, lease, runtime, scheduled, started, stopped, aborted };
}

test('Worker 运行时：启动领取租约、心跳续约、停机排空并释放', async () => {
  const clock = { value: '2026-11-09T08:00:00.000Z' };
  const harness = createHarness(clock);
  assert.equal(harness.runtime.currentState, 'idle');
  await harness.runtime.start();
  assert.equal(harness.runtime.currentState, 'running');
  assert.deepEqual(harness.started, ['task-a', 'task-b']);
  assert.equal(harness.lease.fencingToken, 1);
  assert.equal(harness.scheduled.length, 1);
  assert.equal(harness.scheduled[0].timeoutMs, 10_000);
  await harness.runtime.heartbeatOnce();
  assert.equal(harness.lease.fencingToken, 1, '心跳续约不改变 fencing token');
  await harness.runtime.stop();
  assert.deepEqual(harness.stopped, ['task-b', 'task-a'], '停机按逆序排空任务');
  assert.ok(harness.aborted.includes('task-a') && harness.aborted.includes('task-b'));
  assert.equal(harness.runtime.currentState, 'stopped');
  assert.equal(harness.lease.fencingToken, null, '停机释放租约');
  assert.equal(await harness.store.activeLease('worker', clock.value), null);
  assert.ok(harness.scheduled[0].cancelled, '心跳调度已取消');
  await assert.rejects(() => harness.runtime.start(), RuntimeWorkerError, '停止后不可直接重启（需新实例身份）');
});

test('Worker 运行时：租约丢失触发崩溃抢占响应（中止任务、进入 stalled、回调上报）', async () => {
  const clock = { value: '2026-11-09T08:00:00.000Z' };
  const harness = createHarness(clock);
  await harness.runtime.start();
  // 模拟被抢占：B 接管后，本实例下一次心跳续约必须失败。
  await harness.store.acquire({
    ownerInstanceId: `wkri_${randomBytes(16).toString('hex')}`,
    role: 'worker', leaseMs: 30_000, now: '2026-11-09T08:00:31.000Z',
  });
  await harness.runtime.heartbeatOnce();
  assert.equal(harness.runtime.currentState, 'stalled');
  assert.ok(clock.leaseLost instanceof RuntimeWorkerError);
  assert.equal(clock.leaseLost.code, 'LEASE_PREEMPTED');
  assert.deepEqual(harness.aborted.sort(), ['task-a', 'task-b'], '租约丢失必须中止全部任务');
  assert.ok(harness.scheduled[0].cancelled, '租约丢失后停止心跳调度');
  await harness.runtime.stop();
  assert.equal(harness.runtime.currentState, 'stopped');
});
