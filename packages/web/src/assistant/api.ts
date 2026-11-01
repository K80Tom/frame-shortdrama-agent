export interface AssistantContext { label: string; projectId?: string; runId?: string }

export interface AssistantSession {
  id: string;
  contextKey: string;
  context: AssistantContext;
  title: string;
  createdAt: string;
  updatedAt: string;
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
  estimateCostMicros: number;
  currency: string;
  status: 'pending' | 'submitted' | 'expired' | 'cancelled';
  submittedRunId?: string;
  expiresAt: string;
  createdAt: string;
}

export type AssistantEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start'; toolName: string }
  | { type: 'tool_end'; toolName: string; isError: boolean; summary: string }
  | { type: 'generation_quote'; quote: AssistantQuote }
  | { type: 'done'; message: AssistantMessage }
  | { type: 'error'; code: string; message: string };

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

export async function createAssistantSession(context: AssistantContext): Promise<AssistantSession> {
  const response = await fetch('/api/assistant/sessions', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(context), cache: 'no-store',
  });
  if (!response.ok) throw await readError(response);
  return response.json() as Promise<AssistantSession>;
}

export async function assistantHistory(sessionId: string):
  Promise<{ session: AssistantSession; items: AssistantMessage[]; quotes: AssistantQuote[] }> {
  const response = await fetch(`/api/assistant/sessions/${encodeURIComponent(sessionId)}/messages`, { cache: 'no-store' });
  if (!response.ok) throw await readError(response);
  return response.json();
}

export async function streamAssistantMessage(
  sessionId: string, content: string, onEvent: (event: AssistantEvent) => void, signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/assistant/sessions/${encodeURIComponent(sessionId)}/messages?stream=1`, {
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

export async function submitAssistantQuote(sessionId: string, quoteId: string):
  Promise<{ quote: AssistantQuote; runId: string }> {
  const response = await fetch(
    `/api/assistant/sessions/${encodeURIComponent(sessionId)}/quotes/${encodeURIComponent(quoteId)}/submit`,
    { method: 'POST', headers: JSON_HEADERS, body: '{}', cache: 'no-store' });
  if (!response.ok) throw await readError(response);
  return response.json();
}
