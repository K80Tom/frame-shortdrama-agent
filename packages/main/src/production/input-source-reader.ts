import { createHash } from 'node:crypto';
import { canonicalDigest, ProductionError } from '@lyra/shared';
import type { ShotSourceRef } from '@lyra/shared/dist/shot-spec';
import type { PostgresDatabase } from '../db/client';
import { parseTenantContext } from '../tenancy/context';
import { PostgresProductionInputReferenceReader } from './input-reference-reader';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function unavailable(): never { throw new ProductionError(503, 'PRODUCTION_INPUT_SOURCE_UNAVAILABLE', '生产输入来源暂不可用。'); }
/** Actual PostgreSQL reader, not a new fact store. One SQL statement captures one MVCC project view. */
export class PostgresProductionInputSourceReader {
  constructor(private readonly database: PostgresDatabase) {}
  async readCurrentProjectInputs(tenantValue: unknown, projectId: string, episodeId: string | null = null) {
    const tenant = parseTenantContext(tenantValue);
    return this.database.runWithTenant(tenant, async () => {
      try {
        const row = (await this.database.query(`SELECT p.id, p.input_revision::text, p.current_script_version_id, p.active_plan_revision_id,
          p.active_storyboard_revision_id, s.id AS script_id, s.raw_text, s.content_sha256,
          f.id AS plan_id, f.content_json AS plan_content, b.id AS storyboard_id, b.content_json AS storyboard_content,
          e.id AS episode_id,
          COALESCE((SELECT jsonb_agg(c.spec_json ORDER BY c.shot_order,c.shot_id) FROM (
            SELECT v.spec_json,(v.spec_json->>'order')::integer AS shot_order,h.shot_id
            FROM shot_spec_heads h JOIN shot_spec_versions v ON v.workspace_id=h.workspace_id AND v.id=h.current_version_id
              AND v.project_id=h.project_id AND v.episode_id=h.episode_id AND v.shot_id=h.shot_id
            WHERE h.workspace_id=p.workspace_id AND h.project_id=p.id AND h.episode_id=e.id
            ORDER BY (v.spec_json->>'order')::integer,h.shot_id LIMIT 2001
          ) c),'[]'::jsonb) AS shot_versions
          FROM projects p
          LEFT JOIN script_versions s ON s.id=p.current_script_version_id AND s.project_id=p.id AND s.workspace_id=p.workspace_id
          LEFT JOIN plan_revisions f ON f.id=p.active_plan_revision_id AND f.project_id=p.id
            AND f.script_version_id=s.id AND f.workspace_id=p.workspace_id
          LEFT JOIN storyboard_revisions b ON b.id=p.active_storyboard_revision_id AND b.project_id=p.id
            AND b.script_version_id=s.id AND b.source_plan_revision_id=f.id AND b.workspace_id=p.workspace_id
          LEFT JOIN production_episodes e ON e.workspace_id=p.workspace_id AND e.project_id=p.id AND e.id=$3
          WHERE p.id=$1 AND p.workspace_id=$2`, [projectId, tenant.workspaceId, episodeId])).rows[0];
        if (!row) return null;
        if (episodeId !== null && !row.episode_id) return null;
        if (row.script_id && (typeof row.raw_text !== 'string' || sha(row.raw_text) !== row.content_sha256)) {
          throw new ProductionError(409, 'DIGEST_MISMATCH', '剧本原文摘要不一致。');
        }
        const versions = { scriptVersionId: row.current_script_version_id as string | null,
          planRevisionId: row.active_plan_revision_id as string | null, storyboardRevisionId: row.active_storyboard_revision_id as string | null };
        const script = row.script_id ? { id: row.script_id as string, rawText: row.raw_text as string, digest: row.content_sha256 as string } : null;
        const plan = row.plan_id ? { id: row.plan_id as string, content: row.plan_content as unknown, digest: canonicalDigest(row.plan_content) } : null;
        const storyboard = row.storyboard_id ? { id: row.storyboard_id as string, content: row.storyboard_content as unknown, digest: canonicalDigest(row.storyboard_content) } : null;
        // This is an input-set fingerprint, NOT a fabricated monotonic project revision/CAS counter.
        const shotVersions = row.shot_versions as unknown[];
        const inputSetDigest = canonicalDigest({ projectId: row.id, ...versions, script: script?.digest ?? null,
          plan: plan?.digest ?? null, storyboard: storyboard?.digest ?? null,
          episodeId: row.episode_id ?? null, shotVersions });
        return { projectId: row.id as string, workspaceId: tenant.workspaceId, projectRevision: row.input_revision as string,
          episodeId: row.episode_id as string | null, shotVersions, versions, script, plan, storyboard, inputSetDigest };
      } catch (error) { if (error instanceof ProductionError) throw error; return unavailable(); }
    });
  }
  /** Historical exact script, not current project state. Unicode offsets are code points. */
  async checkSource(tenantValue: unknown, projectId: string, ref: ShotSourceRef) {
    const tenant = parseTenantContext(tenantValue);
    return this.database.runWithTenant(tenant, () => this.database.transaction(client =>
      new PostgresProductionInputReferenceReader(client, tenant, projectId).checkSource(ref)));
  }
}
