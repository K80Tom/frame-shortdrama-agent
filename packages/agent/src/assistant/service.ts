import { ModelError } from '@lyra/shared';
import {
  AssistantError, newAssistantId, parseAssistantContext, parseAssistantMessageInput,
  parseAssistantSessionPatch, type AssistantContext, type AssistantContextSnapshot, type AssistantEvent,
  type AssistantMessage, type AssistantQuote, type AssistantSession, type AssistantTurn,
} from './contracts';
import type { AssistantOrchestrator } from './orchestrator';
import type { AssistantRepository } from './repository';

export interface AssistantProductionPort {
  create(value: unknown): Promise<{ id: string }>;
}

/**
 * 由 Main 注入的上下文推导端口：只读、已裁剪，Agent 不接触数据库。
 * 快照失败不阻断对话，但会显式告诉模型“没有可用快照”。
 */
export interface AssistantContextPort {
  snapshot(context: AssistantContext): Promise<AssistantContextSnapshot>;
}

function errorInfo(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof AssistantError || error instanceof ModelError) {
    return { code: error.code, message: error.message, retryable: (error as AssistantError).status >= 500 };
  }
  return { code: 'ASSISTANT_INTERNAL', message: '助手处理失败，请稍后重试。', retryable: false };
}

function fallbackSnapshot(context: AssistantContext): AssistantContextSnapshot {
  return {
    label: context.label, capturedAt: new Date().toISOString(),
    ...(context.projectId ? { projectId: context.projectId } : {}),
    ...(context.runId ? { productionRunIds: [context.runId] } : { productionRunIds: [] }),
  };
}

export class AssistantService {
  constructor(
    private readonly repository: AssistantRepository,
    private readonly orchestrator: AssistantOrchestrator,
    private readonly production: AssistantProductionPort | undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly contexts?: AssistantContextPort,
  ) {}

  createSession(context: unknown): Promise<AssistantSession> {
    return this.repository.createSession(parseAssistantContext(context) as AssistantContext);
  }

  listSessions(query: { includeArchived?: boolean; limit?: number } = {}): Promise<AssistantSession[]> {
    return this.repository.listSessions(query);
  }

  async updateSession(sessionId: string, patch: unknown): Promise<AssistantSession> {
    await this.repository.getSession(sessionId);
    return this.repository.updateSession(sessionId, parseAssistantSessionPatch(patch));
  }

  async history(sessionId: string): Promise<{
    session: AssistantSession; items: AssistantMessage[]; quotes: AssistantQuote[]; turns: AssistantTurn[];
  }> {
    const session = await this.repository.getSession(sessionId);
    const [items, quotes, turns] = await Promise.all([
      this.repository.listMessages(sessionId), this.repository.listQuotes(sessionId),
      this.repository.listTurnsAfter(sessionId, 0),
    ]);
    return { session, items, quotes, turns };
  }

  /** 断线恢复：只回放已落库的 turn，绝不重放未完成的内存状态。 */
  async resume(sessionId: string, cursor: number): Promise<{
    session: AssistantSession; cursor: number; turns: AssistantTurn[]; events: AssistantEvent[];
  }> {
    const session = await this.repository.getSession(sessionId);
    const turns = await this.repository.listTurnsAfter(sessionId, cursor);
    const last = (await this.repository.lastTurnCursor(sessionId)) || cursor;
    const events: AssistantEvent[] = [];
    for (const turn of turns) {
      events.push(...turn.events);
      if (turn.status !== 'completed') {
        events.push({
          type: 'turn.failed', turnId: turn.id,
          code: turn.error?.code ?? 'ASSISTANT_TURN_INTERRUPTED',
          message: turn.error?.message ?? '上一次回答被中断，请重新发送。',
          retryable: true,
        });
      }
    }
    return { session, cursor: last, turns, events };
  }

