const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { link, mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const {
  BoundedProcessRunner,
  PinnedHttpsMediaFetcher,
  ProductionMediaIngestor,
  ProductionMediaStore,
  TimelineComposer,
  isPublicInternetAddress,
  parseFfprobe,
} = require('../dist/production-media');

const probe = (changes = {}) => ({ container: 'mp4', durationSeconds: 2, width: 720, height: 1280,
  videoCodec: 'h264', hasAudio: true, audioCodec: 'aac', ...changes });

class ContentProber {
  constructor(entries = {}) { this.entries = entries; this.paths = []; }
  async probe(path) {
    this.paths.push(path);
    const key = (await readFile(path)).toString('utf8');
    const result = this.entries[key] ?? probe();
    if (result instanceof Error) throw result;
    return structuredClone(result);
  }
}

async function fixture(t, entries = {}, options = {}) {
  // macOS exposes /var through /private/var. Pass the canonical ancestor so
  // tests exercise service paths rather than that platform alias.
  const temp = await realpath(tmpdir());
  const base = await mkdtemp(join(temp, 'ohao-production-media-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'media-root');
  const prober = new ContentProber(entries);
  const store = new ProductionMediaStore(root, prober, options);
  await store.initialize();
  return { base, root, prober, store };
}

const rejectsCode = code => error => error && error.code === code;

test('content-addressed storage accepts backend buffers, deduplicates bytes, and revalidates reads', async t => {
  const f = await fixture(t, { alpha: probe({ durationSeconds: 1.5 }) },
    { now: () => new Date('2026-10-23T00:00:00.000Z') });
  const first = await f.store.putVideoBuffer(Buffer.from('alpha'));
  const again = await f.store.putVideoBuffer(Buffer.from('alpha'));
  const hash = createHash('sha256').update('alpha').digest('hex');
  assert.equal(first.id, `media_${hash}`);
  assert.equal(first.sha256, hash);
  assert.equal(first.relativePath, join('objects', hash.slice(0, 2), `${hash}.mp4`));
  assert.equal(first.createdAt, '2026-10-23T00:00:00.000Z');
  assert.deepEqual(again, first);
  const owned = await f.store.getVideo(first.id);
  assert.equal(owned.object.id, first.id);
  assert.equal((await readFile(owned.absolutePath)).toString(), 'alpha');
  assert.ok(owned.absolutePath.startsWith(`${f.root}/`));
  assert.ok(f.prober.paths.length >= 3, 'dedupe and reads must not trust old probe metadata');
});

test('owned-file import rejects remote URLs, traversal, symlinks, hardlinks, and non-files', async t => {
  const f = await fixture(t, { inside: probe() });
  const incoming = join(f.root, 'incoming');
  await mkdir(incoming);
  const file = join(incoming, 'inside.mp4');
  await writeFile(file, 'inside');
  assert.equal((await f.store.importOwnedVideo(file)).sourceKind, 'ownedFile');

  const outside = join(f.base, 'outside.mp4');
  await writeFile(outside, 'inside');
  await assert.rejects(f.store.importOwnedVideo(outside), rejectsCode('MEDIA_PATH_OUTSIDE_ROOT'));
  await assert.rejects(f.store.importOwnedVideo('../outside.mp4'), rejectsCode('MEDIA_PATH_OUTSIDE_ROOT'));
  await assert.rejects(f.store.importOwnedVideo('https://cdn.example.test/video.mp4'),
    rejectsCode('REMOTE_MEDIA_NOT_LOCAL'));
  await assert.rejects(f.store.importOwnedVideo(join(f.root, 'missing.mp4')),
    rejectsCode('OWNED_MEDIA_FILE_INVALID'));
  await assert.rejects(f.store.importOwnedVideo(incoming), rejectsCode('OWNED_MEDIA_FILE_INVALID'));

  const linked = join(incoming, 'linked.mp4');
  await symlink(outside, linked);
  await assert.rejects(f.store.importOwnedVideo(linked), rejectsCode('OWNED_MEDIA_FILE_INVALID'));
  const secondName = join(incoming, 'second-name.mp4');
  const { link } = require('node:fs/promises');
  await link(file, secondName);
  await assert.rejects(f.store.importOwnedVideo(file), rejectsCode('OWNED_MEDIA_FILE_INVALID'));
});

test('store-managed objects tolerate an ambient extra hard link while imports still reject aliases', async t => {
  const f = await fixture(t, { clip: probe() });
  const media = await f.store.putVideoBuffer(Buffer.from('clip'));
  const owned = await f.store.getVideo(media.id);
  // Sandboxed runtimes can retain a shadow hard link for the store's own
  // temp-plus-link write, leaving nlink at 2 forever. Store-managed objects
  // must stay readable in that state; their integrity is hash-verified.
  const shadow = join(f.root, 'tmp', `shadow-${media.sha256}.mp4`);
  await link(owned.absolutePath, shadow);
  assert.equal((await f.store.content(media.id)).bytes.toString(), 'clip');
  const again = await f.store.putVideoBuffer(Buffer.from('clip'), 'providerDownload');
  assert.equal(again.id, media.id);

  const incoming = join(f.root, 'incoming');
  await mkdir(incoming);
  const file = join(incoming, 'imported.mp4');
  await writeFile(file, 'distinct-import-content');
  const alias = join(incoming, 'alias.mp4');
  await link(file, alias);
  await assert.rejects(f.store.importOwnedVideo(file), rejectsCode('OWNED_MEDIA_FILE_INVALID'));
  await unlink(alias);
  assert.equal((await f.store.importOwnedVideo(file)).sourceKind, 'ownedFile');
  await unlink(shadow);
});

test('stored objects fail closed after content tampering and unknown IDs are explicit', async t => {
  const f = await fixture(t, { alpha: probe(), tampered: probe() });
  const media = await f.store.putVideoBuffer(Buffer.from('alpha'));
  const content = await f.store.content(media.id);
  assert.equal(content.bytes.toString(), 'alpha');
  content.bytes.fill(0);
  assert.equal((await f.store.content(media.id)).bytes.toString(), 'alpha', 'controller bytes must be detached');
  const owned = await f.store.getVideo(media.id);
  await writeFile(owned.absolutePath, 'tampered');
  await assert.rejects(f.store.content(media.id), rejectsCode('LOCAL_MEDIA_HASH_MISMATCH'));
  await assert.rejects(f.store.getVideo(media.id), rejectsCode('LOCAL_MEDIA_HASH_MISMATCH'));
  await assert.rejects(f.store.getVideo(`media_${'0'.repeat(64)}`), rejectsCode('LOCAL_MEDIA_NOT_FOUND'));
  await assert.rejects(f.store.getVideo('https://example.test/video.mp4'), rejectsCode('REMOTE_MEDIA_NOT_LOCAL'));
});

test('content streaming refuses a symlink substituted for a stored object', async t => {
  const f = await fixture(t, { original: probe() });
  const media = await f.store.putVideoBuffer(Buffer.from('original'));
  const owned = await f.store.getVideo(media.id);
  const outside = join(f.base, 'outside.mp4');
  await writeFile(outside, 'original');
  await unlink(owned.absolutePath);
  await symlink(outside, owned.absolutePath);
  await assert.rejects(f.store.content(media.id), rejectsCode('OWNED_MEDIA_FILE_INVALID'));
});

test('size, duration, resolution and stream metadata limits are enforced before registration', async t => {
  const f = await fixture(t, {
    oversize: probe(), long: probe({ durationSeconds: 11 }), wide: probe({ width: 1922, height: 1080 }),
    noCodec: probe({ videoCodec: '' }),
  }, { limits: { maxBytes: 8, maxDurationSeconds: 10, maxWidth: 1920, maxHeight: 1080,
    maxPixels: 1920 * 1080 } });
  await assert.rejects(f.store.putVideoBuffer(Buffer.alloc(9)), rejectsCode('LOCAL_VIDEO_SIZE_INVALID'));
  await assert.rejects(f.store.putVideoBuffer(Buffer.from('long')), rejectsCode('LOCAL_VIDEO_PROBE_INVALID'));
  await assert.rejects(f.store.putVideoBuffer(Buffer.from('wide')), rejectsCode('LOCAL_VIDEO_PROBE_INVALID'));
  await assert.rejects(f.store.putVideoBuffer(Buffer.from('noCodec')), rejectsCode('LOCAL_VIDEO_PROBE_INVALID'));
  await assert.rejects(f.store.putVideoBuffer('not-a-buffer'), rejectsCode('LOCAL_VIDEO_BUFFER_REQUIRED'));
});

test('ffprobe parser permits one MP4 video and optional audio, rejecting ambiguous streams', () => {
  assert.deepEqual(parseFfprobe({ format: { format_name: 'mov,mp4,m4a,3gp', duration: '3.25' }, streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920 },
    { codec_type: 'audio', codec_name: 'aac' },
  ] }), probe({ durationSeconds: 3.25, width: 1080, height: 1920 }));
  for (const value of [null, {}, { format: { format_name: 'matroska', duration: '2' }, streams: [
    { codec_type: 'video', codec_name: 'h264', width: 10, height: 10 }] },
  { format: { format_name: 'mp4', duration: '2' }, streams: [] },
  { format: { format_name: 'mp4', duration: '2' }, streams: [
    { codec_type: 'video', codec_name: 'h264', width: 10, height: 10 },
    { codec_type: 'video', codec_name: 'h265', width: 10, height: 10 }] }]) {
    assert.throws(() => parseFfprobe(value), rejectsCode('LOCAL_VIDEO_PROBE_INVALID'));
  }
});

test('bounded process runner always uses an argument vector with shell disabled', async () => {
  let invocation;
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough();
      this.killed = false;
    }
    kill() { this.killed = true; return true; }
  }
  const spawn = (command, args, options) => {
    invocation = { command, args, options };
    const child = new FakeChild();
    setImmediate(() => {
      child.stdout.end('safe-output'); child.stderr.end(); child.emit('close', 0, null);
    });
    return child;
  };
  const result = await new BoundedProcessRunner(spawn).run('/usr/bin/fake', ['literal;still-one-arg']);
  assert.equal(result.stdout.toString(), 'safe-output');
  assert.deepEqual(invocation.args, ['literal;still-one-arg']);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('provider HTTPS ingest resolves and checks every address before storing verified MP4 bytes', async t => {
  const f = await fixture(t, { downloaded: probe({ durationSeconds: 4 }) });
  const dnsCalls = [];
  const fetchCalls = [];
  const resolver = { resolve: async hostname => {
    dnsCalls.push(hostname);
    return [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }];
  } };
  const fetcher = { fetch: async (url, options) => {
    fetchCalls.push({ url: url.toString(), options: structuredClone(options) });
    return { status: 200, headers: { 'content-type': 'video/mp4; charset=binary',
      'content-length': String(Buffer.byteLength('downloaded')) }, body: Buffer.from('downloaded') };
  } };
  const ingestor = new ProductionMediaIngestor(f.store, resolver, fetcher,
    { timeoutMs: 3210, maxBytes: 100, maxDnsAddresses: 4 });
  const media = await ingestor.ingestProviderUrl('https://media.provider.example/video.mp4?token=opaque');
  assert.equal(media.sourceKind, 'providerDownload');
  assert.equal((await f.store.getVideo(media.id)).object.id, media.id);
  assert.deepEqual(dnsCalls, ['media.provider.example']);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://media.provider.example/video.mp4?token=opaque');
  assert.deepEqual(fetchCalls[0].options.addresses, [
    { address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]);
  assert.equal(fetchCalls[0].options.timeoutMs, 3210);
  assert.equal(fetchCalls[0].options.maxBytes, 100);
});

test('provider ingest rejects local, private, documentation and mixed DNS answers before fetch', async t => {
  const f = await fixture(t);
  const forbidden = ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.1.1', '172.16.0.1',
    '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
    '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::'];
  for (const address of forbidden) assert.equal(isPublicInternetAddress(address), false, address);
  assert.equal(isPublicInternetAddress('93.184.216.34'), true);
  assert.equal(isPublicInternetAddress('2606:4700:4700::1111'), true);
  let fetches = 0;
  for (const address of forbidden) {
    const family = address.includes(':') ? 6 : 4;
    const ingestor = new ProductionMediaIngestor(f.store,
      { resolve: async () => [{ address, family }] },
      { fetch: async () => { fetches++; throw new Error('must not fetch'); } });
    await assert.rejects(ingestor.ingestProviderUrl('https://media.provider.example/video.mp4'),
      rejectsCode('REMOTE_MEDIA_ADDRESS_FORBIDDEN'), address);
  }
  const mixed = new ProductionMediaIngestor(f.store,
    { resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] },
    { fetch: async () => { fetches++; throw new Error('must not fetch'); } });
  await assert.rejects(mixed.ingestProviderUrl('https://media.provider.example/video.mp4'),
    rejectsCode('REMOTE_MEDIA_ADDRESS_FORBIDDEN'));
  assert.equal(fetches, 0);
});

