import {
  ASSET_PROBE_FIXTURE_VERSION, assetRetrievalPolicyDigest, canonicalDigest,
  type AssetKind, type AssetProbeCase, type AssetProbeReport, type AssetProbeSide, type AssetRecord,
  type AssetRetrievalCandidate, type AssetRetrievalPolicy,
} from '@lyra/shared';
import type { AssetRetrievalQuery, AssetRetrievalResult } from '../assets/retrieval';
import { HybridAssetRetriever } from '../assets/vector/hybrid';

const QUERY_COST_MICROS = 100_000;
interface Fixture {
  key: string;
  expected: AssetProbeCase['expected'];
  expectedAssetId: string | null;
  query: AssetRetrievalQuery;
  assets: AssetRecord[];
  hits: Array<{ assetId: string; score: number }>;
}
function asset(id: string, kind: AssetKind, name: string, description: string): AssetRecord {
  return { id, kind, name, description, resourceUrl: `https://probe.invalid/${id}.png`, createdAt: '2026-01-01T00:00:00.000Z' };
}
function query(kind: AssetKind, name: string, description: string): AssetRetrievalQuery {
  return { kind, name, description, aliases: [], sourceQuotes: [] };
}

/** Fixed local fixtures. No provider, network, Milvus or paid embedding is used. */
export function assetProbeFixtures(): Fixture[] {
  const hero = asset('asset_probe_hero', 'character', '风衣女警立绘', '年轻女警，穿深色风衣，冷色雨夜');
  const semanticHero = asset('asset_probe_semantic', 'character', '林澜', '雨夜撑伞的人');
  const crossKind = asset('asset_probe_location', 'location', '巷口', '雨夜空间');
  return [
    { key: 'unique-lexical-reuse', expected: 'unique', expectedAssetId: hero.id,
      query: query('character', '新角色', '年轻女警，穿深色风衣'), assets: [hero], hits: [] },
    { key: 'ambiguous-safety-block', expected: 'ambiguous', expectedAssetId: null,
      query: query('character', '神秘来客', '冷傲，灰色西装'),
      assets: [asset('asset_probe_a', 'character', '访客甲', '冷傲，灰色西装'),
        asset('asset_probe_b', 'character', '访客乙', '冷傲，灰色西装')], hits: [] },
    { key: 'unrelated-missing', expected: 'missing', expectedAssetId: null,
      query: query('location', '废弃车站', '空旷候车厅'), assets: [hero], hits: [] },
    { key: 'stale-vector-id-hydration', expected: 'unique', expectedAssetId: semanticHero.id,
      query: query('character', '新角色', '雨夜撑伞的人'), assets: [semanticHero, crossKind],
      hits: [{ assetId: 'asset_deleted', score: 0.99 }, { assetId: crossKind.id, score: 0.98 },
        { assetId: semanticHero.id, score: 0.91 }] },
    { key: 'low-confidence-no-reuse', expected: 'missing', expectedAssetId: null,
      query: query('character', '陌生路人', '完全无关的描述'),
      assets: [asset('asset_probe_low', 'character', '西装总裁', '冷傲女总裁')],
      hits: [{ assetId: 'asset_probe_low', score: 0.55 }] },
    { key: 'cross-kind-no-reuse', expected: 'missing', expectedAssetId: null,
      query: query('location', '雨夜巷口', '无人巷道'), assets: [semanticHero],
      hits: [{ assetId: semanticHero.id, score: 0.99 }] },
  ];
}

