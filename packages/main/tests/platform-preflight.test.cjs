const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { PLATFORM_CHECK_IDS, parsePlatformPreflightReport } = require('@lyra/shared');
const { PlatformPreflightService } = require('../dist/platform/preflight');
const { createPlatformProbes } = require('../dist/platform/probes');
const { readConfig } = require('../dist/config');
const { createApp } = require('../dist/app');
const all = () => Object.fromEntries(PLATFORM_CHECK_IDS.map(id => [id, () => true]));

test('all local capabilities ready does not claim supplier verification or paid calls', async () => {
  const report = await new PlatformPreflightService(all()).check();
  assert.equal(report.status, 'ready');
  assert.equal(report.providerAvailabilityChecked, false);
  assert.equal(report.paidCallsMade, 0);
  assert.equal(report.checks.length, 12);
  assert.deepEqual(parsePlatformPreflightReport(report), report);
});

test('required failures block their stages and optional capabilities only degrade', async () => {
  const probes = all();
  probes.vector = () => 'unverified';
  probes['model-image'] = () => false;
  let report = await new PlatformPreflightService(probes).check();
  assert.equal(report.status, 'degraded');
  assert.equal(report.checks.find(c => c.id === 'vector').code, 'VECTOR_UNVERIFIED');
  probes.migrations = () => false;
  report = await new PlatformPreflightService(probes).check();
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.checks.find(c => c.id === 'migrations').stages, ['prepare']);
  assert.ok(report.checks.find(c => c.id === 'migrations').action.includes('db:migrate'));
  probes['model-general'] = () => false;
  probes.migrations = () => true;
  report = await new PlatformPreflightService(probes, { frameAssessmentRequired: false }).check();
  assert.equal(report.checks.find(c => c.id === 'model-general').required, false);
});

test('timeouts and raw failures have bounded sanitized results', async () => {
  const probes = all();
  probes.database = () => { throw new Error('postgres://user:password@private/db?token=secret'); };
  probes.ffmpeg = () => Promise.reject(new Error('C:/private/path secret-key'));
  probes.ffprobe = () => new Promise(() => {});
  const report = await new PlatformPreflightService(probes, { timeoutMs: 10 }).check();
  assert.equal(report.status, 'blocked');
  assert.equal(report.checks.find(c => c.id === 'ffprobe').code, 'FFPROBE_TIMEOUT');
  for (const value of ['password', 'secret-key', 'private/path', 'postgres://']) assert.equal(JSON.stringify(report).includes(value), false);
});

test('concurrent callers share probes, cache expires and returned snapshots cannot mutate cache', async () => {
  let now = Date.UTC(2026, 10, 6), count = 0, release;
  const probes = all();
  probes.database = () => { count++; return new Promise(resolve => { release = resolve; }); };
  const service = new PlatformPreflightService(probes, { now: () => now, cacheMs: 50 });
  const first = service.check(), second = service.check();
  await new Promise(resolve => setImmediate(resolve));
  release(true);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(count, 1);
  a.checks[0].action = 'mutated';
  assert.notEqual((await service.check()).checks[0].action, 'mutated');
  assert.notEqual(a.checks, b.checks);
  now += 51;
  const third = service.check();
  await new Promise(resolve => setImmediate(resolve));
  release(true); await third;
  assert.equal(count, 2);
});

