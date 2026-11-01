import { randomUUID } from 'node:crypto';

/** AI 工作区领域契约。错误一律脱敏：不回显模型原始响应、提示词或上游报文。 */
export class AssistantError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'AssistantError'; }
}

export interface AssistantContext {
  /** 当前页面给人看的上下文说明，例如「项目 · 吞噬星空」。 */
  label: string;
  projectId?: string;
  runId?: string;
}

export interface AssistantSession {
  id: string;
  contextKey: string;
  context: AssistantContext;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export type AssistantRole = 'user' | 'assistant' | 'tool';
export type AssistantMessageStatus = 'streaming' | 'complete' | 'failed';

export interface AssistantMessage {
  id: string;
  sessionId: string;
  seq: number;
  role: AssistantRole;
  content: string;
  thinking: string;
  status: AssistantMessageStatus;
  toolName?: string;
  /** 工具观察摘要或估价卡 ID 等结构化负载，已裁剪为可公开字段。 */
  payload?: Record<string, unknown>;
  createdAt: string;
}

export type AssistantQuoteStatus = 'pending' | 'submitted' | 'expired' | 'cancelled';

export interface AssistantQuote {
  id: string;
  sessionId: string;
  kind: 'production_run';
  /** 创建生产运行的冻结请求，提交时原样使用，绝不再让模型改写。 */
  request: Record<string, unknown>;
  summary: string;
  estimateCostMicros: number;
  currency: string;
  status: AssistantQuoteStatus;
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

const ID_PATTERN = /^[a-z][a-z0-9_-]{2,127}$/;

export function parseAssistantId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new AssistantError(400, 'ASSISTANT_ID_INVALID', `${field} 不合法。`);
  }
  return value;
}

export function parseAssistantContext(value: unknown): AssistantContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssistantError(400, 'ASSISTANT_CONTEXT_INVALID', '助手上下文必须是对象。');
  }
  const input = value as Record<string, unknown>;
  const label = typeof input.label === 'string' ? input.label.trim().slice(0, 120) : '';
  const projectId = input.projectId === undefined ? undefined : parseAssistantId(input.projectId, 'projectId');
  const runId = input.runId === undefined ? undefined : parseAssistantId(input.runId, 'runId');
  return { label: label || '全局工作区', ...(projectId ? { projectId } : {}), ...(runId ? { runId } : {}) };
}

export function contextKeyOf(context: AssistantContext): string {
  return [context.projectId, context.runId].filter(Boolean).join(':') || 'global';
}

export function parseAssistantMessageInput(value: unknown): { content: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssistantError(400, 'ASSISTANT_MESSAGE_INVALID', '消息请求必须是对象。');
  }
  const content = (value as Record<string, unknown>).content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new AssistantError(400, 'ASSISTANT_MESSAGE_EMPTY', '消息内容不能为空。');
  }
  if (content.length > 8000) {
    throw new AssistantError(400, 'ASSISTANT_MESSAGE_TOO_LONG', '单条消息最多 8000 字符，请拆分后发送。');
  }
  return { content: content.trim() };
}

export function newAssistantId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
