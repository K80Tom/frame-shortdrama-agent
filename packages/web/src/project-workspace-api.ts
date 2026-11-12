import type { ProjectAssetRequirementsResponse, ProjectWorkspaceOverview } from '@lyra/shared';
import { workspaceFetch } from './deployment';

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

/** `GET /api/projects/:id/workspace-overview`：只读聚合，不触发模型或付费。 */
export function fetchProjectWorkspaceOverview(projectId: string): Promise<ProjectWorkspaceOverview> {
  return readJson<ProjectWorkspaceOverview>(`/api/projects/${encodeURIComponent(projectId)}/workspace-overview`, '项目概览');
}

/** `GET /api/projects/:id/asset-requirements`：只读匹配视图，前端不实现匹配规则。 */
export function fetchProjectAssetRequirements(projectId: string): Promise<ProjectAssetRequirementsResponse> {
  return readJson<ProjectAssetRequirementsResponse>(`/api/projects/${encodeURIComponent(projectId)}/asset-requirements`, '资产需求');
}
