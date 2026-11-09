import { ProductionError } from '@lyra/shared';
import type { InputVersionRef } from '@lyra/shared';
import type { ProductionInputFinding, ProductionInputSnapshotDraft } from '@lyra/shared';
import { parseTenantContext } from '../tenancy/context';
import type { PostgresProductionInputSourceReader } from './input-source-reader';
import { verifyShotSpecV2 } from './shot-spec';
import { sealProductionInputSnapshot } from './input-snapshot';

/** Resolved by main's versioned policy/model services, never accepted verbatim from an HTTP client. */
export type ProductionInputCompileProfile = Pick<ProductionInputSnapshotDraft, 'id' | 'createdAt' | 'reason' | 'modelConnections'
  | 'retrievalPolicy' | 'qualityGates' | 'budgetPolicy' | 'candidatePolicy' | 'automationMode'>;
function refs(values: InputVersionRef[]): InputVersionRef[] {
  const unique = new Map<string, InputVersionRef>();
  for (const value of values) {
    const previous = unique.get(value.id);
    if (previous && (previous.versionId !== value.versionId || previous.digest !== value.digest)) {
      throw new ProductionError(409, 'DIGEST_MISMATCH', '候选输入引用了同一资源的不同版本。');
    }
    unique.set(value.id, value);
  }
  return [...unique.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
/** Read-only candidate compilation: no adoption, provider execution, or ready/frozen state assignment. */
export class ProductionInputCandidateCompiler {
  constructor(private readonly sources: Pick<PostgresProductionInputSourceReader, 'readCurrentProjectInputs'>) {}
  async compile(tenantValue: unknown, projectId: string, episodeId: string, profile: ProductionInputCompileProfile) {
    const tenant = parseTenantContext(tenantValue);
    const frame = await this.sources.readCurrentProjectInputs(tenant, projectId, episodeId);
    if (!frame || frame.workspaceId !== tenant.workspaceId || frame.projectId !== projectId || frame.episodeId !== episodeId) {
      throw new ProductionError(404, 'REFERENCE_NOT_FOUND', '项目或分集不存在。');
    }
    const findings: ProductionInputFinding[] = [];
    for (const [value, id] of [[frame.script, frame.versions.scriptVersionId], [frame.plan, frame.versions.planRevisionId],
      [frame.storyboard, frame.versions.storyboardRevisionId]] as const) {
      if (!value) findings.push({ code: 'REFERENCE_NOT_FOUND', referenceId: id });
    }
    if (!frame.shotVersions.length) findings.push({ code: 'REFERENCE_NOT_FOUND', referenceId: episodeId });
    if (frame.shotVersions.length > 2000) findings.push({ code: 'CAPABILITY_INCOMPATIBLE', referenceId: episodeId });
    if (findings.length || !frame.script || !frame.plan || !frame.storyboard) {
      return { state: 'blocked' as const, candidate: null, findings, projectRevision: frame.projectRevision };
    }
    const shots = frame.shotVersions.map(verifyShotSpecV2);
    if (shots.some(s => s.workspaceId !== tenant.workspaceId || s.projectId !== projectId || s.episodeId !== episodeId)) {
      throw new ProductionError(404, 'REFERENCE_NOT_FOUND', '镜头版本不存在。');
    }
    const candidate = sealProductionInputSnapshot({ ...profile, schemaVersion: 'lyra-production-input/1', state: 'draft',
      workspaceId: tenant.workspaceId, projectId, episodeId, baseProjectRevision: frame.projectRevision,
      createdBy: tenant.userId, findings: [],
      shots: shots.map(s => ({ shotId: s.shotId, revisionId: s.revisionId, contentDigest: s.contentDigest })),
      script: { id: frame.script.id, versionId: frame.script.id, digest: frame.script.digest },
      plan: { id: frame.plan.id, versionId: frame.plan.id, digest: frame.plan.digest },
      storyboard: { id: frame.storyboard.id, versionId: frame.storyboard.id, digest: frame.storyboard.digest },
      assetPacks: refs(shots.flatMap(s => s.assetPacks.map(p => p.pack))),
      directorScenes: refs(shots.flatMap(s => s.controls.filter(c => c.kind === 'director_scene').map(c => c.artifact))),
      controls: refs(shots.flatMap(s => s.controls.filter(c => c.kind !== 'director_scene').map(c => c.artifact))),
      methodPacks: refs(shots.flatMap(s => s.generation.methodPackRevisions)), promptPacks: refs(shots.map(s => s.generation.promptPackRevision)) });
    return { state: 'draft' as const, candidate, findings: [], projectRevision: frame.projectRevision };
  }
}
