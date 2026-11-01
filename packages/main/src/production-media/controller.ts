import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ProductionMediaError } from './contracts';
import type { ProductionMediaStore } from './store';

export const PRODUCTION_MEDIA_STORE = Symbol('PRODUCTION_MEDIA_STORE');

@Controller('api/production-media')
export class ProductionMediaController {
  constructor(@Inject(PRODUCTION_MEDIA_STORE) private readonly store: ProductionMediaStore | null) {}

  private ready() {
    if (!this.store) throw new ProductionMediaError(503, 'PRODUCTION_MEDIA_UNAVAILABLE',
      '本地成片媒体库尚未就绪，请重启完整后端。');
    return this.store;
  }

  @Get(':id')
  async content(@Param('id') id: string, @Query('download') download: string | undefined,
    @Res() reply: FastifyReply) {
    const media = await this.ready().content(id);
    return reply.header('Content-Type', media.object.mimeType)
      .header('Content-Length', media.bytes.length)
      .header('Accept-Ranges', 'none')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `${download === '1' ? 'attachment' : 'inline'}; filename="${media.object.id}.mp4"`)
      .send(media.bytes);
  }
}
