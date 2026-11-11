const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../dist/config');
const { ModelConnections } = require('../dist/models/connections');
const { createApp } = require('../dist/app');
const { MODEL_PRESETS, PROVIDER_CATALOG } = require('../dist/models/presets/catalog');
const { parseModelPresetCatalog, parseProviderCatalog } = require('@lyra/shared');

const base = readConfig({ LLM_BASE_URL: 'https://legacy.test/v1', LLM_API_KEY: 'legacy-test-only' });
const headers = { host: '127.0.0.1:8788', 'x-shortdrama-call': '1' };

async function harness(t) {
  const store = new ModelConnections(base);
  const app = await createApp({ ...base, modelConnections: store }, async () => new Response('{}'));
  t.after(() => app.close());
  const server = app.getHttpAdapter().getInstance();
  const get = url => server.inject({ method: 'GET', url, headers });
  const post = (url, payload) => server.inject({ method: 'POST', url, headers, payload });
  return { store, server, get, post };
}

test('内置目录覆盖 DeepSeek、可灵、MiniMax、通义千问、火山方舟、OpenAI 与即梦，且预设参数完整', () => {
  const ids = PROVIDER_CATALOG.map(provider => provider.id);
  for (const id of ['deepseek', 'kling', 'minimax', 'dashscope', 'volcengine', 'openai', 'jimeng']) {
    assert.equal(ids.includes(id), true, `缺少服务商 ${id}`);
  }
  assert.equal(ids.length, 7);
  const providers = parseProviderCatalog(PROVIDER_CATALOG);
  assert.equal(providers.length, 7);
  const presets = parseModelPresetCatalog(MODEL_PRESETS, providers);
  assert.equal(presets.length, 22);
  assert.equal(new Set(presets.map(preset => preset.code)).size, presets.length);
  for (const preset of presets) {
    const provider = providers.find(item => item.id === preset.providerId);
    assert.ok(provider, `预设 ${preset.code} 的服务商不存在`);
    assert.ok(provider.supportedKinds.includes(preset.kind), `预设 ${preset.code} 的类型与服务商不匹配`);
    assert.match(preset.defaultBaseUrl, /^https:\/\//);
    if (preset.kind === 'text') assert.ok(preset.contextWindow > 0, `文本预设 ${preset.code} 缺少上下文`);
    if (preset.kind === 'video') {
      assert.ok(preset.config?.supportedResolutions?.length > 0, `视频预设 ${preset.code} 缺少分辨率`);
      assert.ok(preset.config?.supportedAspectRatios?.length > 0, `视频预设 ${preset.code} 缺少画幅`);
    }
    assert.equal(JSON.stringify(preset).includes('apiKey'), false);
  }
  const video = presets.find(preset => preset.code === 'doubao-seedance-2-0');
  assert.ok(video.config.minDuration <= video.config.defaultDuration);
  assert.ok(video.config.defaultDuration <= video.config.maxDuration);
});

test('GET /api/provider-catalog 与 /api/model-presets 返回分组目录并支持 kind/modality/providerId 过滤', async t => {
  const { get } = await harness(t);
  const providers = await get('/api/provider-catalog');
  assert.equal(providers.statusCode, 200);
  assert.equal(providers.headers['cache-control'], 'no-store');
  const providerBody = providers.json();
  assert.equal(providerBody.total, 7);
  assert.equal(providerBody.secretsReturned, false);
  assert.equal(providerBody.providers.every(provider => provider.credentialUrl.startsWith('https://')), true);

  const catalog = await get('/api/model-presets');
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.headers['cache-control'], 'no-store');
  const body = catalog.json();
  assert.equal(body.total, 22);
  assert.equal(body.groups.length, 7);
  assert.equal(body.secretsReturned, false);
  assert.equal(body.groups.find(group => group.provider.id === 'deepseek').presets.length, 3);
  assert.equal(catalog.body.includes('"apiKey"'), false);

  const video = (await get('/api/model-presets?kind=video')).json();
  assert.ok(video.total > 0);
  assert.equal(video.presets.every(preset => preset.kind === 'video'), true);
  assert.equal(video.filters.kind, 'video');

  const image = (await get('/api/model-presets?modality=image')).json();
  assert.ok(image.total > 0);
  assert.equal(image.presets.every(preset => preset.kind === 'image'), true);

  const deepseek = (await get('/api/model-presets?providerId=deepseek')).json();
  assert.equal(deepseek.total, 3);
  assert.equal(deepseek.groups.length, 1);
  assert.equal(deepseek.groups[0].provider.id, 'deepseek');

  const invalid = await get('/api/model-presets?kind=audio');
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.includes('MODEL_PRESET_FILTER_INVALID'), true);
});

test('presetCode 一键创建 Profile 自动补齐 Endpoint/模型/超时，且整个过程不泄露密钥', async t => {
  const { get, post } = await harness(t);
  const created = await post('/api/model-profiles', { presetCode: 'deepseek-chat', apiKey: 'sk-mock-deepseek' });
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.includes('sk-mock-deepseek'), false);
  const profile = created.json().profile;
  assert.equal(profile.name, 'DeepSeek Chat');
  assert.equal(profile.kind, 'text');
  assert.equal(profile.endpoint, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(profile.model, 'deepseek-chat');
  assert.equal(profile.timeoutMs, 180000);
  assert.equal(profile.hasApiKey, true);
  assert.equal(profile.apiKey, undefined);

  const second = await post('/api/model-profiles', { presetCode: 'deepseek-chat', apiKey: 'sk-mock-second' });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().profile.name, 'DeepSeek Chat 2');

  const video = await post('/api/model-profiles', { presetCode: 'kling-v2-1-video', apiKey: 'sk-mock-kling', name: '可灵视频' });
  assert.equal(video.statusCode, 200);
  assert.equal(video.json().profile.kind, 'video');
  assert.equal(video.json().profile.endpoint, 'https://api.klingai.com');
  assert.equal(video.json().profile.model, 'kling-v2-1');
  assert.equal(video.json().profile.timeoutMs, 300000);

  const profiles = await get('/api/model-profiles');
  assert.equal(profiles.statusCode, 200);
  assert.equal(profiles.body.includes('sk-mock-deepseek'), false);
  assert.equal(profiles.body.includes('sk-mock-kling'), false);
  assert.equal(profiles.json().profiles.some(item => item.name === '可灵视频' && item.hasApiKey), true);

  const overridden = await post('/api/model-profiles', {
    presetCode: 'deepseek-v4-flash', endpoint: 'https://evil.test/v1/chat/completions', apiKey: 'sk-mock-bad',
  });
  assert.equal(overridden.statusCode, 400);
  assert.equal(overridden.body.includes('MODEL_CONNECTION_INVALID'), true);

  const unknown = await post('/api/model-profiles', { presetCode: 'not-a-preset', apiKey: 'sk-mock-none' });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.body.includes('MODEL_PRESET_NOT_FOUND'), true);
});
