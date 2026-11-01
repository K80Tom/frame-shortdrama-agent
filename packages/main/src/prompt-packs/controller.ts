import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { PromptPackError, type PromptPackService } from './service';

export const PROMPT_PACK_SERVICE = Symbol('PROMPT_PACK_SERVICE');

function parseStateBody(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PromptPackError(400, 'PROMPT_PACK_INVALID_INPUT', '启用状态参数无效。');
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'enabled') {
    throw new PromptPackError(400, 'PROMPT_PACK_INVALID_INPUT', '只接受 enabled 字段。');
  }
  const enabled = (body as { enabled?: unknown }).enabled;
  if (typeof enabled !== 'boolean') {
    throw new PromptPackError(400, 'PROMPT_PACK_INVALID_INPUT', 'enabled 必须是布尔值。');
  }
  return enabled;
}

@Controller('api/prompt-packs')
export class PromptPacksController {
  constructor(@Inject(PROMPT_PACK_SERVICE) private readonly packs: PromptPackService) {}

  @Get()
  list() {
    return this.packs.list();
  }

  @Get(':packId/content')
  content(@Param('packId') packId: string) {
    return this.packs.content(packId);
  }

  @Post(':packId/state')
  @HttpCode(200)
  state(@Param('packId') packId: string, @Body() body: unknown) {
    return this.packs.setState(packId, parseStateBody(body));
  }

  @Post('import')
  @HttpCode(201)
  importPack(@Body() body: unknown) {
    return this.packs.importPack(body);
  }
}
