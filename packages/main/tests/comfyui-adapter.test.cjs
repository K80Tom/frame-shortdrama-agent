const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ComfyUiNativeClient, ComfyUiError, resolveComfyUiBaseUrl } =
  require('../dist/models/comfyui/native-client');
const { ComfyUiWorkflowValidator } = require('../dist/models/comfyui/workflow-validation');
const { ComfyUiGenerationAdapter } = require('../dist/models/comfyui/generation');
const { InMemoryPaidGenerationInterceptor } = require('../dist/budget/paid-generation');

const WS = `ws_${'b'.repeat(32)}`;
const VERSION = '0.3.40';

function json(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function client(fetch) {
  return new ComfyUiNativeClient({ baseUrl: 'http://127.0.0.1:8188', fetch, timeoutMs: 2_000 });
}

test('native ComfyUI client reads version, Jobs API capability and object_info', async () => {
  const calls = [];
  const c = client(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/system_stats')) return json({ system: { comfyui_version: VERSION } });
    if (url.endsWith('/features')) return json({ jobs_api: true });
    if (url.includes('/api/jobs/')) return new Response(JSON.stringify({ error: 'Job not found' }), { status: 404 });
    if (url.includes('/object_info/KSampler')) return json({ KSampler: { input: {
      required: { model: [['model-a.safetensors', 'model-b.safetensors'], {}], seed: ['INT', {}] },
    } } });
    throw new Error(`unexpected ${url}`);
  });
  const report = await c.testConnection();
  assert.equal(report.comfyuiVersion, VERSION);
  assert.equal(report.jobsApi, true);
  const node = await c.getNodeInfo('KSampler');
  assert.equal(node.classType, 'KSampler');
  assert.deepEqual(node.input.required.model[0], ['model-a.safetensors', 'model-b.safetensors']);
  assert.equal(calls[0].init.headers.accept, 'application/json');
});

test('native ComfyUI URL rejects remote HTTP, credentials and query strings', async () => {
  await assert.rejects(resolveComfyUiBaseUrl('http://comfyui.example.test:8188'),
    error => error instanceof ComfyUiError && error.code === 'COMFYUI_BASE_URL_INVALID');
  await assert.rejects(resolveComfyUiBaseUrl('http://user:pass@127.0.0.1:8188'),
    error => error instanceof ComfyUiError && error.code === 'COMFYUI_BASE_URL_INVALID');
  await assert.rejects(resolveComfyUiBaseUrl('https://comfyui.example.test?token=x', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  }), error => error instanceof ComfyUiError && error.code === 'COMFYUI_BASE_URL_INVALID');
  await assert.rejects(resolveComfyUiBaseUrl('https://comfyui.example.test', {
    lookup: async () => [{ address: '10.0.0.2', family: 4 }],
  }), error => error instanceof ComfyUiError && error.code === 'COMFYUI_BASE_URL_INVALID');
  assert.equal(await resolveComfyUiBaseUrl('http://127.0.0.1:8188/'), 'http://127.0.0.1:8188');
});

test('workflow validator reports missing classes and enum model drift', async () => {
  const validator = new ComfyUiWorkflowValidator({
    getNodeInfo: async classType => classType === 'KSampler'
      ? { classType, input: { required: { model: [['model-a.safetensors'], {}], seed: ['INT', {}] } } }
      : Promise.reject(new Error('missing')),
  });
  const valid = await validator.validate({ 1: { class_type: 'KSampler',
    inputs: { model: 'model-a.safetensors', seed: 1 } } });
  assert.equal(valid.valid, true);
  assert.equal(valid.checkedNodeCount, 1);
  const invalid = await validator.validate({ 1: { class_type: 'KSampler',
    inputs: { model: 'not-installed.safetensors', seed: 1 } } });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.invalidModelInputs.length, 1);
  const missing = await validator.validate({ 1: { class_type: 'KSampler', inputs: {} },
    2: { class_type: 'MissingNode', inputs: {} } });
  assert.equal(missing.valid, false);
  assert.deepEqual(missing.missingNodeClasses, ['MissingNode']);
});