test('provider ingest forbids redirects and rejects non-MP4, encoded, oversized or inconsistent responses', async t => {
  const f = await fixture(t, { valid: probe() }, { limits: { maxBytes: 16 } });
  const resolver = { resolve: async () => [{ address: '93.184.216.34', family: 4 }] };
  let response;
  const ingestor = new ProductionMediaIngestor(f.store, resolver, { fetch: async () => ({
    ...response, headers: { ...response.headers }, body: Buffer.from(response.body),
  }) },
    { maxBytes: 8 });
  const url = 'https://media.provider.example/video.mp4';
  const cases = [
    [{ status: 302, headers: {}, body: Buffer.alloc(0) }, 'REMOTE_MEDIA_REDIRECT_FORBIDDEN'],
    [{ status: 404, headers: {}, body: Buffer.alloc(0) }, 'REMOTE_MEDIA_FETCH_FAILED'],
    [{ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('valid') }, 'REMOTE_MEDIA_CONTENT_TYPE_INVALID'],
    [{ status: 200, headers: { 'content-type': 'video/mp4', 'content-encoding': 'gzip' }, body: Buffer.from('valid') }, 'REMOTE_MEDIA_ENCODING_INVALID'],
    [{ status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '05' }, body: Buffer.from('valid') }, 'REMOTE_MEDIA_LENGTH_INVALID'],
    [{ status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '4' }, body: Buffer.from('valid') }, 'REMOTE_MEDIA_SIZE_INVALID'],
    [{ status: 200, headers: { 'content-type': 'video/mp4' }, body: Buffer.alloc(9) }, 'REMOTE_MEDIA_SIZE_INVALID'],
  ];
  for (const [value, code] of cases) {
    response = value;
    await assert.rejects(ingestor.ingestProviderUrl(url), rejectsCode(code), code);
  }
});