function side(result: AssetRetrievalResult, fixture: Fixture): AssetProbeSide {
  const unique = result.status === 'unique';
  return {
    status: result.status,
    assetId: result.asset?.id ?? null,
    falseReuse: fixture.expected !== 'unique' && unique,
    safetyBlock: fixture.expected !== 'unique' && !unique,
    correctReuse: fixture.expected === 'unique' && unique && result.asset?.id === fixture.expectedAssetId,
    embeddingCostMicros: result.semantic.attempted ? QUERY_COST_MICROS : 0,
  };
}
function casePass(fixture: Fixture, result: AssetRetrievalResult): boolean {
  if (fixture.expected === 'unique') return result.status === 'unique' && result.asset?.id === fixture.expectedAssetId;
  if (fixture.expected === 'ambiguous') return result.status === 'ambiguous';
  return result.status === 'no_candidates' || result.status === 'below_threshold';
}
function metrics(cases: AssetProbeCase[], sideKey: 'baseline' | 'candidate') {
  return {
    falseReuses: cases.filter(item => item[sideKey].falseReuse).length,
    safetyBlocks: cases.filter(item => item[sideKey].safetyBlock).length,
    correctReuses: cases.filter(item => item[sideKey].correctReuse).length,
    contractFailures: 0,
    embeddingCostMicros: cases.reduce((sum, item) => sum + item[sideKey].embeddingCostMicros, 0),
  };
}

export async function runAssetRetrievalProbe(candidate: AssetRetrievalCandidate, createdAt: string): Promise<AssetProbeReport> {
  const comparisons: AssetProbeCase[] = [];
  let baselineContractFailures = 0; let candidateContractFailures = 0;
  for (const fixture of assetProbeFixtures()) {
    const evaluate = async (policy: AssetRetrievalPolicy) => {
      const retriever = new HybridAssetRetriever({
        embedding: { async embedText() { return [0.2, 0.8]; } },
        store: { async search() { return fixture.hits; }, async upsert() { throw new Error('probe is read-only'); },
          async deleteByAssetIds() { throw new Error('probe is read-only'); } },
        model: 'offline-probe-embedding', revision: ASSET_PROBE_FIXTURE_VERSION, queryCostMicros: QUERY_COST_MICROS,
      });
      return retriever.retrieve(fixture.query, fixture.assets, policy);
    };
    const baselineResult = await evaluate(candidate.basePolicy);
    const candidateResult = await evaluate(candidate.policy);
    if (!casePass(fixture, baselineResult)) baselineContractFailures++;
    if (!casePass(fixture, candidateResult)) candidateContractFailures++;
    comparisons.push({ key: fixture.key, expected: fixture.expected, expectedAssetId: fixture.expectedAssetId,
      baseline: side(baselineResult, fixture), candidate: side(candidateResult, fixture), pass: casePass(fixture, candidateResult) });
  }
  const baselineMetrics = metrics(comparisons, 'baseline');
  const candidateMetrics = metrics(comparisons, 'candidate');
  baselineMetrics.contractFailures = baselineContractFailures;
  candidateMetrics.contractFailures = candidateContractFailures;
  const gate = {
    falseReuseDelta: candidateMetrics.falseReuses - baselineMetrics.falseReuses,
    safetyBlockDelta: candidateMetrics.safetyBlocks - baselineMetrics.safetyBlocks,
    correctReuseDelta: candidateMetrics.correctReuses - baselineMetrics.correctReuses,
    contractFailureDelta: candidateMetrics.contractFailures - baselineMetrics.contractFailures,
    embeddingCostDeltaMicros: candidateMetrics.embeddingCostMicros - baselineMetrics.embeddingCostMicros,
  };
  const verdict = gate.falseReuseDelta <= 0 && gate.safetyBlockDelta >= 0 && gate.correctReuseDelta >= 0
    && candidateMetrics.contractFailures === 0 && gate.embeddingCostDeltaMicros <= 0 ? 'pass' : 'fail';
  const identity = { candidateId: candidate.id, fixtureVersion: ASSET_PROBE_FIXTURE_VERSION as typeof ASSET_PROBE_FIXTURE_VERSION,
    baselinePolicyDigest: assetRetrievalPolicyDigest(candidate.basePolicy), candidatePolicyDigest: candidate.policyDigest };
  return {
    id: `eprobe_${canonicalDigest(identity).slice(0, 32)}`, ...identity,
    verdict, gate, baselineMetrics, candidateMetrics, cases: comparisons, modelCalls: 0, createdAt,
  };
}
