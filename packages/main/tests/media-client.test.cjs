const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');
const { MAX_ASSET_BYTES } = require('../dist/assets/media');
const { ModelError } = require('@ohao/shared');
const { DoubaoImageClient, SeedanceVideoClient, MAX_REFERENCE_IMAGE_SOURCE_CHARS } = require('../dist/models/media-client');

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length); body.copy(output, 4);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}

function png() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 70, 110, 140, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
}

const IMAGE = png();
const endpoint = 'https://media.example.test/v1/images/generations';
const secret = 'unit-test-secret-never-log';
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const config = (fetch, changes = {}) => ({ endpoint, model: 'unit-image-model', authType: 'api-key', apiKey: secret,
  timeoutMs: 10_000, fetch, lookup: publicLookup, ...changes });
const body = init => JSON.parse(init.body);
const isCode = code => error => error instanceof ModelError && error.code === code;

test('DoubaoImageClient posts to the configured complete endpoint and accepts verified b64_json', async () => {
  const calls = [];
  const client = new DoubaoImageClient(config(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: [{ b64_json: IMAGE.toString('base64') }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, { authType: 'bearer' }));
  const result = await client.generateImage({ prompt: ' 铜钥匙影棚质感 ', responseFormat: 'b64_json', watermark: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, endpoint);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${secret}`);
  assert.equal(calls[0].init.headers['api-key'], undefined);
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(body(calls[0].init), { model: 'unit-image-model', prompt: '铜钥匙影棚质感', size: '2K', n: 1,
    response_format: 'b64_json', stream: false, watermark: true });
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.source, 'b64_json');
  assert.deepEqual(result.bytes, IMAGE);
});

test('DoubaoImageClient downloads HTTPS output without forwarding provider credentials', async () => {
  const calls = [];
  const lookups = [];
  const client = new DoubaoImageClient(config(async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.test/generated.png?sig=ok' }] }));
    return new Response(IMAGE, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  }, { lookup: async hostname => {
    lookups.push(hostname);
    return [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
  } }));
  const result = await client.generateImage({ prompt: '雨夜旧桥' });
  assert.equal(calls.length, 2);
  assert.deepEqual(lookups, ['cdn.example.test']);
  assert.equal(calls[1].url, 'https://cdn.example.test/generated.png?sig=ok');
  assert.deepEqual(calls[1].init.headers, {});
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.source, 'url');
});

test('DoubaoImageClient constrains only returned media URLs, not an explicitly configured provider endpoint', async () => {
  let lookups = 0;
  const providerEndpoint = 'https://127.0.0.1/v1/images/generations';
  const client = new DoubaoImageClient(config(async (url, init) => {
    assert.equal(url, providerEndpoint);
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ data: [{ b64_json: IMAGE.toString('base64') }] }));
  }, { endpoint: providerEndpoint, lookup: async () => {
    lookups++;
    return [{ address: '127.0.0.1', family: 4 }];
  } }));
  const result = await client.generateImage({ prompt: '本地代理后的模型', responseFormat: 'b64_json' });
  assert.equal(result.mimeType, 'image/png');
  assert.equal(lookups, 0);
});

test('DoubaoImageClient blocks localhost and non-public literal media addresses before download', async t => {
  const unsafeUrls = [
    'https://localhost/generated.png',
    'https://assets.localhost/generated.png',
    'https://printer.local/generated.png',
    'https://0.0.0.0/generated.png',
    'https://10.0.0.1/generated.png',
    'https://100.64.0.1/generated.png',
    'https://127.1/generated.png',
    'https://169.254.169.254/latest/meta-data',
    'https://172.16.0.1/generated.png',
    'https://192.0.0.1/generated.png',
    'https://192.0.2.1/generated.png',
    'https://192.88.99.1/generated.png',
    'https://192.168.1.1/generated.png',
    'https://198.18.0.1/generated.png',
    'https://198.51.100.1/generated.png',
    'https://203.0.113.1/generated.png',
    'https://224.0.0.1/generated.png',
    'https://240.0.0.1/generated.png',
    'https://[::]/generated.png',
    'https://[::1]/generated.png',
    'https://[::ffff:127.0.0.1]/generated.png',
    'https://[fc00::1]/generated.png',
    'https://[fd00::1]/generated.png',
    'https://[fe80::1]/generated.png',
    'https://[ff02::1]/generated.png',
    'https://[2001:db8::1]/generated.png',
    'https://[2002:7f00:1::]/generated.png',
    'https://[3fff::1]/generated.png',
  ];
  for (const unsafeUrl of unsafeUrls) {
    await t.test(unsafeUrl, async () => {
      let calls = 0;
      let lookups = 0;
      const client = new DoubaoImageClient(config(async () => {
        calls++;
        return new Response(JSON.stringify({ data: [{ url: unsafeUrl }] }));
      }, { lookup: async () => {
        lookups++;
        return [{ address: '93.184.216.34', family: 4 }];
      } }));
      await assert.rejects(client.generateImage({ prompt: '拒绝内网' }), isCode('MEDIA_DOWNLOAD_UNSAFE'));
      assert.equal(calls, 1);
      assert.equal(lookups, 0);
    });
  }
});

test('DoubaoImageClient rejects DNS names resolving to any non-public address and fails closed', async t => {
  const unsafeAnswers = [
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '10.1.2.3', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }],
    [{ address: '::1', family: 6 }],
    [{ address: 'fe80::1', family: 6 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.8', family: 4 }],
    [],
  ];
  for (const answers of unsafeAnswers) {
    await t.test(JSON.stringify(answers), async () => {
      let calls = 0;
      const client = new DoubaoImageClient(config(async () => {
        calls++;
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.test/generated.png' }] }));
      }, { lookup: async hostname => {
        assert.equal(hostname, 'cdn.example.test');
        return answers;
      } }));
      await assert.rejects(client.generateImage({ prompt: '拒绝 DNS 重绑' }), isCode('MEDIA_DOWNLOAD_UNSAFE'));
      assert.equal(calls, 1);
    });
  }
  await t.test('resolver failure', async () => {
    let calls = 0;
    const client = new DoubaoImageClient(config(async () => {
      calls++;
      return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.test/generated.png' }] }));
    }, { lookup: async () => { throw new Error('private resolver detail'); } }));
    await assert.rejects(client.generateImage({ prompt: '解析失败时拒绝' }), error => {
      assert.equal(error.code, 'MEDIA_DOWNLOAD_UNSAFE');
      assert.equal(error.message.includes('private resolver detail'), false);
      return true;
    });
    assert.equal(calls, 1);
  });
});

test('DoubaoImageClient defaults to inline b64_json and still falls back to guarded URL download', async t => {
  await t.test('default request asks for b64_json', async () => {
    let requestBody = null;
    const client = new DoubaoImageClient(config(async (url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: [{ b64_json: IMAGE.toString('base64') }] }));
    }));
    const result = await client.generateImage({ prompt: '默认内联' });
    assert.equal(requestBody.response_format, 'b64_json');
    assert.equal(result.source, 'b64_json');
  });
  await t.test('URL-only response still downloads through the guard', async () => {
    const calls = [];
    const client = new DoubaoImageClient(config(async url => {
      calls.push(url);
      if (calls.length === 1) return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.test/generated.png' }] }));
      return new Response(IMAGE, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    }));
    const result = await client.generateImage({ prompt: '仅返回链接' });
    assert.equal(calls.length, 2);
    assert.equal(result.source, 'url');
  });
});

test('allowIntranetMediaSources permits vendor intranet CDNs but keeps local targets blocked', async t => {
  await t.test('private-range DNS answer is downloaded', async () => {
    const calls = [];
    const client = new DoubaoImageClient(config(async url => {
      calls.push(url);
      if (calls.length === 1) return new Response(JSON.stringify({ data: [{ url: 'https://tos-cdn.vendor.test/generated.png' }] }));
      return new Response(IMAGE, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    }, { allowIntranetMediaSources: true, lookup: async () => [{ address: '10.35.10.197', family: 4 }] }));
    const result = await client.generateImage({ prompt: '内网 CDN', responseFormat: 'url' });
    assert.equal(calls.length, 2);
    assert.equal(result.source, 'url');
  });
  await t.test('loopback and link-local literals stay blocked', async () => {
    for (const unsafeUrl of ['https://127.0.0.1/generated.png', 'https://169.254.169.254/latest/meta-data',
      'https://[::1]/generated.png', 'https://[fe80::1]/generated.png', 'https://[::ffff:127.0.0.1]/generated.png']) {
      let calls = 0;
      const client = new DoubaoImageClient(config(async () => {
        calls++;
        return new Response(JSON.stringify({ data: [{ url: unsafeUrl }] }));
      }, { allowIntranetMediaSources: true }));
      await assert.rejects(client.generateImage({ prompt: '本机仍拒绝', responseFormat: 'url' }), isCode('MEDIA_DOWNLOAD_UNSAFE'));
      assert.equal(calls, 1);
    }
  });
  await t.test('localhost-style hostnames stay blocked', async () => {
    let calls = 0;
    const client = new DoubaoImageClient(config(async () => {
      calls++;
      return new Response(JSON.stringify({ data: [{ url: 'https://assets.localhost/generated.png' }] }));
    }, { allowIntranetMediaSources: true }));
    await assert.rejects(client.generateImage({ prompt: '本机域名仍拒绝', responseFormat: 'url' }), isCode('MEDIA_DOWNLOAD_UNSAFE'));
    assert.equal(calls, 1);
  });
});

test('DoubaoImageClient rejects non-HTTPS, oversized and invalid image output without retrying', async t => {
  await t.test('non-HTTPS URL', async () => {
    let calls = 0;
    const client = new DoubaoImageClient(config(async () => {
      calls++;
      return new Response(JSON.stringify({ data: [{ url: 'http://cdn.example.test/generated.png' }] }));
    }));
    await assert.rejects(client.generateImage({ prompt: '道具' }), isCode('INVALID_MEDIA_RESPONSE'));
    assert.equal(calls, 1);
  });
  await t.test('announced size over 6 MiB', async () => {
    let calls = 0;
    const client = new DoubaoImageClient(config(async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.test/large.png' }] }));
      return new Response('x', { headers: { 'Content-Length': String(MAX_ASSET_BYTES + 1) } });
    }));
    await assert.rejects(client.generateImage({ prompt: '场景' }), isCode('MEDIA_RESPONSE_TOO_LARGE'));
    assert.equal(calls, 2);
  });
  await t.test('streamed size over 6 MiB', async () => {
    let calls = 0;
    const client = new DoubaoImageClient(config(async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.test/stream.png' }] }));
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024));
        controller.enqueue(new Uint8Array(3 * 1024 * 1024));
        controller.close();
      } }));
    }));
    await assert.rejects(client.generateImage({ prompt: '场景' }), isCode('MEDIA_RESPONSE_TOO_LARGE'));
    assert.equal(calls, 2);
  });
  await t.test('unrecognized bytes', async () => {
    let calls = 0;
    const client = new DoubaoImageClient(config(async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.test/not-image' }] }));
      return new Response('not an image');
    }));
    await assert.rejects(client.generateImage({ prompt: '人物' }), isCode('INVALID_MEDIA_RESPONSE'));
    assert.equal(calls, 2);
  });
});

test('media clients use complete HTTPS endpoints and never surface upstream secrets or bodies', async () => {
  assert.throws(() => new DoubaoImageClient(config(async () => new Response(), { endpoint: 'http://media.example.test/images' })),
    isCode('MEDIA_NOT_CONFIGURED'));
  assert.throws(() => new DoubaoImageClient(config(async () => new Response(), { endpoint: 'https://media.example.test/?key=secret' })),
    isCode('MEDIA_NOT_CONFIGURED'));
  assert.throws(() => new DoubaoImageClient(config(async () => new Response(), { apiKey: 'secret\nInjected: yes' })),
    isCode('MEDIA_NOT_CONFIGURED'));
  let calls = 0;
  const client = new DoubaoImageClient(config(async () => {
    calls++;
    return new Response(`provider leaked ${secret} at ${endpoint}`, { status: 401 });
  }));
  await assert.rejects(client.generateImage({ prompt: '秘钥不出现' }), error => {
    const visible = `${error.message} ${JSON.stringify(error.details)}`;
    assert.equal(error.code, 'MEDIA_UPSTREAM_ERROR');
    assert.equal(error.details.upstreamStatus, 401);
    assert.equal(visible.includes(secret), false);
    assert.equal(visible.includes(endpoint), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('SeedanceVideoClient submits one task with configured model, media roles and api-key auth', async () => {
  const calls = [];
  const taskEndpoint = 'https://video.example.test/contents/generations/tasks';
  const client = new SeedanceVideoClient(config(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: 'task_123', status: 'queued' }));
  }, { endpoint: taskEndpoint, model: 'unit-video-model' }));
  const task = await client.submit({ prompt: ' 镜头缓慢推进 ', firstFrameUrl: 'https://cdn.example.test/first.png',
    lastFrameUrl: 'https://cdn.example.test/last.png', referenceImageUrls: ['https://cdn.example.test/ref.png'],
    referenceVideoUrls: ['https://cdn.example.test/ref.mp4'], referenceAudioUrls: ['https://cdn.example.test/ref.wav'],
    generateAudio: false, resolution: '720p', duration: 8, ratio: '16:9', watermark: true,
    omniReferenceTaskType: 'reference_to_video' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, taskEndpoint);
  assert.equal(calls[0].init.headers['api-key'], secret);
  const request = body(calls[0].init);
  assert.equal(request.model, 'unit-video-model');
  assert.equal(request.content[0].text, '镜头缓慢推进');
  assert.deepEqual(request.content.slice(1).map(item => item.role),
    ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio']);
  assert.equal(request.content.some(item => item.image_url?.role || item.video_url?.role), false);
  assert.deepEqual({ generate_audio: request.generate_audio, resolution: request.resolution, duration: request.duration,
    ratio: request.ratio, watermark: request.watermark, omni_reference_task_type: request.omni_reference_task_type },
  { generate_audio: false, resolution: '720p', duration: 8, ratio: '16:9', watermark: true,
    omni_reference_task_type: 'reference_to_video' });
  assert.deepEqual(task, { taskId: 'task_123', status: 'queued', done: false, videoUrl: null, errorMessage: null, model: null });
});

test('SeedanceVideoClient accepts only bounded canonical PNG/JPEG/WebP data references', async () => {
  const calls = [];
  const taskEndpoint = 'https://video.example.test/contents/generations/tasks';
  const client = new SeedanceVideoClient(config(async (url, init) => {
    calls.push({ url, init }); return new Response(JSON.stringify({ id: 'task_data_image' }));
  }, { endpoint: taskEndpoint, model: 'unit-video-model' }));
  const source = `data:image/png;base64,${IMAGE.toString('base64')}`;
  await client.submit({ prompt: '本地参考图', referenceImageUrls: [source] });
  const request = body(calls[0].init);
  assert.equal(request.content.find(item => item.role === 'reference_image').image_url.url, source);
  for (const invalid of [
    `data:image/gif;base64,${IMAGE.toString('base64')}`,
    `data:image/jpeg;base64,${IMAGE.toString('base64')}`,
    'data:image/png;base64,%%%%',
    `data:image/png;base64,${'A'.repeat(MAX_REFERENCE_IMAGE_SOURCE_CHARS + 1)}`,
  ]) await assert.rejects(client.submit({ prompt: '拒绝无效参考图', referenceImageUrls: [invalid] }), isCode('INVALID_MEDIA_REQUEST'));
  assert.equal(calls.length, 1);
});

test('SeedanceVideoClient queries a task and validates terminal video URL', async () => {
  const calls = [];
  const taskEndpoint = 'https://video.example.test/contents/generations/tasks';
  const client = new SeedanceVideoClient(config(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: 'task_123', status: 'succeeded', model: 'seedance-public-name',
      content: { video_url: 'https://cdn.example.test/result.mp4?signature=ok' } }));
  }, { endpoint: taskEndpoint, model: 'unit-video-model', authType: 'bearer' }));
  const task = await client.query('task_123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${taskEndpoint}/task_123`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${secret}`);
  assert.deepEqual(task, { taskId: 'task_123', status: 'succeeded', done: true,
    videoUrl: 'https://cdn.example.test/result.mp4?signature=ok', errorMessage: null, model: 'seedance-public-name' });
});

test('SeedanceVideoClient rejects unsafe references/task IDs and sanitizes terminal provider errors', async () => {
  let calls = 0;
  const client = new SeedanceVideoClient(config(async () => {
    calls++;
    return new Response(JSON.stringify({ id: 'task_failed', status: 'failed', error: {
      message: `failed with ${secret} ${endpoint} Bearer MAAS1234567890abcdef` } }));
  }, { endpoint: 'https://video.example.test/contents/generations/tasks', model: 'unit-video-model' }));
  await assert.rejects(client.submit({ prompt: '镜头', firstFrameUrl: 'http://unsafe.example.test/a.png' }),
    isCode('INVALID_MEDIA_REQUEST'));
  await assert.rejects(client.submit({ prompt: '\ud800' }), isCode('INVALID_MEDIA_REQUEST'));
  await assert.rejects(client.query('../task'), isCode('INVALID_MEDIA_REQUEST'));
  assert.equal(calls, 0);
  const failed = await client.submit({ prompt: '镜头' });
  assert.equal(calls, 1);
  assert.equal(failed.done, true);
  assert.equal(failed.errorMessage.includes(secret), false);
  assert.equal(failed.errorMessage.includes(endpoint), false);
  assert.equal(failed.errorMessage.includes('MAAS1234567890abcdef'), false);
  assert.match(failed.errorMessage, /\[REDACTED\]/);
});

test('SeedanceVideoClient refuses malformed success and does not retry a network failure', async t => {
  await t.test('success without HTTPS video', async () => {
    let calls = 0;
    const client = new SeedanceVideoClient(config(async () => {
      calls++;
      return new Response(JSON.stringify({ id: 'task_1', status: 'succeeded', content: { video_url: 'http://unsafe/video.mp4' } }));
    }, { endpoint: 'https://video.example.test/contents/generations/tasks' }));
    await assert.rejects(client.query('task_1'), isCode('INVALID_MEDIA_RESPONSE'));
    assert.equal(calls, 1);
  });
  await t.test('unknown network result', async () => {
    let calls = 0;
    const client = new SeedanceVideoClient(config(async () => {
      calls++;
      throw new Error(`network ${secret}`);
    }, { endpoint: 'https://video.example.test/contents/generations/tasks' }));
    await assert.rejects(client.submit({ prompt: '镜头' }), error => {
      assert.equal(error.code, 'MEDIA_UPSTREAM_UNAVAILABLE');
      assert.equal(error.message.includes(secret), false);
      return true;
    });
    assert.equal(calls, 1);
  });
});
