const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const { MODELS } = require('../dist/models/registry');
const { ModelClient } = require('../dist/models/client');
const { parseCall } = require('@ohao/shared');

const modelEnv = { LLM_BASE_URL: 'https://model.test/openai', LLM_API_KEY: 'test-only-api-key' };
const config = readConfig(modelEnv);
const modelId = 'deepseek-v4.1-flash-1017';
const headers = { host: '127.0.0.1:8788', 'x-shortdrama-call': '1' };
const input = (overrides = {}) => ({ messages: [{ role: 'user', content: 'hello' }], allowPaid: true, ...overrides });
const completion = (changes = {}) => ({ id: 'chatcmpl-test', model: modelId,
  choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }, ...changes });
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('registry exposes only the MAAS text model without invented context or reasoning capabilities', () => {
  assert.equal(MODELS.length, 1);
  assert.equal(MODELS[0].id, modelId);
  assert.equal(MODELS[0].imageInput, false);
  assert.equal(MODELS[0].configuredContextTokens, null);
  assert.deepEqual(MODELS[0].reasoningEfforts, ['model-default']);
  assert.equal(MODELS[0].defaultReasoningEffort, 'model-default');
});

test('unconfigured defaults cannot fall back to the removed proxy; remote configuration requires clean HTTPS', () => {
  const defaults = readConfig({});
  assert.equal(defaults.provider, 'maas');
  assert.equal(defaults.baseUrl, '');
  assert.equal(defaults.apiKey, '');
  assert.equal(defaults.defaultModel, modelId);
  assert.equal(defaults.reasoningEffort, 'model-default');
  assert.equal(config.baseUrl, modelEnv.LLM_BASE_URL);
  assert.equal(config.apiKey, modelEnv.LLM_API_KEY);
  assert.equal(readConfig({ ...modelEnv, LLM_BASE_URL: `${modelEnv.LLM_BASE_URL}/` }).baseUrl, modelEnv.LLM_BASE_URL);
  for (const env of [
    { PORT: 'bad' }, { LLM_TIMEOUT_MS: '0' }, { LLM_MAX_OUTPUT_TOKENS: '999999' },
    { LLM_BASE_URL: 'http://127.0.0.1:8787/v1' }, { LLM_BASE_URL: 'https://secret@model.test/openai' },
    { LLM_BASE_URL: 'https://model.test/openai?token=secret' }, { LLM_BASE_URL: 'https://model.test/openai#secret' },
    { LLM_DEFAULT_MODEL: 'unknown' }, { LLM_DEFAULT_MODEL: 'gpt-5.6-terra' },
    { LLM_REASONING_EFFORT: 'ultra' }, { LLM_REASONING_EFFORT: 'medium' },
    { LLM_API_KEY: 'test-key\r\nInjected: unsafe' },
  ]) assert.throws(() => readConfig(env));
});

test('MAAS sends api-key, non-streaming text, bounded max_tokens and no reasoning_effort (mock only)', async () => {
  for (const model of MODELS) {
    let called = 0;
    const client = new ModelClient(config, async (url, options) => {
      called++;
      const body = JSON.parse(options.body);
      assert.equal(url, 'https://model.test/openai/chat/completions');
      assert.equal(body.model, model.id);
      assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
      assert.equal(Object.hasOwn(body, 'thinking'), false);
      assert.equal(body.max_tokens, 8192);
      assert.equal(body.stream, false);
      assert.equal(options.headers['api-key'], modelEnv.LLM_API_KEY);
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.redirect, 'error');
      return json(completion({ model: model.id }));
    });
    const result = await client.call(input({ model: model.id }));
    assert.equal(result.requestedModel, model.id);
    assert.equal(result.status, 'completed');
    assert.equal(called, 1);
  }
});

test('model-default is explicit and old reasoning tiers never reach the transport', async () => {
  let calls = 0;
  const client = new ModelClient(config, async (_, options) => {
    calls++;
    assert.equal(Object.hasOwn(JSON.parse(options.body), 'reasoning_effort'), false);
    assert.equal(JSON.parse(options.body).max_tokens, 4096);
    return json(completion());
  });
  assert.equal((await client.call(input({ reasoningEffort: 'model-default', maxOutputTokens: 4096 }))).reasoningEffort, 'model-default');
  for (const reasoningEffort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    await assert.rejects(client.call(input({ reasoningEffort })));
  }
  assert.equal(calls, 1);
});

test('thinking is omitted by default and only explicit disabled is accepted without changing model-default', async () => {
  let calls = 0;
  const client = new ModelClient(config, async (_, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
    return json(completion());
  });
  const result = await client.call(input({ thinking: 'disabled' }));
  assert.equal(result.reasoningEffort, 'model-default');
  for (const thinking of ['enabled', 'auto', null, false, { type: 'disabled' }]) {
    await rejectsCode(client.call(input({ thinking })), 'INVALID_REQUEST');
  }
  assert.equal(calls, 1);
});