test('provider URL grammar is strict and IP literals are checked without DNS', async t => {
  const f = await fixture(t);
  let dnsCalls = 0;
  let fetches = 0;
  const ingestor = new ProductionMediaIngestor(f.store, { resolve: async () => { dnsCalls++; return []; } },
    { fetch: async () => { fetches++; throw new Error('must not fetch'); } });
  for (const url of ['http://media.provider.example/v.mp4', ' https://media.provider.example/v.mp4',
    'https://user:pass@media.provider.example/v.mp4', 'https://media.provider.example:8443/v.mp4',
    'https://localhost/v.mp4', 'https://service.local/v.mp4', 'https://127.0.0.1/v.mp4',
    'file:///tmp/video.mp4']) {
    await assert.rejects(ingestor.ingestProviderUrl(url), error => error
      && ['REMOTE_MEDIA_URL_INVALID', 'REMOTE_MEDIA_ADDRESS_FORBIDDEN'].includes(error.code), url);
  }
  assert.equal(dnsCalls, 0);
  assert.equal(fetches, 0);
});

test('default HTTPS fetcher pins the socket lookup and never enables an agent redirect path', async () => {
  let invocation;
  class FakeRequest extends EventEmitter {
    end() {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { 'content-type': 'video/mp4', 'content-length': '5' };
      invocation.onResponse(response);
      response.end('video');
    }
    destroy() { this.destroyed = true; }
  }
  const request = (url, options, onResponse) => {
    invocation = { url, options, onResponse };
    return new FakeRequest();
  };
  const fetcher = new PinnedHttpsMediaFetcher(request);
  const result = await fetcher.fetch(new URL('https://media.provider.example/video.mp4'), {
    addresses: [{ address: '93.184.216.34', family: 4 }], timeoutMs: 1000, maxBytes: 10,
  });
  assert.equal(result.body.toString(), 'video');
  assert.equal(invocation.options.agent, false);
  let pinned;
  invocation.options.lookup('media.provider.example', {}, (_error, list) => { pinned = list; });
  // The all-form array is required: the classic (err, address, family) callback
  // raises ERR_INVALID_IP_ADDRESS on Node 22 without a pinned request family.
  assert.deepEqual(pinned, [{ address: '93.184.216.34', family: 4 }]);
});

