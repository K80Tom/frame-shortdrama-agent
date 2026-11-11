const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ModelPresetContractError,
  isModelKind,
  parseModelPresetCatalog,
  parseModelPresetCatalogDocument,
  parseProviderCatalog,
} = require('../dist/model-presets');

const provider = (id, supportedKinds = ['text']) => ({
  id,
  label: id,
  vendor: id,
  platform: 'openai_compatible',
  defaultBaseUrl: 'https://api.example.com/v1/chat/completions',
  credentialUrl: 'https://console.example.com/keys?from=lyra',
  documentationUrl: 'https://docs.example.com',
  supportedKinds,
});

const textPreset = (code = 'example-chat', providerId = 'example') => ({
  code,
  name: code,
  providerId,
  kind: 'text',
  description: '公开文本模型预设',
  capabilities: ['文本对话'],
  contextWindow: 131072,
  modelCode: code,
  defaultBaseUrl: 'https://api.example.com/v1/chat/completions',
  config: { maxOutputTokens: 4096, defaultTimeoutMs: 180000 },
});

const videoPreset = (code = 'example-video') => {
  const { contextWindow: _ignored, ...base } = textPreset(code);
  return {
    ...base,
    kind: 'video',
    capabilities: ['文生视频'],
    config: {
      supportedResolutions: ['720p', '1080p'],
      supportedAspectRatios: ['16:9', '9:16'],
      supportedDurations: [5, 10],
      minDuration: 5,
      maxDuration: 10,
      defaultDuration: 5,
      supportFirstFrame: true,
      supportLastFrame: false,
      defaultTimeoutMs: 300000,
    },
  };
};

const throwsContract = fn => assert.throws(fn, error =>
  error instanceof ModelPresetContractError && error.code === 'MODEL_PRESET_INVALID');

test('服务商目录与预设目录可解析，视频与文本必需参数被保留', () => {
  assert.equal(isModelKind('video'), true);
  assert.equal(isModelKind('audio'), false);
  const providers = parseProviderCatalog([provider('example', ['text', 'video'])]);
  assert.equal(providers.length, 1);
  assert.equal(providers[0].credentialUrl, 'https://console.example.com/keys?from=lyra');
  const presets = parseModelPresetCatalog([textPreset(), videoPreset()], providers);
  assert.equal(presets.length, 2);
  assert.equal(presets[0].contextWindow, 131072);
  assert.deepEqual(presets[1].config.supportedResolutions, ['720p', '1080p']);
  const document = parseModelPresetCatalogDocument({ providers: [provider('example', ['text', 'video'])], presets: [textPreset(), videoPreset()] });
  assert.equal(document.providers[0].id, 'example');
  assert.equal(document.presets.length, 2);
});

test('服务商与预设的公开元数据约束会拒绝密钥、重复 id、非法 URL 与不完整参数', () => {
  throwsContract(() => parseProviderCatalog([{ ...provider('example'), apiKey: 'sk-should-not-be-here' }]));
  throwsContract(() => parseProviderCatalog([provider('example'), provider('example')]));
  throwsContract(() => parseProviderCatalog([{ ...provider('example'), defaultBaseUrl: 'http://api.example.com' }]));
  throwsContract(() => parseProviderCatalog([{ ...provider('example'), defaultBaseUrl: 'https://user:pass@api.example.com' }]));
  throwsContract(() => parseModelPresetCatalog([{ ...textPreset(), apiKey: 'sk-should-not-be-here' }], [provider('example')]));
  throwsContract(() => parseModelPresetCatalog([textPreset()], [provider('example', ['video'])]));
  throwsContract(() => parseModelPresetCatalog([textPreset('unknown', 'missing')], [provider('example')]));
  throwsContract(() => parseModelPresetCatalog([{ ...textPreset(), contextWindow: undefined }], [provider('example')]));
  throwsContract(() => parseModelPresetCatalog([{ ...videoPreset(), config: { ...videoPreset().config, supportedResolutions: undefined } }], [provider('example', ['video'])]));
  throwsContract(() => parseModelPresetCatalog([{ ...videoPreset(), config: { ...videoPreset().config, supportedAspectRatios: undefined } }], [provider('example', ['video'])]));
  throwsContract(() => parseModelPresetCatalog([{ ...videoPreset(), config: { ...videoPreset().config, supportLastFrame: true, supportFirstFrame: false } }], [provider('example', ['video'])]));
  throwsContract(() => parseModelPresetCatalog([{ ...videoPreset(), config: { ...videoPreset().config, defaultDuration: 20 } }], [provider('example', ['video'])]));
  throwsContract(() => parseModelPresetCatalog([textPreset(), textPreset()], [provider('example')]));
});
