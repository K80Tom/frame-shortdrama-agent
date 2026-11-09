import { DRIVER_MANAGED_PREFIX, type BlobStorageDriver } from '../../storage/driver';
import { OutboxTaskError } from './contracts';
import type { OutboxTaskHandler } from './consumer';

/** 平台任务类型白名单：API 只接受这里的类型，未知类型一律拒绝。 */
export const OUTBOX_TASK_TYPE_WHITELIST = ['runtime.smoke', 'storage.staging_gc', 'video.generate'] as const;
export type WhitelistedOutboxTaskType = (typeof OUTBOX_TASK_TYPE_WHITELIST)[number];

export function isWhitelistedOutboxTaskType(value: unknown): value is WhitelistedOutboxTaskType {
  return typeof value === 'string' && (OUTBOX_TASK_TYPE_WHITELIST as readonly string[]).includes(value);
}

/** runtime.smoke：CLI 验收用冒烟任务，回显消息并记录处理时间。 */
export function createRuntimeSmokeHandler(): OutboxTaskHandler {
  return {
    taskType: 'runtime.smoke',
    async execute({ task }) {
      const message = task.payload.message;
      if (message !== undefined && (typeof message !== 'string' || message.length > 500)) {
        throw new OutboxTaskError('OUTBOX_TASK_INVALID', 'message 必须是不超过 500 字符的字符串。');
      }
      return {
        taskType: task.taskType,
        taskId: task.taskId,
        echo: typeof message === 'string' ? message : '',
        processedAt: new Date().toISOString(),
      };
    },
  };
}

export interface StagingGcHandlerOptions {
  readonly driver: BlobStorageDriver;
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

const DEFAULT_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * storage.staging_gc：清理驱动托管命名空间内 staging/ 前缀的过期对象。
 * staging 对象键约定为 `<createdMs>-<random>`，GC 解析首段时间戳判断过期，
 * 绝不触碰托管前缀之外的任何业务对象。
 */
export function createStagingGcHandler(options: StagingGcHandlerOptions): OutboxTaskHandler {
  return {
    taskType: 'storage.staging_gc',
    async execute({ task }) {
      const now = options.now?.() ?? Date.now();
      const requested = task.payload.maxAgeMs;
      const maxAgeMs = typeof requested === 'number' && Number.isSafeInteger(requested)
        ? Math.min(Math.max(requested, 60 * 60 * 1000), 30 * 24 * 60 * 60 * 1000)
        : options.maxAgeMs ?? DEFAULT_STAGING_MAX_AGE_MS;
      if (requested !== undefined && (typeof requested !== 'number' || !Number.isSafeInteger(requested))) {
        throw new OutboxTaskError('OUTBOX_TASK_INVALID', 'maxAgeMs 必须是整数毫秒。');
      }
      const stagingPrefix = `${options.driver.managedPrefix}staging`;
      const entries = await options.driver.list(stagingPrefix, { limit: 1000 });
      let deleted = 0;
      for (const entry of entries) {
        const relative = entry.key.startsWith(`${DRIVER_MANAGED_PREFIX}staging/`)
          ? entry.key.slice(`${DRIVER_MANAGED_PREFIX}staging/`.length)
          : null;
        const firstSegment = relative?.split('/')[0]?.split('-')[0];
        const createdMs = firstSegment ? Number.parseInt(firstSegment, 10) : Number.NaN;
        if (!Number.isSafeInteger(createdMs) || createdMs <= 0) continue;
        if (now - createdMs < maxAgeMs) continue;
        await options.driver.delete(entry.key);
        deleted += 1;
      }
      return {
        taskType: task.taskType,
        taskId: task.taskId,
        scanned: entries.length,
        deleted,
        maxAgeMs,
        processedAt: new Date().toISOString(),
      };
    },
  };
}
