import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ProductionError, parseObjectVersionRequest } from '@lyra/shared';
import { tenantExecutionScope } from '../tenancy/scope';
import type { PostgresObjectVersionRepository } from './object-versions';

export const OBJECT_VERSIONS = Symbol('OBJECT_VERSIONS');
export type ObjectVersionApi = Pick<PostgresObjectVersionRepository, 'request' | 'get'>;

/** Metadata only. No caller-supplied workspace, Actor, storage locator or provider selector. */
@Controller('api/object-versions')
export class ObjectVersionController {
  constructor(@Inject(OBJECT_VERSIONS) private readonly versions: ObjectVersionApi | null) {}

  private tenant() {
    const current = tenantExecutionScope.current();
    if (current?.kind !== 'tenant') {
      throw new ProductionError(401, 'OBJECT_VERSION_AUTH_REQUIRED', '对象版本操作需要已认证的工作区身份。');
    }
    return current.tenant;
  }

  private ready() {
    if (!this.versions) {
      throw new ProductionError(503, 'OBJECT_VERSION_UNAVAILABLE', '对象版本服务尚未就绪，请先应用 044 迁移。');
    }
    return this.versions;
  }

  @Post()
  @HttpCode(202)
  @Header('Cache-Control', 'private, no-store')
  request(@Body() body: unknown) {
    const tenant = this.tenant();
    if (tenant.role === 'viewer') {
      throw new ProductionError(403, 'REFERENCE_FORBIDDEN', '只读成员不能请求物化对象版本。');
    }
    const input = parseObjectVersionRequest(body);
    return this.ready().request(tenant, input);
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  async get(@Param('id') id: string) {
    const tenant = this.tenant();
    if (!/^objver_[a-f0-9]{32}$/u.test(id)) {
      throw new ProductionError(400, 'OBJECT_VERSION_INVALID', '对象版本标识无效。');
    }
    const version = await this.ready().get(tenant, id);
    if (!version) throw new ProductionError(404, 'REFERENCE_NOT_FOUND', '找不到此对象版本。');
    return version;
  }
}
