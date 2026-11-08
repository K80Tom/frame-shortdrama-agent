const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const { MemoryProductionRepository } = require('../dist/production/repository');
const { ProductionService } = require('../dist/production/service');

const HEADERS = {
  host: '127.0.0.1:8788',
  origin: 'http://127.0.0.1:5173',
  'x-shortdrama-call': '1',
};

function request() {
  return {
    projectId: 'project_0123456789abcdef0123456789abcdef',
    scriptVersionId: 'script_0123456789abcdef0123456789abcdef',
    ratio: '9:16',
    targetDurationSec: 90,
    visualStyle: '写实电影感',
    qualityPreset: 'balanced',
    automationMode: 'auto',
    candidatePolicy: 'gacha', candidateLimit: 2,
    directorPolicy: 'auto',
    budgetMicros: 50_000_000,
    currency: 'CNY',
    allowPaid: true,
    clientRequestId: 'http-production-run-1',
  };
}

test('production HTTP creates, lists, reads and pauses a durable run behind the local write guard', async t => {
  const service = new ProductionService(new MemoryProductionRepository(), { pollIntervalMs: 60_000 });
  const app = await createApp(readConfig({}), fetch, { productionService: service });
  t.after(() => app.close());

  const denied = await app.inject({ method: 'POST', url: '/api/production-runs',
    headers: { host: HEADERS.host, origin: HEADERS.origin }, payload: request() });
  assert.equal(denied.statusCode, 403);

  const created = await app.inject({ method: 'POST', url: '/api/production-runs', headers: HEADERS, payload: request() });
  assert.equal(created.statusCode, 202);
  assert.match(created.headers['cache-control'], /no-store/);
  const run = created.json();
  assert.match(run.id, /^production_[a-f0-9]{32}$/);
  assert.equal(run.stages.length, 10);

  const listed = await app.inject({ method: 'GET', url: '/api/production-runs', headers: { host: HEADERS.host } });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().runs[0].id, run.id);

  const read = await app.inject({ method: 'GET', url: `/api/production-runs/${run.id}`, headers: { host: HEADERS.host } });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().clientRequestId, request().clientRequestId);

  const paused = await app.inject({ method: 'POST', url: `/api/production-runs/${run.id}/actions`, headers: HEADERS,
    payload: { type: 'pause' } });
  assert.equal(paused.statusCode, 200);
  assert.equal(paused.json().status, 'paused');
});

test('production and media routes fail closed when their runtime dependencies are absent', async t => {
  const app = await createApp(readConfig({}));
  t.after(() => app.close());
  const runs = await app.inject({ method: 'GET', url: '/api/production-runs', headers: { host: HEADERS.host } });
  assert.equal(runs.statusCode, 503);
  assert.equal(runs.json().error.code, 'PRODUCTION_PERSISTENCE_UNAVAILABLE');
  const media = await app.inject({ method: 'GET', url: `/api/production-media/media_${'a'.repeat(64)}`,
    headers: { host: HEADERS.host } });
  assert.equal(media.statusCode, 503);
  assert.equal(media.json().error.code, 'PRODUCTION_MEDIA_UNAVAILABLE');
});

test('production media route streams only bytes returned by the verified local store', async t => {
  const id = `media_${'b'.repeat(64)}`;
  let received = '';
  const store = { async content(value) {
    received = value;
    return { object: { id, mimeType: 'video/mp4' }, bytes: Buffer.from('verified-local-mp4') };
  } };
  const app = await createApp(readConfig({}), fetch, { productionMediaStore: store });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: `/api/production-media/${id}?download=1`,
    headers: { host: HEADERS.host } });
  assert.equal(response.statusCode, 200);
  assert.equal(received, id);
  assert.equal(response.headers['content-type'], 'video/mp4');
  assert.match(response.headers['content-disposition'], /^attachment;/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.rawPayload.toString(), 'verified-local-mp4');
});

test('session media routes require the workspace object service and never fall back to global local bytes', async t => {
  const workspaceId = `ws_${'c'.repeat(32)}`;
  const id = `media_${'d'.repeat(64)}`;
  const authService = {
    async authenticate() {
      return {
        sessionId: `ses_${'e'.repeat(32)}`,
        csrfToken: 'f'.repeat(43),
        tenant: {
          userId: `usr_${'1'.repeat(32)}`,
          workspaceId,
          role: 'owner',
          requestId: 'request-media-object-0001',
        },
        view: { authenticated: true, user: { id: `usr_${'1'.repeat(32)}`, displayName: 'Owner' },
          workspaces: [{ id: workspaceId, slug: 'studio', name: 'Studio', role: 'owner' }],
          currentWorkspaceId: workspaceId },
      };
    },
    verifyCsrf() {},
    async revoke() {},
  };
  let localReads = 0;
  const local = { async content() { localReads++; return {
    object: { id, mimeType: 'video/mp4' }, bytes: Buffer.from('must-not-leak'),
  }; } };
  const config = readConfig({ LYRA_AUTH_MODE: 'session' });
  const unavailable = await createApp(config, fetch, { authService, productionMediaStore: local });
  t.after(() => unavailable.close());
  const rejected = await unavailable.inject({ method: 'GET', url: `/api/production-media/${id}`,
    headers: { host: HEADERS.host, cookie: 'session=test' } });
  assert.equal(rejected.statusCode, 503);
  assert.equal(rejected.json().error.code, 'OBJECT_MEDIA_UNAVAILABLE');
  assert.equal(localReads, 0);

  const calls = [];
  const objects = {
    async content(scope, mediaId) {
      calls.push(['content', scope.workspaceId, mediaId]);
      return { record: { contentType: 'video/mp4' }, bytes: Buffer.from('workspace-object') };
    },
    async access(scope, mediaId) {
      calls.push(['access', scope.workspaceId, mediaId]);
      return { method: 'GET', url: 'https://objects.example.test/signed',
        expiresAt: '2026-11-08T00:05:00.000Z' };
    },
  };
  const app = await createApp(config, fetch, { authService, productionMediaStore: local,
    productionMediaObjectService: objects });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: `/api/production-media/${id}`,
    headers: { host: HEADERS.host, cookie: 'session=test' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.rawPayload.toString(), 'workspace-object');
  const signed = await app.inject({ method: 'GET', url: `/api/production-media/${id}/access`,
    headers: { host: HEADERS.host, cookie: 'session=test' } });
  assert.equal(signed.statusCode, 200);
  assert.equal(signed.json().url, 'https://objects.example.test/signed');
  assert.deepEqual(calls, [
    ['content', workspaceId, id],
    ['access', workspaceId, id],
  ]);
  assert.equal(localReads, 0);
});
