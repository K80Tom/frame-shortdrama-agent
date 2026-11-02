import type { AssetKind, AssetRecord } from '@lyra/shared';
import { DEFAULT_ASSET_RETRIEVAL_POLICY, type AssetRetrievalPolicy } from '@lyra/shared';

export const ASSET_RETRIEVAL_RULE_VERSION = 'asset-rag-structured/1';
export const ASSET_RETRIEVAL_HYBRID_RULE_VERSION = 'asset-rag-hybrid/1';
export const ASSET_RETRIEVAL_THRESHOLD = DEFAULT_ASSET_RETRIEVAL_POLICY.threshold;
export const ASSET_RETRIEVAL_AMBIGUITY_MARGIN = DEFAULT_ASSET_RETRIEVAL_POLICY.ambiguityMargin;
export const ASSET_RETRIEVAL_SEMANTIC_WEIGHT = DEFAULT_ASSET_RETRIEVAL_POLICY.semanticWeight;
const RECALL_THRESHOLD = 0.34;
const MAX_TOKENS = 24;
const MAX_CANDIDATES = 5;

export type AssetRetrievalRuleVersion = typeof ASSET_RETRIEVAL_RULE_VERSION
  | typeof ASSET_RETRIEVAL_HYBRID_RULE_VERSION;
export type AssetRetrievalMode = 'structured_lexical' | 'hybrid_semantic_lexical';

export interface AssetRetrievalQuery {
  kind: AssetKind;
  name: string;
  aliases: string[];
  description?: string;
  sourceQuotes?: string[];
}

export interface AssetRetrievalCandidate {
  asset: AssetRecord;
  score: number;
  matchedFields: Array<'name' | 'description' | 'semantic'>;
  matchedTerms: string[];
  lexicalScore?: number;
  semanticScore?: number;
}

export interface AssetRetrievalSemanticDiagnostics {
  status: 'disabled' | 'available' | 'degraded';
  /** A query embedding was attempted, including a request that later failed. */
  attempted: boolean;
  model: string | null;
  candidateCount: number;
  reason: 'not_configured' | 'available' | 'projection_unavailable';
}

export interface AssetRetrievalProvider {
  model: string;
  revision: string;
  /** Conservative run-budget ceiling for one query embedding. */
  queryCostMicros: number;
}

export interface AssetRetriever {
  readonly semanticProvider?: AssetRetrievalProvider;
  retrieve(query: AssetRetrievalQuery, assets: AssetRecord[], policy?: AssetRetrievalPolicy): Promise<AssetRetrievalResult>;
}

export interface AssetRetrievalResult {
  ruleVersion: AssetRetrievalRuleVersion;
  mode: AssetRetrievalMode;
  status: 'unique' | 'ambiguous' | 'below_threshold' | 'no_candidates';
  asset: AssetRecord | null;
  score: number | null;
  threshold: number;
  ambiguityMargin: number;
  candidates: AssetRetrievalCandidate[];
  ambiguousCandidates: AssetRetrievalCandidate[];
  semantic: AssetRetrievalSemanticDiagnostics;
}

/**
 * Deterministic lexical retrieval adapted from 短剧Main's structured/CJK
 * fallback strategy. Lyra's AssetService remains the source of truth: no LLM
 * query rewriting or old-platform API is used. Optional semantic retrieval is
 * layered on by HybridAssetRetriever and hydrated against the same catalog.
 * Exact identity matching stays in the production executor and runs first.
 * A catalog name that only contains, or is only contained by, the entity name
 * stays below the auto-reuse band so creation time cannot promote it.
 */
function partialNameCap(policy: AssetRetrievalPolicy): number {
  const cap = Math.floor((policy.threshold - policy.ambiguityMargin - 0.0002) * 10_000) / 10_000;
  return cap > 0 ? cap : 0;
}