test('timeline composition uses only validated local objects, saves a manifest, and is idempotent', async t => {
  const f = await fixture(t, {
    'clip-a': probe({ durationSeconds: 1, width: 721, height: 1279 }),
    'clip-b': probe({ durationSeconds: 2, width: 1080, height: 1920 }),
    composed: probe({ durationSeconds: 3, width: 722, height: 1280 }),
  });
  const first = await f.store.putVideoBuffer(Buffer.from('clip-a'));
  const second = await f.store.putVideoBuffer(Buffer.from('clip-b'));
  const calls = [];
  const runner = { run: async (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options } });
    await writeFile(args.at(-1), 'composed');
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  } };
  const composer = new TimelineComposer(f.store, runner, { now: () => new Date('2026-10-23T01:00:00.000Z') });
  const manifest = await composer.compose({ videoIds: [first.id, second.id], title: '  第一集  ' });
  assert.match(manifest.id, /^timeline_[a-f0-9]{64}$/);
  assert.equal(manifest.title, '第一集');
  assert.equal(manifest.createdAt, '2026-10-23T01:00:00.000Z');
  assert.equal(manifest.output.sourceKind, 'composition');
  assert.equal(manifest.composition.expectedDurationSeconds, 3);
  assert.deepEqual([manifest.composition.width, manifest.composition.height], [722, 1280]);
  assert.deepEqual(manifest.inputs.map(input => input.mediaId), [first.id, second.id]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'ffmpeg');
  assert.ok(calls[0].args.every(value => typeof value === 'string'));
  assert.ok(calls[0].args.some(value => value.includes('concat=n=2:v=1:a=1[vout][aout]')));
  assert.ok(calls[0].args.includes((await f.store.getVideo(first.id)).absolutePath));
  assert.ok(calls[0].args.includes((await f.store.getVideo(second.id)).absolutePath));
  assert.equal(calls[0].args.some(value => /^https?:/i.test(value)), false);
  assert.deepEqual(await composer.compose({ videoIds: [first.id, second.id], title: '第一集' }), manifest);
  assert.equal(calls.length, 1, 'saved timeline must not rerun ffmpeg');
  assert.deepEqual(await f.store.readManifest(manifest.id), manifest);
});

