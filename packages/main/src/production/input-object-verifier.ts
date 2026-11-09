import type { PoolClient } from 'pg';
import type { ProductionInputErrorCode } from '@lyra/shared';
import type { ObjectStorage } from '../infrastructure/object-storage';
import { parseTenantContext } from '../tenancy/context';

/** Use the adoption/validation transaction's client, not an unrelated pooled connection. */
export class ProductionInputObjectVerifier {
  constructor(private readonly client: Pick<PoolClient, 'query'>, private readonly objects: Pick<ObjectStorage, 'provider' | 'bucket' | 'head'>) {}
  async check(tenantValue: unknown, expected: { objectId: string; versionId: string; checksum: string }): Promise<ProductionInputErrorCode | null> {
    const tenant = parseTenantContext(tenantValue);
    if (typeof expected.objectId !== 'string' || !/^obj_[a-f0-9]{32}$/u.test(expected.objectId) || expected.objectId.length !== 36
      || typeof expected.versionId !== 'string' || !expected.versionId || expected.versionId.length > 512
      || /[\x00-\x1f\x7f]/u.test(expected.versionId) || typeof expected.checksum !== 'string'
      || expected.checksum.length !== 64 || !/^[a-f0-9]{64}$/u.test(expected.checksum)) return 'DIGEST_MISMATCH';
    try {
      const row = (await this.client.query(`SELECT workspace_id,provider,bucket,object_key,version_id,sha256,size_bytes,
        content_type,status,verified_at,deleted_at FROM object_records WHERE workspace_id=$1 AND id=$2 FOR SHARE`,
      [tenant.workspaceId, expected.objectId])).rows[0];
      if (!row) return 'REFERENCE_NOT_FOUND';
      if (row.workspace_id !== tenant.workspaceId) return 'REFERENCE_FORBIDDEN';
      if (row.status !== 'ready' || !row.verified_at || row.deleted_at) return 'SNAPSHOT_NOT_READY';
      // Never invent a provider version from ETag, the mutable row counter or a local path.
      // Versionless backends need an explicit immutable object-version contract before this path is enabled.
      if (!row.version_id) return 'CAPABILITY_INCOMPATIBLE';
      if (row.version_id !== expected.versionId || row.sha256 !== expected.checksum) return 'DIGEST_MISMATCH';
      if (row.provider !== this.objects.provider || row.bucket !== this.objects.bucket) return 'CAPABILITY_INCOMPATIBLE';
      const bytes = Number(row.size_bytes);
      if (!Number.isSafeInteger(bytes) || bytes < 1) return 'DIGEST_MISMATCH';
      const head = await this.objects.head({ workspaceId: tenant.workspaceId }, row.object_key);
      if (!head) return 'REFERENCE_NOT_FOUND';
      if (head.provider !== row.provider || head.bucket !== row.bucket || head.key !== row.object_key
        || head.versionId !== expected.versionId || head.sha256 !== expected.checksum
        || head.size !== bytes || head.contentType !== row.content_type) return 'DIGEST_MISMATCH';
      return null;
    } catch { return 'SNAPSHOT_NOT_READY'; } // no driver, URL, key or provider error text escapes
  }
}
