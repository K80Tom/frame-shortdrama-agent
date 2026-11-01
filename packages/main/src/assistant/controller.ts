import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AssistantError, parseAssistantId, type AssistantEvent } from '@ohao/agent';
import type { AssistantService } from '@ohao/agent';

export const ASSISTANT_SERVICE = Symbol('ASSISTANT_SERVICE');

@Controller('api/assistant')
export class AssistantController {
  constructor(@Inject(ASSISTANT_SERVICE) private readonly assistant: AssistantService | null) {}

  private ready(): AssistantService {
    if (!this.assistant) {
      throw new AssistantError(503, 'ASSISTANT_UNAVAILABLE',
        'AI 工作区尚未就绪：请应用 018 迁移、配置文本模型并重启后端。');
    }
    return this.assistant;
  }

  @Post('sessions')
  @HttpCode(201)
  createSession(@Body() body: unknown) { return this.ready().createSession(body); }

  @Get('sessions/:id/messages')
  history(@Param('id') id: string) { return this.ready().history(parseAssistantId(id, 'sessionId')); }

  @Post('sessions/:id/quotes/:quoteId/submit')
  @HttpCode(200)
  submitQuote(@Param('id') id: string, @Param('quoteId') quoteId: string) {
    return this.ready().submitQuote(parseAssistantId(id, 'sessionId'), parseAssistantId(quoteId, 'quoteId'));
  }

  /**
   * 发送消息。默认返回完整事件序列（便于脚本与测试）；
   * stream=1 或 Accept: text/event-stream 时以 SSE 逐事件下发。
   */
  @Post('sessions/:id/messages')
  @HttpCode(200)
  async send(
    @Param('id') id: string, @Body() body: unknown, @Query('stream') stream: string | undefined,
    @Headers('accept') accept: string | undefined, @Res() reply: FastifyReply,
  ): Promise<void> {
    const sessionId = parseAssistantId(id, 'sessionId');
    const useStream = stream === '1' || (accept ?? '').includes('text/event-stream');
    if (!useStream) {
      const events: AssistantEvent[] = [];
      for await (const event of this.ready().send(sessionId, body)) events.push(event);
      await reply.status(200).send({ events });
      return;
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (event: AssistantEvent) => { reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); };
    try {
      for await (const event of this.ready().send(sessionId, body)) write(event);
    } catch (error) {
      write({
        type: 'error',
        code: error instanceof AssistantError ? error.code : 'ASSISTANT_INTERNAL',
        message: error instanceof AssistantError ? error.message : '助手处理失败，请稍后重试。',
      });
    } finally {
      reply.raw.end();
    }
  }
}
