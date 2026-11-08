const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { link, mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } = require('node:fs/promises');
const { isAbsolute, join, relative, resolve, sep } = require('node:path');
const { tmpdir } = require('node:os');
const { canCreateSymlink, WINDOWS_SYMLINK_SKIP } = require('./platform.cjs');
const {
  BoundedProcessRunner,
  PinnedHttpsMediaFetcher,
  ProductionMediaIngestor,
  ProductionMediaStore,
  TimelineComposer,
  isPublicInternetAddress,
  parseAssessment,
  parseFfprobe,
} = require('../dist/production-media');
const { ProductionMediaObjectProjection } = require('../dist/production-media/object-storage');
const {
  LocalObjectStorage,
  S3CompatibleObjectStorage,
  createObjectStorageFromEnv,
  readObjectStorageConfig,
} = require('../dist/infrastructure/object-storage');

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
  const rel = relative(resolve(f.root), resolve(owned.absolutePath));
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  assert.ok(f.prober.paths.length >= 3, 'dedupe and reads must not trust old probe metadata');
});

test('stored hook durably queues both new and deduplicated media before returning', async t => {
  const f = await fixture(t, { projected: probe() });
  const queued = [];
  f.store.setStoredHook(async object => { queued.push(object.id); });
  const first = await f.store.putVideoBuffer(Buffer.from('projected'));
  const duplicate = await f.store.putVideoBuffer(Buffer.from('projected'));
  assert.equal(duplicate.id, first.id);
  assert.deepEqual(queued, [first.id, first.id]);
  assert.throws(() => f.store.setStoredHook(async () => undefined),
    rejectsCode('MEDIA_STORED_HOOK_ALREADY_SET'));
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

  if (await canCreateSymlink()) {
    const linked = join(incoming, 'linked.mp4');
    await symlink(outside, linked);
    await assert.rejects(f.store.importOwnedVideo(linked), rejectsCode('OWNED_MEDIA_FILE_INVALID'));
  } else t.diagnostic(WINDOWS_SYMLINK_SKIP);
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
  if (!(await canCreateSymlink())) return t.skip(WINDOWS_SYMLINK_SKIP);
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

test('allowIntranetMediaSources lets vendor intranet CDNs through while local targets stay blocked', async t => {
  const f = await fixture(t, { intranet: probe({ durationSeconds: 4 }) });
  await t.test('private DNS answer is fetched and stored', async () => {
    const fetchCalls = [];
    const ingestor = new ProductionMediaIngestor(f.store,
      { resolve: async () => [{ address: '10.35.10.197', family: 4 }] },
      { fetch: async (url, options) => {
        fetchCalls.push({ url: url.toString(), addresses: structuredClone(options.addresses) });
        return { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(Buffer.byteLength('intranet')) }, body: Buffer.from('intranet') };
      } }, { allowIntranetMediaSources: true });
    const media = await ingestor.ingestProviderUrl('https://tos-cdn.vendor-cdn.example/video.mp4?x=1');
    assert.equal(media.sourceKind, 'providerDownload');
    assert.equal(fetchCalls.length, 1);
    assert.deepEqual(fetchCalls[0].addresses, [{ address: '10.35.10.197', family: 4 }]);
    assert.equal(fetchCalls[0].url, 'https://tos-cdn.vendor-cdn.example/video.mp4?x=1');
  });
  await t.test('loopback, link-local and local hostnames remain forbidden', async () => {
    let fetches = 0;
    const mustNotFetch = { fetch: async () => { fetches++; throw new Error('must not fetch'); } };
    for (const address of ['127.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fe80::1', '0.0.0.0']) {
      const family = address.includes(':') ? 6 : 4;
      const ingestor = new ProductionMediaIngestor(f.store,
        { resolve: async () => [{ address, family }] }, mustNotFetch, { allowIntranetMediaSources: true });
      await assert.rejects(ingestor.ingestProviderUrl('https://media.provider.example/video.mp4'),
        rejectsCode('REMOTE_MEDIA_ADDRESS_FORBIDDEN'), address);
    }
    const localName = new ProductionMediaIngestor(f.store,
      { resolve: async () => [{ address: '10.1.2.3', family: 4 }] }, mustNotFetch, { allowIntranetMediaSources: true });
    await assert.rejects(localName.ingestProviderUrl('https://assets.localhost/video.mp4'),
      rejectsCode('REMOTE_MEDIA_ADDRESS_FORBIDDEN'));
    assert.equal(fetches, 0);
  });
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

test('auto edit adds title and end cards with crossfades and keeps a deterministic manifest', async t => {
  const f = await fixture(t, {
    'clip-a': probe({ durationSeconds: 1, width: 721, height: 1279 }),
    'clip-b': probe({ durationSeconds: 2, width: 1080, height: 1920 }),
    edited: probe({ durationSeconds: 6.5, width: 722, height: 1280 }),
  });
  const first = await f.store.putVideoBuffer(Buffer.from('clip-a'));
  const second = await f.store.putVideoBuffer(Buffer.from('clip-b'));
  const calls = [];
  const runner = { run: async (command, args) => {
    if (args.includes('-filters')) {
      return { stdout: Buffer.from(' Filters:\n TSC drawtext          V->V       Draw text on top of video frames.\n'),
        stderr: Buffer.alloc(0) };
    }
    calls.push([...args]);
    await writeFile(args.at(-1), 'edited');
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  } };
  const fontPath = join(f.base, 'fixture-font.ttf');
  await writeFile(fontPath, 'font fixture for stub runner');
  const composer = new TimelineComposer(f.store, runner, { now: () => new Date('2026-10-23T01:00:00.000Z'), fontCandidates: [fontPath] });
  const manifest = await composer.compose({ videoIds: [first.id, second.id], title: '吞噬星空',
    edit: { titleCardText: '吞噬星空', titleCardSubtitle: 'AI 自动制作短片',
      endCardText: '本片由 AI 流水线自动生成', transitionSeconds: 0.4 } });
  assert.equal(manifest.composition.strategy, 'ffmpeg-auto-edit');
  assert.equal(manifest.composition.edit.titleCardText, '吞噬星空');
  assert.equal(manifest.composition.edit.titleCardSubtitle, 'AI 自动制作短片');
  assert.equal(manifest.composition.edit.endCardText, '本片由 AI 流水线自动生成');
  assert.equal(manifest.composition.edit.transitionSeconds, 0.4);
  assert.equal(manifest.composition.edit.titleCardSeconds, 2.5);
  assert.equal(manifest.composition.edit.endCardSeconds, 2.2);
  // 1 + 2 + 2.5 + 2.2 - 3 x 0.4 = 6.5
  assert.equal(manifest.composition.expectedDurationSeconds, 6.5);
  assert.equal(calls.length, 1);
  const flat = calls[0].join(' ');
  assert.ok(flat.includes('xfade=transition=fade:duration=0.400:offset=2.100'));
  assert.ok(flat.includes('acrossfade=d=0.400'));
  assert.ok(flat.includes('color=c=0x0A0A0F:s=722x1280:r=30'));
  assert.ok(flat.includes('anullsrc=channel_layout=stereo:sample_rate=48000'));
  const graph = calls[0][calls[0].indexOf('-filter_complex') + 1];
  assert.ok(graph.split(';').every(segment => segment.startsWith('[')),
    'every filter segment must open with an input label so ffmpeg can parse the graph');
  assert.ok(flat.includes("drawtext=fontfile="), 'drawtext-capable ffmpeg must render card text');
  assert.ok(flat.includes("text='吞噬星空'"), 'title card text must be drawn');
  assert.equal(calls[0].some(value => value.includes('concat=n=')), false, 'crossfade path must not use concat');
  assert.deepEqual(await composer.compose({ videoIds: [first.id, second.id], title: '吞噬星空',
    edit: { titleCardText: '吞噬星空', titleCardSubtitle: 'AI 自动制作短片',
      endCardText: '本片由 AI 流水线自动生成', transitionSeconds: 0.4 } }), manifest);
  assert.equal(calls.length, 1, 'saved auto-edit timeline must not rerun ffmpeg');
});

for (const hasDrawtext of [false, true]) test(`auto edit keeps textless cards when drawtext=${hasDrawtext} but no font exists`, async t => {
  const f = await fixture(t, {
    'clip-a': probe({ durationSeconds: 1, width: 721, height: 1279 }),
    'clip-b': probe({ durationSeconds: 2, width: 1080, height: 1920 }),
    edited: probe({ durationSeconds: 6.5, width: 722, height: 1280 }),
  });
  const first = await f.store.putVideoBuffer(Buffer.from('clip-a'));
  const second = await f.store.putVideoBuffer(Buffer.from('clip-b'));
  const calls = [];
  const runner = { run: async (command, args) => {
    if (args.includes('-filters')) {
      return { stdout: Buffer.from(hasDrawtext ? ' TSC drawtext V->V Draw text\n' : ' TSC scale V->V Scale video\n'),
        stderr: Buffer.alloc(0) };
    }
    calls.push([...args]);
    await writeFile(args.at(-1), 'edited');
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  } };
  const composer = new TimelineComposer(f.store, runner, { now: () => new Date('2026-10-23T01:00:00.000Z'), fontCandidates: [] });
  const manifest = await composer.compose({ videoIds: [first.id, second.id], title: '吞噬星空',
    edit: { titleCardText: '吞噬星空', titleCardSubtitle: 'AI 自动制作短片',
      endCardText: '本片由 AI 流水线自动生成', transitionSeconds: 0.4 } });
  assert.equal(manifest.composition.strategy, 'ffmpeg-auto-edit');
  // 卡片时长与转场结构保持不变：1 + 2 + 2.5 + 2.2 - 3 x 0.4 = 6.5
  assert.equal(manifest.composition.expectedDurationSeconds, 6.5);
  assert.equal(calls.length, 1);
  const flat = calls[0].join(' ');
  const graph = calls[0][calls[0].indexOf('-filter_complex') + 1];
  assert.ok(graph.split(';').every(segment => segment.startsWith('[')),
    'every filter segment must open with an input label so ffmpeg can parse the graph');
  assert.equal(flat.includes('drawtext'), false, 'textless fallback must not reference a missing ffmpeg filter');
  assert.ok(flat.includes('color=c=0x0A0A0F:s=722x1280:r=30'), 'cards keep the solid background');
  assert.ok(flat.includes('xfade=transition=fade:duration=0.400:offset=2.100'));
});

test('target duration trims every clip proportionally so the film lands on the frozen length', async t => {
  const f = await fixture(t, {
    'clip-a': probe({ durationSeconds: 4, width: 1080, height: 1920 }),
    'clip-b': probe({ durationSeconds: 6, width: 1080, height: 1920 }),
    edited: probe({ durationSeconds: 10, width: 1080, height: 1920 }),
  });
  const first = await f.store.putVideoBuffer(Buffer.from('clip-a'));
  const second = await f.store.putVideoBuffer(Buffer.from('clip-b'));
  const calls = [];
  const runner = { run: async (command, args) => {
    if (args.includes('-filters')) {
      return { stdout: Buffer.from(' Filters:\n TSC drawtext V->V Draw text.\n'), stderr: Buffer.alloc(0) };
    }
    calls.push([...args]);
    await writeFile(args.at(-1), 'edited');
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  } };
  const composer = new TimelineComposer(f.store, runner);
  const manifest = await composer.compose({ videoIds: [first.id, second.id], title: '吞噬星空',
    edit: { titleCardText: '吞噬星空', titleCardSubtitle: 'AI 自动制作短片',
      endCardText: '本片由 AI 流水线自动生成', transitionSeconds: 0.4, targetSeconds: 10 } });
  // pieces = title + 2 clips + end = 4, transitions = 3 x 0.4 = 1.2 overlap
  // scale = (10 - 4.7 + 1.2) / 10 = 0.65 -> clip durations 2.6s and 3.9s
  assert.equal(manifest.composition.strategy, 'ffmpeg-auto-edit');
  assert.ok(Math.abs(manifest.composition.expectedDurationSeconds - 10) < 0.01);
  const flat = calls[0].join(' ');
  assert.ok(flat.includes('trim=duration=2.600'), 'first clip must be trimmed to 2.6s');
  assert.ok(flat.includes('trim=duration=3.900'), 'second clip must be trimmed to 3.9s');
  assert.ok(flat.includes('atrim=duration=2.600'), 'audio must be trimmed in sync');
  assert.ok(flat.includes('trim=duration=2.500') === false, 'cards keep their own fixed durations');
  assert.ok(flat.includes('xfade=transition=fade:duration=0.400:offset=4.300'), 'crossfade offsets follow trimmed durations');
});

test('frame-assessment directives drop, trim and speed up clips before the timeline is built', async t => {
  const f = await fixture(t, {
    'clip-a': probe({ durationSeconds: 4, width: 1080, height: 1920 }),
    'clip-b': probe({ durationSeconds: 6, width: 1080, height: 1920 }),
    'clip-c': probe({ durationSeconds: 5, width: 1080, height: 1920 }),
    edited: probe({ durationSeconds: 10.7, width: 1080, height: 1920 }),
  });
  const first = await f.store.putVideoBuffer(Buffer.from('clip-a'));
  const second = await f.store.putVideoBuffer(Buffer.from('clip-b'));
  const third = await f.store.putVideoBuffer(Buffer.from('clip-c'));
  const calls = [];
  const runner = { run: async (command, args) => {
    if (args.includes('-filters')) return { stdout: Buffer.from(' Filters:\n TSC drawtext V->V Draw text.\n'), stderr: Buffer.alloc(0) };
    calls.push([...args]);
    await writeFile(args.at(-1), 'edited');
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  } };
  const composer = new TimelineComposer(f.store, runner);
  const manifest = await composer.compose({ videoIds: [first.id, second.id, third.id], title: '吞噬星空',
    edit: { titleCardText: '吞噬星空', titleCardSubtitle: 'AI 自动制作短片', endCardText: '本片由 AI 流水线自动生成',
      transitionSeconds: 0.4, targetSeconds: null,
      clipDirectives: [
        { videoId: first.id, action: 'speedup', speedFactor: 1.25 },
        { videoId: second.id, action: 'trim', trimSeconds: 4 },
        { videoId: third.id, action: 'drop' },
      ] } });
  assert.equal(manifest.composition.strategy, 'ffmpeg-auto-edit');
  // kept = 2 clips (3.2s after 1.25x speed + 4s trimmed) + title 2.5 + end 2.2, 3 x 0.4 overlap
  assert.ok(Math.abs(manifest.composition.expectedDurationSeconds - 10.7) < 0.05);
  const flat = calls.join(' ');
  assert.ok(flat.includes('setpts=PTS/1.25'), 'speedup clip must use setpts division');
  assert.ok(flat.includes('atempo=1.25'), 'speedup clip must keep audio in sync');
  assert.ok(flat.includes('trim=duration=4.000'), 'trim directive must shorten the clip');
  const mediaInputs = calls[0].filter((arg, index) => calls[0][index - 1] === '-i' && arg.endsWith('.mp4'));
  assert.equal(mediaInputs.length, 2, 'dropped clip must not be passed as an input file');
  assert.equal(manifest.inputs.length, 2, 'dropped clip must not appear in the manifest inputs');
});

test('target fallback keeps assessment speed and trims the source so playback hits the target', async t => {
  const f = await fixture(t, {
    'clip-a': probe({ durationSeconds: 12, width: 1080, height: 1920 }),
    'clip-b': probe({ durationSeconds: 12, width: 1080, height: 1920 }),
    edited: probe({ durationSeconds: 5, width: 1080, height: 1920 }),
  });
  const first = await f.store.putVideoBuffer(Buffer.from('clip-a'));
  const second = await f.store.putVideoBuffer(Buffer.from('clip-b'));
  const calls = [];
  const runner = { run: async (command, args) => {
    if (args.includes('-filters')) return { stdout: Buffer.from(' Filters:\n TSC drawtext V->V Draw text.\n'), stderr: Buffer.alloc(0) };
    calls.push([...args]);
    await writeFile(args.at(-1), 'edited');
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  } };
  const composer = new TimelineComposer(f.store, runner);
  // 12s at 2x is already 6s, past the 5s target, so free-clip scaling cannot
  // land the film. Uniform playback scale is 5/18: 1.667s + 3.333s, and both
  // source trims are 3.333s. The speedup must survive that scale.
  const manifest = await composer.compose({ videoIds: [first.id, second.id], title: '目标时长',
    edit: { transitionSeconds: 0, targetSeconds: 5, clipDirectives: [
      { videoId: first.id, action: 'speedup', speedFactor: 2 },
    ] } });
  assert.ok(Math.abs(manifest.composition.expectedDurationSeconds - 5) < 0.01);
  const flat = calls[0].join(' ');
  assert.ok(flat.includes('[0:v:0]trim=duration=3.333,setpts=PTS/2,'), 'sped-up clip keeps its factor after the source trim');
  assert.ok(flat.includes('[0:a:0]atrim=duration=3.333,atempo=2,'), 'sped-up audio stays in sync');
  assert.ok(flat.includes('[1:v:0]trim=duration=3.333,setpts=PTS-STARTPTS,'), 'free clip is trimmed to the scaled playback');
  assert.equal(flat.includes('[1:v:0]trim=duration=3.333,setpts=PTS/'), false);
});

test('target fallback refuses a scale that would leave an assessed clip under one second', async t => {
  const f = await fixture(t, {
    'clip-a': probe({ durationSeconds: 12, width: 1080, height: 1920 }),
    'clip-b': probe({ durationSeconds: 40, width: 1080, height: 1920 }),
  });
  const first = await f.store.putVideoBuffer(Buffer.from('clip-a'));
  const second = await f.store.putVideoBuffer(Buffer.from('clip-b'));
  let rendered = 0;
  const runner = { run: async (_command, args) => {
    if (args.includes('-filters')) return { stdout: Buffer.from(''), stderr: Buffer.alloc(0) };
    rendered++;
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  } };
  const composer = new TimelineComposer(f.store, runner);
  await assert.rejects(composer.compose({ videoIds: [first.id, second.id], title: '过短',
    edit: { transitionSeconds: 0, targetSeconds: 5, clipDirectives: [
      { videoId: first.id, action: 'speedup', speedFactor: 2 },
    ] } }), rejectsCode('TIMELINE_TARGET_TOO_SHORT'));
  assert.equal(rendered, 0, 'an impossible target must not render a timeline that misses the plan');
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

function assessment(body, shotId = 'shot_one', durationSeconds = 5) {
  return parseAssessment(JSON.stringify(body), shotId, durationSeconds);
}

test('frame assessment does not keep a pass the dimension scores do not support', () => {
  const missing = parseAssessment('{"verdict":"pass"}', 'shot_missing', 5);
  assert.equal(missing.verdict, 'reject');
  assert.equal(missing.advice.action, 'drop');
  assert.ok(missing.issues.includes('分数低于维度规则，已降级判定'));
  assert.ok(missing.issues.includes('不合格镜头不会按保留处理'));

  const oneLow = assessment({
    verdict: 'pass',
    scores: { identity: 5, anatomy: 5, action: 2, quality: 5 },
    advice: { action: 'keep', speedFactor: 1, trimSeconds: null, reason: '还可以' },
  }, 'shot_weak');
  assert.equal(oneLow.verdict, 'weak');
  assert.equal(oneLow.advice.action, 'keep');

  const twoLow = assessment({
    verdict: 'weak',
    scores: { identity: 1, anatomy: 5, action: 2, quality: 5 },
    advice: { action: 'keep', speedFactor: 1, trimSeconds: null, reason: '多处不合格' },
  }, 'shot_reject');
  assert.equal(twoLow.verdict, 'reject');
  assert.equal(twoLow.advice.action, 'drop');

  const consistent = assessment({
    verdict: 'pass',
    scores: { identity: 5, anatomy: 4, action: 4, quality: 5 },
    advice: { action: 'keep', speedFactor: 1, trimSeconds: null, reason: '画面稳定' },
  }, 'shot_pass');
  assert.equal(consistent.verdict, 'pass');
  assert.equal(consistent.advice.action, 'keep');
  assert.deepEqual(consistent.issues, []);

  const explicitReject = assessment({
    verdict: 'reject',
    scores: { identity: 5, anatomy: 5, action: 5, quality: 5 },
    advice: { action: 'keep', speedFactor: 1.4, trimSeconds: 2, reason: '畸形' },
  }, 'shot_model_reject');
  assert.equal(explicitReject.verdict, 'reject');
  assert.equal(explicitReject.advice.action, 'drop');
  assert.equal(explicitReject.advice.speedFactor, 1);
  assert.equal(explicitReject.advice.trimSeconds, null);

  const salvaged = assessment({
    verdict: 'reject',
    scores: { identity: 1, anatomy: 1, action: 5, quality: 5 },
    advice: { action: 'trim', speedFactor: 1, trimSeconds: 2, reason: '裁掉破损开头' },
  }, 'shot_trim');
  assert.equal(salvaged.verdict, 'reject');
  assert.equal(salvaged.advice.action, 'trim');
  assert.equal(salvaged.advice.trimSeconds, 2);

  const unknown = assessment({
    verdict: 'maybe',
    scores: { identity: 5, anatomy: 5, action: 5, quality: 5 },
    advice: { action: 'keep', speedFactor: 1, trimSeconds: null, reason: '' },
  }, 'shot_unknown');
  assert.equal(unknown.verdict, 'weak');
  assert.equal(unknown.advice.action, 'keep');
});


const { timelineFontCandidates, findTimelineFont, timelineFontFilterPath } =
  require('../dist/production-media/timeline-fonts');

test('timeline fonts use Windows system root and preserve Unix fallbacks', () => {
  assert.deepEqual(timelineFontCandidates('win32', 'D:\\Windows'), [
    'D:/Windows/Fonts/msyh.ttc', 'D:/Windows/Fonts/simhei.ttf', 'D:/Windows/Fonts/arial.ttf',
  ]);
  assert.equal(timelineFontCandidates('win32', 'D:/系统目录')[0], 'D:/系统目录/Fonts/msyh.ttc');
  for (const root of ['relative', '//server/share', '\\\\server\\share', "C:/Windows';evil", 'C:/Windows;evil', 'C:/Windows\n']) {
    assert.equal(timelineFontCandidates('win32', root)[0], 'C:/Windows/Fonts/msyh.ttc');
  }
  assert.ok(timelineFontCandidates('linux').includes('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'));
  assert.ok(timelineFontCandidates('darwin').includes('/System/Library/Fonts/PingFang.ttc'));
  assert.equal(timelineFontCandidates('linux').some(path => path.includes('Windows')), false);
});

test('timeline font lookup tries missing fonts in order and returns null without a readable font', async () => {
  const visited = [];
  assert.equal(await findTimelineFont(['missing', 'valid', 'unused'], async path => {
    visited.push(path); return path === 'valid';
  }), 'valid');
  assert.deepEqual(visited, ['missing', 'valid']);
  assert.equal(await findTimelineFont(['missing'], async () => false), null);
  assert.equal(await findTimelineFont([], async () => { throw new Error('must not read'); }), null);
});

test('drawtext font paths normalize Windows separators and escape drive colons', () => {
  assert.equal(timelineFontFilterPath('C:\\Windows\\Fonts\\msyh.ttc'), 'C\\:/Windows/Fonts/msyh.ttc');
  assert.equal(timelineFontFilterPath('/System/Library/Fonts/Hiragino Sans GB.ttc'),
    '/System/Library/Fonts/Hiragino Sans GB.ttc');
  for (const path of ["C:/font'bad.ttf", '/font;evil.ttf', '/font,evil.ttf', '/font[evil].ttf', 'relative.ttf', '/font.ttf\n']) {
    assert.throws(() => timelineFontFilterPath(path), TypeError);
  }
});


test('real FFmpeg smoke: local font produces visible title pixels', {
  skip: process.env.LYRA_TEST_FFMPEG !== '1',
}, async () => {
  const { spawnSync } = require('node:child_process');
  const font = await findTimelineFont(timelineFontCandidates());
  assert.ok(font, 'local integration environment must provide a readable system font');
  const filter = `drawtext=fontfile='${timelineFontFilterPath(font)}':text='中文测试':fontcolor=white:fontsize=32:x=10:y=10`;
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'color=c=black:s=320x180:d=0.1', '-vf', filter, '-frames:v', '1', '-f', 'rawvideo',
    '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1024 * 1024, timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr?.toString());
  assert.equal(result.stdout.length, 320 * 180 * 3);
  assert.ok(result.stdout.some(channel => channel > 128), 'text must change the black frame');

});
test('object storage scopes immutable local bytes by workspace and explicitly projects verified media', async t => {
  const f = await fixture(t, { clip: probe() });
  const objects = new LocalObjectStorage(join(f.base, 'object-store'));
  const firstScope = { workspaceId: `ws_${'1'.repeat(32)}` };
  const otherScope = { workspaceId: `ws_${'2'.repeat(32)}` };
  await objects.probe();
  const saved = await objects.put({ scope: firstScope, key: 'assets/clip.bin', body: Buffer.from('clip'),
    contentType: 'application/octet-stream' });
  assert.equal(saved.sha256, createHash('sha256').update('clip').digest('hex'));
  assert.equal((await objects.get({ scope: firstScope, key: saved.key, maxBytes: 100 })).body.toString(), 'clip');
  await assert.rejects(objects.get({ scope: otherScope, key: saved.key, maxBytes: 100 }),
    error => error.code === 'OBJECT_NOT_FOUND');
  await assert.rejects(objects.put({ scope: firstScope, key: '../escape', body: Buffer.from('x'),
    contentType: 'application/octet-stream' }), error => error.code === 'OBJECT_KEY_INVALID');

  const media = await f.store.putVideoBuffer(Buffer.from('clip'));
  const projection = new ProductionMediaObjectProjection(f.store, objects);
  const reference = await projection.project(firstScope, media.id);
  assert.equal(reference.sha256, media.sha256);
  assert.equal((await projection.restore(firstScope, reference)).id, media.id);

  const unusableRoot = join(f.base, 'object-store-file');
  await writeFile(unusableRoot, 'not a directory');
  await assert.rejects(new LocalObjectStorage(unusableRoot).probe(),
    error => error.code === 'OBJECT_STORAGE_UNAVAILABLE');
});

test('S3-compatible adapter keeps provider boundaries explicit and only signs tenant staging keys', async () => {
  const saved = new Map(); let signed;
  const client = {
    async headBucket(input) { assert.equal(input.Bucket, 'lyra-media'); return {}; },
    async putObject(input) {
      saved.set(input.Key, { body: Buffer.from(input.Body), metadata: input.Metadata,
        type: input.ContentType }); return { ETag: '"etag-one"', VersionId: 'v1' };
    },
    async headObject(input) {
      const value = saved.get(input.Key); if (!value) throw { name: 'NotFound' };
      return { ContentLength: value.body.length, ContentType: value.type, Metadata: value.metadata,
        ETag: '"etag-one"', VersionId: 'v1' };
    },
    async getObject(input) {
      const value = saved.get(input.Key); if (!value) throw { name: 'NotFound' };
      return { Body: value.body, ContentType: value.type, Metadata: value.metadata,
        ETag: '"etag-one"', VersionId: 'v1' };
    },
    async deleteObject(input) { saved.delete(input.Key); return {}; },
  };
  const scope = { workspaceId: `ws_${'3'.repeat(32)}` };
  const storage = new S3CompatibleObjectStorage(client, { provider: 'cos', bucket: 'lyra-media',
    prefix: 'prod', now: () => new Date('2026-11-08T00:00:00.000Z'),
    presignPut: async (input, ttl) => { signed = { input, ttl }; return 'https://storage.test/signed'; },
    presignGet: async (input, ttl) => { signed = { input, ttl }; return 'https://storage.test/download'; } });
  await storage.probe();
  const object = await storage.put({ scope, key: 'media/a.mp4', body: Buffer.from('movie'),
    contentType: 'video/mp4' });
  assert.equal(object.provider, 'cos');
  assert.ok(saved.has(`prod/workspaces/${scope.workspaceId}/media/a.mp4`));
  await assert.rejects(storage.createPresignedPut({ scope, key: 'media/direct.mp4',
    contentType: 'video/mp4', expiresInSeconds: 60, expectedSha256: 'a'.repeat(64) }),
  error => error.code === 'OBJECT_STAGING_REQUIRED');
  const upload = await storage.createPresignedPut({ scope, key: 'staging/request/a.mp4',
    contentType: 'video/mp4', expiresInSeconds: 60, expectedSha256: 'a'.repeat(64) });
  assert.equal(upload.expiresAt, '2026-11-08T00:01:00.000Z');
  assert.equal(signed.input.Key, `prod/workspaces/${scope.workspaceId}/staging/request/a.mp4`);
  assert.equal(signed.ttl, 60);
  const download = await storage.createPresignedGet({ scope, key: object.key,
    expiresInSeconds: 90, expectedSha256: object.sha256 });
  assert.equal(download.url, 'https://storage.test/download');
  assert.equal(download.expiresAt, '2026-11-08T00:01:30.000Z');
  assert.equal(signed.input.Key, `prod/workspaces/${scope.workspaceId}/media/a.mp4`);
  assert.equal(signed.ttl, 90);

  const denied = new S3CompatibleObjectStorage({ ...client, async headBucket() { throw { name: 'Forbidden' }; } },
    { provider: 's3', bucket: 'lyra-media' });
  await assert.rejects(denied.probe(), error => error.code === 'OBJECT_STORAGE_UNAVAILABLE');
});

test('S3-compatible reads reject declared oversized objects before consuming the response body', async () => {
  let reads = 0;
  const body = {
    async *[Symbol.asyncIterator]() {
      reads++;
      yield Buffer.from('must-not-be-read');
    },
  };
  const client = {
    async headBucket() { return {}; }, async putObject() { return {}; },
    async headObject() { throw { name: 'NotFound' }; }, async deleteObject() { return {}; },
    async getObject() { return { ContentLength: 11, Body: body }; },
  };
  const storage = new S3CompatibleObjectStorage(client, { provider: 's3', bucket: 'lyra-media' });
  await assert.rejects(storage.get({ scope: { workspaceId: `ws_${'4'.repeat(32)}` },
    key: 'media/large.mp4', maxBytes: 10 }), rejectsCode('OBJECT_SIZE_INVALID'));
  assert.equal(reads, 0, 'declared oversized responses must fail before the stream is read');
});

test('S3-compatible reads prefer bounded streaming over transformToByteArray', async () => {
  const bytes = Buffer.from('movie');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let transformed = 0;
  let streamed = 0;
  const body = {
    async *[Symbol.asyncIterator]() {
      streamed++;
      yield bytes.subarray(0, 2);
      yield bytes.subarray(2);
    },
    async transformToByteArray() {
      transformed++;
      return bytes;
    },
  };
  const client = {
    async headBucket() { return {}; }, async putObject() { return {}; },
    async headObject() { throw { name: 'NotFound' }; }, async deleteObject() { return {}; },
    async getObject() { return { ContentLength: bytes.length, ContentType: 'video/mp4',
      Metadata: { sha256 }, Body: body }; },
  };
  const storage = new S3CompatibleObjectStorage(client, { provider: 'minio', bucket: 'lyra-media' });
  const result = await storage.get({ scope: { workspaceId: `ws_${'5'.repeat(32)}` },
    key: 'media/movie.mp4', expectedSha256: sha256, maxBytes: 10 });
  assert.equal(result.body.toString(), 'movie');
  assert.equal(streamed, 1);
  assert.equal(transformed, 0, 'the unbounded SDK helper must not win over an async iterator');
});

test('S3-compatible streaming stops as soon as cumulative bytes exceed the read limit', async () => {
  let yielded = 0;
  const body = {
    async *[Symbol.asyncIterator]() {
      for (const chunk of ['123456', '789012', 'must-not-be-read']) {
        yielded++;
        yield Buffer.from(chunk);
      }
    },
  };
  const client = {
    async headBucket() { return {}; }, async putObject() { return {}; },
    async headObject() { throw { name: 'NotFound' }; }, async deleteObject() { return {}; },
    async getObject() { return { Body: body }; },
  };
  const storage = new S3CompatibleObjectStorage(client, { provider: 'cos', bucket: 'lyra-media' });
  await assert.rejects(storage.get({ scope: { workspaceId: `ws_${'6'.repeat(32)}` },
    key: 'media/unbounded.mp4', maxBytes: 10 }), rejectsCode('OBJECT_SIZE_INVALID'));
  assert.equal(yielded, 2, 'stream consumption must stop on the first over-limit chunk');
});

test('object storage runtime maps Stage 1 environment into a lazy MinIO SDK client', () => {
  let clientOptions;
  class Command { constructor(input) { this.input = input; } }
  class S3Client { constructor(options) { clientOptions = options; } async send() { return {}; } }
  const s3Module = { S3Client, HeadBucketCommand: Command, PutObjectCommand: Command, GetObjectCommand: Command,
    HeadObjectCommand: Command, DeleteObjectCommand: Command };
  const storage = createObjectStorageFromEnv({ OBJECT_STORAGE_PROVIDER: 'minio',
    OBJECT_STORAGE_ENDPOINT: 'http://minio:9000', OBJECT_STORAGE_REGION: 'us-east-1',
    OBJECT_STORAGE_BUCKET: 'lyra-media', OBJECT_STORAGE_ACCESS_KEY: 'access',
    OBJECT_STORAGE_SECRET_KEY: 'secret', OBJECT_STORAGE_FORCE_PATH_STYLE: 'true' }, {
    s3Module, presignerModule: { async getSignedUrl() { return 'https://storage.test/signed'; } },
  });
  assert.equal(storage.provider, 'minio');
  assert.equal(clientOptions.endpoint, 'http://minio:9000');
  assert.equal(clientOptions.forcePathStyle, true);
  assert.deepEqual(clientOptions.credentials, { accessKeyId: 'access', secretAccessKey: 'secret' });
  assert.throws(() => readObjectStorageConfig({ OBJECT_STORAGE_PROVIDER: 's3',
    OBJECT_STORAGE_ENDPOINT: 'http://insecure.test', OBJECT_STORAGE_BUCKET: 'bucket' }),
  /HTTP 仅允许 MinIO/);
});
