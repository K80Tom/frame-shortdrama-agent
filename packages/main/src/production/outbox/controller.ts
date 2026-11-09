import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { OutboxTaskError } from './contracts';
import type { OutboxSubmitInput } from './service';
import { OutboxTaskService } from './service';

export const OUTBOX_TASK_SERVICE = Symbol('OUTBOX_TASK_SERVICE');

@Controller('api/runtime/outbox')
export class OutboxTaskController {
  constructor(@Inject(OUTBOX_TASK_SERVICE) private readonly service: OutboxTaskService) {}

  @Post('tasks')
  async submit(@Body() body: Record<string, unknown>) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new OutboxTaskError('OUTBOX_TASK_INVALID', '请求体必须是 JSON 对象。');
    }
    const input: OutboxSubmitInput = {
      taskType: typeof body.taskType === 'string' ? body.taskType : '',
      idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '',
      payload: (body.payload ?? {}) as Record<string, unknown>,
      aggregateType: typeof body.aggregateType === 'string' ? body.aggregateType : null,
      aggregateId: typeof body.aggregateId === 'string' ? body.aggregateId : null,
      maxAttempts: typeof body.maxAttempts === 'number' ? body.maxAttempts : undefined,
      availableAt: typeof body.availableAt === 'string' ? body.availableAt : undefined,
    };
    return { task: await this.service.submit(input) };
  }

  @Get('tasks/:taskId')
  async status(@Param('taskId') taskId: string) {
    const snapshot = await this.service.status(taskId);
    if (!snapshot) throw new OutboxTaskError('OUTBOX_TASK_NOT_FOUND', '任务不存在。');
    return snapshot;
  }
}
