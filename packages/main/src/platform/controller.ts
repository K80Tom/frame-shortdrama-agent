import { Controller, Get, Inject } from '@nestjs/common';
import type { PlatformPreflightService } from './preflight';
export const PLATFORM_PREFLIGHT = Symbol('PLATFORM_PREFLIGHT');

@Controller('api/platform')
export class PlatformController {
  constructor(@Inject(PLATFORM_PREFLIGHT) private readonly preflight: PlatformPreflightService) {}
  @Get('preflight')
  check() { return this.preflight.check(); }
}
