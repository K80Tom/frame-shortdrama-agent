const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const { AuthService, passwordHash } = require('../dist/auth/service');
const { PostgresAuthRepository, RegistrationNotReadyError, insertBootstrapAdmin } = require('../dist/auth/repository');
const { tenantExecutionScope } = require('../dist/tenancy/scope');
const { LEGACY_WORKSPACE_ID } = require('../dist/tenancy/context');

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
async function fixture(role = 'owner', rateLimiter, options = {}) {
  const salt = '3'.repeat(32);
  const sessions = new Map();
  const registrations = [];
  const registrationMemberships = new Map();
  const registrationCredentials = new Map();
  const fixtureWorkspaceId = options.workspaceId ?? workspaceId;
  const repository = {
    async findCredential(email) {
      if (email === 'owner@example.com') return {
        userId,
        displayName: 'Owner',
        passwordSalt: salt,
        passwordHash: await passwordHash('correct horse battery staple', salt),
        passwordAlgorithm: 'scrypt-v1',
      };
      return registrationCredentials.get(email) ?? null;
    },
    async listWorkspaces(id) {
      return id === userId ? [{ id: fixtureWorkspaceId, slug: 'main-studio', name: 'Main studio', role }]
        : registrationMemberships.get(id) ?? [];
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
    async createRegistration(input) {
      if (options.registrationError) throw options.registrationError;
      if (registrationCredentials.has(input.email)) {
        const error = new Error('unique violation'); error.code = '23505'; throw error;
      }
      registrations.push(input);
      registrationMemberships.set(input.userId, [{ id: input.workspaceId, slug: input.workspaceSlug,
        name: input.workspaceName, role: 'owner' }]);
      registrationCredentials.set(input.email, { userId: input.userId, displayName: input.displayName,
        passwordSalt: input.passwordSalt, passwordHash: input.passwordHash, passwordAlgorithm: 'scrypt-v1' });
      sessions.set(input.session.tokenHash, { ...input.session, displayName: input.displayName, revokedAt: null });
    },
  };
  const authService = new AuthService(repository, {
    sessionTtlSeconds: 3600,
    registrationMode: options.registrationMode ?? 'disabled',
    now: () => new Date('2026-11-08T00:00:00.000Z'),
  });
  const config = readConfig({ LYRA_AUTH_MODE: 'session',
    LYRA_REGISTRATION_MODE: options.registrationMode ?? 'disabled' });
  let observedScope;
  const breakdownService = {
    async listProjects() { observedScope = tenantExecutionScope.current(); return []; },
  };
  const app = await createApp(config, fetch, { authService, breakdownService, rateLimiter,
    registrationRateLimiter: options.registrationRateLimiter });
  return { app, registrations, observedScope: () => observedScope };
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

const registrationPayload = {
  displayName: '林导演',
  email: 'new-owner@example.com',
  password: 'correct horse battery staple',
  workspaceName: '星河片场',
};

test('registration config is public but registration remains an explicit opt-in', async t => {
  const allow = { async consume() { return { allowed: true, remaining: 2, retryAfterSeconds: 3600 }; } };
  const disabled = await fixture('owner', undefined, { registrationRateLimiter: allow });
  t.after(() => disabled.app.close());
  const disabledConfig = await disabled.app.inject({ url: '/api/auth/config', headers: baseHeaders });
  assert.equal(disabledConfig.statusCode, 200);
  assert.deepEqual(disabledConfig.json(), { registrationMode: 'disabled' });
  const disabledRegistration = await disabled.app.inject({ method: 'POST', url: '/api/auth/register', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
  }, payload: registrationPayload });
  assert.equal(disabledRegistration.statusCode, 403);
  assert.equal(disabledRegistration.json().error.code, 'AUTH_REGISTRATION_DISABLED');

  const enabled = await fixture('owner', undefined, { registrationMode: 'workspace' });
  t.after(() => enabled.app.close());
  const enabledConfig = await enabled.app.inject({ url: '/api/auth/config', headers: baseHeaders });
  assert.equal(enabledConfig.statusCode, 200);
  assert.deepEqual(enabledConfig.json(), { registrationMode: 'workspace' });
});

test('registration fails closed without the dedicated distributed limiter', async t => {
  const { app, registrations } = await fixture('owner', undefined, { registrationMode: 'workspace' });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
  }, payload: registrationPayload });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'RATE_LIMIT_UNAVAILABLE');
  assert.equal(registrations.length, 0);
});

