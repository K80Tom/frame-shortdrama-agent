import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());

const auth = await server.ssrLoadModule('/src/auth.ts');
const deployment = await server.ssrLoadModule('/src/deployment.ts');
const { LoginView, SessionControlView } = await server.ssrLoadModule('/src/AuthBoundary.tsx');

const sessionPayload = {
  authenticated: true,
  user: { id: 'usr_0123456789abcdef0123456789abcdef', displayName: '林导演' },
  workspaces: [
    { id: 'ws_0123456789abcdef0123456789abcdef', name: '制作组', slug: 'production', role: 'owner' },
    { id: 'ws_fedcba9876543210fedcba9876543210', name: '实验室', slug: 'lab', role: 'viewer' },
  ],
  currentWorkspaceId: 'ws_0123456789abcdef0123456789abcdef',
};

test('authenticated session parser binds the user to an allowed current workspace', () => {
  const session = auth.parseAuthSession(sessionPayload);
  assert.equal(session.user.displayName, '林导演');
  assert.equal(session.workspaces[1].role, 'viewer');
  const directory = auth.sessionWorkspaceDirectory(session);
  assert.equal(directory.currentWorkspaceId, sessionPayload.currentWorkspaceId);
  assert.deepEqual(directory.items.map(item => item.legacy), [false, false]);
  assert.equal(directory.items[0].role, 'owner');

  assert.throws(() => auth.parseAuthSession({ ...sessionPayload, currentWorkspaceId: 'ws_not_allowed' }), error =>
    error instanceof auth.AuthApiError && error.kind === 'invalid');
  assert.throws(() => auth.parseAuthSession({ ...sessionPayload, authenticated: false }), error =>
    error instanceof auth.AuthApiError && error.kind === 'invalid');
});

test('login validation rejects malformed input without sending it', () => {
  assert.match(auth.validateLoginInput('not-an-email', 'secret'), /邮箱/);
  assert.match(auth.validateLoginInput('user@example.com', ''), /密码/);
  assert.equal(auth.validateLoginInput(' user@example.com ', 'secret'), null);
});

test('auth APIs use the declared endpoints and explicit local mutation marker', async () => {
  const originalFetch = globalThis.fetch;
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const calls = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: 'lyra_csrf=csrf%2Dtoken%2D123' } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => key === deployment.workspaceStorageKey ? sessionPayload.currentWorkspaceId : null,
  } });
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    if (String(input).endsWith('/logout')) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(sessionPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    assert.equal((await auth.fetchAuthSession()).authenticated, true);
    const loggedIn = await auth.loginWithPassword(' user@example.com ', 'correct horse battery staple');
    assert.equal(loggedIn.currentWorkspaceId, sessionPayload.currentWorkspaceId);
    await auth.logoutAuthSession();

    assert.deepEqual(calls.map(call => call.input), ['/api/auth/session', '/api/auth/login', '/api/auth/logout']);
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[1].init.method, 'POST');
    assert.equal(new Headers(calls[0].init.headers).get('X-Workspace-Id'), sessionPayload.currentWorkspaceId);
    const loginHeaders = new Headers(calls[1].init.headers);
    assert.equal(loginHeaders.get('X-Shortdrama-Call'), '1');
    assert.equal(loginHeaders.has('X-Workspace-Id'), false, 'a stale tenant selection must not affect login');
    assert.equal(loginHeaders.has('X-CSRF-Token'), false, 'login uses the explicit mutation marker before a session exists');
    assert.deepEqual(JSON.parse(calls[1].init.body), { email: 'user@example.com', password: 'correct horse battery staple' });
    const logoutHeaders = new Headers(calls[2].init.headers);
    assert.equal(logoutHeaders.get('X-Shortdrama-Call'), '1');
    assert.equal(logoutHeaders.get('X-Workspace-Id'), sessionPayload.currentWorkspaceId);
    assert.equal(logoutHeaders.get('X-CSRF-Token'), 'csrf-token-123');
  } finally {
    globalThis.fetch = originalFetch;
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor); else delete globalThis.document;
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor); else delete globalThis.localStorage;
  }
});

test('AUTH_NOT_CONFIGURED is distinct from an unauthenticated session', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'AUTH_NOT_CONFIGURED', message: 'disabled' } }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
    await assert.rejects(auth.fetchAuthSession(), error => error instanceof auth.AuthApiError
      && error.kind === 'not-configured' && error.code === 'AUTH_NOT_CONFIGURED');

    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: '请登录' } }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
    await assert.rejects(auth.fetchAuthSession(), error => error instanceof auth.AuthApiError
      && error.kind === 'unauthenticated' && error.status === 401);
  } finally { globalThis.fetch = originalFetch; }
});

