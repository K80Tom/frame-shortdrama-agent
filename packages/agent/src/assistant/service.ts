import { ModelError } from '@ohao/shared';
import {
  AssistantError, newAssistantId, parseAssistantContext, parseAssistantMessageInput,
  type AssistantContext, type AssistantEvent, type AssistantMessage, type AssistantQuote, type AssistantSession,
} from './contracts';
import type { AssistantOrchestrator } from './orchestrator';
import type { AssistantRepository } from './repository';

export interface AssistantProductionPort {
  create(value: unknown): Promise<{ id: string }>;
}

function errorInfo(error: unknown): { code: string; message: string } {
  if (error instanceof AssistantError || error instanceof ModelError) return { code: error.code, message: error.message };
  return { code: 'ASSISTANT_INTERNAL', message: '助手处理失败，请稍后重试。' };
}

export class AssistantService {
  constructor(
    private readonly repository: AssistantRepository,
    private readonly orchestrator: AssistantOrchestrator,
    private readonly production: AssistantProductionPort | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  createSession(context: unknown): Promise<AssistantSession> {
    return this.repository.createSession(parseAssistantContext(context) as AssistantContext);
  }

  async history(sessionId: string): Promise<{ session: AssistantSession; items: AssistantMessage[]; quotes: AssistantQuote[] }> {
    const session = await this.repository.getSession(sessionId);
    const [items, quotes] = await Promise.all([this.repository.listMessages(sessionId), this.repository.listQuotes(sessionId)]);
    return { session, items, quotes };
  }

  /**
   * 发送一条用户消息并以事件流返回处理过程。
   * 事件即真实执行轨迹：工具调用、估价卡与最终回答都会同步落库，刷新后可回放。
   */
  async *send(sessionId: string, input: unknown): AsyncGenerator<AssistantEvent> {
    const { content } = parseAssistantMessageInput(input);
    const session = await this.repository.getSession(sessionId);
    const history = await this.repository.listMessages(sessionId);
    await this.repository.appendMessage({
      id: newAssistantId('msg'), sessionId, role: 'user', content, thinking: '', status: 'complete',
    });
    yield { type: 'session', sessionId };

    const assistantId = newAssistantId('msg');
    let text = '';
    try {
      for await (const event of this.orchestrator.respond(session, history, content)) {
        if (event.type === 'text_delta') text += event.delta;
        if (event.type === 'tool_end') {
          await this.repository.appendMessage({
            id: newAssistantId('msg'), sessionId, role: 'tool', content: event.summary, thinking: '',
            status: 'complete', toolName: event.toolName,
            payload: { isError: event.isError },
          });
        }
        if (event.type === 'generation_quote') {
          await this.repository.appendMessage({
            id: newAssistantId('msg'), sessionId, role: 'tool', content: event.quote.summary, thinking: '',
            status: 'complete', toolName: 'generation_quote', payload: { quoteId: event.quote.id },
          });
        }
        yield event;
      }
      const message = await this.repository.appendMessage({
        id: assistantId, sessionId, role: 'assistant', content: text, thinking: '', status: 'complete',
      });
      yield { type: 'done', message };
    } catch (error) {
      const info = errorInfo(error);
      const message = await this.repository.appendMessage({
        id: assistantId, sessionId, role: 'assistant', content: text, thinking: '', status: 'failed',
        payload: { code: info.code },
      });
      yield { type: 'error', code: info.code, message: info.message };
      yield { type: 'done', message };
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
