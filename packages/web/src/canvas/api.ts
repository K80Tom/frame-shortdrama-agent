import { workspaceFetch } from '../deployment';
import type {
  CanvasCommand, CanvasCommandReceipt, CanvasDocument, CanvasGraph, CanvasQuote, CanvasRevision, CanvasRuntimeView,
  CanvasValidationResult,
} from '@lyra/shared';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' };

async function readError(response: Response): Promise<Error> {
  try {
    const body = await response.json() as { error?: { code?: string; message?: string; details?: unknown } };
    const error = new Error(body.error?.message ?? `请求失败（${response.status}）`);
    (error as Error & { code?: string; details?: unknown }).code = body.error?.code;
    (error as Error & { details?: unknown }).details = body.error?.details;
    return error;
  } catch {
    return new Error(`请求失败（${response.status}）`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await workspaceFetch(path, { cache: 'no-store', ...init });
  if (!response.ok) throw await readError(response);
  return response.json() as Promise<T>;
}

export function listCanvases(projectId: string): Promise<CanvasDocument[]> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/canvases`);
}

export function createCanvas(projectId: string, body: { title?: string; from?: 'storyboard' | 'empty' } = {}):
  Promise<CanvasDocument> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/canvases`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body),
  });
}

export function getCanvas(canvasId: string): Promise<{
  document: CanvasDocument; latest: CanvasRevision | null; revisions: CanvasRevision[];
}> {
  return request(`/api/canvases/${encodeURIComponent(canvasId)}`);
}

export function canvasRevision(canvasId: string, revisionId: string): Promise<CanvasRevision> {
  return request(`/api/canvases/${encodeURIComponent(canvasId)}/revisions/${encodeURIComponent(revisionId)}`);
}

export function submitCanvasCommands(canvasId: string, expectedRevision: number, clientRequestId: string,
  commands: CanvasCommand[]): Promise<{ revision: CanvasRevision; receipt: CanvasCommandReceipt; replay: boolean }> {
  return request(`/api/canvases/${encodeURIComponent(canvasId)}/revisions/${expectedRevision}/commands`, {
    method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ clientRequestId, expectedRevision, commands }),
  });
}

export function validateCanvas(canvasId: string, revision: string): Promise<CanvasValidationResult & { revision: number }> {
  return request(`/api/canvases/${encodeURIComponent(canvasId)}/revisions/${encodeURIComponent(revision)}/validate`, {
    method: 'POST', headers: JSON_HEADERS, body: '{}',
  });
}

export function adoptCanvas(canvasId: string, revision: number, expectedRevision: number): Promise<CanvasRevision> {
  return request(`/api/canvases/${encodeURIComponent(canvasId)}/revisions/${revision}/adopt`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ expectedRevision }),
  });
}

export function requestCanvasQuote(canvasId: string, revision: number, body: {
  budgetMicros?: number; model?: string; candidatePolicy?: string; candidateLimit?: number;
} = {}): Promise<CanvasQuote> {
  return request(`/api/canvases/${encodeURIComponent(canvasId)}/revisions/${revision}/quote`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body),
  });
}

/**
 * 唯一付费入口：确认估价卡并创建运行。界面上必须先展示估价卡，再由人确认。
 * 后端会再次校验 quote 状态、摘要、过期与预算，前端不持有任何绕过路径。
 */
export function confirmBudgetAndCreateRun(canvasId: string, revision: number, body: {
  quoteId: string; clientRequestId: string;
}): Promise<{ id: string; revisionId: string; createdAt: string }> {
  return request(`/api/canvases/${encodeURIComponent(canvasId)}/revisions/${revision}/budget/confirm`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body),
  });
}

/**
 * 节点驱动：分镜节点一键异步生成。仍需 quoteId 证明估价卡已确认；
 * 同一 revision 已有运行时后端直接复用，不会重复扣费。
 */
export function generateCanvasNode(canvasId: string, revision: number, nodeId: string, body: {
  quoteId: string; clientRequestId: string;
}): Promise<{ id: string; nodeId: string; revisionId: string; createdAt: string }> {
  return request(
    `/api/canvases/${encodeURIComponent(canvasId)}/revisions/${revision}/nodes/${encodeURIComponent(nodeId)}/generate`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) },
  );
}

export function canvasRuntimeView(canvasId: string, revision: number, cursor?: string | null): Promise<CanvasRuntimeView> {
  const params = new URLSearchParams({ revision: String(revision) });
  if (cursor) params.set('cursor', cursor);
  return request(`/api/canvases/${encodeURIComponent(canvasId)}/runtime-view?${params.toString()}`);
}

export function canvasEvents(canvasId: string): Promise<Array<{
  id: string; type: string; createdAt: string; payload: Record<string, unknown>;
}>> {
  return request(`/api/canvases/${encodeURIComponent(canvasId)}/events`);
}

/** 供测试与状态栏使用：把 revision 的图取出来（不落 localStorage）。 */
export async function loadCanvasGraph(canvasId: string, revision: string): Promise<{ revision: CanvasRevision; graph: CanvasGraph }> {
  const loaded = await canvasRevision(canvasId, revision);
  return { revision: loaded, graph: loaded.graph };
}
