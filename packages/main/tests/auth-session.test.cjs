const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const { AuthService, passwordHash } = require('../dist/auth/service');
const { insertBootstrapAdmin } = require('../dist/auth/repository');
const { tenantExecutionScope } = require('../dist/tenancy/scope');

const userId = `usr_${'1'.repeat(32)}`;
const workspaceId = `ws_${'2'.repeat(32)}`;

test('first-admin bootstrap stores a bounded opaque subject for maximum-length emails', async () => {
  let storedSubject;
  const database = { async transaction(work) { return work({ async query(sql, values) {
    if (sql.includes('SELECT count(*)')) return { rows: [{ count: '0' }] };
    if (sql.includes('INSERT INTO users')) { storedSubject = values[1]; return { rows: [], rowCount: 1 }; }
    if (sql.includes('UPDATE workspaces')) return { rows: [{ id: workspaceId }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } }); } };
  await insertBootstrapAdmin(database, {
    userId, workspaceId, email: `${'a'.repeat(240)}@x.test`, displayName: 'Owner',
    workspaceName: 'Main studio', workspaceSlug: 'main-studio', passwordSalt: 'salt',
    passwordHash: 'hash', now: '2026-11-08T00:00:00.000Z',
  });
  assert.match(storedSubject, /^email-sha256:[a-f0-9]{64}$/u);
  assert.ok(storedSubject.length <= 200);
});
async function fixture(role = 'owner', rateLimiter) {
  const salt = '3'.repeat(32);
  const sessions = new Map();
  const repository = {
    async findCredential(email) {
      return email === 'owner@example.com' ? {
        userId,
        displayName: 'Owner',
        passwordSalt: salt,
        passwordHash: await passwordHash('correct horse battery staple', salt),
        passwordAlgorithm: 'scrypt-v1',
      } : null;
    },
    async listWorkspaces(id) {
      return id === userId ? [{ id: workspaceId, slug: 'main-studio', name: 'Main studio', role }] : [];
    },
    async createSession(input) { sessions.set(input.tokenHash, { ...input, displayName: 'Owner', revokedAt: null }); },
    async findSession(tokenHash, now) {
      const row = sessions.get(tokenHash);
      return row && !row.revokedAt && row.expiresAt > now ? {
        id: row.id,
        userId: row.userId,
        displayName: row.displayName,
        currentWorkspaceId: row.currentWorkspaceId,
        csrfHash: row.csrfHash,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
      } : null;
    },
    async touchSession(id, currentWorkspaceId) {
      for (const row of sessions.values()) if (row.id === id) row.currentWorkspaceId = currentWorkspaceId;
    },
    async revokeSession(id, now) {
      for (const row of sessions.values()) if (row.id === id) row.revokedAt = now;
    },
  };
  const authService = new AuthService(repository, {
    sessionTtlSeconds: 3600,
    now: () => new Date('2026-11-08T00:00:00.000Z'),
  });
  const config = readConfig({ LYRA_AUTH_MODE: 'session' });
  let observedScope;
  const breakdownService = {
    async listProjects() { observedScope = tenantExecutionScope.current(); return []; },
  };
  const app = await createApp(config, fetch, { authService, breakdownService, rateLimiter });
  return { app, observedScope: () => observedScope };
}

test('session deployment rate limits login before password verification', async t => {
  const { app } = await fixture('owner', { async consume() {
    return { allowed: false, remaining: 0, retryAfterSeconds: 37 };
  } });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
  }, payload: { email: 'owner@example.com', password: 'wrong' } });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['retry-after'], '37');
  assert.equal(response.json().error.code, 'RATE_LIMITED');
});
function cookieJar(response) {
  const values = Array.isArray(response.headers['set-cookie'])
    ? response.headers['set-cookie'] : [response.headers['set-cookie']];
  return values.filter(Boolean).map(value => value.split(';')[0]).join('; ');
}

function csrf(jar) {
  return decodeURIComponent(jar.split('; ').find(value => value.startsWith('lyra_csrf='))?.slice('lyra_csrf='.length) ?? '');
}

const baseHeaders = { host: '127.0.0.1:8788' };

