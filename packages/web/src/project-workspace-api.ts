import type {
  ProjectAssetRequirementsResponse, ProjectWorkspaceOverview, ScriptParseAttempt, ScriptStructure,
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

export async function getBreakdownModel(): Promise<{ model: string; connectionRevision: string; configured: boolean }> {
  const result = await request<{ defaultModel: string; connectionRevision?: string; configured: boolean }>('/models?role=breakdown');
  return { model: result.defaultModel, connectionRevision: result.connectionRevision ?? '', configured: result.configured };
}