test('registration enforces three attempts per source IP per hour before password hashing', async t => {
  const calls = [];
  const limiter = { async consume(key, limit, windowSeconds) {
    calls.push({ key, limit, windowSeconds });
    return { allowed: false, remaining: 0, retryAfterSeconds: 901 };
  } };
  const { app, registrations } = await fixture('owner', undefined, {
    registrationMode: 'workspace', registrationRateLimiter: limiter,
  });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
    'x-forwarded-for': '198.51.100.24',
  }, payload: registrationPayload });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['retry-after'], '901');
  assert.equal(registrations.length, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].key, /^register:[a-f0-9]{64}$/u);
  assert.deepEqual({ limit: calls[0].limit, windowSeconds: calls[0].windowSeconds },
    { limit: 3, windowSeconds: 3600 });
});

test('registration fails closed when the distributed limiter errors', async t => {
  const limiter = { async consume() { throw new Error('redis unavailable'); } };
  const { app, registrations } = await fixture('owner', undefined, {
    registrationMode: 'workspace', registrationRateLimiter: limiter,
  });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
  }, payload: registrationPayload });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'RATE_LIMIT_UNAVAILABLE');
  assert.equal(registrations.length, 0);
});

test('registration waits for explicit control-workspace bootstrap', async t => {
  const limiter = { async consume() { return { allowed: true, remaining: 2, retryAfterSeconds: 3600 }; } };
  const { app, registrations } = await fixture('owner', undefined, {
    registrationMode: 'workspace', registrationRateLimiter: limiter,
    registrationError: new RegistrationNotReadyError(),
  });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
  }, payload: registrationPayload });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'AUTH_REGISTRATION_NOT_READY');
  assert.equal(registrations.length, 0);
});

test('workspace registration validates its strict contract, issues a session, and restores owner membership', async t => {
  const limiter = { async consume() { return { allowed: true, remaining: 2, retryAfterSeconds: 3600 }; } };
  const { app, registrations } = await fixture('owner', undefined, {
    registrationMode: 'workspace', registrationRateLimiter: limiter,
  });
  t.after(() => app.close());

  const missingMarker = await app.inject({ method: 'POST', url: '/api/auth/register', headers: {
    ...baseHeaders, 'content-type': 'application/json',
  }, payload: registrationPayload });
  assert.equal(missingMarker.statusCode, 403);
  const wrongOrigin = await app.inject({ method: 'POST', url: '/api/auth/register', headers: {
    ...baseHeaders, origin: 'https://attacker.invalid', 'x-shortdrama-call': '1',
    'content-type': 'application/json',
  }, payload: registrationPayload });
  assert.equal(wrongOrigin.statusCode, 403);
  const unknown = await app.inject({ method: 'POST', url: '/api/auth/register', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
  }, payload: { ...registrationPayload, role: 'admin' } });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.json().error.code, 'AUTH_INPUT_INVALID');
  const short = await app.inject({ method: 'POST', url: '/api/auth/register', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
  }, payload: { ...registrationPayload, password: 'too-short' } });
  assert.equal(short.statusCode, 400);

  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
  }, payload: registrationPayload });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().user.displayName, registrationPayload.displayName);
  assert.equal(response.json().workspaces.length, 1);
  assert.equal(response.json().workspaces[0].role, 'owner');
  assert.equal(response.json().currentWorkspaceId, response.json().workspaces[0].id);
  assert.equal(registrations.length, 1);
  assert.equal('password' in registrations[0], false);
  assert.match(registrations[0].passwordHash, /^[a-f0-9]{128}$/u);
  assert.notEqual(registrations[0].passwordHash, registrationPayload.password);
  const cookies = Array.isArray(response.headers['set-cookie'])
    ? response.headers['set-cookie'] : [response.headers['set-cookie']];
  assert.match(cookies.find(value => value.startsWith('lyra_session=')), /HttpOnly/u);
  assert.doesNotMatch(cookies.find(value => value.startsWith('lyra_csrf=')), /HttpOnly/u);
  const restored = await app.inject({ url: '/api/auth/session', headers: {
    ...baseHeaders, cookie: cookieJar(response),
  } });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().workspaces[0].role, 'owner');
});

