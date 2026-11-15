import { Body, Controller, Get, HttpException, Inject, Post, Query } from '@nestjs/common';
import type { VoiceReferenceService } from './service';

export const VOICE_REFERENCE_SERVICE = Symbol('VOICE_REFERENCE_SERVICE');

@Controller('api/voice-references')
export class VoiceReferencesController {
  constructor(@Inject(VOICE_REFERENCE_SERVICE) private readonly voices: VoiceReferenceService | null) {}

  @Get()
  async list(@Query('projectId') projectId: string) {
    if (!this.voices) throw new HttpException({ code: 'VOICE_REFERENCES_UNAVAILABLE', message: '音色样本服务尚未配置。' }, 503);
    return { items: await this.voices.list(projectId) };
  }

  @Post()
  async create(@Body() body: unknown) {
    if (!this.voices) throw new HttpException({ code: 'VOICE_REFERENCES_UNAVAILABLE', message: '音色样本服务尚未配置。' }, 503);
    return this.voices.create(body);
  }
}