test('composition blocks missing local video, remote URLs, mixed audio and invalid outputs', async t => {
  const f = await fixture(t, {
    voiced: probe({ durationSeconds: 1 }), silent: probe({ durationSeconds: 1, hasAudio: false, audioCodec: null }),
    badoutput: probe({ durationSeconds: 30, width: 720, height: 1280 }),
  }, { limits: { maxDurationSeconds: 60 } });
  const voiced = await f.store.putVideoBuffer(Buffer.from('voiced'));
  const silent = await f.store.putVideoBuffer(Buffer.from('silent'));
  let calls = 0;
  const runner = { run: async (_command, args) => { calls++;
    await writeFile(args.at(-1), 'badoutput'); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; } };
  const composer = new TimelineComposer(f.store, runner);
  await assert.rejects(composer.compose({ videoIds: [] }), rejectsCode('LOCAL_VIDEO_REQUIRED'));
  await assert.rejects(composer.compose({ videoIds: ['https://cdn.example.test/video.mp4'] }),
    rejectsCode('REMOTE_MEDIA_NOT_LOCAL'));
  await assert.rejects(composer.compose({ videoIds: [voiced.id, silent.id] }),
    rejectsCode('TIMELINE_AUDIO_INCOMPATIBLE'));
  assert.equal(calls, 0);
  await assert.rejects(composer.compose({ videoIds: [voiced.id] }), rejectsCode('TIMELINE_OUTPUT_MISMATCH'));
  assert.equal(calls, 1);
  const digest = createHash('sha256').update(JSON.stringify({ version: 1, videoIds: [voiced.id], title: '' })).digest('hex');
  assert.equal(await f.store.readManifest(`timeline_${digest}`), null,
    'a mismatched ffmpeg output must never be registered as a delivered timeline');
});
