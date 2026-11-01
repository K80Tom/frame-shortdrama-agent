const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, realpath, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { deflateSync } = require('node:zlib');
const { readConfig } = require('../dist/config');
const { DoubaoImageApiAdapter } = require('../dist/desktop-assets/api-adapter');

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length); body.copy(output, 4);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}
function png() {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 70, 110, 140, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
}

const JOB = `desktop_${'a'.repeat(32)}`;
function configured(overrides = {}) {
  return { ...readConfig({}), endpointUrl: 'https://image.test/openai/doubao/images/generations',
    defaultModel: 'doubao-image-test', apiKey: 'test-only-key', authType: 'api-key', timeoutMs: 10_000,
    connectionRevision: 'image-revision-1', ...overrides };
}

async function fixture(t, fetch, config = configured()) {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'ohao-image-api-adapter-')));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const outputPath = join(projectRoot, 'outputs/private/desktop-assets', JOB, 'result.png');
  await mkdir(join(projectRoot, 'outputs/private/desktop-assets', JOB), { recursive: true });
  return { adapter: new DoubaoImageApiAdapter(() => config, { projectRoot, fetch }), outputPath };
}

test('configured image API health is local-only and reports the selected model revision', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error('must not call'); });
  assert.deepEqual(await f.adapter.health(), {
    available: true, installed: true, accessibilityTrusted: true, code: 'IMAGE_MODEL_READY',
    message: '已选中生图模型 doubao-image-test。连接配置完整，实际可用性将在用户授权的生成请求中验证。',
    model: 'doubao-image-test', connectionRevision: 'image-revision-1', transport: 'api',
  });
  assert.equal(calls, 0);
});

test('image API adapter sends one bounded request, saves verified bytes and never exposes its key', async t => {
  const image = png(); let calls = 0;
  const f = await fixture(t, async (url, options) => {
    calls++;
    assert.equal(url, 'https://image.test/openai/doubao/images/generations');
    assert.equal(options.headers['api-key'], 'test-only-key');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.deepEqual({ model: body.model, prompt: body.prompt, size: body.size, n: body.n,
      response_format: body.response_format, stream: body.stream, watermark: body.watermark },
    { model: 'doubao-image-test', prompt: '原创资产提示词', size: '2K', n: 1,
      response_format: 'url', stream: false, watermark: false });
    return new Response(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  const result = await f.adapter.submit({ jobId: JOB, prompt: '原创资产提示词', outputPath: f.outputPath,
    expectedModelConnectionRevision: 'image-revision-1' });
  assert.equal(result.state, 'submitted'); assert.equal(calls, 1);
  assert.deepEqual(await readFile(f.outputPath), image);
  assert.equal(JSON.stringify(result).includes('test-only-key'), false);
});

test('stale selection and unsafe output paths fail before any paid request', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error('must not call'); });
  const stale = await f.adapter.submit({ jobId: JOB, prompt: '原创提示词', outputPath: f.outputPath,
    expectedModelConnectionRevision: 'old-revision' });
  assert.equal(stale.state, 'blocked'); assert.equal(stale.code, 'MODEL_SELECTION_CHANGED');
  const unsafe = await f.adapter.submit({ jobId: JOB, prompt: '原创提示词', outputPath: join(tmpdir(), 'other.png'),
    expectedModelConnectionRevision: 'image-revision-1' });
  assert.equal(unsafe.state, 'blocked'); assert.equal(unsafe.code, 'IMAGE_OUTPUT_PATH_INVALID');
  assert.equal(calls, 0);
});

test('a local rejection before the image request is blocked and does not call the provider', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error('must not call'); });
  const invalid = await f.adapter.submit({ jobId: JOB, prompt: '\ud800', outputPath: f.outputPath,
    expectedModelConnectionRevision: 'image-revision-1' });
  assert.equal(invalid.state, 'blocked'); assert.equal(invalid.code, 'INVALID_MEDIA_REQUEST');
  const misconfigured = await fixture(t, async () => { calls++; throw new Error('must not call'); },
    configured({ endpointUrl: 'http://image.test/insecure' }));
  const blocked = await misconfigured.adapter.submit({ jobId: JOB, prompt: '原创提示词', outputPath: misconfigured.outputPath,
    expectedModelConnectionRevision: 'image-revision-1' });
  assert.equal(blocked.state, 'blocked'); assert.equal(blocked.code, 'MEDIA_NOT_CONFIGURED');
  assert.equal(calls, 0);
});

test('an upstream failure is persisted as unknown and is never presented as safe to retry', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error('network unavailable'); });
  const result = await f.adapter.submit({ jobId: JOB, prompt: '原创提示词', outputPath: f.outputPath,
    expectedModelConnectionRevision: 'image-revision-1' });
  assert.equal(result.state, 'unknown'); assert.equal(result.code, 'IMAGE_SUBMISSION_UNCERTAIN');
  assert.equal(calls, 1); await assert.rejects(readFile(f.outputPath), { code: 'ENOENT' });
});

test('incomplete image configuration is unavailable without probing the provider', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error('must not call'); }, configured({ apiKey: '' }));
  const health = await f.adapter.health();
  assert.equal(health.available, false); assert.equal(health.code, 'IMAGE_MODEL_NOT_CONFIGURED'); assert.equal(calls, 0);
});
