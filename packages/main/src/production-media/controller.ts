import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ProductionMediaError } from './contracts';
import type { ProductionMediaStore } from './store';
import type { ProductionMediaObjectService } from './object-worker';
import { tenantExecutionScope } from '../tenancy/scope';

export const PRODUCTION_MEDIA_STORE = Symbol('PRODUCTION_MEDIA_STORE');
export const PRODUCTION_MEDIA_OBJECT_SERVICE = Symbol('PRODUCTION_MEDIA_OBJECT_SERVICE');

@Controller('api/production-media')
export class ProductionMediaController {
  constructor(
    @Inject(PRODUCTION_MEDIA_STORE) private readonly store: ProductionMediaStore | null,
    @Inject(PRODUCTION_MEDIA_OBJECT_SERVICE) private readonly objects: ProductionMediaObjectService | null,
  ) {}

  private ready() {
    if (!this.store) throw new ProductionMediaError(503, 'PRODUCTION_MEDIA_UNAVAILABLE',
      '本地成片媒体库尚未就绪，请重启完整后端。');
    return this.store;
  }

  @Get(':id/access')
  async access(@Param('id') id: string) {
    const scope = tenantExecutionScope.current();
    if (!this.objects || scope?.kind !== 'tenant') {
      throw new ProductionMediaError(503, 'OBJECT_MEDIA_SIGNING_UNAVAILABLE',
        '当前运行模式未启用 workspace 对象签名。');
    }
    return this.objects.access({ workspaceId: scope.tenant.workspaceId }, id);
  }

  @Get(':id')
  async content(@Param('id') id: string, @Query('download') download: string | undefined,
    @Res() reply: FastifyReply) {
    const scope = tenantExecutionScope.current();
    let media;
    if (scope?.kind === 'tenant') {
      if (!this.objects) {
        throw new ProductionMediaError(503, 'OBJECT_MEDIA_UNAVAILABLE',
          'workspace 对象媒体服务未启用。');
      }
      media = await this.objects.content({ workspaceId: scope.tenant.workspaceId }, id);
    } else {
      media = await this.ready().content(id);
    }
    const bytes = media.bytes;
    const contentType = 'record' in media ? media.record.contentType : media.object.mimeType;
    return reply.header('Content-Type', contentType)
      .header('Content-Length', bytes.length)
      .header('Accept-Ranges', 'none')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `${download === '1' ? 'attachment' : 'inline'}; filename="${id}.mp4"`)
      .send(bytes);
  }
}
