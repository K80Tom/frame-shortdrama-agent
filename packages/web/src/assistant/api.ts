import { workspaceFetch } from '../deployment';

export interface AssistantContext { label: string; projectId?: string; runId?: string }

export interface AssistantContextSnapshot {
  label: string;
  capturedAt: string;
  projectId?: string;
  projectTitle?: string;
  scriptVersionId?: string;
  storyboardRevisionId?: string;
  productionRunIds: string[];
  canvasId?: string;
}

export interface AssistantSession {
  id: string;
  contextKey: string;
  context: AssistantContext;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface AssistantTurn {
  id: string;
  sessionId: string;
  agentRunId: string;
  cursor: number;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  userContent: string;
  context: AssistantContextSnapshot;
  events: AssistantEvent[];
  startedAt: string;
  completedAt?: string;
  error?: { code: string; message: string };
}

export interface AssistantMessage {
  id: string;
  sessionId: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  thinking: string;
  status: 'streaming' | 'complete' | 'failed';
  toolName?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface AssistantQuote {
  id: string;
  sessionId: string;
  kind: 'production_run';
  request: Record<string, unknown>;
  summary: string;
  /** 系统估价；展示“预计花费”只能用它或区间，不能拿预算冒充。 */
  estimateCostMicros: number;
  estimateRangeMicros?: { lowMicros: number; highMicros: number };
  /** 用户设置的预算上限；与估价分开显示。 */
  budgetMicros?: number;
  priceRevision?: string;
  assumptions?: string[];
  currency: string;
  status: 'pending' | 'submitted' | 'expired' | 'cancelled';
  submittedRunId?: string;
  expiresAt: string;
  createdAt: string;
}

export type AssistantEvent =
  | { type: 'session'; sessionId: string; turnId?: string }
  | { type: 'turn.started'; sessionId: string; turnId: string; agentRunId: string; context: AssistantContextSnapshot }
  | { type: 'model.delta'; delta: string; turnId: string }
  | { type: 'text_delta'; delta: string; turnId?: string }
  | { type: 'thinking_delta'; delta: string; turnId?: string }
  | { type: 'tool.proposed'; turnId: string; callId: string; toolName: string; arguments: Record<string, unknown> }
  | { type: 'tool_start'; toolName: string; turnId?: string; callId?: string }
  | { type: 'tool_end'; toolName: string; isError: boolean; summary: string; turnId?: string; callId?: string }
  | { type: 'generation_quote'; quote: AssistantQuote; turnId?: string }
  | { type: 'confirmation.required'; quote: AssistantQuote; turnId: string }
  | { type: 'run.created'; turnId: string; quoteId: string; runId: string }
  | { type: 'done'; message: AssistantMessage; turnId?: string; cursor?: number }
  | { type: 'turn.failed'; turnId: string; code: string; message: string; retryable: boolean }
  | { type: 'error'; code: string; message: string; turnId?: string };

const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' };

async function readError(response: Response): Promise<Error> {
  try {
    const body = await response.json() as { error?: { code?: string; message?: string } };
    const error = new Error(body.error?.message ?? `请求失败（${response.status}）`);
    (error as Error & { code?: string }).code = body.error?.code;
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

export function createAssistantSession(context: AssistantContext): Promise<AssistantSession> {
  return request('/api/assistant/sessions', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(context),
  });
}

export function listAssistantSessions(includeArchived = false): Promise<AssistantSession[]> {
  return request(`/api/assistant/sessions?includeArchived=${includeArchived ? '1' : '0'}&limit=30`);
}

export function updateAssistantSession(sessionId: string, patch: { title?: string; archived?: boolean }):
  Promise<AssistantSession> {
  return request(`/api/assistant/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch),
  });
}

export function assistantHistory(sessionId: string): Promise<{
  session: AssistantSession; items: AssistantMessage[]; quotes: AssistantQuote[]; turns: AssistantTurn[];
}> {
  return request(`/api/assistant/sessions/${encodeURIComponent(sessionId)}/messages`);
}

export function resumeAssistantSession(sessionId: string, cursor: number): Promise<{
  session: AssistantSession; cursor: number; turns: AssistantTurn[]; events: AssistantEvent[];
}> {
  return request(`/api/assistant/sessions/${encodeURIComponent(sessionId)}/resume?cursor=${cursor}`);
}

export async function streamAssistantMessage(
  sessionId: string, content: string, onEvent: (event: AssistantEvent) => void, signal?: AbortSignal,
  cursor?: number,
): Promise<void> {
  const suffix = cursor && cursor > 0 ? `&cursor=${cursor}` : '';
  const response = await workspaceFetch(
    `/api/assistant/sessions/${encodeURIComponent(sessionId)}/messages?stream=1${suffix}`, {
      method: 'POST', headers: { ...JSON_HEADERS, Accept: 'text/event-stream' },
      body: JSON.stringify({ content }), cache: 'no-store', signal,
    });
  if (!response.ok || !response.body) throw await readError(response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = chunk.split('\n').find(item => item.startsWith('data:'));
        if (line) onEvent(JSON.parse(line.slice(5).trim()) as AssistantEvent);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function submitAssistantQuote(sessionId: string, quoteId: string):
  Promise<{ quote: AssistantQuote; runId: string }> {
  return request(
    `/api/assistant/sessions/${encodeURIComponent(sessionId)}/quotes/${encodeURIComponent(quoteId)}/submit`,
    { method: 'POST', headers: JSON_HEADERS, body: '{}' });
}
