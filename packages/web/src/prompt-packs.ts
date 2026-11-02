/** 方法包页面数据层：列表只拿元数据，正文按需单独请求（渐进式披露）。 */
import type { MethodNode } from '@lyra/shared';

export type PromptPackItem = {
  id: string;
  name: string;
  summary: string;
  stages: string[];
  models: string[];
  license: string;
  quality: string;
  enabled: boolean;
  source: string;
  /** library=第三方入库；imported=本机自己导入。 */
  origin: 'library' | 'imported';
  runtimeNodes?: MethodNode[];
};

export type PromptPackList = { packs: PromptPackItem[]; total: number };
export type PromptPackContent = { id: string; license: string; content: string };

export class PromptPackApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'PromptPackApiError';
  }
}

function messageOf(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  const error = (data as { error?: unknown }).error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return '';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message.slice(0, 300) : '';
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, cache: 'no-store' });
  const data = await readJson(response);
  if (!response.ok) throw new PromptPackApiError(messageOf(data) || `请求失败（${response.status}）`, response.status);
  return data as T;
}

export function fetchPromptPacks(signal?: AbortSignal): Promise<PromptPackList> {
  return getJson<PromptPackList>('/api/prompt-packs', signal);
}

export function fetchPromptPackContent(id: string, signal?: AbortSignal): Promise<PromptPackContent> {
  return getJson<PromptPackContent>(`/api/prompt-packs/${encodeURIComponent(id)}/content`, signal);
}

export async function setPromptPackState(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean; updatedAt: string }> {
  const response = await fetch(`/api/prompt-packs/${encodeURIComponent(id)}/state`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' },
    body: JSON.stringify({ enabled }),
  });
  const data = await readJson(response);
  if (!response.ok) throw new PromptPackApiError(messageOf(data) || `请求失败（${response.status}）`, response.status);
  return data as { id: string; enabled: boolean; updatedAt: string };
}

/** 自己导入方法：正文与元数据一起提交，默认不启用。 */
export type PromptPackImportInput = {
  name: string;
  stages: string[];
  summary?: string;
  license?: string;
  content: string;
  id?: string;
};

export async function importPromptPack(
  input: PromptPackImportInput,
): Promise<{ id: string; name: string; stages: string[]; total: number }> {
  const response = await fetch('/api/prompt-packs/import', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' },
    body: JSON.stringify(input),
  });
  const data = await readJson(response);
  if (!response.ok) throw new PromptPackApiError(messageOf(data) || `请求失败（${response.status}）`, response.status);
  return data as { id: string; name: string; stages: string[]; total: number };
}

export const PROMPT_PACK_STAGE_LABELS: Record<string, string> = {
  topic: '选题',
  adaptation: '改编',
  character: '人物',
  'episode-outline': '集纲',
  script: '剧本',
  'script-review': '审稿',
  storyboard: '分镜',
  'video-prompt': '视频提示词',
  production: '出片',
};

export function stageLabel(stage: string): string {
  return PROMPT_PACK_STAGE_LABELS[stage] ?? stage;
}

export function licenseTone(license: string): 'ok' | 'warn' {
  const normalized = license.toLowerCase();
  return normalized.includes('nc') || normalized.includes('非商用') || normalized.includes('未声明') ? 'warn' : 'ok';
}
