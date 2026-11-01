import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { desktopError } from './contracts';
import type { DesktopAssetService } from './service';
export const DESKTOP_ASSET_SERVICE = Symbol('DESKTOP_ASSET_SERVICE');
@Controller('api')
export class DesktopAssetController {
  constructor(@Inject(DESKTOP_ASSET_SERVICE) private readonly service: DesktopAssetService | null) {}
  private ready() {
    if (!this.service) desktopError(503, 'DESKTOP_PERSISTENCE_UNAVAILABLE', '资产生成任务存储未就绪，请应用 013 迁移并重启后端。');
    return this.service;
  }
  @Get('asset-generation/status') generationStatus() { return this.status(); }
  @Get('desktop-assets/status') status() {
    return this.service ? this.service.status() : {available:false, code:'DESKTOP_PERSISTENCE_UNAVAILABLE', message:'请先应用 013 迁移并重启后端。', model:'未配置', busy:false};
  }
  @Get('asset-generation') generationList(@Query('chapterId') chapterId: string) { return this.list(chapterId); }
  @Get('desktop-assets') list(@Query('chapterId') chapterId: string) { return this.ready().list(chapterId); }
  @Get('novel-revisions/:id/items/:itemId/asset-generation-preview') generationPreview(@Param('id') id: string, @Param('itemId') itemId: string) { return this.preview(id, itemId); }
  @Get('novel-revisions/:id/items/:itemId/desktop-asset-preview') preview(@Param('id') id: string, @Param('itemId') itemId: string) { return this.ready().preview(id, itemId); }
  @Post('novel-revisions/:id/asset-generation') generationCreate(@Param('id') id: string, @Body() body: unknown) { return this.create(id, body); }
  @Post('novel-revisions/:id/desktop-assets') create(@Param('id') id: string, @Body() body: unknown) { return this.ready().create(id, body); }
  @Post('asset-generation/:id/reconcile') generationReconcile(@Param('id') id: string, @Body() body: unknown) { return this.reconcile(id, body); }
  @Post('desktop-assets/:id/reconcile') reconcile(@Param('id') id: string, @Body() body: unknown) { return this.ready().reconcile(id, body); }
  @Post('asset-generation/:id/decision') generationDecision(@Param('id') id: string, @Body() body: unknown) { return this.decision(id, body); }
  @Post('desktop-assets/:id/decision') decision(@Param('id') id: string, @Body() body: unknown) { return this.ready().decision(id, body); }
}