test('session recovery can deliberately bypass a stale selected workspace', async () => {
  const originalFetch = globalThis.fetch;
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const captured = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => key === deployment.workspaceStorageKey ? 'ws_fedcba9876543210fedcba9876543210' : null,
  } });
  globalThis.fetch = async (_input, init = {}) => {
    captured.push(new Headers(init.headers));
    return new Response(JSON.stringify(sessionPayload), { status: 200,
      headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await auth.fetchAuthSession();
    await auth.fetchAuthSession(undefined, false);
    assert.equal(captured[0].get('X-Workspace-Id'), 'ws_fedcba9876543210fedcba9876543210');
    assert.equal(captured[1].has('X-Workspace-Id'), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else delete globalThis.localStorage;
  }
});

test('every mutating API request adds workspace and CSRF context without overriding explicit headers', async () => {
  const originalFetch = globalThis.fetch;
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const captured = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: 'other=1; lyra_csrf=csrf%2Dtoken%2D123' } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://lyra.example.com' } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => key === deployment.workspaceStorageKey ? sessionPayload.currentWorkspaceId : null } });
  globalThis.fetch = async (input, init = {}) => { captured.push({ input, init }); return new Response(null, { status: 204 }); };
  try {
    await deployment.workspaceFetch('/api/save', { method: 'POST', headers: { 'X-Shortdrama-Call': '1' } });
    await deployment.workspaceFetch('/api/read', { method: 'GET' });
    await deployment.workspaceFetch('/api/explicit', { method: 'POST', headers: { 'X-CSRF-Token': 'explicit-token' } });
    await deployment.workspaceFetch('/api/patch', { method: 'PATCH' });
    await deployment.workspaceFetch('https://lyra.example.com/api/same-origin', { method: 'POST' });
    await deployment.workspaceFetch('https://attacker.invalid/api/collect', { method: 'POST' });
    const post = new Headers(captured[0].init.headers);
    assert.equal(post.get('X-Workspace-Id'), sessionPayload.currentWorkspaceId);
    assert.equal(post.get('X-CSRF-Token'), 'csrf-token-123');
    assert.equal(post.get('X-Shortdrama-Call'), '1');
    assert.equal(new Headers(captured[1].init.headers).has('X-CSRF-Token'), false);
    assert.equal(new Headers(captured[2].init.headers).get('X-CSRF-Token'), 'explicit-token');
    assert.equal(new Headers(captured[3].init.headers).get('X-CSRF-Token'), 'csrf-token-123');
    assert.equal(new Headers(captured[4].init.headers).get('X-Workspace-Id'), sessionPayload.currentWorkspaceId);
    assert.equal(new Headers(captured[4].init.headers).get('X-CSRF-Token'), 'csrf-token-123');
    assert.equal(new Headers(captured[5].init.headers).has('X-Workspace-Id'), false);
    assert.equal(new Headers(captured[5].init.headers).has('X-CSRF-Token'), false);
    assert.equal(deployment.readCsrfToken('lyra_csrf=too%20short'), null);
  } finally {
    globalThis.fetch = originalFetch;
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor); else delete globalThis.document;
    if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor); else delete globalThis.location;
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor); else delete globalThis.localStorage;
  }
});

test('login and session controls expose honest loading, error, logout, and legacy states', () => {
  const errorHtml = renderToStaticMarkup(createElement(LoginView, { busy: false, error: '账号或密码错误', async onLogin() {} }));
  assert.match(errorHtml, /type="email"/);
  assert.match(errorHtml, /type="password"/);
  assert.match(errorHtml, /账号或密码错误/);
  assert.match(errorHtml, /HttpOnly Cookie/);
  const busyHtml = renderToStaticMarkup(createElement(LoginView, { busy: true, error: '', async onLogin() {} }));
  assert.match(busyHtml, /正在验证/);
  assert.match(busyHtml, /disabled=""/);

  const authenticated = renderToStaticMarkup(createElement(SessionControlView, { mode: 'authenticated', session: auth.parseAuthSession(sessionPayload), busy: false, error: '', onLogout() {} }));
  assert.match(authenticated, /林导演/);
  assert.match(authenticated, /退出/);
  const legacy = renderToStaticMarkup(createElement(SessionControlView, { mode: 'legacy', session: null, busy: false, error: '', onLogout() {} }));
  assert.match(legacy, /Legacy/);
  assert.match(legacy, /未登录/);
  assert.doesNotMatch(legacy, /已登录/);
});