test('concurrent duplicate registration exposes one generic conflict and leaves one account', async t => {
  const limiter = { async consume() { return { allowed: true, remaining: 2, retryAfterSeconds: 3600 }; } };
  const { app, registrations } = await fixture('owner', undefined, {
    registrationMode: 'workspace', registrationRateLimiter: limiter,
  });
  t.after(() => app.close());
  const request = () => app.inject({ method: 'POST', url: '/api/auth/register', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
  }, payload: registrationPayload });
  const responses = await Promise.all([request(), request()]);
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [201, 409]);
  const conflict = responses.find(response => response.statusCode === 409).json();
  assert.equal(conflict.error.code, 'AUTH_REGISTRATION_CONFLICT');
  assert.doesNotMatch(conflict.error.message, /email|new-owner|already|exists/iu);
  assert.equal(registrations.length, 1);
});

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

test('new workspace owners cannot mutate deployment-wide model connections', async t => {
  const tenantOwner = await fixture('owner'); t.after(() => tenantOwner.app.close());
  const tenantLogin = await tenantOwner.app.inject({ method: 'POST', url: '/api/auth/login', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
  }, payload: { email: 'owner@example.com', password: 'correct horse battery staple' } });
  const tenantJar = cookieJar(tenantLogin);
  const denied = await tenantOwner.app.inject({ method: 'POST', url: '/api/model-profiles', headers: {
    ...baseHeaders, cookie: tenantJar, 'x-shortdrama-call': '1', 'x-csrf-token': csrf(tenantJar),
    'content-type': 'application/json',
  }, payload: {} });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, 'AUTH_FORBIDDEN');

  const controlOwner = await fixture('owner', undefined, { workspaceId: LEGACY_WORKSPACE_ID });
  t.after(() => controlOwner.app.close());
  const controlLogin = await controlOwner.app.inject({ method: 'POST', url: '/api/auth/login', headers: {
    ...baseHeaders, 'x-shortdrama-call': '1', 'content-type': 'application/json',
  }, payload: { email: 'owner@example.com', password: 'correct horse battery staple' } });
  const controlJar = cookieJar(controlLogin);
  const passedAuthorization = await controlOwner.app.inject({ method: 'POST', url: '/api/model-profiles', headers: {
    ...baseHeaders, cookie: controlJar, 'x-shortdrama-call': '1', 'x-csrf-token': csrf(controlJar),
    'content-type': 'application/json',
  }, payload: {} });
  assert.notEqual(passedAuthorization.statusCode, 403);
  assert.notEqual(passedAuthorization.json().error?.code, 'AUTH_FORBIDDEN');
});

