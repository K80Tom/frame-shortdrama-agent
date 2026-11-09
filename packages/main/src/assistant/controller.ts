import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  AssistantError, parseAssistantCursor, parseAssistantId, type AssistantEvent,
} from '@lyra/agent';
import type { AssistantService } from '@lyra/agent';

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

  @Get('sessions')
  listSessions(@Query('includeArchived') includeArchived: string | undefined,
    @Query('limit') limit: string | undefined) {
    return this.ready().listSessions({
      includeArchived: includeArchived === '1',
      limit: limit ? Math.max(1, Math.min(100, Number(limit) || 30)) : 30,
    });
  }

  @Patch('sessions/:id')
  updateSession(@Param('id') id: string, @Body() body: unknown) {
    return this.ready().updateSession(parseAssistantId(id, 'sessionId'), body);
  }

  @Get('sessions/:id/messages')
  history(@Param('id') id: string) { return this.ready().history(parseAssistantId(id, 'sessionId')); }

  /** 断线恢复：从 cursor 之后回放已落库的 turn（不重放未完成的内存状态）。 */
  @Get('sessions/:id/resume')
  resume(@Param('id') id: string, @Query('cursor') cursor: string | undefined) {
    return this.ready().resume(parseAssistantId(id, 'sessionId'), parseAssistantCursor(cursor));
  }

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
    @Query('cursor') cursor: string | undefined,
    @Headers('accept') accept: string | undefined, @Res() reply: FastifyReply,
  ): Promise<void> {
    const sessionId = parseAssistantId(id, 'sessionId');
    const after = parseAssistantCursor(cursor);
    const resumed = after > 0 ? await this.ready().resume(sessionId, after) : null;
    const useStream = stream === '1' || (accept ?? '').includes('text/event-stream');
    if (!useStream) {
      const events: AssistantEvent[] = resumed ? [...resumed.events] : [];
      for await (const event of this.ready().send(sessionId, body)) events.push(event);
      await reply.status(200).send({ events, resumedFrom: after });
      return;
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let seq = 0;
    const write = (event: AssistantEvent) => {
      seq += 1;
      const cursor = (event as { cursor?: number }).cursor;
      const id = typeof cursor === 'number' ? `${cursor}:${seq}` : `${after}:${seq}`;
      reply.raw.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    try {
      if (resumed) for (const event of resumed.events) write(event);
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
