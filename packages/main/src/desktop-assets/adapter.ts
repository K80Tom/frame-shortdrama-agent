import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { access, lstat, realpath, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export interface DesktopBridgeHealth {
  available: boolean;
  installed: boolean;
  accessibilityTrusted: boolean;
  code: string;
  message: string;
  appVersion?: string;
  /** Present for a configured API adapter. Legacy desktop bridges omit it. */
  model?: string;
  connectionRevision?: string;
  transport?: 'api' | 'desktop';
}
export interface DesktopSubmitInput {
  jobId: string;
  prompt: string;
  outputPath: string;
  expectedModelConnectionRevision?: string;
}
export interface DesktopSubmitResult {
  state: 'submitted' | 'blocked' | 'unknown';
  code: string;
  message: string;
  taskRef?: string;
}
export interface DesktopAssetAdapter {
  /** Desktop mode needs an operational save-path prompt; API mode receives a
   * pure visual prompt and writes the returned bytes itself. */
  readonly promptMode?: 'api' | 'desktop';
  health(): Promise<DesktopBridgeHealth>;
  submit(input: DesktopSubmitInput): Promise<DesktopSubmitResult>;
}
export interface MacDoubaoDesktopAdapterOptions { projectRoot?: string; helperPath?: string; timeoutMs?: number }

const safeCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(value);
const safeMessage = (value: unknown): value is string => typeof value === 'string' && value.length <= 500 && !value.includes('\0');
function unavailable(code: string, message: string): DesktopBridgeHealth {
  return { available: false, installed: false, accessibilityTrusted: false, code, message };
}

/** LaunchServices starts the granted app as an app, not a Node child binary.
 * Private, short-lived stdin/stdout files keep prompts out of argv and logs. */
export class MacDoubaoDesktopAdapter implements DesktopAssetAdapter {
  readonly promptMode = 'desktop' as const;
  private readonly projectRoot: string;
  private readonly helperPath: string;
  private readonly timeoutMs: number;
  private active = false;
  private launchPending = false;
  private healthFlight: Promise<DesktopBridgeHealth> | null = null;
  private healthCache: { until: number; value: DesktopBridgeHealth } | null = null;
  constructor(options: MacDoubaoDesktopAdapterOptions = {}) {
    this.projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    this.helperPath = options.helperPath ?? path.join(this.projectRoot,
      'outputs/private/desktop-helper/OHAO Desktop Bridge.app/Contents/MacOS/OHAODesktopBridge');
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }
  private launch(command: string, args: string[], options: SpawnOptions): ChildProcess { return spawn(command, args, options); }
  private async invoke(command: 'health' | 'submit', input?: DesktopSubmitInput): Promise<unknown> {
    // Includes a timed-out app whose -W observer has not seen it exit. Never
    // accumulate background app instances just because status is being polled.
    if (this.launchPending) throw new Error('HELPER_STILL_RUNNING');
    this.launchPending = true;
    const bundlePath = path.dirname(path.dirname(path.dirname(this.helperPath)));
    const base = path.join(this.projectRoot, 'outputs/private/desktop-bridge-ipc');
    let directory = '';
    try {
      await mkdir(base, { recursive: true, mode: 0o700 });
      if (await realpath(base) !== base) throw new Error('HELPER_IPC_PATH_INVALID');
      directory = await mkdtemp(path.join(base, 'call-'));
      const request = await open(path.join(directory, 'request.json'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await request.writeFile(input ? JSON.stringify(input) : ''); } finally { await request.close(); }
      const response = await open(path.join(directory, 'response.json'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await response.close();
    } catch {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      this.launchPending = false;
      throw new Error('HELPER_IPC_UNAVAILABLE');
    }
    const requestPath = path.join(directory, 'request.json'), responsePath = path.join(directory, 'response.json');
    return new Promise((resolve, reject) => {
      const cleanup = async () => {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        this.launchPending = false;
      };
      // -n ensures this invocation receives its arguments; -g does not focus
      // the bridge. The helper itself activates Doubao only for submit.
      let child: ChildProcess;
      try {
        child = this.launch('/usr/bin/open', ['-n', '-g', '-W', '-a', bundlePath,
          '--stdin', command === 'submit' ? requestPath : '/dev/null', '--stdout', responsePath,
          '--stderr', '/dev/null', '--args', command], { stdio: 'ignore', shell: false,
            env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'zh_CN.UTF-8' } });
      } catch { void cleanup().then(() => reject(new Error('HELPER_UNAVAILABLE'))); return; }
      let settled = false, closed = false, retainForReconciliation = false;
      let observerDeadline: NodeJS.Timeout | undefined;
      const settle = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => {
        settle(new Error('HELPER_TIMEOUT'));
        // Killing open is not cancelling the app. Keep -W alive to observe its
        // exit and preserve the files while that app might still read them.
        child.unref();
        observerDeadline = setTimeout(() => {
          if (closed) return;
          retainForReconciliation = true;
          child.kill('SIGTERM');
          // Only the observer is stopped. Keep the tiny IPC directory and
          // launchPending guard: the app's state is still unknown.
        }, 10 * 60_000);
        observerDeadline.unref();
      }, command === 'health' ? 10_000 : this.timeoutMs);
      child.on('error', async () => {
        if (closed || retainForReconciliation) return;
        closed = true; clearTimeout(timer); if (observerDeadline) clearTimeout(observerDeadline);
        await cleanup(); settle(new Error('HELPER_UNAVAILABLE'));
      });
      child.on('close', async code => {
        if (closed) return;
        closed = true; clearTimeout(timer); if (observerDeadline) clearTimeout(observerDeadline);
        if (retainForReconciliation) return;
        let value: unknown, error: Error | undefined;
        try {
          if (code !== 0) throw new Error('HELPER_LAUNCH_FAILED');
          const before = await lstat(responsePath);
          if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 16_384) throw new Error('HELPER_OUTPUT_LIMIT');
          const response = await open(responsePath, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const info = await response.stat();
            if (!info.isFile() || info.nlink !== 1 || info.size > 16_384 || info.dev !== before.dev || info.ino !== before.ino) throw new Error('HELPER_OUTPUT_LIMIT');
            const bytes = await response.readFile();
            if (bytes.length > 16_384) throw new Error('HELPER_OUTPUT_LIMIT');
            value = JSON.parse(bytes.toString('utf8'));
          } finally { await response.close(); }
        } catch { error = new Error('HELPER_RESPONSE_UNCERTAIN'); }
        await cleanup(); settle(error, value);
      });
    });
  }
  async health(): Promise<DesktopBridgeHealth> {
    if (this.healthCache && this.healthCache.until > Date.now()) return { ...this.healthCache.value };
    if (this.healthFlight) return this.healthFlight;
    const flight = this.readHealth();
    this.healthFlight = flight;
    try {
      const value = await flight;
      this.healthCache = { until: Date.now() + 2000, value };
      return { ...value };
    } finally { if (this.healthFlight === flight) this.healthFlight = null; }
  }
  private async readHealth(): Promise<DesktopBridgeHealth> {
    if (process.platform !== 'darwin') return unavailable('DESKTOP_PLATFORM_UNSUPPORTED', '桌面豆包生图目前只支持 macOS。');
    try { await access(this.helperPath, constants.X_OK); }
    catch { return unavailable('DESKTOP_HELPER_NOT_BUILT', '桌面桥尚未构建，请运行 node scripts/build-desktop-helper.mjs。'); }
    try {
      const value = await this.invoke('health') as Partial<DesktopBridgeHealth> | null;
      if (!value || typeof value.available !== 'boolean' || typeof value.installed !== 'boolean'
        || typeof value.accessibilityTrusted !== 'boolean' || !safeCode(value.code) || !safeMessage(value.message)
        || (value.appVersion !== undefined && (typeof value.appVersion !== 'string' || !/^[0-9.]{1,30}$/.test(value.appVersion)))) {
        return unavailable('DESKTOP_HEALTH_INVALID', '桌面桥返回了无法核对的状态，未启用生成。');
      }
      return { available: value.available && value.installed && value.accessibilityTrusted,
        installed: value.installed, accessibilityTrusted: value.accessibilityTrusted,
        code: value.code, message: value.message, ...(value.appVersion ? { appVersion: value.appVersion } : {}) };
    } catch { return unavailable('DESKTOP_HELPER_UNAVAILABLE', '桌面桥暂不可用，请检查本机安装和辅助功能权限。'); }
  }
  async submit(input: DesktopSubmitInput): Promise<DesktopSubmitResult> {
    if (this.active) return { state: 'blocked', code: 'DESKTOP_BUSY', message: '另一个桌面任务正在提交，请稍后再试。' };
    // Claim before the first await, including health checks, so two incoming
    // HTTP requests cannot both pass the desktop exclusivity guard.
    this.active = true;
    try { return await this.submitExclusive(input); }
    finally { this.active = false; }
  }
  private async submitExclusive(input: DesktopSubmitInput): Promise<DesktopSubmitResult> {
    const blocked = (code: string, message: string): DesktopSubmitResult => ({ state: 'blocked', code, message });
    if (!/^desktop_[a-f0-9]{32}$/.test(input.jobId) || typeof input.prompt !== 'string'
      || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 32_000 || input.prompt.includes('\0')) {
      return blocked('DESKTOP_INPUT_INVALID', '桌面任务输入不合法。');
    }
    const expected = path.join(this.projectRoot, 'outputs/private/desktop-assets', input.jobId, 'result.png');
    if (input.outputPath !== expected) return blocked('DESKTOP_OUTPUT_PATH_INVALID', '任务输出路径不合法。');
    try {
      const directory = path.dirname(expected);
      if ((await realpath(directory)) !== directory || !(await lstat(directory)).isDirectory()) {
        return blocked('DESKTOP_OUTPUT_PATH_INVALID', '任务目录不可用或包含符号链接。');
      }
    } catch { return blocked('DESKTOP_OUTPUT_PATH_INVALID', '任务目录尚未准备好。'); }
    const status = await this.health();
    if (!status.available) return blocked(status.code, status.message);
    try {
      const value = await this.invoke('submit', input) as Partial<DesktopSubmitResult> | null;
      if (!value || !['submitted', 'blocked', 'unknown'].includes(value.state ?? '') || !safeCode(value.code) || !safeMessage(value.message)
        || (value.taskRef !== undefined && (typeof value.taskRef !== 'string' || !/^chrome:\/\/doubaowork-chat\/chat\/[0-9]+$/.test(value.taskRef)))) {
        return { state: 'unknown', code: 'DESKTOP_RESPONSE_UNCERTAIN', message: '无法核对桌面提交结果，只等待原任务输出，不会自动重发。' };
      }
      return { state: value.state!, code: value.code, message: value.message, ...(value.taskRef ? { taskRef: value.taskRef } : {}) };
    } catch { return { state: 'unknown', code: 'DESKTOP_SUBMISSION_UNCERTAIN', message: '桌面提交结果不明确，只等待原任务输出，不会自动重复生成。' }; }
  }
}
