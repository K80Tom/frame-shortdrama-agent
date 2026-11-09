import {
  PLATFORM_CHECK_IDS, parsePlatformPreflightReport,
  type PlatformCheckId, type PlatformPreflightReport,
} from '@lyra/shared';

export type PlatformProbe = () => boolean | 'unverified' | Promise<boolean | 'unverified'>;
const SPECS: Record<PlatformCheckId, { required: boolean; paid: boolean; stages: string[]; action: string }> = {
  database: { required: true, paid: false, stages: ['prepare'], action: '检查本地 PostgreSQL 配置和服务状态。' },
  migrations: { required: true, paid: false, stages: ['prepare'], action: '执行 npm run db:migrate，完成后重启后端。' },
  'media-directory': { required: true, paid: false, stages: ['assets', 'compose', 'deliver'], action: '检查受控媒体库及子目录读写权限，不要指向远程目录。' },
  'media-service': { required: true, paid: false, stages: ['video', 'compose', 'deliver'], action: '检查本地媒体服务初始化状态并重启后端。' },
  ffmpeg: { required: true, paid: false, stages: ['compose'], action: '安装 FFmpeg 并使 ffmpeg 命令在后端 PATH 中可用。' },
  ffprobe: { required: true, paid: false, stages: ['video', 'review', 'deliver'], action: '安装 FFmpeg 并使 ffprobe 命令在后端 PATH 中可用。' },
  'model-breakdown': { required: true, paid: true, stages: ['breakdown', 'storyboard'], action: '在模型连接中配置拆解用途；此处仅检查本地配置，不验证供应商。' },
  'model-video': { required: true, paid: true, stages: ['video'], action: '在模型连接中配置视频用途；真实调用仍需人工授权。' },
  'model-image': { required: false, paid: true, stages: ['assets'], action: '缺失资产需要生成时配置生图用途；已有资产可继续复用。' },
  'model-general': { required: true, paid: true, stages: ['compose'], action: '配置通用模型用于抽帧评估；禁用该功能需在启动配置中明确设置。' },
  vector: { required: false, paid: true, stages: ['assets'], action: '可选向量服务未验证时仅降级检索，名称/别名匹配不受影响。' },
  'production-runtime': { required: true, paid: false, stages: ['prepare'], action: '完成生产所需迁移和服务配置后重启后端。' },
};

export class PlatformPreflightService {
  private cached: PlatformPreflightReport | null = null;
  private pending: Promise<PlatformPreflightReport> | null = null;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly now: () => number;
  constructor(private readonly probes: Partial<Record<PlatformCheckId, PlatformProbe>>, private readonly options: {
    timeoutMs?: number; cacheMs?: number; now?: () => number; frameAssessmentRequired?: boolean;
  } = {}) {
    this.timeoutMs = options.timeoutMs ?? 2000;
    this.cacheMs = options.cacheMs ?? 10_000;
    this.now = options.now ?? Date.now;
    if (![this.timeoutMs, this.cacheMs].every(n => Number.isSafeInteger(n) && n >= 1)
      || this.timeoutMs > 30_000 || this.cacheMs > 60_000) throw new TypeError('运行前检查配置无效。');
  }
  async check(): Promise<PlatformPreflightReport> {
    if (this.cached && this.now() < Date.parse(this.cached.expiresAt)) return structuredClone(this.cached);
    if (!this.pending) {
      this.pending = this.collect().then(report => { this.cached = report; return report; })
        .finally(() => { this.pending = null; });
    }
    return structuredClone(await this.pending);
  }
  private async collect(): Promise<PlatformPreflightReport> {
    const checks = await Promise.all(PLATFORM_CHECK_IDS.map(async id => {
      const spec = SPECS[id];
      const required = id === 'model-general' && this.options.frameAssessmentRequired === false ? false : spec.required;
      let timer: NodeJS.Timeout | undefined;
      let outcome: boolean | 'unverified' | 'timeout' = false;
      try {
        outcome = await Promise.race([
          Promise.resolve().then(() => this.probes[id]?.() ?? false),
          new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.timeoutMs); }),
        ]);
      } catch { outcome = false; }
      finally { if (timer) clearTimeout(timer); }
      const available = outcome === true;
      return { id, required, paid: spec.paid, stages: [...spec.stages],
        status: available ? 'ready' as const : required ? 'blocked' as const : 'degraded' as const,
        code: id.replaceAll('-', '_').toUpperCase() + (available ? '_READY'
          : outcome === 'timeout' ? '_TIMEOUT' : outcome === 'unverified' ? '_UNVERIFIED' : '_UNAVAILABLE'),
        action: available ? '本地检查通过；不代表真实供应商或内容质量已验证。' : spec.action };
    }));
    const at = this.now();
    return parsePlatformPreflightReport({
      schemaVersion: 'lyra-platform-preflight/1', checkedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + this.cacheMs).toISOString(),
      status: checks.some(c => c.status === 'blocked') ? 'blocked' : checks.some(c => c.status === 'degraded') ? 'degraded' : 'ready',
      providerAvailabilityChecked: false, paidCallsMade: 0, checks,
    });
  }
}
