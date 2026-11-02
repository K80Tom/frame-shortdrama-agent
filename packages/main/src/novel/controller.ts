import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { NovelError } from '@lyra/shared';
import type { NovelService } from './service';

export const NOVEL_SERVICE = Symbol('NOVEL_SERVICE');
function parseOpaqueId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new NovelError(400, 'NOVEL_ID_INVALID', '小说记录标识不合法。');
  return id;
}

@Controller('api')
export class NovelController {
  constructor(@Inject(NOVEL_SERVICE) private readonly service: NovelService | null) {}
  private ready() {
    if (!this.service) throw new NovelError(503, 'NOVEL_PERSISTENCE_UNAVAILABLE', '小说存储未就绪，请配置本机数据库并显式执行 npm run db:migrate（包含 008），然后重启后端。');
    return this.service;
  }
  @Get('novels') async list() { return { novels: await this.ready().list() }; }
  @Post('novels') create(@Body() body: unknown) { return this.ready().create(body); }
  @Get('novels/:id') get(@Param('id') id: string) { return this.ready().get(parseOpaqueId(id)); }
  @Get('novels/:id/entities') registry(@Param('id') id: string) { return this.ready().registry(parseOpaqueId(id)); }
  @Post('novels/:id/screenplay/preview') preview(@Param('id') id: string, @Body() body: unknown) {
    return this.ready().previewAdaptation(parseOpaqueId(id), body);
  }
  @Post('novels/:id/screenplay/adopt') adopt(@Param('id') id: string, @Body() body: unknown) {
    return this.ready().adoptAdaptation(parseOpaqueId(id), body);
  }
  @Get('novel-chapters/:id/revisions') async revisions(@Param('id') id: string) {
    return { revisions: await this.ready().revisions(parseOpaqueId(id)) };
  }
  @Get('novel-chapters/:id/attempts') async attempts(@Param('id') id: string) {
    return { attempts: await this.ready().attempts(parseOpaqueId(id)) };
  }
  @Post('novel-chapters/:id/seed') seed(@Param('id') id: string, @Body() body: unknown) {
    return this.ready().seed(parseOpaqueId(id), body);
  }
  @Post('novel-chapters/:id/extract') extract(@Param('id') id: string, @Body() body: unknown) {
    return this.ready().extract(parseOpaqueId(id), body);
  }
  @Post('novel-revisions/:id/corrections') correct(@Param('id') id: string, @Body() body: unknown) {
    return this.ready().correct(parseOpaqueId(id), body);
  }
  @Post('novel-revisions/:id/asset-bindings') bindAssets(@Param('id') id: string, @Body() body: unknown) {
    return this.ready().bindAssets(parseOpaqueId(id), body);
  }
}
