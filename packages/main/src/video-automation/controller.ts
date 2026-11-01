import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { VideoAutomationError } from './contracts';
import type { VideoAutomationService } from './service';
export const VIDEO_AUTOMATION_SERVICE = Symbol('VIDEO_AUTOMATION_SERVICE');
@Controller('api')
export class VideoAutomationController {
  constructor(@Inject(VIDEO_AUTOMATION_SERVICE) private readonly service: VideoAutomationService | null) {}
  private ready() {
    if (!this.service) throw new VideoAutomationError(503, 'VIDEO_PERSISTENCE_UNAVAILABLE', '请先显式应用 014 迁移并重启后端。');
    return this.service;
  }
  @Get('video-automation/status') status() {
    return this.service ? this.service.status() : { available: false, code: 'VIDEO_PERSISTENCE_UNAVAILABLE',
      message: '请先显式应用 014 迁移并重启后端。', model: '', connectionRevision: null, busy: false, activeRunId: null };
  }
  @Get('video-automation-runs') list() { return this.ready().list(); }
  @Get('video-automation-runs/:id') get(@Param('id') id: string) { return this.ready().get(id); }
  @Post('video-automation-runs') @HttpCode(202)
  create(@Body() body: unknown) { return this.ready().create(body); }
  @Post('video-automation-runs/:id/reconcile') @HttpCode(200)
  reconcile(@Param('id') id: string, @Body() body: unknown) { return this.ready().reconcile(id, body); }
}