test('upstream rejection of explicit disabled thinking does not retry without it or change the model', async () => {
  let calls = 0;
  const client = new ModelClient(config, async (_, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.model, modelId);
    return new Response('unsupported parameter', { status: 400 });
  });
  await rejectsCode(client.call(input({ thinking: 'disabled' })), 'UPSTREAM_ERROR');
  assert.equal(calls, 1);
});

test('reject invalid bodies, images, unknown fields, missing consent before network', async () => {
  let called = 0;
  const client = new ModelClient(config, async () => { called++; return json(completion()); });
  const badBodies = [null, {}, input({ allowPaid: false }), input({ messages: [] }),
    input({ stream: true }), input({ apiKey: 'do-not-forward' }), input({ tools: [] }),
    input({ maxOutputTokens: 1 }), input({ reasoningEffort: 'ultra' }),
    input({ messages: [{ role: 'system', content: 'no user' }] }),
    input({ messages: [{ role: 'user', content: '   ' }] }),
    input({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] }),
    input({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }] }),
  ];
  for (const bad of badBodies) await assert.rejects(client.call(bad));
  await rejectsCode(client.call(input({ model: 'fake' })), 'UNKNOWN_MODEL');
  for (const model of ['gpt-5.6-terra', 'qwen3.7-plus', 'codewiz-qwen3.8-max', 'deepseek-v4.1-flash-ali']) {
    await rejectsCode(client.call(input({ model })), 'UNKNOWN_MODEL');
  }
  assert.equal(called, 0);
});

test('missing URL or key fails before invoking the transport and never substitutes a legacy provider', async () => {
  let calls = 0;
  for (const env of [{}, { LLM_BASE_URL: modelEnv.LLM_BASE_URL }, { LLM_API_KEY: modelEnv.LLM_API_KEY }]) {
    const client = new ModelClient(readConfig(env), async () => { calls++; return json(completion()); });
    await assert.rejects(client.call(input()), error => error.status === 503 && error.code === 'MODEL_NOT_CONFIGURED');
  }
  assert.equal(calls, 0);
});

test('text request size caps and text-only messages apply to direct calls too', () => {
  assert.throws(() => parseCall(input({ messages: [{ role: 'user', content: [
    { type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,test' } },
  ] }] })), e => e.code === 'INVALID_REQUEST');
  assert.throws(() => parseCall(input({ messages: Array.from({ length: 12 }, () => ({ role: 'user', content: 'a'.repeat(1000000) })) })), e => e.code === 'INPUT_TOO_LARGE');
});

test('upstream failures are sanitized and never retried', async () => {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    let calls = 0;
    const client = new ModelClient(config, async () => { calls++; return new Response('secret-token-private-url', { status }); });
    await assert.rejects(client.call(input()), error => {
      assert.equal(error.code, 'UPSTREAM_ERROR');
      assert.equal(error.details.upstreamStatus, status);
      assert.ok(!JSON.stringify(error).includes('secret-token'));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('network failure does not retry', async () => {
  let calls = 0;
  await rejectsCode(new ModelClient(config, async () => { calls++; throw new Error('secret'); }).call(input()), 'PROXY_UNAVAILABLE');
  assert.equal(calls, 1);
});

test('invalid/empty output fails; truncation stays incomplete; usage is normalized', async () => {
  await rejectsCode(new ModelClient(config, async () => new Response('not JSON')).call(input()), 'INVALID_UPSTREAM_RESPONSE');
  await rejectsCode(new ModelClient(config, async () => json({ error: 'secret' })).call(input()), 'INVALID_UPSTREAM_RESPONSE');
  await rejectsCode(new ModelClient(config, async () => json(completion({ choices: [{ message: { content: null }, finish_reason: 'length' }] }))).call(input()), 'EMPTY_OUTPUT');
  await rejectsCode(new ModelClient(config, async () => json(completion({ choices: [{ message: { content: 'x' }, finish_reason: 'tool_calls' }] }))).call(input()), 'UNEXPECTED_FINISH');
  const result = await new ModelClient(config, async () => json(completion({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }))).call(input());
  assert.equal(result.status, 'incomplete');
  assert.ok(result.warnings.length);
  assert.equal(result.usage.totalTokens, 10);
  assert.equal(result.usage.reasoningTokens, null);
});

test('bounded concurrency rejects excess calls and releases capacity', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = new ModelClient({ ...config, maxConcurrentCalls: 1 }, async () => { await gate; return json(completion()); });
  const pending = client.call(input());
  await rejectsCode(client.call(input()), 'LOCAL_BUSY');
  release(); await pending;
  assert.equal((await client.call(input())).status, 'completed');
});

test('timeout also covers reading body, cancels fetch, no automatic retry', async () => {
  let calls = 0;
  let sawAbort = false;
  const client = new ModelClient({ ...config, timeoutMs: 80 }, async (_, options) => {
    calls++;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        options.signal.addEventListener('abort', () => {
          sawAbort = true;
          controller.error(options.signal.reason);
        }, { once: true });
      },
    });
    return new Response(stream, { headers: { 'content-type': 'application/json' } });
  });
  // AbortSignal.timeout() intentionally uses an unref'ed timer in Node.  Keep
  // this deterministic in the test while the response body is stalled.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await rejectsCode(client.call(input()), 'UPSTREAM_TIMEOUT');
    assert.equal(calls, 1);
    assert.equal(sawAbort, true);
  } finally {
    clearInterval(keepAlive);
  }
});