export function retrieveAssetForGeneration(
  query: AssetRetrievalQuery,
  assets: AssetRecord[],
  policy: AssetRetrievalPolicy = DEFAULT_ASSET_RETRIEVAL_POLICY,
): AssetRetrievalResult {
  const names = [...new Set([query.name, ...query.aliases]
    .map(value => normalizeSearchText(value)).filter(value => codePointLength(value) >= 2))];
  let description = cleanDescription(query.description ?? '', names);
  if (!description) {
    description = cleanDescription((query.sourceQuotes ?? []).slice(0, 2).join('。'), names);
  }
  const nameTokens = tokenizeAssetQuery(names.join(' '));
  const descriptionTokens = tokenizeAssetQuery(description);
  const clauses = description.split(/[\s，。！？、；：,!.?;:]+/u)
    .filter(value => codePointLength(value) >= 4 && !STOP_WORDS.has(value));

  const candidates = assets.filter(asset => asset.kind === query.kind).map(asset => {
    const assetName = normalizeSearchText(asset.name);
    const assetDescription = cleanDescription(asset.description, [assetName]);
    const byName = coverage(nameTokens, assetName, assetDescription);
    const byDescription = coverage(descriptionTokens, assetName, assetDescription);
    const matchedFields = new Set<'name' | 'description'>([...byName.fields, ...byDescription.fields]);
    const matchedTerms = new Set<string>([...byName.terms, ...byDescription.terms]);
    const exactName = names.some(anchor => anchor === assetName);
    // "沈玥" inside "沈玥的姐姐", or "林晚" inside "林晚晴", stays outside the reuse band.
    const partialName = !exactName && names.some(anchor => assetName.includes(anchor)
      || (codePointLength(assetName) >= 2 && anchor.includes(assetName) && isUsefulToken(assetName)));
    let descriptionScore = byDescription.score * 0.95;
    for (const clause of clauses) {
      if (assetDescription.includes(clause)) {
        descriptionScore = Math.max(descriptionScore, 0.90);
        matchedFields.add('description'); matchedTerms.add(clause);
      }
    }
    let nameScore = byName.score * 0.96;
    if (exactName) {
      nameScore = Math.max(nameScore, 0.99);
      matchedFields.add('name');
      matchedTerms.add(names.find(anchor => anchor === assetName)!);
    } else if (partialName) {
      nameScore = partialNameCap(policy);
      for (const anchor of names) {
        if (assetName.includes(anchor)) { matchedFields.add('name'); matchedTerms.add(anchor); }
        else if (codePointLength(assetName) >= 2 && anchor.includes(assetName) && isUsefulToken(assetName)) {
          matchedFields.add('name'); matchedTerms.add(assetName);
        }
      }
    } else if (codePointLength(assetName) >= 2 && isUsefulToken(assetName) && description.includes(assetName)) {
      descriptionScore = Math.max(descriptionScore, 0.74);
      matchedFields.add('name'); matchedTerms.add(assetName);
    }
    const score = Math.max(nameScore, descriptionScore);
    return {
      asset,
      score: Math.round(Math.min(score, 1) * 10_000) / 10_000,
      matchedFields: [...matchedFields],
      matchedTerms: [...matchedTerms].slice(0, 8),
    } satisfies AssetRetrievalCandidate;
  }).filter(candidate => candidate.score >= RECALL_THRESHOLD && candidate.matchedTerms.length > 0)
    .sort((left, right) => right.score - left.score
      || right.asset.createdAt.localeCompare(left.asset.createdAt)
      || left.asset.id.localeCompare(right.asset.id));

  return finalizeAssetRetrieval(candidates, {
    ruleVersion: ASSET_RETRIEVAL_RULE_VERSION,
    mode: 'structured_lexical',
    semantic: { status: 'disabled', attempted: false, model: null, candidateCount: 0, reason: 'not_configured' },
  }, policy);
}

/** Shared ranking/ambiguity gate for lexical-only and hydrated hybrid candidates. */
export function finalizeAssetRetrieval(
  recalled: AssetRetrievalCandidate[],
  metadata: Pick<AssetRetrievalResult, 'ruleVersion' | 'mode' | 'semantic'>,
  policy: AssetRetrievalPolicy = DEFAULT_ASSET_RETRIEVAL_POLICY,
): AssetRetrievalResult {
  const candidates = recalled.filter(candidate => candidate.score >= RECALL_THRESHOLD
      && (candidate.matchedTerms.length > 0 || candidate.semanticScore !== undefined))
    .sort((left, right) => right.score - left.score
      || right.asset.createdAt.localeCompare(left.asset.createdAt)
      || left.asset.id.localeCompare(right.asset.id));
  const top = candidates[0] ?? null;
  const close = top ? candidates.filter(candidate => top.score - candidate.score < policy.ambiguityMargin) : [];
  const status = !top ? 'no_candidates'
    : top.score < policy.threshold ? 'below_threshold'
      : close.length > 1 ? 'ambiguous' : 'unique';
  return {
    ...metadata,
    status,
    asset: status === 'unique' ? top!.asset : null,
    score: top?.score ?? null,
    threshold: policy.threshold,
    ambiguityMargin: policy.ambiguityMargin,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    ambiguousCandidates: status === 'ambiguous' ? close : [],
  };
}

