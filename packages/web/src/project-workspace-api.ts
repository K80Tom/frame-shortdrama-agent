import type {
  EpisodeParseRequest, EpisodeParseResponse, ProjectAssetRequirementsResponse,
  ProjectWorkspaceOverview, ScriptEntityKind, ScriptParseAttempt, ScriptStructure, AssetRecord,
} from '@lyra/shared';
import { workspaceFetch } from './deployment';
import type { FactPlan } from './facts-editor';

export interface ProjectRecord {
  id: string;
  title: string;
  currentScriptVersionId: string | null;
  activePlanRevisionId: string | null;
  activeStoryboardRevisionId: string | null;
}

export interface ScriptVersionRecord {
  id: string;
  projectId: string;
  version: number;
  rawText: string;
  structure: ScriptStructure | null;
  createdAt: string;
}

/** 版本历史只读摘要：列表接口不回传 rawText/structure，避免整份剧本重复传输。 */
export interface ScriptVersionSummary {
  id: string;
  projectId: string;
  version: number;
  contentSha256: string;
  createdAt: string;
}

async function readJson<T>(path: string, subject: string): Promise<T> {
  const response = await workspaceFetch(path, { cache: 'no-store' });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === 'object' && body.error && typeof body.error === 'object'
      && 'message' in body.error ? String((body.error as { message: unknown }).message) : `${subject}请求失败（${response.status}）。`;
    throw new Error(message);
  }
  return body as T;
}

