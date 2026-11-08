import { createHash } from 'node:crypto';
import {
  TENANT_DATA_EVENT_SCHEMA_VERSION,
  parseDataEventWorkspaceId,
  parseDataEventV2,
  tenantDataEventDigest,
  type DataEventV2,
} from '@lyra/shared';
import { createDataEvent, type CreateDataEventInput } from './event';

// Keep the main-package import path during the V1/V2 migration while the
// versioned wire contract itself lives in @lyra/shared.
export {
  TENANT_DATA_EVENT_SCHEMA_VERSION,
  assertSameTenantDataEvent,
  isDataEventV2,
  parseDataEventV2,
  parseTenantDataEvent,
  tenantDataEventDigest,
  workspaceIdOfDataEvent,
  type DataEventV2,
  type TenantDataEvent,
} from '@lyra/shared';

export interface CreateDataEventV2Input extends CreateDataEventInput {
  workspaceId: string;
}
export function tenantDataEventIdempotencyKey(workspaceId: string, input: Pick<CreateDataEventInput,
  'aggregateType' | 'aggregateId' | 'aggregateVersion' | 'eventType'>): string {
  const tenant = parseDataEventWorkspaceId(workspaceId, 'workspaceId');
  const digest = createHash('sha256').update([
    tenant, input.aggregateType, input.aggregateId, String(input.aggregateVersion), input.eventType,
  ].join('\u0000')).digest('hex');
  return `tenant:${digest}`;
}
export function createDataEventV2(input: CreateDataEventV2Input): DataEventV2 {
  const workspaceId = parseDataEventWorkspaceId(input.workspaceId, 'workspaceId');
  const v1 = createDataEvent({
    ...input,
    idempotencyKey: input.idempotencyKey ?? tenantDataEventIdempotencyKey(workspaceId, input),
  });
  const event = parseDataEventV2({
    ...v1,
    schemaVersion: TENANT_DATA_EVENT_SCHEMA_VERSION,
    workspaceId,
  });
  tenantDataEventDigest(event);
  return event;
}