test('postgres registration writes user, workspace, owner membership, credential and session in one system transaction', async () => {
  const trace = [];
  let transactionCount = 0;
  const database = {
    runAsSystem(reason, work) { trace.push({ kind: 'scope', reason }); return work(); },
    async transaction(work) {
      transactionCount += 1;
      return work({ async query(sql, values) {
        trace.push({ kind: 'query', sql: sql.replace(/\s+/gu, ' ').trim(), values });
        if (sql.includes('SELECT id') && sql.includes('FROM workspaces')) {
          return { rows: [{ id: LEGACY_WORKSPACE_ID }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      } });
    },
  };
  const repository = new PostgresAuthRepository(database);
  await repository.createRegistration({
    userId: `usr_${'a'.repeat(32)}`,
    workspaceId: `ws_${'b'.repeat(32)}`,
    email: 'registered@example.com',
    displayName: 'Registered owner',
    workspaceName: 'Registered studio',
    workspaceSlug: 'studio-registered',
    passwordSalt: 'c'.repeat(32),
    passwordHash: 'd'.repeat(128),
    session: {
      id: `ses_${'e'.repeat(32)}`,
      tokenHash: 'f'.repeat(64),
      csrfHash: '1'.repeat(64),
      userId: `usr_${'a'.repeat(32)}`,
      currentWorkspaceId: `ws_${'b'.repeat(32)}`,
      createdAt: '2026-11-08T00:00:00.000Z',
      expiresAt: '2026-11-09T00:00:00.000Z',
    },
  });
  assert.equal(transactionCount, 1);
  assert.deepEqual(trace[0], { kind: 'scope', reason: 'auth.registration' });
  const statements = trace.filter(item => item.kind === 'query').map(item => item.sql);
  assert.equal(statements.filter(sql => sql.startsWith('INSERT INTO')).length, 5);
  assert.ok(statements.some(sql => sql.startsWith('INSERT INTO users')));
  assert.ok(statements.some(sql => sql.startsWith('INSERT INTO workspaces')));
  assert.ok(statements.some(sql => sql.startsWith('INSERT INTO workspace_members')));
  assert.ok(statements.some(sql => sql.startsWith('INSERT INTO user_credentials')));
  assert.ok(statements.some(sql => sql.startsWith('INSERT INTO auth_sessions')));
});

test('postgres registration refuses to create an orphan tenant before the control workspace is bootstrapped', async () => {
  let insertCount = 0;
  const database = {
    runAsSystem(_reason, work) { return work(); },
    async transaction(work) {
      return work({ async query(sql) {
        if (sql.includes('INSERT INTO')) insertCount += 1;
        return { rows: [], rowCount: 0 };
      } });
    },
  };
  const repository = new PostgresAuthRepository(database);
  await assert.rejects(repository.createRegistration({
    userId: `usr_${'a'.repeat(32)}`,
    workspaceId: `ws_${'b'.repeat(32)}`,
    email: 'registered@example.com',
    displayName: 'Registered owner',
    workspaceName: 'Registered studio',
    workspaceSlug: 'studio-registered',
    passwordSalt: 'c'.repeat(32),
    passwordHash: 'd'.repeat(128),
    session: {
      id: `ses_${'e'.repeat(32)}`,
      tokenHash: 'f'.repeat(64),
      csrfHash: '1'.repeat(64),
      userId: `usr_${'a'.repeat(32)}`,
      currentWorkspaceId: `ws_${'b'.repeat(32)}`,
      createdAt: '2026-11-08T00:00:00.000Z',
      expiresAt: '2026-11-09T00:00:00.000Z',
    },
  }), error => error instanceof RegistrationNotReadyError);
  assert.equal(insertCount, 0);
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
    { LYRA_REGISTRATION_MODE: 'workspace' },
    { LYRA_AUTH_MODE: 'session', LYRA_REGISTRATION_MODE: 'open' },
    { LYRA_SESSION_TTL_SECONDS: '1' },
    { LYRA_PUBLIC_ORIGIN: 'http://studio.example.com' },
    { LYRA_PUBLIC_ORIGIN: 'https://user:secret@studio.example.com' },
    { LYRA_PUBLIC_ORIGIN: 'https://studio.example.com/path' },
    { LYRA_PUBLIC_ORIGIN: 'https://studio.example.com', LYRA_COOKIE_DOMAIN: 'other.example.net' },
  ]) assert.throws(() => readConfig(env));
});
