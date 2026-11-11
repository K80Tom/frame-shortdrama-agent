const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseModelExecutionBinding } = require('../dist');
const binding = (adapter, protocol) => ({ providerId: 'custom', adapter, protocol, config: {} });

test('model execution binding accepts only exact kind/adapter/protocol tuples and returns an isolated copy', () => {
  for (const [kind, adapter, protocol] of [['text', 'openai-chat', 'openai-chat-v1'],
    ['image', 'ark-image', 'ark-image-v1'], ['video', 'ark-video', 'ark-video-v1'],
    ['image', 'unavailable', 'metadata-only']]) {
    const original = binding(adapter, protocol);
    const parsed = parseModelExecutionBinding(original, kind);
    assert.deepEqual(parsed, original); assert.notEqual(parsed, original);
    parsed.config.defaultDuration = 5;
    assert.deepEqual(original.config, {});
  }
  for (const value of [null, {}, binding('ark-image', 'ark-video-v1'), binding('openai-chat', 'openai-chat-v1'),
    { ...binding('ark-video', 'ark-video-v1'), apiKey: 'must-not-be-public' },
    { ...binding('ark-video', 'ark-video-v1'), config: { minDuration: 16, maxDuration: 4 } },
    { ...binding('ark-video', 'ark-video-v1'), config: { supportLastFrame: true, supportFirstFrame: false } },
    { ...binding('ark-video', 'ark-video-v1'), config: { supportedDurations: [5, 10], defaultDuration: 8 } },
    { ...binding('ark-video', 'ark-video-v1'), config: { defaultWidth: 2048 } },
    { ...binding('ark-video', 'ark-video-v1'), config: { supportedResolutions: ['720p'], defaultResolution: '8k' } },
    { ...binding('ark-video', 'ark-video-v1'), config: { supportedAspectRatios: ['16:9'], defaultAspectRatio: '5:4' } }]) {
    assert.throws(() => parseModelExecutionBinding(value, 'video'), error => error.code === 'MODEL_PRESET_INVALID');
  }
  assert.throws(() => parseModelExecutionBinding(binding('unavailable', 'metadata-only'), 'audio'));
});