test('ComfyUI generation reserves before /prompt and blocks a budget-short request', async () => {
  let promptCalls = 0;
  const c = client(async (url, init) => {
    if (url.includes('/object_info/KSampler')) return json({ KSampler: { input: { required: {
      model: [['model-a.safetensors']],
    } } } });
    if (url.endsWith('/prompt')) { promptCalls += 1; return json({ prompt_id: 'prompt-12345678', number: 1, node_errors: {} }); }
    throw new Error(`unexpected ${url}`);
  });
  const validator = new ComfyUiWorkflowValidator(c);
  const ledger = new InMemoryPaidGenerationInterceptor();
  const adapter = new ComfyUiGenerationAdapter(c, validator, ledger);
  const base = { workspaceId: WS, operationKey: 'comfy:shot-1', clientRequestId: 'comfy-req-1',
    model: 'sdxl', prompt: '雨夜旧桥', workflow: { 1: { class_type: 'KSampler', inputs: { model: 'model-a.safetensors' } } },
    estimateMicros: 10_000, budgetLimitMicros: 10_000, currency: 'CNY' };
  await assert.rejects(adapter.submit({ ...base, budgetLimitMicros: 1 }),
    error => error.code === 'COMFYUI_GENERATION_REQUEST_INVALID');
  assert.equal(promptCalls, 0);
  const accepted = await adapter.submit(base);
  assert.equal(accepted.promptId, 'prompt-12345678');
  assert.equal(promptCalls, 1);
  await assert.rejects(adapter.submit(base), error => error.code === 'BUDGET_RESERVATION_NOT_OPEN');
  assert.equal(promptCalls, 1);
  const occupied = new InMemoryPaidGenerationInterceptor();
  await occupied.reserve({ workspaceId: WS, operationKey: 'comfy:other', provider: 'comfyui', model: 'sdxl',
    estimateMicros: 950_000, budgetLimitMicros: 1_000_000, currency: 'CNY' });
  const short = new ComfyUiGenerationAdapter(c, validator, occupied);
  await assert.rejects(short.submit({ ...base, operationKey: 'comfy:short', budgetLimitMicros: 1_000_000,
    estimateMicros: 100_000 }), error => error.code === 'BUDGET_EXCEEDED');
});

test('ComfyUI prompt node errors release the hold, while upstream 5xx keeps it unknown', async () => {
  const workflow = { 1: { class_type: 'KSampler', inputs: { model: 'model-a.safetensors' } } };
  const validator = new ComfyUiWorkflowValidator({ getNodeInfo: async classType => ({
    classType, input: { required: { model: [['model-a.safetensors']] } },
  }) });
  const ledger = new InMemoryPaidGenerationInterceptor();
  let mode = 'node-errors';
  const c = { submitPrompt: async () => {
    if (mode === 'node-errors') return { promptId: 'prompt-12345678', number: 1, nodeErrors: ['1'] };
    if (mode === 'http-400') throw new ComfyUiError(400, 'COMFYUI_UPSTREAM_ERROR', 'bad workflow');
    if (mode === 'http-429') throw new ComfyUiError(429, 'COMFYUI_UPSTREAM_ERROR', 'rate limited');
    throw new ComfyUiError(502, 'COMFYUI_UPSTREAM_ERROR', 'upstream');
  } };
  const adapter = new ComfyUiGenerationAdapter(c, validator, ledger);
  const request = { workspaceId: WS, operationKey: 'comfy:shot-2', clientRequestId: 'comfy-req-2',
    model: 'sdxl', prompt: 'x', workflow, estimateMicros: 1_000, budgetLimitMicros: 1_000, currency: 'CNY' };
  await assert.rejects(adapter.submit(request), error => error.code === 'COMFYUI_NODE_ERRORS');
  const afterRelease = await ledger.reserve({ ...request, operationKey: 'comfy:shot-2',
    provider: 'comfyui', model: 'sdxl', estimateMicros: 1_000, budgetLimitMicros: 1_000, currency: 'CNY' });
  assert.equal(afterRelease.status, 'released');
  mode = 'upstream';
  await assert.rejects(adapter.submit({ ...request, operationKey: 'comfy:shot-3', clientRequestId: 'comfy-req-3' }),
    error => error.code === 'COMFYUI_SUBMIT_UNCERTAIN');
  const unknown = await ledger.reserve({ ...request, operationKey: 'comfy:shot-3', provider: 'comfyui',
    model: 'sdxl', estimateMicros: 1_000, budgetLimitMicros: 1_000, currency: 'CNY' });
  assert.equal(unknown.status, 'unknown');
  mode = 'http-400';
  const expanded = { ...request, budgetLimitMicros: 2_000 };
  await assert.rejects(adapter.submit({ ...expanded, operationKey: 'comfy:shot-4', clientRequestId: 'comfy-req-4' }),
    error => error.code === 'COMFYUI_UPSTREAM_ERROR');
  assert.equal((await ledger.reserve({ ...expanded, operationKey: 'comfy:shot-4', provider: 'comfyui',
    model: 'sdxl', estimateMicros: 1_000, budgetLimitMicros: 2_000, currency: 'CNY' })).status, 'released');
  mode = 'http-429';
  await assert.rejects(adapter.submit({ ...expanded, operationKey: 'comfy:shot-5', clientRequestId: 'comfy-req-5' }),
    error => error.code === 'COMFYUI_SUBMIT_UNCERTAIN');
  assert.equal((await ledger.reserve({ ...expanded, operationKey: 'comfy:shot-5', provider: 'comfyui',
    model: 'sdxl', estimateMicros: 1_000, budgetLimitMicros: 2_000, currency: 'CNY' })).status, 'unknown');
});
