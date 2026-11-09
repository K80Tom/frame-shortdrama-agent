import { access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import type { PlatformCheckId } from '@lyra/shared';
import type { AppConfig } from '../config';
import { configForRole, type ModelRole } from '../models/connections';
import { BoundedProcessRunner, type ProcessRunner } from '../production-media/probe';
import { BREAKDOWN_PERSISTENCE_MIGRATIONS } from '../db/readiness';
import type { PlatformProbe } from './preflight';

interface DatabaseProbe {
  verifyConnection(): Promise<void>;
  hasMigrations(versions: readonly string[]): Promise<boolean>;
}
export function createPlatformProbes(deps: {
  config: AppConfig; database?: DatabaseProbe; mediaRoot?: string;
  mediaServiceReady: boolean; productionRuntimeReady: boolean; vectorConfigured: boolean; runner?: ProcessRunner;
}): Partial<Record<PlatformCheckId, PlatformProbe>> {
  const runner = deps.runner ?? new BoundedProcessRunner();
  const binary = async (name: string): Promise<boolean> => {
    await runner.run(name, ['-version'], { timeoutMs: 1500, maxOutputBytes: 64 * 1024 });
    return true;
  };
  const model = (role: ModelRole): boolean => {
    const config = configForRole(deps.config, role);
    // 只检查已由模型连接模块校验的本地配置，绝不发送 HTTP/模型请求。
    return Boolean(config.apiKey && config.defaultModel && (config.endpointUrl || config.baseUrl));
  };
  return {
    database: async () => { if (!deps.database) return false; await deps.database.verifyConnection(); return true; },
    migrations: () => deps.database?.hasMigrations([
      ...BREAKDOWN_PERSISTENCE_MIGRATIONS, '009', '010', '014', '015', '016', '017', '024', '025', '026', '027', '028', '029', '030', '031',
      // 当前平台的 Canvas、冻结输入/Run/DirectorScene 与 Assistant 持久化。
      '032', '033', '034', '035', '036', '037', '038', '039',
    ]) ?? false,
    'media-directory': async () => {
      if (!deps.mediaRoot) return false;
      for (const path of [deps.mediaRoot, ...['objects', 'tmp', 'manifests'].map(name => join(deps.mediaRoot!, name))]) {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
        await access(path, constants.R_OK | constants.W_OK);
      }
      return true;
    },
    'media-service': () => deps.mediaServiceReady,
    'production-runtime': () => deps.productionRuntimeReady,
    ffmpeg: () => binary('ffmpeg'), ffprobe: () => binary('ffprobe'),
    'model-breakdown': () => model('breakdown'), 'model-video': () => model('video'),
    'model-image': () => model('image'), 'model-general': () => model('general'),
    // 不把配置存在或对象创建成功冒充真实向量服务已验证。
    vector: () => deps.vectorConfigured ? 'unverified' : false,
  };
}
