import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AssetError } from '@lyra/shared';
import type { AssetService } from './service';

export const ASSET_SERVICE = Symbol('ASSET_SERVICE');

@Controller('api/assets')
export class AssetController {
  constructor(@Inject(ASSET_SERVICE) private readonly service: AssetService | null) {}
  private ready() {
    if (!this.service) throw new AssetError(503, 'ASSET_PERSISTENCE_UNAVAILABLE',
      '资产目录未就绪，请显式执行 npm run db:migrate（包含 009），然后重启后端。小说原文与校对不受影响。');
    return this.service;
  }
  @Get() async list() { return { assets: await this.ready().list() }; }
  @Post() create(@Body() body: unknown) { return this.ready().create(body); }
  @Post('import') importImage(@Body() body: unknown) { return this.ready().importImage(body); }
  @Post(':id/update') update(@Param('id') id: string, @Body() body: unknown) { return this.ready().update(id, body); }
  @Post(':id/media') replaceMedia(@Param('id') id: string, @Body() body: unknown) { return this.ready().replaceMedia(id, body); }
  @Get(':id/content') async content(@Param('id') id: string, @Query('download') download: string | undefined, @Res() reply: FastifyReply) {
    const media = await this.ready().content(id);
    const extension = media.mimeType === 'image/jpeg' ? 'jpg' : media.mimeType.slice(6);
    return reply.header('Content-Type', media.mimeType)
      .header('Content-Length', media.bytes.length)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `${download === '1' ? 'attachment' : 'inline'}; filename="${id}.${extension}"`)
      .send(media.bytes);
  }
  @Get(':id') get(@Param('id') id: string) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new AssetError(400, 'ASSET_ID_INVALID', '资产记录标识不合法。');
    return this.ready().get(id);
  }
}
