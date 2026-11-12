import { canonicalDigest } from './production';

export const ASSET_RETRIEVAL_POLICY_SCHEMA_VERSION = 'asset-retrieval-policy/1';

/** Only ranking gates are versioned here. The asset catalog remains the source of truth. */
export interface AssetRetrievalPolicy {
  threshold: number;
  ambiguityMargin: number;
  semanticWeight: number;
}

export interface FrozenAssetRetrievalPolicy extends AssetRetrievalPolicy {
  schemaVersion: typeof ASSET_RETRIEVAL_POLICY_SCHEMA_VERSION;
  registryRevision: number;
  policyDigest: string;
  sourceCandidateId: string | null;
}

export const DEFAULT_ASSET_RETRIEVAL_POLICY: Readonly<AssetRetrievalPolicy> = Object.freeze({
  threshold: 0.62,
  ambiguityMargin: 0.08,
  semanticWeight: 0.95,
});

export function assertAssetRetrievalPolicy(value: AssetRetrievalPolicy): void {
  const valid = [value.threshold, value.ambiguityMargin, value.semanticWeight].every(Number.isFinite)
    && value.threshold >= 0 && value.threshold <= 1
    && value.ambiguityMargin >= 0 && value.ambiguityMargin <= 0.5
    && value.semanticWeight >= 0 && value.semanticWeight <= 1;
  if (!valid) throw new Error('Asset retrieval policy values are outside their supported ranges.');
}

export function assetRetrievalPolicyDigest(policy: AssetRetrievalPolicy): string {
  assertAssetRetrievalPolicy(policy);
  return canonicalDigest({
    schemaVersion: ASSET_RETRIEVAL_POLICY_SCHEMA_VERSION,
    threshold: policy.threshold,
    ambiguityMargin: policy.ambiguityMargin,
    semanticWeight: policy.semanticWeight,
  });
}

export function freezeAssetRetrievalPolicy(
  policy: AssetRetrievalPolicy,
  registryRevision = 0,
  sourceCandidateId: string | null = null,
): FrozenAssetRetrievalPolicy {
  if (!Number.isSafeInteger(registryRevision) || registryRevision < 0) throw new Error('Invalid registry revision.');
  return {
    schemaVersion: ASSET_RETRIEVAL_POLICY_SCHEMA_VERSION,
    threshold: policy.threshold,
    ambiguityMargin: policy.ambiguityMargin,
    semanticWeight: policy.semanticWeight,
    registryRevision,
    policyDigest: assetRetrievalPolicyDigest(policy),
    sourceCandidateId,
  };
}

/** Legacy runs and a registry with no adoption both retain this exact baseline.
 * The canonical digest is frozen so browser bundles do not execute Node's crypto at module load.
 * A Node regression test asserts it stays equal to assetRetrievalPolicyDigest(DEFAULT_ASSET_RETRIEVAL_POLICY).
 */
export const DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY: Readonly<FrozenAssetRetrievalPolicy> = Object.freeze({
  ...DEFAULT_ASSET_RETRIEVAL_POLICY,
  schemaVersion: ASSET_RETRIEVAL_POLICY_SCHEMA_VERSION,
  registryRevision: 0,
  policyDigest: 'bacf3bf4e0496a1689085131805d1d5bb80a63ede9d0f59e14abc95dc98ce87f',
  sourceCandidateId: null,
});
