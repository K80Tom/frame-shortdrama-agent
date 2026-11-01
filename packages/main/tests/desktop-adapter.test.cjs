const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { MacDoubaoDesktopAdapter } = require('../dist/desktop-assets/adapter');
const { assertUnixMode, canCreateSymlink, WINDOWS_SYMLINK_SKIP } = require('./platform.cjs');

const jobId = 'desktop_0123456789abcdef0123456789abcdef';
const ready = { available: true, installed: true, accessibilityTrusted: true, code: 'DESKTOP_READY', message: 'ready' };
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-adapter-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputPath = path.join(root, 'outputs/private/desktop-assets', jobId, 'result.png');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const adapter = new MacDoubaoDesktopAdapter({ projectRoot: root });
  adapter.health = async () => ready;
  let calls = 0;
  adapter.invoke = async command => {
    assert.equal(command, 'submit'); calls++;
    return { state: 'submitted', code: 'DESKTOP_SUBMITTED', message: 'submitted', taskRef: 'chrome://doubaowork-chat/chat/1234' };
  };
  return { adapter, input: { jobId, prompt: '只生成一张图片', outputPath }, calls: () => calls, root };
}

test('desktop adapter only permits its exact isolated job output', async t => {
  const { adapter, input, calls } = await fixture(t);
  for (const outputPath of ['/tmp/result.png', input.outputPath + '/../result.png']) {
    assert.equal((await adapter.submit({ ...input, outputPath })).code, 'DESKTOP_OUTPUT_PATH_INVALID');
  }
  assert.equal(calls(), 0);
});

test('desktop adapter rejects symlink job directory before any native submission', async t => {
  if (!(await canCreateSymlink())) return t.skip(WINDOWS_SYMLINK_SKIP);
  const { adapter, input, calls, root } = await fixture(t);
  const directory = path.dirname(input.outputPath);
  await fs.rmdir(directory);
  const other = path.join(root, 'other'); await fs.mkdir(other);
  await fs.symlink(other, directory, 'dir');
  assert.equal((await adapter.submit(input)).code, 'DESKTOP_OUTPUT_PATH_INVALID');
  assert.equal(calls(), 0);
});

test('desktop adapter never submits when accessibility health is unavailable', async t => {
  const { adapter, input, calls } = await fixture(t);
  adapter.health = async () => ({ ...ready, available: false, accessibilityTrusted: false,
    code: 'DESKTOP_ACCESSIBILITY_REQUIRED', message: 'permission required' });
  assert.equal((await adapter.submit(input)).state, 'blocked');
  assert.equal(calls(), 0);
});

test('desktop adapter atomically excludes concurrent callers while health is pending', async t => {
  const { adapter, input, calls } = await fixture(t);
  let release;
  adapter.health = async () => new Promise(resolve => { release = () => resolve(ready); });
  const first = adapter.submit(input);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await adapter.submit(input)).code, 'DESKTOP_BUSY');
  release();
  assert.equal((await first).state, 'submitted');
  assert.equal(calls(), 1);
});

test('desktop adapter invokes once and treats an error as unknown without retry', async t => {
  const { adapter, input } = await fixture(t);
  let calls = 0;
  adapter.invoke = async () => { calls++; throw new Error('private diagnostic'); };
  const result = await adapter.submit(input);
  assert.equal(result.state, 'unknown');
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /private diagnostic/);
});

test('desktop adapter rejects malformed result/task references without leaking output', async t => {
  const { adapter, input } = await fixture(t);
  for (const result of [null, { state: 'submitted', code: 'ok', message: 'private' },
    { state: 'submitted', code: 'DESKTOP_SUBMITTED', message: 'submitted', taskRef: 'https://private.example/token' }]) {
    adapter.invoke = async () => result;
    const value = await adapter.submit(input);
    assert.equal(value.state, 'unknown');
    assert.doesNotMatch(JSON.stringify(value), /private/);
  }
});

