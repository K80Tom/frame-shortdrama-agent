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

/**
 * 由 Main 从数据库推导的只读上下文快照。Agent 只消费、不改写：
 * 模型看到的项目事实必须与后端版本一致，不能依赖前端口头描述。
 */
export interface AssistantContextSnapshot {
  label: string;
  capturedAt: string;
  projectId?: string;
  projectTitle?: string;
  scriptVersionId?: string;
  storyboardRevisionId?: string;
  productionRunIds: string[];
  canvasId?: string;
  pendingQuotes?: number;
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
  /** 一次 AssistantTurn 对应一个 AgentRun，一对一绑定。 */
  agentRunId: string;
  /** 会话内单调递增的恢复游标；客户端断线后从这个数字之后续读。 */
  cursor: number;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  userContent: string;
  context: AssistantContextSnapshot;
  events: AssistantEvent[];
  startedAt: string;
  completedAt?: string;
  error?: { code: string; message: string };
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
  /** 系统估价（元 × 1e6）。与 budgetMicros 分开存储，界面上不得混用。 */
  estimateCostMicros: number;
  /** 系统估计区间，前端展示「预计花费」应使用区间而不是单值。 */
  estimateRangeMicros?: { lowMicros: number; highMicros: number };
  /** 用户允许的预算上限；为空表示尚未设置，提交时按估价区间校验。 */
  budgetMicros?: number;
  priceRevision?: string;
  assumptions?: string[];
  currency: string;
  status: AssistantQuoteStatus;
  submittedRunId?: string;
  expiresAt: string;
  createdAt: string;
}

export type AssistantEvent =
  | { type: 'session'; sessionId: string; turnId?: string }
  /** 一次用户输入开始：turnId 与 agentRunId 在此确定并贯穿整个流。 */
  | { type: 'turn.started'; sessionId: string; turnId: string; agentRunId: string; context: AssistantContextSnapshot }
  | { type: 'model.delta'; delta: string; turnId: string }
  | { type: 'text_delta'; delta: string; turnId?: string }
  | { type: 'thinking_delta'; delta: string; turnId?: string }
  /** 模型提议调用工具：此时尚未执行，前端可展示“准备查询”。 */
  | { type: 'tool.proposed'; turnId: string; callId: string; toolName: string; arguments: Record<string, unknown> }
  | { type: 'tool_start'; toolName: string; turnId?: string; callId?: string }
  | { type: 'tool_end'; toolName: string; isError: boolean; summary: string; turnId?: string; callId?: string }
  | { type: 'generation_quote'; quote: AssistantQuote; turnId?: string }
  /** 需要人工确认：只有确认后才会调用付费提交接口。 */
  | { type: 'confirmation.required'; quote: AssistantQuote; turnId: string }
  | { type: 'run.created'; turnId: string; quoteId: string; runId: string }
  | { type: 'done'; message: AssistantMessage; turnId?: string; cursor?: number }
  | { type: 'turn.failed'; turnId: string; code: string; message: string; retryable: boolean }
  | { type: 'error'; code: string; message: string; turnId?: string };

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

export function parseAssistantSessionPatch(value: unknown): { title?: string; archived?: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssistantError(400, 'ASSISTANT_SESSION_PATCH_INVALID', '会话设置必须是对象。');
  }
  const input = value as Record<string, unknown>;
  const patch: { title?: string; archived?: boolean } = {};
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || !input.title.trim()) {
      throw new AssistantError(400, 'ASSISTANT_SESSION_PATCH_INVALID', '会话标题不能为空。');
    }
    patch.title = input.title.trim().slice(0, 60);
  }
  if (input.archived !== undefined) {
    if (typeof input.archived !== 'boolean') {
      throw new AssistantError(400, 'ASSISTANT_SESSION_PATCH_INVALID', '归档状态必须是布尔值。');
    }
    patch.archived = input.archived;
  }
  if (patch.title === undefined && patch.archived === undefined) {
    throw new AssistantError(400, 'ASSISTANT_SESSION_PATCH_INVALID', '没有需要更新的会话字段。');
  }
  return patch;
}

export function parseAssistantCursor(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const cursor = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 1_000_000) {
    throw new AssistantError(400, 'ASSISTANT_CURSOR_INVALID', '恢复游标不合法。');
  }
  return cursor;
}
