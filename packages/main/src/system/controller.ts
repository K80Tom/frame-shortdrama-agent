import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { SystemStatusService } from './status';

export const SYSTEM_STATUS = Symbol('SYSTEM_STATUS');

@Controller()
export class SystemController {
  constructor(@Inject(SYSTEM_STATUS) private readonly status: SystemStatusService) {}

  @Get('livez')
  live() {
    return { status: 'ok', runtimeRole: this.status.runtimeRole };
  }

  @Get('readyz')
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const snapshot = await this.status.snapshot();
    reply.code(snapshot.readiness === 'ready' ? 200 : 503);
    return snapshot;
  }

  @Get('api/system/status')
  snapshot() {
    return this.status.snapshot();
  }
}
