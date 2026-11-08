const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const { SystemStatusService, staticProbe } = require('../dist/system/status');
const { startWorkerProcessLifetime } = require('../dist/system/worker-lifetime');

const headers = { host: '127.0.0.1:8788' };

test('runtime role parsing keeps all compatibility and rejects unknown roles', () => {
  assert.equal(readConfig({}).runtimeRole, 'all');
  assert.equal(readConfig({ LYRA_RUNTIME_ROLE: 'API' }).runtimeRole, 'api');
  assert.equal(readConfig({ LYRA_RUNTIME_ROLE: 'worker' }).runtimeRole, 'worker');
  assert.throws(() => readConfig({ LYRA_RUNTIME_ROLE: 'scheduler' }));
});

test('Stage 1 API fails closed without session auth and readiness uses rollback-only DML', () => {
  const mainSource = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');
  const databaseSource = readFileSync(join(__dirname, '../src/db/client.ts'), 'utf8');
  assert.match(mainSource, /runtimeRole === 'api' && config\.authMode !== 'session'/u);
  assert.match(mainSource, /verifyWritable\(\)/u);
  assert.match(databaseSource, /INSERT INTO runtime_heartbeats/u);
  assert.match(databaseSource, /ROLLBACK TO SAVEPOINT lyra_readiness_write_probe/u);
});

test('worker-only lifetime stays referenced and waits for graceful signal cleanup', async () => {
  const signals = new EventEmitter();
  let shutdowns = 0;
  const lifetime = startWorkerProcessLifetime(async () => { shutdowns += 1; }, {
    signals,
    intervalMs: 1_000,
  });
  assert.equal(lifetime.isReferenced(), true);
  signals.emit('SIGTERM');
  await lifetime.done;
  assert.equal(lifetime.isReferenced(), false);
  assert.equal(shutdowns, 1);
  await lifetime.stop();
  assert.equal(shutdowns, 1);
});

test('status distinguishes required readiness from rebuildable degradation without leaking probe errors', async () => {
  const status = new SystemStatusService('api', {
    postgres: staticProbe(true, { status: 'healthy', detail: '可写。', provider: 'postgresql' }),
    objectStorage: staticProbe(true, { status: 'healthy', detail: '私有桶可用。', provider: 'minio' }),
    redis: { required: false, async check() { throw new Error('redis://secret@private-host'); } },
    milvus: staticProbe(false, { status: 'degraded', detail: '降级为词法检索。' }),
  });
  const snapshot = await status.snapshot(new Date('2026-11-08T00:00:00.000Z'));
  assert.equal(snapshot.readiness, 'ready');
  assert.equal(snapshot.runtimeRole, 'api');
  assert.equal(snapshot.services.find(item => item.id === 'redis').status, 'unavailable');
  assert.equal(JSON.stringify(snapshot).includes('private-host'), false);
});

test('live, ready and system status endpoints expose role and return 503 only for required failures', async () => {
  const status = new SystemStatusService('api', {
    postgres: staticProbe(true, { status: 'unavailable', detail: '数据库不可写。' }),
    objectStorage: staticProbe(true, { status: 'healthy', detail: '对象存储可用。', provider: 's3' }),
  });
  const app = await createApp(readConfig({ LYRA_RUNTIME_ROLE: 'api' }), fetch, { systemStatus: status });
  try {
    assert.equal((await app.inject({ url: '/livez', headers })).statusCode, 200);
    const ready = await app.inject({ url: '/readyz', headers });
    assert.equal(ready.statusCode, 503);
    assert.equal(ready.json().readiness, 'not-ready');
    const system = await app.inject({ url: '/api/system/status', headers });
    assert.equal(system.statusCode, 200);
    assert.equal(system.json().runtimeRole, 'api');
  } finally {
    await app.close();
  }
});
