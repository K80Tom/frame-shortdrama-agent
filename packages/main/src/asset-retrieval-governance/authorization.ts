import type { AssetRetrievalObservation } from '@lyra/shared';
import type { AssetPackRepository } from '../assets/asset-pack-repository';
/** Reads the exact authoritative version; client observation/decision flags are not evidence. */
export function assetRetrievalAuthorization(repository: Pick<AssetPackRepository, 'get'>, now = () => new Date()) {
  return async (workspaceId: string, observation: AssetRetrievalObservation,
    decision: { selectedAssetId: string | null; selectedAssetVersionId: string | null }): Promise<boolean> => {
    if (observation.workspaceId !== workspaceId || !decision.selectedAssetId || !decision.selectedAssetVersionId) return false;
    try {
      const v = await repository.get(workspaceId, decision.selectedAssetVersionId);
      if (!v || v.workspaceId !== workspaceId || v.id !== decision.selectedAssetVersionId || v.logicalAssetId !== decision.selectedAssetId
        || v.status !== 'adopted' || v.authorizationStatus !== 'allowed' || v.reviewStatus !== 'approved'
        || !v.license || !v.reviewedBy || !v.reviewedAt) return false;
      const at = now().getTime();
      if (!Number.isFinite(Date.parse(v.validFrom)) || Date.parse(v.validFrom) > at
        || v.validUntil !== null && (!Number.isFinite(Date.parse(v.validUntil)) || Date.parse(v.validUntil) <= at)) return false;
      if (v.projectScope === 'project' && (!observation.projectId || v.projectId !== observation.projectId)) return false;
      if (v.restrictedProjects.length && (!observation.projectId || v.restrictedProjects.includes(observation.projectId))) return false;
      // No explicit intended usage is not proof of permission for arbitrary reuse.
      if (!v.allowedUsages.includes('evaluation')) return false;
      const candidate = observation.candidates.find(c => c.assetId === v.logicalAssetId && c.assetVersionId === v.id);
      if (!candidate || candidate.assetVersionDigest !== v.contentDigest) return false;
      return true;
    } catch { return false; }
  };
}