test('HTTP route integration: health/catalog are free, origin/host/header/body guarded', async () => {
  let calls = 0;
  const app = await createApp(config, async () => { calls++; return json(completion()); });
  const server = app.getHttpAdapter().getInstance();
  try {
    const health = await server.inject({ url: '/healthz', headers });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().modelAvailabilityChecked, false);
    const list = await server.inject({ url: '/api/models', headers });
    assert.equal(list.json().models.length, 1); assert.equal(calls, 0);
    for (const response of [health, list]) {
      assert.equal(response.body.includes(modelEnv.LLM_API_KEY), false);
      assert.equal(response.body.includes(modelEnv.LLM_BASE_URL), false);
    }
    for (const blockedHeaders of [{ host: 'evil.example' }, { ...headers, origin: 'https://evil.example' }, { host: '127.0.0.1' }]) {
      const response = await server.inject({ method: 'POST', url: '/api/model-calls', headers: blockedHeaders, payload: input() });
      assert.equal(response.statusCode, 403);
    }
    const invalid = await server.inject({ method: 'POST', url: '/api/model-calls', headers, payload: { bad: true } });
    assert.equal(invalid.statusCode, 400); assert.equal(calls, 0);
    const success = await server.inject({ method: 'POST', url: '/api/model-calls', headers, payload: input() });
    assert.equal(success.statusCode, 200); assert.equal(success.json().text, 'OK'); assert.equal(calls, 1);
    const oversized = await server.inject({ method: 'POST', url: '/api/model-calls', headers, payload: input({ messages: [{ role: 'user', content: 'a'.repeat(11 * 1024 * 1024) }] }) });
    assert.equal(oversized.statusCode, 413); assert.equal(calls, 1);
  } finally { await app.close(); }
});

test('example env contains no credentials and smoke requires explicit paid opt-in', () => {
  const env = readFileSync('.env.example', 'utf8');
  for (const line of env.split(/\r?\n/).filter(line => /^(?:.*KEY|.*TOKEN|.*EMAIL|.*COOKIE)=/.test(line))) {
    assert.equal(line.slice(line.indexOf('=') + 1).trim(), '', 'credential examples must be blank');
  }
  assert.match(env, /^LLM_API_KEY=\s*$/m);
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['scripts/model-smoke.mjs'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--allow-paid/);
});

test('HTTP starts without model credentials but refuses paid calls without contacting any provider', async () => {
  let calls = 0;
  const app = await createApp(readConfig({}), async () => { calls++; throw new Error('must not call'); });
  try {
    for (const url of ['/healthz', '/api/models']) {
      const response = await app.inject({ url, headers });
      assert.equal(response.statusCode, 200);
    }
    const response = await app.inject({ method: 'POST', url: '/api/model-calls', headers, payload: input() });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'MODEL_NOT_CONFIGURED');
    assert.equal(calls, 0);
  } finally { await app.close(); }
});

test('HTTP errors never expose configured keys, private endpoint paths or raw provider errors', async () => {
  const secretConfig = readConfig({ LLM_BASE_URL: 'https://model.test/private-endpoint', LLM_API_KEY: 'test-secret-not-for-output' });
  const rawError = `${secretConfig.apiKey} ${secretConfig.baseUrl} vendor-private-payload`;
  for (const transport of [
    async () => new Response(rawError, { status: 401 }),
    async () => { throw new Error(rawError); },
    async () => new Response(JSON.stringify({ error: rawError })),
    async () => json(completion({ choices: [{ finish_reason: secretConfig.apiKey, message: { content: 'ignored' } }] })),
  ]) {
    const app = await createApp(secretConfig, transport);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/model-calls', headers, payload: input() });
      assert.equal(response.statusCode, 502);
      for (const secret of [secretConfig.apiKey, secretConfig.baseUrl, 'vendor-private-payload']) {
        assert.equal(response.body.includes(secret), false);
      }
    } finally { await app.close(); }
  }
});