test('session auth issues HttpOnly/session and readable CSRF cookies, then restores the workspace', async t => {
  const { app, observedScope } = await fixture(); t.after(() => app.close());
  const anonymous = await app.inject({ url: '/api/auth/session', headers: baseHeaders });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error.code, 'AUTH_REQUIRED');

  const bad = await app.inject({ method: 'POST', url: '/api/auth/login', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
  }, payload: { email: 'owner@example.com', password: 'wrong' } });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json().error.code, 'AUTH_INVALID_CREDENTIALS');

  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
  }, payload: { email: 'OWNER@example.com', password: 'correct horse battery staple' } });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().currentWorkspaceId, workspaceId);
  const setCookies = Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [login.headers['set-cookie']];
  assert.match(setCookies.find(value => value.startsWith('lyra_session=')), /HttpOnly/u);
  assert.doesNotMatch(setCookies.find(value => value.startsWith('lyra_csrf=')), /HttpOnly/u);
  assert.equal(setCookies.some(value => /Secure/u.test(value)), false);

  const jar = cookieJar(login);
  const restored = await app.inject({ url: '/api/auth/session', headers: { ...baseHeaders, cookie: jar,
    'x-workspace-id': workspaceId } });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().user.displayName, 'Owner');
  assert.equal(restored.json().workspaces[0].role, 'owner');

  const directory = await app.inject({ url: '/api/workspaces', headers: { ...baseHeaders, cookie: jar } });
  assert.equal(directory.statusCode, 200);
  assert.equal(directory.json().legacyMode, false);
  assert.equal((await app.inject({ url: '/api/projects', headers: { ...baseHeaders, cookie: jar } })).statusCode, 200);
  assert.equal(observedScope().tenant.workspaceId, workspaceId);
});
test('mutations require the double-submit CSRF token and logout revokes the server session', async t => {
  const { app } = await fixture(); t.after(() => app.close());
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
  }, payload: { email: 'owner@example.com', password: 'correct horse battery staple' } });
  const jar = cookieJar(login);
  const rejected = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: {
    ...baseHeaders, cookie: jar, 'x-shortdrama-call': '1',
  } });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.json().error.code, 'CSRF_TOKEN_INVALID');

  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: {
    ...baseHeaders, cookie: jar, 'x-shortdrama-call': '1', 'x-csrf-token': csrf(jar),
  } });
  assert.equal(logout.statusCode, 200);
  assert.equal(logout.json().authenticated, false);
  const expired = Array.isArray(logout.headers['set-cookie']) ? logout.headers['set-cookie'] : [logout.headers['set-cookie']];
  assert.ok(expired.every(value => /Max-Age=0/u.test(value)));
  assert.equal((await app.inject({ url: '/api/auth/session', headers: { ...baseHeaders, cookie: jar } })).statusCode, 401);
});

test('unauthorized workspace selection is indistinguishable from a missing resource', async t => {
  const { app } = await fixture(); t.after(() => app.close());
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
  }, payload: { email: 'owner@example.com', password: 'correct horse battery staple' } });
  const response = await app.inject({ url: '/api/workspaces', headers: {
    ...baseHeaders, cookie: cookieJar(login), 'x-workspace-id': `ws_${'9'.repeat(32)}`,
  } });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: { code: 'RESOURCE_NOT_FOUND', message: '资源不存在。' } });
});

test('session falls back to another active workspace only when no explicit selection was requested', async () => {
  const firstWorkspaceId = `ws_${'4'.repeat(32)}`;
  const secondWorkspaceId = `ws_${'5'.repeat(32)}`;
  const salt = '6'.repeat(32);
  const password = 'correct horse battery staple';
  const hash = await passwordHash(password, salt);
  const sessionRows = new Map();
  let memberships = [
    { id: firstWorkspaceId, slug: 'first', name: 'First', role: 'owner' },
    { id: secondWorkspaceId, slug: 'second', name: 'Second', role: 'member' },
  ];
  const repository = {
    async findCredential(email) { return email === 'owner@example.com' ? {
      userId, displayName: 'Owner', passwordSalt: salt, passwordHash: hash,
      passwordAlgorithm: 'scrypt-v1',
    } : null; },
    async listWorkspaces() { return memberships; },
    async createSession(input) { sessionRows.set(input.tokenHash, { ...input, displayName: 'Owner', revokedAt: null }); },
    async findSession(tokenHash) {
      const row = sessionRows.get(tokenHash);
      return row ? { id: row.id, userId: row.userId, displayName: row.displayName,
        currentWorkspaceId: row.currentWorkspaceId, csrfHash: row.csrfHash,
        expiresAt: row.expiresAt, revokedAt: null } : null;
    },
    async touchSession(id, currentWorkspaceId) {
      for (const row of sessionRows.values()) if (row.id === id) row.currentWorkspaceId = currentWorkspaceId;
    },
    async revokeSession() {},
  };
  const service = new AuthService(repository, { sessionTtlSeconds: 3600,
    now: () => new Date('2026-11-08T00:00:00.000Z') });
  const issued = await service.login({ email: 'owner@example.com', password });
  const cookies = `lyra_session=${issued.sessionToken}; lyra_csrf=${issued.csrfToken}`;

  memberships = [{ id: secondWorkspaceId, slug: 'second', name: 'Second', role: 'member' }];
  const recovered = await service.authenticate(cookies, undefined, 'request-fallback-0001');
  assert.equal(recovered.tenant.workspaceId, secondWorkspaceId);
  assert.equal(recovered.view.currentWorkspaceId, secondWorkspaceId);

  await assert.rejects(service.authenticate(cookies, firstWorkspaceId, 'request-fallback-0002'), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.code, 'RESOURCE_NOT_FOUND');
    return true;
  });
});

