const { test } = require('node:test');
const assert = require('node:assert/strict');
const { InMemoryPaidGenerationInterceptor } = require('../dist/budget/paid-generation');
const { KlingVideoAdapter, JimengVideoAdapter, MiniMaxVideoAdapter, SeedanceVideoAdapter } =
  require('../dist/models/video-providers');

const WS = `ws_${'c'.repeat(32)}`;
const first = 'https://assets.example.test/first.png?sig=1';
const last = 'https://assets.example.test/last.png?sig=2';
const reference = 'https://assets.example.test/ref.png?sig=3';

function request(provider, extra = {}) {
  const model = provider === 'kling' ? 'kling-v2' : provider === 'jimeng' ? 'jimeng-video'
    : provider === 'seedance' ? 'doubao-seedance-1-5-pro-251215' : 'minimax-hailuo';
  const durationSeconds = provider === 'kling' ? 5 : provider === 'seedance' ? 5 : 10;
  return { workspaceId: WS, operationKey: `video:${provider}:shot-1`, clientRequestId: `video-${provider}-1`,
    provider, model, prompt: '雨夜旧桥，人物保持克制', durationSeconds, ratio: '16:9',
    resolution: '1080p', firstFrameUrl: first, lastFrameUrl: last, referenceImageUrls: [reference],
    generateAudio: false, estimateMicros: 100_000, budgetLimitMicros: 500_000, currency: 'CNY', ...extra };
}

function config(provider, fetch) {
  return { endpoint: provider === 'kling' ? 'https://api.kling.test' : provider === 'jimeng'
    ? 'https://ark.example.test/api/v3/contents/generations/tasks' : provider === 'seedance'
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

test('Seedance assembles content roles with explicit return_last_frame', () => {
  const adapter = new SeedanceVideoAdapter(config('seedance'), new InMemoryPaidGenerationInterceptor());
  const built = adapter.inspectRequest(request('seedance'));
  assert.deepEqual(built.body.content.map(item => item.role ?? item.type), ['text', 'first_frame', 'last_frame', 'reference_image']);
  assert.equal(built.body.model, 'doubao-seedance-1-5-pro-251215');
  assert.equal(built.body.return_last_frame, true);
  assert.equal(built.body.generate_audio, false);
  assert.equal(built.body.duration, 5);
});

test('Seedance rejects sub-2s durations and audio on 1.0 models before budget or network', () => {
  const adapter = new SeedanceVideoAdapter(config('seedance'), new InMemoryPaidGenerationInterceptor());
  assert.throws(() => adapter.inspectRequest(request('seedance', { durationSeconds: 1 })),
    error => error.code === 'VIDEO_PROVIDER_DURATION_UNSUPPORTED');
  assert.throws(() => adapter.inspectRequest(request('seedance', {
    model: 'doubao-seedance-1-0-pro-250528', generateAudio: true,
  })), error => error.code === 'VIDEO_PROVIDER_AUDIO_UNSUPPORTED');
});

test('Seedance poll maps Ark statuses and extracts video and last frame URLs', async () => {
  const calls = [];
  const adapter = new SeedanceVideoAdapter(config('seedance', async (url, init) => {
    calls.push({ url, method: init.method });
    return new Response(JSON.stringify({ id: 'cgt-12345678', status: 'succeeded',
      content: { video_url: 'https://cdn.example.test/v.mp4', last_frame_url: 'https://cdn.example.test/tail.png' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }), new InMemoryPaidGenerationInterceptor());
  const poll = await adapter.poll({ providerTaskId: 'cgt-12345678' });
  assert.equal(poll.state, 'succeeded');
  assert.equal(poll.videoUrl, 'https://cdn.example.test/v.mp4');
  assert.equal(poll.lastFrameUrl, 'https://cdn.example.test/tail.png');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://ark.example.test/api/v3/contents/generations/tasks/cgt-12345678');
  assert.equal(adapter.inspectPoll({ providerTaskId: 'cgt-12345678' }).url,
    'https://ark.example.test/api/v3/contents/generations/tasks/cgt-12345678');
  const pending = adapter['parsePollResponse']({ status: 'running' }, { providerTaskId: 'cgt-12345678' });
  assert.equal(pending.state, 'pending');
  const failed = adapter['parsePollResponse']({ status: 'failed' }, { providerTaskId: 'cgt-12345678' });
  assert.equal(failed.state, 'failed');
});

test('provider poll rejects malformed task ids before any network call', async () => {
  const adapter = new SeedanceVideoAdapter(config('seedance'), new InMemoryPaidGenerationInterceptor());
  assert.throws(() => adapter.inspectPoll({ providerTaskId: 'short' }),
    error => error.code === 'VIDEO_PROVIDER_REQUEST_INVALID');
});

test('Kling poll chooses the generation path and parses succeed', async () => {
  const adapter = new KlingVideoAdapter(config('kling'), new InMemoryPaidGenerationInterceptor());
  assert.equal(adapter.inspectPoll({ providerTaskId: 'task_12345678', imageToVideo: true }).url,
    'https://api.kling.test/v1/videos/image2video/task_12345678');
  const parse = adapter['parsePollResponse']({
    data: { task_status: 'succeed', task_result: { videos: [{ url: 'https://cdn.example.test/k.mp4' }] } },
  }, { providerTaskId: 'task_12345678', imageToVideo: true });
  assert.equal(parse.state, 'succeeded');
  assert.equal(parse.videoUrl, 'https://cdn.example.test/k.mp4');
  const processing = adapter['parsePollResponse']({ data: { task_status: 'processing' } },
    { providerTaskId: 'task_12345678' });
  assert.equal(processing.state, 'pending');
});

test('Jimeng and MiniMax poll parse terminal states', () => {
  const jimeng = new JimengVideoAdapter(config('jimeng'), new InMemoryPaidGenerationInterceptor());
  assert.match(jimeng.inspectPoll({ providerTaskId: 'cgt-00000000' }).url, /\/cgt-00000000$/u);
  const mini = new MiniMaxVideoAdapter(config('minimax'), new InMemoryPaidGenerationInterceptor());
  assert.match(mini.inspectPoll({ providerTaskId: 'task_87654321' }).url, /\/v1\/query\/video_generation\?GroupId=1234567890&task_id=task_87654321$/u);
  const miniDone = mini['parsePollResponse']({ status: 'Success',
    file: { download_url: 'https://cdn.example.test/m.mp4' } }, { providerTaskId: 'task_87654321' });
  assert.equal(miniDone.state, 'succeeded');
  assert.equal(miniDone.videoUrl, 'https://cdn.example.test/m.mp4');
  const miniQueued = mini['parsePollResponse']({ status: 'Queueing' }, { providerTaskId: 'task_87654321' });
  assert.equal(miniQueued.state, 'pending');
  const jimengPending = jimeng['parsePollResponse']({ status: 'queued' }, { providerTaskId: 'cgt-00000000' });
  assert.equal(jimengPending.state, 'pending');
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
