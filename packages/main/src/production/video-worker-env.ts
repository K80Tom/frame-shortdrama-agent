import type { PoolClient } from 'pg';
import type { PostgresDatabase } from '../db/client';
import type { ObjectStorage } from '../infrastructure/object-storage';
import { readObjectVersionBytes, type StoredObjectVersionRow } from '../production-media/object-versions';
import type { PaidGenerationInterceptor } from '../budget/paid-generation';
import {
  JimengVideoAdapter, KlingVideoAdapter, MiniMaxVideoAdapter, SeedanceVideoAdapter,
  type CommercialVideoAdapter,
} from '../models/video-providers';
import type { CommercialVideoProviderConfig } from '../models/video-providers/types';
import { PostgresModelGenerationAudit } from './model-generation-audit';
import { ProductionInputObjectVerifier } from './input-object-verifier';
import {
  createVideoGenerationHandler, type VideoGenerationAdapterRegistry, type VideoGenerationHandlerOptions,
} from './video-worker';
import type { BlobStorageDriver } from '../storage/driver';

/** 每个供应商的环境配置；只配了 API Key 的供应商才会注册适配器（CI 永远不配）。 */
export function readCommercialVideoAdapterConfigs(env: NodeJS.ProcessEnv):
  Partial<Record<'kling' | 'jimeng' | 'minimax' | 'seedance', CommercialVideoProviderConfig>> {
  const configs: Partial<Record<'kling' | 'jimeng' | 'minimax' | 'seedance', CommercialVideoProviderConfig>> = {};
  const entry = (provider: string): CommercialVideoProviderConfig => ({
    endpoint: env[`LYRA_VIDEO_${provider}_ENDPOINT`] || '',
    apiKey: env[`LYRA_VIDEO_${provider}_API_KEY`] || '',
    ...(provider === 'MINIMAX' && env.LYRA_VIDEO_MINIMAX_GROUP_ID
      ? { groupId: env.LYRA_VIDEO_MINIMAX_GROUP_ID } : {}),
    timeoutMs: 180_000,
  });
  for (const [provider, key] of [['kling', 'KLING'], ['jimeng', 'JIMENG'],
    ['minimax', 'MINIMAX'], ['seedance', 'SEEDANCE']] as const) {
    if (env[`LYRA_VIDEO_${key}_API_KEY`]) configs[provider] = entry(key);
  }
  return configs;
}

export function createCommercialVideoAdapters(configs:
  Partial<Record<'kling' | 'jimeng' | 'minimax' | 'seedance', CommercialVideoProviderConfig>>,
  budget: PaidGenerationInterceptor): VideoGenerationAdapterRegistry {
  const registry: VideoGenerationAdapterRegistry = {};
  const build: Array<[keyof typeof configs, new (config: CommercialVideoProviderConfig,
    budget: PaidGenerationInterceptor) => CommercialVideoAdapter]> = [
    ['kling', KlingVideoAdapter], ['jimeng', JimengVideoAdapter],
    ['minimax', MiniMaxVideoAdapter], ['seedance', SeedanceVideoAdapter],
  ];
  for (const [provider, factory] of build) {
    const config = configs[provider];
    if (config) registry[provider] = new factory(config, budget);
  }
  return registry;
}

/**
 * 已验真帧字节读取器：行级校验 + 字节级 sha256 复核（readObjectVersionBytes 内完成）。
 * 调用方运行在任务工作区的租户作用域内，行级过滤天然生效。
 */
export function createObjectVersionFrameLoader(database: PostgresDatabase, objects: ObjectStorage,
  maxBytes = 32 * 1024 * 1024): VideoGenerationHandlerOptions['loadFrameBytes'] {
  const client = database as unknown as Pick<PoolClient, 'query'>;
  return async frame => {
    const result = await client.query<StoredObjectVersionRow>(
      `SELECT * FROM object_versions WHERE workspace_id = current_setting('lyra.workspace_id', true)
         AND id = $1 AND object_id = $2 AND status = 'ready' AND verified_at IS NOT NULL`,
      [frame.versionId, frame.objectId]);
    const row = result.rows[0];
    if (!row) throw new Error(`首尾帧对象版本不可读：${frame.versionId}`);
    const read = await readObjectVersionBytes(row, objects, row.object_key, row.provider_version_id, maxBytes);
    return read.body;
  };
}

/** main 装配用：组合验真器、帧读取器、驱动、台账与真实适配器。 */
export function createVideoGenerationWorkerHandler(deps: {
  database: PostgresDatabase;
  objectStorage: ObjectStorage;
  driver: BlobStorageDriver;
  budget: PaidGenerationInterceptor;
  adapters?: VideoGenerationAdapterRegistry;
  pollIntervalMs?: number;
  pollDeadlineMs?: number;
}): ReturnType<typeof createVideoGenerationHandler> {
  const adapters = deps.adapters ?? createCommercialVideoAdapters(readCommercialVideoAdapterConfigs(process.env), deps.budget);
  return createVideoGenerationHandler({
    adapters,
    verifier: new ProductionInputObjectVerifier(deps.database as unknown as Pick<PoolClient, 'query'>, deps.objectStorage),
    loadFrameBytes: createObjectVersionFrameLoader(deps.database, deps.objectStorage),
    driver: deps.driver,
    audit: new PostgresModelGenerationAudit(deps.database as unknown as Pick<PoolClient, 'query'>),
    pollIntervalMs: deps.pollIntervalMs,
    pollDeadlineMs: deps.pollDeadlineMs,
  });
}