test('local probes check migration prerequisites, local directory and exact bounded binary commands', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lyra-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['objects', 'tmp', 'manifests']) await mkdir(join(root, name));
  let verified = 0, migrations;
  const commands = [];
  const probes = createPlatformProbes({
    config: readConfig({ LLM_BASE_URL: 'https://model.test/v1', LLM_API_KEY: 'fake-only' }),
    database: { async verifyConnection() { verified++; }, async hasMigrations(ids) { migrations = ids; return false; } },
    mediaRoot: root, mediaServiceReady: true, productionRuntimeReady: true, vectorConfigured: true,
    runner: { async run(command, args, options) { commands.push({ command, args, options }); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; } },
  });
  const report = await new PlatformPreflightService(probes).check();
  assert.equal(verified, 1);
  for (const version of ['001', '007', '014', '015', '016', '017', '024']) assert.ok(migrations.includes(version));
  assert.equal(report.checks.find(c => c.id === 'media-directory').status, 'ready');
  assert.equal(report.checks.find(c => c.id === 'migrations').status, 'blocked');
  assert.equal(report.checks.find(c => c.id === 'vector').status, 'degraded');
  assert.deepEqual(commands.map(c => c.command).sort(), ['ffmpeg', 'ffprobe']);
  for (const command of commands) { assert.deepEqual(command.args, ['-version']); assert.equal(command.options.timeoutMs, 1500); }
});

test('missing runtime configuration fails closed without filesystem or provider access', async () => {
  const probes = createPlatformProbes({ config: readConfig({}), mediaServiceReady: false,
    productionRuntimeReady: false, vectorConfigured: false,
    runner: { async run() { throw new Error('missing binary secret payload'); } } });
  const report = await new PlatformPreflightService(probes).check();
  assert.equal(report.status, 'blocked');
  assert.equal(report.checks.find(c => c.id === 'database').status, 'blocked');
  assert.equal(report.checks.find(c => c.id === 'media-directory').status, 'blocked');
  assert.equal(report.checks.find(c => c.id === 'model-video').status, 'blocked');
  assert.equal(JSON.stringify(report).includes('secret payload'), false);
});

test('shared DTO rejects extra fields, duplicate checks, false success, invalid dates and paid claims', async () => {
  const report = await new PlatformPreflightService(all()).check();
  const corrupt = [
    r => { r.apiKey = 'secret'; }, r => { r.checks.pop(); }, r => { r.checks[1] = r.checks[0]; },
    r => { r.status = 'blocked'; }, r => { r.providerAvailabilityChecked = true; }, r => { r.paidCallsMade = 1; },
    r => { r.checkedAt = 'invalid'; }, r => { r.expiresAt = r.checkedAt; },
    r => { r.checks[0].status = 'degraded'; }, r => { r.checks[0].stages = ['unknown']; },
    r => { r.checks[0].code = 'TOKEN\n'; },
  ];
  for (const change of corrupt) { const value = structuredClone(report); change(value); assert.throws(() => parsePlatformPreflightReport(value), TypeError); }
  for (const options of [{ cacheMs: 0 }, { cacheMs: 60001 }, { timeoutMs: Infinity }, { timeoutMs: 0 }]) {
    assert.throws(() => new PlatformPreflightService(all(), options), TypeError);
  }
});

test('HTTP uses local guard/no-store, and real CLI doctor consumes the shared report without model calls', async t => {
  let calls = 0;
  const app = await createApp(readConfig({}), async () => { calls++; throw new Error('must not call provider'); },
    { platformPreflight: new PlatformPreflightService(all()) });
  t.after(() => app.close());
  const denied = await app.inject({ method: 'GET', url: '/api/platform/preflight', headers: { host: 'evil.test' } });
  assert.equal(denied.statusCode, 403);
  const response = await app.inject({ method: 'GET', url: '/api/platform/preflight', headers: { host: '127.0.0.1:8788' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(parsePlatformPreflightReport(response.json()).status, 'ready');
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const cli = join(__dirname, '../../cli/dist/index.js');
  await t.test('compiled CLI integration', { skip: !require('node:fs').existsSync(cli) }, async () => {
    const { stdout } = await execFile(process.execPath, [cli, 'doctor', '--api', 'http://127.0.0.1:' + address.port, '--json'], { timeout: 10000 });
    assert.equal(JSON.parse(stdout).preflight.status, 'ready');
  });
  assert.equal(calls, 0);
});
