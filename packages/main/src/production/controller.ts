import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ProductionError } from '@lyra/shared';
import type { ProductionService } from './service';

export const PRODUCTION_SERVICE = Symbol('PRODUCTION_SERVICE');

@Controller('api/production-runs')
export class ProductionController {
  constructor(@Inject(PRODUCTION_SERVICE) private readonly production: ProductionService | null) {}
  private ready() {
    if (!this.production) throw new ProductionError(503, 'PRODUCTION_PERSISTENCE_UNAVAILABLE',
      '自动制片服务未就绪：请应用 015、016 迁移，并确认剧本拆解、资产、视频模型与本地媒体服务均已配置后重启后端。');
    return this.production;
  }
  @Get()
  list() { return this.ready().list(); }
  @Get(':id')
  get(@Param('id') id: string) { return this.ready().get(id); }
  @Post() @HttpCode(202)
  create(@Body() body: unknown) { return this.ready().create(body); }
  @Post(':id/actions') @HttpCode(200)
  action(@Param('id') id: string, @Body() body: unknown) { return this.ready().action(id, body); }
  @Post(':id/reviews') @HttpCode(200)
  review(@Param('id') id: string, @Body() body: unknown) { return this.ready().review(id, body); }
}