/** Bounded CJK/Latin terms used for auditable lexical retrieval and tests. */
export function tokenizeAssetQuery(query: string): string[] {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];
  const raw: string[] = [...DOMAIN_TERMS.filter(term => normalized.includes(term))];
  for (const part of normalized.split(TOKEN_BOUNDARY)) {
    const compact = part.replace(/(?:一位|一个|一种|题材|气质|风格|感觉|整体|左右|配|穿|带|的|和|与|或|及|并且|中|里|上|下)/gu, ' ');
    for (const segment of compact.split(/\s+/u)) {
      if (!segment) continue;
      raw.push(segment);
      if (/^[\u3400-\u9fff]{3,}$/u.test(segment)) raw.push(...cjkNgrams(segment));
    }
  }
  const ranked = new Map<string, { score: number; index: number }>();
  raw.forEach((value, index) => {
    const token = normalizeToken(value);
    if (!isUsefulToken(token)) return;
    const score = tokenScore(token);
    const current = ranked.get(token);
    if (!current || score > current.score) ranked.set(token, { score, index: current?.index ?? index });
  });
  return [...ranked.entries()].sort((left, right) => right[1].score - left[1].score
    || left[1].index - right[1].index || left[0].localeCompare(right[0]))
    .slice(0, MAX_TOKENS).map(([token]) => token);
}

function coverage(tokens: string[], name: string, description: string) {
  const fields = new Set<'name' | 'description'>();
  const terms = new Set<string>();
  const total = tokens.reduce((sum, token) => sum + tokenWeight(token), 0);
  let matched = 0;
  for (const token of tokens) {
    if (name.includes(token)) {
      matched += tokenWeight(token);
      fields.add('name'); terms.add(token);
    } else if (description.includes(token)) {
      matched += tokenWeight(token) * 0.85;
      fields.add('description'); terms.add(token);
    }
  }
  return { score: total ? matched / total : 0, fields, terms };
}

function cleanDescription(value: string, names: string[]): string {
  let text = normalizeSearchText(value);
  for (const name of names) text = text.replaceAll(name, ' ');
  return text
    .replace(/全流程自动制片生成|事实来自计划|生图模型|视觉风格|剧本中已确认的实体|已确认的实体|剧本设定|已有角色资产|角色候选/gu, ' ')
    .replace(/\b(?:plan|script|project|production)_[a-f0-9]{16,}\b/giu, ' ')
    .replace(/[\s，。！？、；：,!.?;:]+/gu, ' ').trim();
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').trim();
}
function normalizeToken(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN')
    .replace(/^[^\p{L}\p{N}\u3400-\u9fff]+|[^\p{L}\p{N}\u3400-\u9fff]+$/gu, '');
}
function cjkNgrams(value: string): string[] {
  const chars = [...value]; const grams: string[] = [];
  for (const size of [4, 3, 2]) {
    for (let index = 0; index <= chars.length - size; index += 1) grams.push(chars.slice(index, index + size).join(''));
  }
  return grams;
}
function tokenWeight(token: string): number {
  return Math.min(4, Math.max(1, codePointLength(token)));
}
function tokenScore(token: string): number {
  return (DOMAIN_TERMS.includes(token) ? 20 : 0)
    + (/[\u3400-\u9fff]/u.test(token) ? 5 : 0) + Math.min(codePointLength(token), 8);
}
function codePointLength(value: string): number { return [...value].length; }
function isUsefulToken(token: string): boolean {
  if (!token || STOP_WORDS.has(token) || /^\d+$/u.test(token)) return false;
  if (/^[a-z0-9_-]{2,}$/u.test(token)) return true;
  if (/^[\u3400-\u9fff]$/u.test(token)) return USEFUL_SINGLE_CJK.has(token);
  return codePointLength(token) >= 2;
}

const TOKEN_BOUNDARY = /[\s,，.。:：;；!！?？、/\\()[\]{}<>《》"'“”‘’|]+/u;
const USEFUL_SINGLE_CJK = new Set(['男', '女', '红', '黑', '白', '灰', '蓝', '绿', '紫', '金']);
const STOP_WORDS = new Set([
  '找', '想找', '查找', '搜索', '找一位', '找一个', '一位', '一个', '一种', '需要', '帮我', '给我', '用于', '可以',
  '相关', '中的', '里面', '题材', '素材', '资产', '图片', '图像', '参考', '参考图', '角色',
  '剧本', '设定', '测试', '生成', '计划', '模型', '描述', '说明', '候选', '已有', '事实', '来源',
]);
const DOMAIN_TERMS = [
  '女总裁', '男主角', '女主角', '红长发', '黑长发', '白衬衫', '灰色西装', '黑色西装',
  '短裙', '长裙', '战损版', '少年版', '老年版', '古装版', '现代版', '都市', '豪门',
  '古风', '仙侠', '玄幻', '神魔', '科幻', '赛博朋克', '太空', '机甲', '机器人',
  '道具', '武器', '法宝', '场景', '客厅', '卧室', '办公室', '会议室', '光影',
  '暖光', '冷光', '冷傲', '强势', '温柔', '霸气', '阴冷', '宏大', '震撼',
];
