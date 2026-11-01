import { Type, type Static } from '@sinclair/typebox';

const Id = Type.String({ minLength: 1, maxLength: 100 });
export const EntityTypeSchema = Type.Union((['person', 'group', 'creature', 'place', 'object', 'material'] as const).map(v => Type.Literal(v)));
export const OccurrenceSchema = Type.Union((['present', 'mentioned', 'historical', 'imagined'] as const).map(v => Type.Literal(v)));
export type EntityType = Static<typeof EntityTypeSchema>;
export type Occurrence = Static<typeof OccurrenceSchema>;
const Count = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
export const UsageSchema = Type.Object({ inputTokens: Count, outputTokens: Count, totalTokens: Count, reasoningTokens: Count }, { additionalProperties: false });
export interface Usage { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; reasoningTokens: number | null }
export const AnalysisIssueSchema = Type.Object({
  code: Type.Union((['missing', 'wrongName', 'wrongType', 'wrongScope', 'unsupported', 'speaker', 'duplicate', 'identity', 'classification'] as const).map(v => Type.Literal(v))),
  targetId: Type.Union([Id, Type.Null()]),
  paragraphIds: Type.Array(Id, { minItems: 1, maxItems: 20, uniqueItems: true }),
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
}, { additionalProperties: false });
export type AnalysisIssue = Static<typeof AnalysisIssueSchema>;
export const AnalysisSchema = Type.Object({
  version: Type.Literal('novel-review/1'),
  status: Type.Union((['partial', 'needsReview', 'reviewed', 'humanEdited'] as const).map(v => Type.Literal(v))),
  calls: Type.Array(Type.Object({
    stage: Type.Union((['extract', 'scan', 'verify', 'repair', 'recheck'] as const).map(v => Type.Literal(v))),
    usage: UsageSchema,
  }, { additionalProperties: false }), { minItems: 1, maxItems: 5 }),
  contextRevisionIds: Type.Array(Id, { maxItems: 2000, uniqueItems: true }),
  paragraphCoverage: Type.Array(Type.Object({ paragraphId: Id, itemIds: Type.Array(Id, { maxItems: 1000, uniqueItems: true }) }, { additionalProperties: false }), { maxItems: 20000 }),
  issues: Type.Array(AnalysisIssueSchema, { maxItems: 500 }),
}, { additionalProperties: false });
export type NovelAnalysis = Static<typeof AnalysisSchema>;
export const entityTypes: Record<EntityType, string> = { person: '个体人物', group: '群体', creature: '生物 / 怪兽', place: '地点', object: '物件', material: '材料' };
export const occurrences: Record<Occurrence, string> = { present: '本章现场', mentioned: '仅被提及', historical: '历史 / 转述', imagined: '设想 / 假设' };
