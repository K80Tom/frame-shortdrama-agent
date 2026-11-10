import { createHash } from 'node:crypto';
import type { AssetRecord } from '@lyra/shared';
import { DEFAULT_ASSET_RETRIEVAL_POLICY, type AssetRetrievalPolicy } from '@lyra/shared';
import {
  ASSET_RETRIEVAL_HYBRID_RULE_VERSION,
  assetConstraintEvaluation,
  assetCandidateExplanation,
  assetIsHardEligible,
  finalizeAssetRetrieval,
  retrieveAssetForGeneration,
  type AssetRetrievalCandidate,
  type AssetRetrievalProvider,
  type AssetRetrievalQuery,
  type AssetRetrievalResult,
  type AssetRetriever,
  type AssetRetrievalSubject,
} from '../retrieval';
import type { AssetEmbeddingClient } from './embedding';
import { isRebuildableVectorDependencyFailure } from './errors';
import type { AssetVectorStore } from './milvus';
import { buildAssetVectorText } from './projection';

/** Semantic recall + deterministic lexical ranking, always hydrated from AssetService records. */
export class HybridAssetRetriever implements AssetRetriever {
  readonly semanticProvider: AssetRetrievalProvider;

  constructor(private readonly dependencies: {
    embedding: AssetEmbeddingClient;
    store: AssetVectorStore;
    model: string;
    revision: string;
    queryCostMicros: number;
  }) {
    if (!Number.isSafeInteger(dependencies.queryCostMicros) || dependencies.queryCostMicros < 0) {
      throw new Error('queryCostMicros must be a non-negative safe integer');
    }
    this.semanticProvider = {
      model: dependencies.model, revision: dependencies.revision, queryCostMicros: dependencies.queryCostMicros,
    };
  }

  async retrieve(query: AssetRetrievalQuery, assets: AssetRetrievalSubject[],
    policy: AssetRetrievalPolicy = DEFAULT_ASSET_RETRIEVAL_POLICY): Promise<AssetRetrievalResult> {
    const lexical = retrieveAssetForGeneration(query, assets, policy);
    try {
      const vector = await this.dependencies.embedding.embedText(assetQueryVectorText(query));
      const budget = Math.min(24, Math.max(1, query.candidateBudget ?? 12));
      const hits = await this.dependencies.store.search(vector, query.kind, budget, {
        assetIds: [...new Set(assets.filter(asset => assetIsHardEligible(query, asset)).map(asset => asset.id))],
      });
      const catalog = new Map(assets.map(asset => [asset.id, asset]));
      const combined = new Map<string, AssetRetrievalCandidate>(lexical.candidates.map(candidate => [candidate.asset.id, {
        ...candidate, lexicalScore: candidate.score,
      }]));
      let hydrated = 0;
      let rejected = 0;
      for (const hit of hits) {
        // Milvus is rebuildable. Stale IDs, cross-kind hits, unauthorized assets
        // and failed PostgreSQL digest checks are never candidates.
        const asset = catalog.get(hit.assetId);
        if (!asset || !assetIsHardEligible(query, asset) || !Number.isFinite(hit.score)) { rejected++; continue; }
        if (hit.sourceVersion && hit.sourceVersion !== createHash('sha256')
          .update(buildAssetVectorText(asset), 'utf8').digest('hex')) { rejected++; continue; }
        hydrated++;
        const semanticScore = Math.max(0, Math.min(1, hit.score));
        const current = combined.get(asset.id);
        const lexicalScore = current?.lexicalScore ?? current?.score ?? 0;
        const hybridScore = semanticScore * policy.semanticWeight
          + lexicalScore * (1 - policy.semanticWeight);
        const matchedFields = new Set(current?.matchedFields ?? []);
        matchedFields.add('semantic');
        const constraint = assetConstraintEvaluation(query, asset);
        const hasConstraints = Boolean(query.requiredView || query.requiredState || query.requiredTraits?.length);
        const qualityScore = Math.max(0, Math.min(1, asset.qualityScore ?? 1));
        const combinedScore = hasConstraints
          ? Math.round(Math.min(1, hybridScore * 0.72 + constraint.score * 0.18 + qualityScore * 0.10) * 10_000) / 10_000
          : undefined;
        const semanticCandidate: AssetRetrievalCandidate = {
          asset,
          // A strong lexical hit must not be penalized merely because a vector
          // projection is stale. Semantic hits still dominate otherwise.
          score: Math.round(Math.min(1, Math.max(lexicalScore, hybridScore)) * 10_000) / 10_000,
          matchedFields: [...matchedFields], matchedTerms: current?.matchedTerms ?? [],
          lexicalScore, semanticScore,
          viewScore: query.requiredView ? (asset.views?.includes(query.requiredView) ? 1 : 0) : undefined,
          constraintScore: hasConstraints ? constraint.score : undefined,
          qualityScore: hasConstraints ? qualityScore : undefined,
          combinedScore,
          matchedTraits: constraint.matchedTraits,
          missingRequirements: constraint.missing,
          assetPackVersionId: asset.assetPackVersionId,
        };
        semanticCandidate.explanation = assetCandidateExplanation(semanticCandidate);
        combined.set(asset.id, semanticCandidate);
      }
      return finalizeAssetRetrieval([...combined.values()], {
        ruleVersion: ASSET_RETRIEVAL_HYBRID_RULE_VERSION, mode: 'hybrid_semantic_lexical',
        semantic: { status: 'available', attempted: true, model: this.dependencies.model,
          candidateCount: hydrated, reason: hydrated || !rejected ? 'available' : 'verification_failed' },
        retrievalMode: 'hybrid', degradationReason: null, requirementGaps: lexical.requirementGaps,
      }, policy, Math.min(5, Math.max(1, query.topK ?? 5)));
    } catch (error) {
      if (!isRebuildableVectorDependencyFailure(error)) throw error;
      return {
        ...lexical, ruleVersion: ASSET_RETRIEVAL_HYBRID_RULE_VERSION, mode: 'hybrid_semantic_lexical',
        semantic: { status: 'degraded', attempted: true, model: this.dependencies.model,
          candidateCount: 0, reason: 'projection_unavailable' },
        retrievalMode: 'degraded-lexical', degradationReason: 'milvus-unreachable',
      };
    }
  }
}

export function assetQueryVectorText(query: AssetRetrievalQuery): string {
  return [
    `类型：${query.kind}`, `名称：${query.name}`,
    query.aliases.length ? `别名：${query.aliases.join('、')}` : '',
    query.description?.trim() ? `描述：${query.description.trim()}` : '',
    ...(query.sourceQuotes ?? []).slice(0, 2).map(quote => `原文：${quote.trim()}`),
  ].filter(Boolean).join('\n').slice(0, 8_000);
}
