import { createHash } from 'node:crypto';
import type { AssetRecord } from '@lyra/shared';
import { DEFAULT_ASSET_RETRIEVAL_POLICY, type AssetRetrievalPolicy } from '@lyra/shared';
import {
  ASSET_RETRIEVAL_HYBRID_RULE_VERSION,
  finalizeAssetRetrieval,
  retrieveAssetForGeneration,
  type AssetRetrievalCandidate,
  type AssetRetrievalProvider,
  type AssetRetrievalQuery,
  type AssetRetrievalResult,
  type AssetRetriever,
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

  async retrieve(query: AssetRetrievalQuery, assets: AssetRecord[],
    policy: AssetRetrievalPolicy = DEFAULT_ASSET_RETRIEVAL_POLICY): Promise<AssetRetrievalResult> {
    const lexical = retrieveAssetForGeneration(query, assets, policy);
    try {
      const vector = await this.dependencies.embedding.embedText(assetQueryVectorText(query));
      const hits = await this.dependencies.store.search(vector, query.kind, 12);
      const catalog = new Map(assets.map(asset => [asset.id, asset]));
      const combined = new Map<string, AssetRetrievalCandidate>(lexical.candidates.map(candidate => [candidate.asset.id, {
        ...candidate, lexicalScore: candidate.score,
      }]));
      let hydrated = 0;
      for (const hit of hits) {
        // Milvus is rebuildable. Stale IDs and cross-kind hits are never assets.
        const asset = catalog.get(hit.assetId);
        if (!asset || asset.kind !== query.kind || !Number.isFinite(hit.score)) continue;
        if (hit.sourceVersion && hit.sourceVersion !== createHash('sha256')
          .update(buildAssetVectorText(asset), 'utf8').digest('hex')) continue;
        hydrated++;
        const semanticScore = Math.max(0, Math.min(1, hit.score));
        const current = combined.get(asset.id);
        const lexicalScore = current?.lexicalScore ?? current?.score ?? 0;
        const hybridScore = semanticScore * policy.semanticWeight
          + lexicalScore * (1 - policy.semanticWeight);
        const matchedFields = new Set(current?.matchedFields ?? []);
        matchedFields.add('semantic');
        combined.set(asset.id, {
          asset,
          // A strong lexical hit must not be penalized merely because a vector
          // projection is stale. Semantic hits still dominate otherwise.
          score: Math.round(Math.min(1, Math.max(lexicalScore, hybridScore)) * 10_000) / 10_000,
          matchedFields: [...matchedFields], matchedTerms: current?.matchedTerms ?? [],
          lexicalScore, semanticScore,
        });
      }
      return finalizeAssetRetrieval([...combined.values()], {
        ruleVersion: ASSET_RETRIEVAL_HYBRID_RULE_VERSION, mode: 'hybrid_semantic_lexical',
        semantic: { status: 'available', attempted: true, model: this.dependencies.model,
          candidateCount: hydrated, reason: 'available' },
      }, policy);
    } catch (error) {
      if (!isRebuildableVectorDependencyFailure(error)) throw error;
      return {
        ...lexical, ruleVersion: ASSET_RETRIEVAL_HYBRID_RULE_VERSION, mode: 'hybrid_semantic_lexical',
        semantic: { status: 'degraded', attempted: true, model: this.dependencies.model,
          candidateCount: 0, reason: 'projection_unavailable' },
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