export async function request<T>(path: string, options: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const normalized = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : `/${path}`}`;
  const response = await workspaceFetch(normalized, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    cache: 'no-store',
    ...(options.body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' },
      body: JSON.stringify(options.body),
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === 'object' && body.error && typeof body.error === 'object'
      && 'message' in body.error ? String((body.error as { message: unknown }).message) : `请求失败（${response.status}）。`;
    throw new Error(message);
  }
  return body as T;
}

/** `GET /api/projects/:id/workspace-overview`：只读聚合，不触发模型或付费。 */
export function fetchProjectWorkspaceOverview(projectId: string): Promise<ProjectWorkspaceOverview> {
  return readJson<ProjectWorkspaceOverview>(`/api/projects/${encodeURIComponent(projectId)}/workspace-overview`, '项目概览');
}

/** `GET /api/projects/:id/asset-requirements`：只读匹配视图，前端不实现匹配规则。 */
export function fetchProjectAssetRequirements(projectId: string): Promise<ProjectAssetRequirementsResponse> {
  return readJson<ProjectAssetRequirementsResponse>(`/api/projects/${encodeURIComponent(projectId)}/asset-requirements`, '资产需求');
}

export function getProject(projectId: string): Promise<ProjectRecord> {
  return request<ProjectRecord>(`/projects/${encodeURIComponent(projectId)}`);
}

export async function getCurrentScriptVersion(projectId: string): Promise<ScriptVersionRecord | null> {
  const project = await getProject(projectId);
  if (!project.currentScriptVersionId) return null;
  return request<ScriptVersionRecord>(`/projects/${encodeURIComponent(projectId)}/script-versions/${encodeURIComponent(project.currentScriptVersionId)}`);
}

export function getScriptVersion(projectId: string, scriptVersionId: string): Promise<ScriptVersionRecord> {
  return request<ScriptVersionRecord>(`/projects/${encodeURIComponent(projectId)}/script-versions/${encodeURIComponent(scriptVersionId)}`);
}

export function saveScriptVersion(projectId: string, input: { rawText: string; structure?: ScriptStructure }): Promise<ScriptVersionRecord> {
  return request<ScriptVersionRecord>(`/projects/${encodeURIComponent(projectId)}/script-versions`, { method: 'POST', body: input });
}

/** 版本历史：只用于列表展示与“当前版本”标记，不触发任何写入。 */
export async function listScriptVersions(projectId: string): Promise<ScriptVersionSummary[]> {
  const result = await request<{ items: ScriptVersionSummary[] }>(
    `/projects/${encodeURIComponent(projectId)}/script-versions`);
  return result.items;
}

export async function listPlanRevisions(projectId: string): Promise<FactPlan[]> {
  const result = await request<{ items: FactPlan[] }>(`/projects/${encodeURIComponent(projectId)}/plan-revisions`);
  return result.items;
}

export function listScriptParseAttempts(projectId: string): Promise<ScriptParseAttempt[]> {
  return request<ScriptParseAttempt[]>(`/projects/${encodeURIComponent(projectId)}/script-parse-attempts`);
}

/**
 * `POST /api/projects/:projectId/episodes/:episodeNumber/parse`
 * 只解析目标集；付费动作必须由前端显式传入 `allowPaid: true` 并经过人工确认；
 * `commandId` 是幂等键，一次会话内稳定复用，网络重试不重复建单。请求/响应类型来自 `@lyra/shared`。
 */
export function parseEpisode(
  projectId: string,
  episodeNumber: number,
  body: EpisodeParseRequest,
): Promise<EpisodeParseResponse> {
  return request<EpisodeParseResponse>(
    `/projects/${encodeURIComponent(projectId)}/episodes/${episodeNumber}/parse`,
    { method: 'POST', body },
  );
}

/** confirm-entities 提交项：原名 `name`，行内改名经 `renameTo`；未勾选项 selected:false。 */
export interface ConfirmEntitiesSelection {
  candidateId: string;
  kind: ScriptEntityKind;
  name: string;
  aliases: string[];
  description: string | null;
  selected: boolean;
  renameTo: string | null;
}

export interface ConfirmEntitiesCheckSummary {
  id: string;
  result: 'passed' | 'failed';
}

/**
 * 与 `checkPlan` 返回结构对齐：`check` 是校验记录，`issues` 是问题清单；
 * 确认端点不重复发起 check，直接复用这份结果做人工警告与采用。
 */
export interface ConfirmEntitiesResponse {
  scriptVersion: ScriptVersionRecord;
  plan: FactPlan | null;
  check: { check: ConfirmEntitiesCheckSummary; issues: Array<Record<string, unknown>> } | null;
  reusedAssets: Array<{ kind: ScriptEntityKind; name: string; existingAssetId: string | null }>;
}

/**
 * `POST /api/projects/:projectId/episodes/:episodeNumber/confirm-entities`
 * 从服务端 parse attempt 恢复草稿、替换目标集后保存新版本；允许 0 个已选实体（仅保存解析场次）。
 * `attemptId` 关联本次解析记录；selections 覆盖全部候选，忽略项绝不入库。
 */
export function confirmEpisodeEntities(
  projectId: string,
  episodeNumber: number,
  body: { scriptVersionId: string; attemptId: string | null; selections: ConfirmEntitiesSelection[] },
): Promise<ConfirmEntitiesResponse> {
  return request<ConfirmEntitiesResponse>(
    `/projects/${encodeURIComponent(projectId)}/episodes/${episodeNumber}/confirm-entities`,
    { method: 'POST', body },
  );
}

export function rebuildCurrentFactPlan(projectId: string): Promise<ConfirmEntitiesResponse> {
  return request<ConfirmEntitiesResponse>(
    `/projects/${encodeURIComponent(projectId)}/fact-plans/rebuild-current`, { method: 'POST', body: {} },
  );
}

export interface FactPlanCheckResult {
  check: ConfirmEntitiesCheckSummary;
  issues: Array<Record<string, unknown>>;
}

/** 删除的是新事实候选中的需求实体，不删除资产库记录，也不原地改写已采用版本。 */
export function removeFactPlanEntities(
  basePlanRevisionId: string,
  expectedActivePlanRevisionId: string,
  entities: Array<{ kind: ScriptEntityKind; entityId: string }>,
): Promise<FactPlan> {
  return request<FactPlan>(`/plan-revisions/${encodeURIComponent(basePlanRevisionId)}/entity-edits`, {
    method: 'POST', body: { expectedActivePlanRevisionId, edits: [], removeEntities: entities },
  });
}

export function checkFactPlan(planRevisionId: string): Promise<FactPlanCheckResult> {
  return request<FactPlanCheckResult>(`/plan-revisions/${encodeURIComponent(planRevisionId)}/checks`, {
    method: 'POST', body: {},
  });
}

export function adoptFactPlan(projectId: string, input: {
  planRevisionId: string;
  checkId: string;
  expectedActivePlanRevisionId: string;
  allowCheckWarnings: boolean;
}): Promise<unknown> {
  return request(`/projects/${encodeURIComponent(projectId)}/adoptions`, {
    method: 'POST', body: input,
  });
}

/** 自动复用同名/别名实体，或创建待补素材的元数据资产；不会覆盖已有素材。 */
export function createMetadataAsset(input: {
  kind: ScriptEntityKind; name: string; aliases: string[]; description: string | null;
}): Promise<AssetRecord> {
  return request<AssetRecord>('/assets/metadata', { method: 'POST', body: {
    kind: input.kind, name: input.name, aliases: input.aliases, description: input.description ?? '',
  } });
}
export async function getStoryboardModel(): Promise<{ model: string; connectionRevision: string; configured: boolean }> {
  const result = await request<{ defaultModel: string; connectionRevision?: string; configured: boolean }>('/models?role=general');
  return { model: result.defaultModel, connectionRevision: result.connectionRevision ?? '', configured: result.configured };
}
export async function getBreakdownModel(): Promise<{ model: string; connectionRevision: string; configured: boolean }> {
  const result = await request<{ defaultModel: string; connectionRevision?: string; configured: boolean }>('/models?role=breakdown');
  return { model: result.defaultModel, connectionRevision: result.connectionRevision ?? '', configured: result.configured };
}