test('desktop helper source has fixed target and durable marker before its only Return', async () => {
  const source = await fs.readFile(path.join(__dirname, '../desktop-helper/main.swift'), 'utf8');
  assert.match(source, /com\.work\.pc\.doubao\.browser/);
  assert.match(source, /O_WRONLY \| O_CREAT \| O_EXCL \| O_NOFOLLOW/);
  assert.match(source, /fsync\(fd\)/);
  assert.equal((source.match(/try key\(36, app: app\)/g) || []).length, 1);
  assert.ok(source.indexOf('try writeMarker(marker, jobId: input.jobId)') < source.indexOf('try key(36, app: app)'));
  const healthSource = source.slice(source.indexOf('func health()'), source.indexOf('func attribute('));
  assert.doesNotMatch(healthSource, /snapshot\(|targetApp\(|openApplication|WithOptions|CGEvent/);
  assert.match(source, /guard submittedTaskReference\(taskDocumentURL\(nodes\)\) != nil/);
  assert.match(source, /DESKTOP_WINDOWS_AMBIGUOUS/);
  const locatorSource = source.slice(source.indexOf('func composerCandidates('), source.indexOf('func composer('));
  assert.doesNotMatch(locatorSource, /containsLabel\(|composerValue\(|kAXValueAttribute/);
  assert.match(locatorSource, /taskComposerScope\(nodes\)/);
  assert.match(locatorSource, /editableTextAreas\(scope\)/);
  const diagnoseSource = source.slice(source.indexOf('func diagnose()'), source.indexOf('func taskDocumentURL('));
  assert.doesNotMatch(diagnoseSource, /targetApp\(|openApplication|activate\(|press\(|key\(|CGEvent|kAXTitleAttribute/);
  assert.match(diagnoseSource, /diagnosticTaskURLClass\(urls\)/);
  const fillSource = source.slice(source.indexOf('func fill('), source.indexOf('func validate('));
  assert.ok(fillSource.indexOf('kAXValueAttribute as CFString, prompt as CFString') < fillSource.indexOf('NSPasteboard.general'));
  assert.ok(fillSource.indexOf('let fallbackInput = try emptyComposer(current)') < fillSource.indexOf('NSPasteboard.general'));
  assert.match(fillSource, /isExactComposerPrompt\(composerValue\(field\), prompt: prompt\)/);
});

test('native pure guards reject ambiguous pages, windows and incomplete submission text', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-guards-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'guards-test');
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-module-cache-path', path.join(directory, 'module-cache'),
    path.join(__dirname, '../desktop-helper/guards.swift'), path.join(__dirname, 'desktop-helper-guards/main.swift'), '-o', binary], { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr);
  const result = spawnSync(binary, [], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /73 native pure guard assertions passed/);
});

function fakeLauncher(adapter, onLaunch) {
  adapter.launch = (command, args, options) => {
    const child = new EventEmitter();
    child.killCalls = 0;
    child.kill = () => { child.killCalls++; return true; };
    child.unref = () => child;
    setImmediate(() => { Promise.resolve(onLaunch({ command, args, options, child })).catch(error => child.emit('error', error)); });
    return child;
  };
}

test('LaunchServices invocation isolates stdin/stdout and cleans only its own private directory', async t => {
  const { adapter, input, root } = await fixture(t); delete adapter.invoke;
  let directory;
  fakeLauncher(adapter, async ({ command, args, options, child }) => {
    assert.equal(command, '/usr/bin/open');
    assert.deepEqual(args.slice(0, 5), ['-n', '-g', '-W', '-a',
      path.join(root, 'outputs/private/desktop-helper/Lyra Desktop Bridge.app')]);
    assert.deepEqual(args.slice(-2), ['--args', 'submit']);
    assert.equal(args.includes('-F'), false);
    assert.equal(args.some(arg => arg.includes(input.prompt)), false);
    assert.equal(options.shell, false);
    const requestPath = args[args.indexOf('--stdin') + 1];
    const responsePath = args[args.indexOf('--stdout') + 1];
    directory = path.dirname(requestPath);
    assert.equal(path.dirname(responsePath), directory);
    assertUnixMode((await fs.stat(directory)).mode, 0o700);
    assertUnixMode((await fs.stat(requestPath)).mode, 0o600);
    assertUnixMode((await fs.stat(responsePath)).mode, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(requestPath, 'utf8')), input);
    assert.equal(args[args.indexOf('--stderr') + 1], '/dev/null');
    await fs.writeFile(responsePath, JSON.stringify({ state: 'submitted', code: 'DESKTOP_SUBMITTED', message: 'ok' }));
    child.emit('close', 0);
  });
  assert.equal((await adapter.invoke('submit', input)).state, 'submitted');
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  assert.equal((await fs.stat(path.dirname(input.outputPath))).isDirectory(), true);
});

test('LaunchServices timeout retains IPC and prevents duplicate launches until observed app exit', async t => {
  const { input, root } = await fixture(t);
  const adapter = new MacDoubaoDesktopAdapter({ projectRoot: root, timeoutMs: 20 });
  let directory, responsePath, runningChild, calls = 0;
  fakeLauncher(adapter, async ({ args, child }) => {
    calls++; runningChild = child;
    responsePath = args[args.indexOf('--stdout') + 1]; directory = path.dirname(responsePath);
  });
  await assert.rejects(adapter.invoke('submit', input), /HELPER_TIMEOUT/);
  assert.equal(runningChild.killCalls, 0, 'timeout must not pretend killing open cancels the app');
  assert.equal((await fs.stat(directory)).isDirectory(), true);
  await assert.rejects(adapter.invoke('health'), /HELPER_STILL_RUNNING/);
  assert.equal(calls, 1);
  await fs.writeFile(responsePath, '{}');
  runningChild.emit('close', 0);
  for (let i = 0; i < 100 && adapter.launchPending; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(adapter.launchPending, false);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('LaunchServices response refuses symlinks, hardlinks and oversized content', async t => {
  const symlinks = await canCreateSymlink();
  for (const mode of ['symlink', 'hardlink', 'oversized']) {
    if (mode === 'symlink' && !symlinks) { t.diagnostic(WINDOWS_SYMLINK_SKIP); continue; }
    const { adapter, input, root } = await fixture(t); delete adapter.invoke;
    const target = path.join(root, 'unrelated.json'); await fs.writeFile(target, '{"sensitive":"do not return"}');
    fakeLauncher(adapter, async ({ args, child }) => {
      const output = args[args.indexOf('--stdout') + 1];
      if (mode === 'oversized') await fs.writeFile(output, 'x'.repeat(16_385));
      else { await fs.unlink(output); await fs[mode === 'symlink' ? 'symlink' : 'link'](target, output); }
      child.emit('close', 0);
    });
    await assert.rejects(adapter.invoke('submit', input), /HELPER_RESPONSE_UNCERTAIN/);
    assert.equal(await fs.readFile(target, 'utf8'), '{"sensitive":"do not return"}');
  }
});

test('health coalesces concurrent requests and false results expire instead of caching forever', async () => {
  const adapter = new MacDoubaoDesktopAdapter();
  let calls = 0, release;
  adapter.readHealth = async () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { release = () => resolve({ ...ready, available: false, accessibilityTrusted: false }); });
    return ready;
  };
  const first = adapter.health(), second = adapter.health();
  assert.equal(calls, 1); release();
  assert.equal((await first).available, false); assert.equal((await second).available, false);
  assert.equal((await adapter.health()).available, false); assert.equal(calls, 1);
  assert.ok(adapter.healthCache.until <= Date.now() + 2000);
  adapter.healthCache.until = Date.now() - 1;
  assert.equal((await adapter.health()).available, true); assert.equal(calls, 2);
});