  /**
   * 发送一条用户消息并以事件流返回处理过程。
   * 事件即真实执行轨迹：工具调用、估价卡与最终回答都会同步落库，刷新后可回放。
   */
  async *send(sessionId: string, input: unknown): AsyncGenerator<AssistantEvent> {
    const { content } = parseAssistantMessageInput(input);
    const session = await this.repository.getSession(sessionId);
    const history = await this.repository.listMessages(sessionId);
    const turnId = newAssistantId('turn');
    const agentRunId = newAssistantId('agentrun');
    let context: AssistantContextSnapshot;
    try {
      context = this.contexts ? await this.contexts.snapshot(session.context) : fallbackSnapshot(session.context);
    } catch {
      context = fallbackSnapshot(session.context);
    }
    const recorded: AssistantEvent[] = [];
    const take = (event: AssistantEvent) => { recorded.push(event); return event; };

    await this.repository.appendMessage({
      id: newAssistantId('msg'), sessionId, role: 'user', content, thinking: '', status: 'complete',
    });
    const started = take({ type: 'turn.started', sessionId, turnId, agentRunId, context });
    yield { type: 'session', sessionId, turnId };
    yield started;

    const assistantId = newAssistantId('msg');
    let text = '';
    try {
      for await (const event of this.orchestrator.respond(session, history, content, { turnId, context })) {
        // 只计一次文本增量：model.delta 是新协议，text_delta 仅为兼容别名。
        if (event.type === 'model.delta') text += event.delta;
        if (event.type === 'tool_end') {
          await this.repository.appendMessage({
            id: newAssistantId('msg'), sessionId, role: 'tool', content: event.summary, thinking: '',
            status: 'complete', toolName: event.toolName,
            payload: { isError: event.isError, callId: (event as { callId?: string }).callId ?? null },
          });
        }
        if (event.type === 'confirmation.required') {
          await this.repository.appendMessage({
            id: newAssistantId('msg'), sessionId, role: 'tool', content: event.quote.summary, thinking: '',
            status: 'complete', toolName: 'generation_quote', payload: { quoteId: event.quote.id },
          });
        }
        // 只记录一次文本事件，避免 model.delta 与 text_delta 重复计入轨迹。
        if (event.type !== 'text_delta') recorded.push(event);
        yield event;
      }
      const message = await this.repository.appendMessage({
        id: assistantId, sessionId, role: 'assistant', content: text, thinking: '', status: 'complete',
      });
      const turn = await this.repository.createTurn({
        id: turnId, sessionId, agentRunId, cursor: 0, status: 'completed', userContent: content,
        context, events: recorded, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      });
      const done = take({ type: 'done', message, turnId, cursor: turn.cursor });
      yield done;
    } catch (error) {
      const info = errorInfo(error);
      const message = await this.repository.appendMessage({
        id: assistantId, sessionId, role: 'assistant', content: text, thinking: '', status: 'failed',
        payload: { code: info.code },
      });
      const failed = take({ type: 'turn.failed', turnId, code: info.code, message: info.message,
        retryable: info.retryable });
      const errorEvent = take({ type: 'error', code: info.code, message: info.message, turnId });
      const turn = await this.repository.createTurn({
        id: turnId, sessionId, agentRunId, cursor: 0, status: 'failed', userContent: content,
        context, events: [...recorded], startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        error: { code: info.code, message: info.message },
      });
      yield failed;
      yield errorEvent;
      const done = take({ type: 'done', message, turnId, cursor: turn.cursor });
      yield done;
    }
  }

  /**
   * 确认提交估价卡。这是唯一的付费入口：服务端校验状态与有效期，
   * 使用建卡时冻结的请求，绝不重新询问模型。
   */
  async submitQuote(sessionId: string, quoteId: string): Promise<{ quote: AssistantQuote; runId: string }> {
    const quote = await this.repository.getQuote(sessionId, quoteId);
    if (quote.status === 'submitted' && quote.submittedRunId) {
      return { quote, runId: quote.submittedRunId };
    }
    if (quote.status !== 'pending') {
      throw new AssistantError(409, 'ASSISTANT_QUOTE_CONFLICT', '这张估价卡已失效，请重新向助手提出生成需求。');
    }
    if (this.now().getTime() > new Date(quote.expiresAt).getTime()) {
      await this.repository.updateQuoteStatus(quote.id, 'expired');
      throw new AssistantError(409, 'ASSISTANT_QUOTE_EXPIRED', '估价确认卡已过期，请重新向助手提出生成需求。');
    }
    // 预算上限必须覆盖系统估价：两者分开显示，但不能让用户以低于估价的预算提交。
    if (quote.budgetMicros !== undefined && quote.budgetMicros < quote.estimateCostMicros) {
      throw new AssistantError(409, 'ASSISTANT_QUOTE_BUDGET_TOO_LOW',
        `预算上限 ${quote.budgetMicros / 1_000_000} 元低于系统估价 ${quote.estimateCostMicros / 1_000_000} 元，请调整后重新生成。`);
    }
    if (!this.production) {
      throw new AssistantError(503, 'ASSISTANT_PRODUCTION_UNAVAILABLE', '自动制片服务未就绪，暂时无法提交；估价卡仍保留，可在服务恢复后重试。');
    }
    const run = await this.production.create(quote.request);
    const submitted = await this.repository.updateQuoteStatus(quote.id, 'submitted', run.id);
    await this.repository.appendMessage({
      id: newAssistantId('msg'), sessionId, role: 'tool', content: `已提交自动制片运行 ${run.id}`, thinking: '',
      status: 'complete', toolName: 'submit_quote', payload: { quoteId: quote.id, runId: run.id },
    });
    return { quote: submitted, runId: run.id };
  }
}
