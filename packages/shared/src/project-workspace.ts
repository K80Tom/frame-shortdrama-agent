/**
 * 项目正式主链（#182）只读聚合契约。
 *
 * 这两个接口都是 GET、只读：不触发模型、不发起付费、不写 Outbox。
 * 聚合的事实来自 PostgreSQL（经 RLS 租户上下文），前端不复制业务规则。
 */

/** 项目正式工作区的六个区段（顺序即主链顺序）。 */
export type ProjectFlowSection =
  | 'overview' | 'script' | 'assets' | 'storyboard' | 'canvas' | 'production';

export const PROJECT_FLOW_SECTION_ORDER: readonly ProjectFlowSection[] = [
  'overview', 'script', 'assets', 'storyboard', 'canvas', 'production',
] as const;

/** 概览页唯一主行动的枚举，由服务端按优先级决定，不按导航区段算百分比。 */
export type ProjectNextActionId =
  | 'add-script' | 'start-breakdown' | 'review-facts' | 'adopt-facts'
  | 'resolve-assets' | 'adopt-storyboard' | 'create-production'
  | 'handle-todos' | 'view-delivery';

export interface ProjectTodo {
  id: string;
  label: string;
  kind: string;
}

/**
 * `GET /api/projects/:projectId/workspace-overview` 的 200 响应。
 * 所有字段都是只读快照；`nextAction` 是服务端按 §优先级算出的唯一主行动。
 */
export interface ProjectWorkspaceOverview {
  projectId: string;
  title: string;
  updatedAt: string | null;
  script: { versionId: string; version: number; updatedAt: string | null } | null;
  facts: {
    planRevisionId: string;
    scriptVersionId: string;
    sceneCount: number;
    entityCount: number;
    adoptedAt: string | null;
    /** 已采用事实落后于当前剧本版本。 */
    stale: boolean;
  } | null;
  assets: { total: number; ready: number; missing: number; ambiguous: number };
  storyboard: {
    revisionId: string;
    shotCount: number;
    candidateCount: number;
    adoptedAt: string | null;
    /** 已采用分镜落后于当前剧本/事实版本。 */
    stale: boolean;
  } | null;
  latestRun: {
    runId: string;
    kind: 'breakdown' | 'production' | 'video';
    status: string;
    stage: string | null;
    updatedAt: string | null;
  } | null;
  todos: ProjectTodo[];
  delivery: { available: boolean; artifactCount: number; lastDeliveredAt: string | null };
  nextAction: {
    id: ProjectNextActionId;
    label: string;
    detail: string;
    section: ProjectFlowSection;
  } | null;
}

/** 资产匹配复用 production 执行器的同一规则版本。 */
export const PROJECT_ASSET_MATCH_RULE_VERSION = 'production-asset-match/5';

export type ProjectAssetRequirementKind = 'character' | 'location' | 'prop';

/**
 * `GET /api/projects/:projectId/asset-requirements` 的 200 响应。
 * 无已采用事实时：planRevisionId 为 null、requirements 为空、summary 全零。
 */
export interface ProjectAssetRequirementsResponse {
  projectId: string;
  planRevisionId: string | null;
  ruleVersion: typeof PROJECT_ASSET_MATCH_RULE_VERSION;
  summary: { total: number; matched: number; missing: number; ambiguous: number };
  requirements: Array<{
    requirementId: string;
    kind: ProjectAssetRequirementKind;
    name: string;
    sceneIds: string[];
    match: {
      assetId: string | null;
      matchedBy: 'name' | 'alias' | 'retrieval' | null;
      matchedTerm: string | null;
      ambiguous: boolean;
      alternatives: Array<{ assetId: string; name: string; score: number | null }>;
    };
    action: { kind: 'create' | 'choose' | 'none'; label: string };
  }>;
}
