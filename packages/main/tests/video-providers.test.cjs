const { test } = require('node:test');
const assert = require('node:assert/strict');
const { InMemoryPaidGenerationInterceptor } = require('../dist/budget/paid-generation');
const { KlingVideoAdapter, JimengVideoAdapter, MiniMaxVideoAdapter } =
  require('../dist/models/video-providers');

const WS = `ws_${'c'.repeat(32)}`;
const first = 'https://assets.example.test/first.png?sig=1';
const last = 'https://assets.example.test/last.png?sig=2';
const reference = 'https://assets.example.test/ref.png?sig=3';

function request(provider, extra = {}) {
  return { workspaceId: WS, operationKey: `video:${provider}:shot-1`, clientRequestId: `video-${provider}-1`,
    provider, model: provider === 'kling' ? 'kling-v2' : provider === 'jimeng' ? 'jimeng-video' : 'minimax-hailuo',
    prompt: '雨夜旧桥，人物保持克制', durationSeconds: provider === 'kling' ? 5 : 10, ratio: '16:9',
    resolution: '1080p', firstFrameUrl: first, lastFrameUrl: last, referenceImageUrls: [reference],
    generateAudio: false, estimateMicros: 100_000, budgetLimitMicros: 500_000, currency: 'CNY', ...extra };
}

function config(provider, fetch) {
  return { endpoint: provider === 'kling' ? 'https://api.kling.test' : provider === 'jimeng'
    ? 'https://ark.example.test/api/v3/contents/generations/tasks' : 'https://api.minimax.test/v1/video_generation',
    apiKey: 'test-secret', ...(provider === 'minimax' ? { groupId: '1234567890' } : {}), fetch, timeoutMs: 2_000 };
}

test('Kling assembles first and last frames on image2video', () => {
  const adapter = new KlingVideoAdapter(config('kling'), new InMemoryPaidGenerationInterceptor());
  const built = adapter.inspectRequest(request('kling'));
  assert.equal(built.url, 'https://api.kling.test/v1/videos/image2video');
  assert.equal(built.body.image, first);
  assert.equal(built.body.image_tail, last);
  assert.equal(built.body.duration, '5');
  assert.equal(built.body.mode, 'pro');
  assert.equal(built.body.external_task_id, 'video-kling-1');
});

test('Kling rejects a last frame without a first frame before any budget or network action', () => {
  const adapter = new KlingVideoAdapter(config('kling'), new InMemoryPaidGenerationInterceptor());
  assert.throws(() => adapter.inspectRequest(request('kling', { firstFrameUrl: undefined }),
  ), error => error.code === 'VIDEO_PROVIDER_REQUEST_INVALID');
});

test('Jimeng assembles multimodal content roles in order', () => {
  const adapter = new JimengVideoAdapter(config('jimeng'), new InMemoryPaidGenerationInterceptor());
  const built = adapter.inspectRequest(request('jimeng'));
  assert.deepEqual(built.body.content.map(item => item.role ?? item.type), ['text', 'first_frame', 'last_frame', 'reference_image']);
  assert.equal(built.body.generate_audio, false);
  assert.equal(built.body.resolution, '1080p');
});

test('MiniMax sends GroupId and first/last frame fields', () => {
  const adapter = new MiniMaxVideoAdapter(config('minimax'), new InMemoryPaidGenerationInterceptor());
  const built = adapter.inspectRequest(request('minimax', { durationSeconds: 10 }));
  assert.match(built.url, /GroupId=1234567890/u);
  assert.equal(built.body.first_frame_image, first);
  assert.equal(built.body.last_frame_image, last);
  assert.equal(built.body.resolution, '1080P');
});

test('commercial video submission commits only after a valid task id', async () => {
  const calls = [];
  const ledger = new InMemoryPaidGenerationInterceptor();
  const adapter = new KlingVideoAdapter(config('kling', async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: { task_id: 'task_12345678' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }), ledger);
  const accepted = await adapter.submit(request('kling'));
  assert.equal(accepted.taskId, 'task_12345678');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-secret');
  assert.equal(calls[0].init.redirect, 'error');
  const again = await ledger.reserve({ workspaceId: WS, operationKey: 'video:kling:shot-1', provider: 'kling',
    model: 'kling-v2', estimateMicros: 100_000, budgetLimitMicros: 500_000, currency: 'CNY' });
  assert.equal(again.status, 'committed');
});

test('commercial video never calls the provider when the budget is short', async () => {
  let calls = 0;
  const ledger = new InMemoryPaidGenerationInterceptor();
  const adapter = new KlingVideoAdapter(config('kling', async () => { calls += 1; return new Response('{}'); }), ledger);
  await assert.rejects(adapter.submit(request('kling', { budgetLimitMicros: 1, estimateMicros: 100_000 }),
  ));
  assert.equal(calls, 0);
});

test('commercial video releases on 4xx and keeps unknown on 5xx', async () => {
  const ledger = new InMemoryPaidGenerationInterceptor();
  const reject = new KlingVideoAdapter(config('kling', async () => new Response('{}', { status: 400 })), ledger);
  await assert.rejects(reject.submit(request('kling')), error => error.code === 'VIDEO_PROVIDER_REJECTED');
  const released = await ledger.reserve({ workspaceId: WS, operationKey: 'video:kling:shot-1', provider: 'kling',
    model: 'kling-v2', estimateMicros: 100_000, budgetLimitMicros: 500_000, currency: 'CNY' });
  assert.equal(released.status, 'released');

  const uncertain = new KlingVideoAdapter(config('kling', async () => new Response('{}', { status: 503 })), ledger);
  await assert.rejects(uncertain.submit(request('kling', { operationKey: 'video:kling:shot-2', clientRequestId: 'video-kling-2' }),
  ));
  const unknown = await ledger.reserve({ workspaceId: WS, operationKey: 'video:kling:shot-2', provider: 'kling',
    model: 'kling-v2', estimateMicros: 100_000, budgetLimitMicros: 500_000, currency: 'CNY' });
  assert.equal(unknown.status, 'unknown');
});
