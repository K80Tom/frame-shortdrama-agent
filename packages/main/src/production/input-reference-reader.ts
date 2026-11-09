import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { canonicalDigest } from '@lyra/shared';
import type { InputVersionRef, ShotSourceRef } from '@lyra/shared';
import type { ProductionInputErrorCode } from '@lyra/shared';
import { parseTenantContext } from '../tenancy/context';
import type { InputReferenceKind } from './input-validation';
import { verifyShotSpecV2 } from './shot-spec';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
/** Transaction-scoped source adapter for existing PostgreSQL facts; never silently accepts unsupported domains. */
export class PostgresProductionInputReferenceReader {
  private readonly tenant;
  constructor(private readonly client: Pick<PoolClient, 'query'>, tenantValue: unknown, private readonly projectId: string) {
    this.tenant = parseTenantContext(tenantValue);
  }
  async authorizeProject(): Promise<boolean> {
    const result = await this.client.query('SELECT id FROM projects WHERE workspace_id=$1 AND id=$2 FOR SHARE', [this.tenant.workspaceId, this.projectId]);
    return result.rowCount === 1;
  }
  async loadShot(revisionId: string) {
    const row = (await this.client.query(`SELECT spec_json FROM shot_spec_versions
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR SHARE`, [this.tenant.workspaceId, this.projectId, revisionId])).rows[0];
    return row ? verifyShotSpecV2(row.spec_json) : null;
  }
  async checkVersion(kind: InputReferenceKind, ref: InputVersionRef): Promise<ProductionInputErrorCode | null> {
    if (!['script', 'plan', 'storyboard'].includes(kind)) return 'CAPABILITY_INCOMPATIBLE';
    // Legacy revisions use their immutable row ID as both resource and version.
    if (ref.id !== ref.versionId) return 'DIGEST_MISMATCH';
    try {
      if (kind === 'script') {
        const row = (await this.client.query(`SELECT raw_text,content_sha256 FROM script_versions
          WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR SHARE`, [this.tenant.workspaceId, this.projectId, ref.versionId])).rows[0];
        if (!row) return 'REFERENCE_NOT_FOUND';
        if (typeof row.raw_text !== 'string' || sha(row.raw_text) !== row.content_sha256 || row.content_sha256 !== ref.digest) return 'DIGEST_MISMATCH';
        return null;
      }
      // Table choice is a closed, main-owned enum, not arbitrary SQL from input.
      const table = kind === 'plan' ? 'plan_revisions' : 'storyboard_revisions';
      const adoptions = kind === 'plan' ? 'plan_adoptions' : 'storyboard_adoptions';
      const row = (await this.client.query(`SELECT r.content_json,EXISTS(SELECT 1 FROM ${adoptions} a
        WHERE a.workspace_id=r.workspace_id AND a.project_id=r.project_id AND a.to_revision_id=r.id) AS was_adopted
        FROM ${table} r WHERE r.workspace_id=$1 AND r.project_id=$2 AND r.id=$3 FOR SHARE OF r`,
      [this.tenant.workspaceId, this.projectId, ref.versionId])).rows[0];
      if (!row) return 'REFERENCE_NOT_FOUND';
      if (canonicalDigest(row.content_json) !== ref.digest) return 'DIGEST_MISMATCH';
      if (row.was_adopted !== true) return 'SNAPSHOT_NOT_READY';
      return null;
    } catch { return 'SNAPSHOT_NOT_READY'; }
  }
  async checkSource(ref: ShotSourceRef): Promise<ProductionInputErrorCode | null> {
    try {
      const row = (await this.client.query(`SELECT raw_text,content_sha256 FROM script_versions
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR SHARE`, [this.tenant.workspaceId, this.projectId, ref.scriptVersionId])).rows[0];
      if (!row) return 'REFERENCE_NOT_FOUND';
      if (typeof row.raw_text !== 'string' || sha(row.raw_text) !== row.content_sha256) return 'DIGEST_MISMATCH';
      const points = Array.from(row.raw_text);
      return !Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < 0 || ref.end <= ref.start
        || ref.end > points.length || points.slice(ref.start, ref.end).join('') !== ref.quote ? 'DIGEST_MISMATCH' : null;
    } catch { return 'SNAPSHOT_NOT_READY'; }
  }
}
