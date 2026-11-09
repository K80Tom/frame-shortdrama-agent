import { createHash } from 'node:crypto';
import { DATA_EVENT_SCHEMA_VERSION } from '@lyra/shared';
import type {
  ConsumerCheckpoint,
  ProjectionCommitInput,
  ProjectionRecord,
  ProjectionStore,
} from './checkpoint';
import {
  TENANT_DATA_EVENT_SCHEMA_VERSION,
  workspaceIdOfDataEvent,
  type TenantDataEvent,
} from './tenant-event';

export type ProjectionStatus = 'projected' | 'duplicate' | 'gap' | 'quarantined';

export interface ProjectionResult {
  status: ProjectionStatus;
  projection: ProjectionRecord | null;
  checkpoint: ConsumerCheckpoint | null;
  reason?: string;
}

export interface DataProjectorOptions {
  supportedSchemas?: readonly string[];
  /** 范围重放可能从 aggregate 中间版本开始；线上 Dispatcher 必须保持 false。 */
  allowInitialVersion?: boolean;
  now?: () => Date;
}

function scalarPayload(event: TenantDataEvent): Record<string, string | number | boolean | null> {
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(event.payload)) {
    if (!/^[a-z][a-zA-Z0-9]{0,63}$/u.test(key)) continue;
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isSafeInteger(value))) {
      output[key] = value;
    }
  }
  return output;
}

/**
 * 只接收 ProjectionStore，不接收任何业务 Repository；投影结果不能回写业务状态。
 */
export class DataProjector {
  private readonly supportedSchemas: ReadonlySet<string>;
  private readonly allowInitialVersion: boolean;
  private readonly now: () => Date;

  constructor(
    readonly consumerName: string,
    private readonly store: ProjectionStore,
    options: DataProjectorOptions = {},
  ) {
    this.supportedSchemas = new Set(options.supportedSchemas
      ?? [DATA_EVENT_SCHEMA_VERSION, TENANT_DATA_EVENT_SCHEMA_VERSION, 'lyra.production.outbox_legacy/v1']);
    this.allowInitialVersion = options.allowInitialVersion ?? false;
    this.now = options.now ?? (() => new Date());
  }

  async deliver(event: TenantDataEvent): Promise<ProjectionResult> {
    const workspaceId = workspaceIdOfDataEvent(event);
    if (!this.supportedSchemas.has(event.schemaVersion)) {
      await this.store.recordQuarantine({
        consumerName: this.consumerName,
        workspaceId,
        eventId: event.eventId,
        reason: `UNKNOWN_SCHEMA:${event.schemaVersion}`,
        schemaVersion: event.schemaVersion,
        createdAt: this.now().toISOString(),
      });
      return { status: 'quarantined', projection: null, checkpoint: null,
        reason: `UNKNOWN_SCHEMA:${event.schemaVersion}` };
    }
    if (await this.store.hasProcessed(this.consumerName, event.eventId)) {
      return { status: 'duplicate', projection: null, checkpoint: null };
    }
    const last = await this.store.getAggregateVersion(this.consumerName,
      workspaceId, event.aggregateType, event.aggregateId);
    if (last !== null && event.aggregateVersion <= last) {
      return { status: 'duplicate', projection: null, checkpoint: null };
    }
    if (last === null && event.aggregateVersion > 1 && !this.allowInitialVersion) {
      return { status: 'gap', projection: null, checkpoint: null,
        reason: `GAP:${event.aggregateType}:${event.aggregateId}:${event.aggregateVersion}` };
    }
    if (last !== null && event.aggregateVersion !== last + 1) {
      return { status: 'gap', projection: null, checkpoint: null,
        reason: `GAP:${event.aggregateType}:${event.aggregateId}:${event.aggregateVersion}` };
    }

    const projection: ProjectionRecord = {
      projectionId: `projection_${createHash('sha256')
        .update(`${this.consumerName}:${workspaceId}:${event.eventId}`).digest('hex').slice(0, 32)}`,
      consumerName: this.consumerName,
      workspaceId,
      eventId: event.eventId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
      output: {
        workspaceId,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        aggregateVersion: event.aggregateVersion,
        ...scalarPayload(event),
      },
      createdAt: this.now().toISOString(),
    };
    const checkpoint: ConsumerCheckpoint = {
      consumerName: this.consumerName,
      workspaceId,
      eventId: event.eventId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
      updatedAt: this.now().toISOString(),
    };
    const input: ProjectionCommitInput = { consumerName: this.consumerName, event, projection, checkpoint };
    const result = await this.store.commit(input);
    if (!result.applied) return { status: 'duplicate', projection: null, checkpoint: null };
    return { status: 'projected', projection, checkpoint };
  }
}