test('viewer is read-only while logout remains available, and model configuration requires admin', async t => {
  const viewer = await fixture('viewer'); t.after(() => viewer.app.close());
  const viewerLogin = await viewer.app.inject({ method: 'POST', url: '/api/auth/login', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
  }, payload: { email: 'owner@example.com', password: 'correct horse battery staple' } });
  const viewerJar = cookieJar(viewerLogin);
  assert.equal((await viewer.app.inject({ url: '/api/projects', headers: {
    ...baseHeaders, cookie: viewerJar,
  } })).statusCode, 200);
  const viewerWrite = await viewer.app.inject({ method: 'POST', url: '/api/model-calls', headers: {
    ...baseHeaders, cookie: viewerJar, 'x-shortdrama-call': '1', 'x-csrf-token': csrf(viewerJar),
    'content-type': 'application/json',
  }, payload: {} });
  assert.equal(viewerWrite.statusCode, 403);
  assert.equal(viewerWrite.json().error.code, 'AUTH_FORBIDDEN');
  assert.equal((await viewer.app.inject({ method: 'POST', url: '/api/auth/logout', headers: {
    ...baseHeaders, cookie: viewerJar, 'x-shortdrama-call': '1', 'x-csrf-token': csrf(viewerJar),
  } })).statusCode, 200);

  const member = await fixture('member'); t.after(() => member.app.close());
  const memberLogin = await member.app.inject({ method: 'POST', url: '/api/auth/login', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
  }, payload: { email: 'owner@example.com', password: 'correct horse battery staple' } });
  const memberJar = cookieJar(memberLogin);
  const modelWrite = await member.app.inject({ method: 'POST', url: '/api/model-profiles', headers: {
    ...baseHeaders, cookie: memberJar, 'x-shortdrama-call': '1', 'x-csrf-token': csrf(memberJar),
    'content-type': 'application/json',
  }, payload: {} });
  assert.equal(modelWrite.statusCode, 403);
  assert.equal(modelWrite.json().error.code, 'AUTH_FORBIDDEN');
});

test('legacy mode is explicit and public origins must be safe', async t => {
  const app = await createApp(readConfig({}), fetch); t.after(() => app.close());
  const session = await app.inject({ url: '/api/auth/session', headers: baseHeaders });
  assert.equal(session.statusCode, 503);
  assert.equal(session.json().error.code, 'AUTH_NOT_CONFIGURED');
  const workspaces = await app.inject({ url: '/api/workspaces', headers: baseHeaders });
  assert.equal(workspaces.json().legacyMode, true);

  assert.equal(readConfig({ LYRA_AUTH_MODE: 'session', LYRA_PUBLIC_ORIGIN: 'https://studio.example.com' }).sessionCookieSecure, true);
  for (const env of [
    { LYRA_AUTH_MODE: 'unknown' },
    { LYRA_SESSION_TTL_SECONDS: '1' },
    { LYRA_PUBLIC_ORIGIN: 'http://studio.example.com' },
    { LYRA_PUBLIC_ORIGIN: 'https://user:secret@studio.example.com' },
    { LYRA_PUBLIC_ORIGIN: 'https://studio.example.com/path' },
    { LYRA_PUBLIC_ORIGIN: 'https://studio.example.com', LYRA_COOKIE_DOMAIN: 'other.example.net' },
  ]) assert.throws(() => readConfig(env));
});
