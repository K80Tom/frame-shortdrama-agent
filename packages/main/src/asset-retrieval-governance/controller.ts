// #128 资产检索策略治理领域 Facade。
// 租户与操作者身份只来自认证会话；路径中的 workspaceId 仅用于路由，必须与会话一致。
// Dataset/Evaluation 注册委托 #134，Candidate/Canary/Adopt/Rollback 委托 #135；
// 本控制器不保存任何通用治理状态，只返回领域 payload 与来自 #134/#135 的 typed refs。

import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ProductionError } from '@lyra/shared';
import type { AuthenticatedRequest } from '../auth/contracts';
import type { EvolutionGateService } from '../evolution/gate-service';
import {
  ASSET_RETRIEVAL_GOVERNANCE_SERVICE,
  type AssetRetrievalGovernanceService,
} from './service';

function session(request: FastifyRequest, pathWorkspaceId: string): { workspaceId: string; actorId: string } {
  const auth = (request as typeof request & { auth?: AuthenticatedRequest }).auth;
  if (!auth?.tenant?.workspaceId) {
    throw new ProductionError(403, 'ASSET_RETRIEVAL_WORKSPACE_REQUIRED', '缺少有效的工作区会话。');
  }
  if (pathWorkspaceId && auth.tenant.workspaceId !== pathWorkspaceId) {
    throw new ProductionError(403, 'ASSET_RETRIEVAL_WORKSPACE_MISMATCH', '路径工作区与会话工作区不一致。');
  }
  return { workspaceId: auth.tenant.workspaceId, actorId: auth.tenant.userId || 'unknown' };
}

function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProductionError(400, 'ASSET_RETRIEVAL_INPUT_INVALID', '请求体必须是 JSON 对象。');
  }
  return value as Record<string, unknown>;
}

@Controller('api/workspaces/:workspaceId/asset-retrieval-governance')
export class AssetRetrievalGovernanceController {
  constructor(
    @Inject(ASSET_RETRIEVAL_GOVERNANCE_SERVICE)
    private readonly service: AssetRetrievalGovernanceService,
  ) {}

  @Get('summary')
  summary(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string) {
    const tenant = session(request, workspaceId);
    return this.service.summary(tenant.workspaceId);
  }

  @Get('observations')
  listObservations(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string) {
    const tenant = session(request, workspaceId);
    return this.service.listObservations(tenant.workspaceId);
  }

  @Post('observations') @HttpCode(201)
  recordObservation(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Body() raw: unknown) {
    const tenant = session(request, workspaceId);
    return this.service.recordObservation(tenant.workspaceId, raw);
  }

  @Get('observations/:observationId')
  getObservation(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Param('observationId') observationId: string) {
    const tenant = session(request, workspaceId);
    return this.service.getObservation(tenant.workspaceId, observationId);
  }

  @Get('decisions')
  listDecisions(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string) {
    const tenant = session(request, workspaceId);
    return this.service.listDecisions(tenant.workspaceId);
  }

  @Post('decisions') @HttpCode(201)
  recordDecision(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Body() raw: unknown) {
    const tenant = session(request, workspaceId);
    return this.service.recordDecision(tenant.workspaceId, raw);
  }

  @Get('decisions/:decisionId')
  getDecision(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Param('decisionId') decisionId: string) {
    const tenant = session(request, workspaceId);
    return this.service.getDecision(tenant.workspaceId, decisionId);
  }

  @Get('dataset-revisions')
  listDatasetRevisions(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string) {
    const tenant = session(request, workspaceId);
    return this.service.listDatasetRevisions(tenant.workspaceId);
  }

  @Post('dataset-revisions') @HttpCode(201)
  createDatasetRevision(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Body() raw: unknown) {
    const tenant = session(request, workspaceId);
    return this.service.createDatasetRevision(tenant.workspaceId, raw);
  }

  @Get('dataset-revisions/:datasetId')
  getDatasetRevision(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Param('datasetId') datasetId: string) {
    const tenant = session(request, workspaceId);
    return this.service.getDatasetRevision(tenant.workspaceId, datasetId);
  }

  @Post('dataset-revisions/:datasetId/register-evaluation-dataset') @HttpCode(200)
  registerEvaluationDataset(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Param('datasetId') datasetId: string, @Body() raw: unknown) {
    const tenant = session(request, workspaceId);
    return this.service.registerEvaluationDataset(tenant.workspaceId, datasetId, raw);
  }

  @Post('dataset-revisions/:datasetId/search-policy') @HttpCode(200)
  searchPolicy(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Param('datasetId') datasetId: string, @Body() raw: unknown) {
    const tenant = session(request, workspaceId);
    return this.service.searchPolicy(tenant.workspaceId, datasetId, raw);
  }

  @Get('policy-payloads')
  listPolicyPayloads(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string) {
    const tenant = session(request, workspaceId);
    return this.service.listPolicyPayloads(tenant.workspaceId);
  }

  @Post('policy-payloads') @HttpCode(201)
  createPolicyPayload(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Body() raw: unknown) {
    const tenant = session(request, workspaceId);
    const value = body(raw);
    if (value.createdBy === undefined) value.createdBy = tenant.actorId;
    return this.service.createPolicyPayload(tenant.workspaceId, value);
  }

  @Post('dataset-revisions/:datasetId/search-and-create-payload') @HttpCode(201)
  searchAndCreatePolicyPayload(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Param('datasetId') datasetId: string, @Body() raw: unknown) {
    const tenant = session(request, workspaceId);
    const value = body(raw);
    if (value.assetRetrievalDatasetRevisionId === undefined) value.assetRetrievalDatasetRevisionId = datasetId;
    if (value.createdBy === undefined) value.createdBy = tenant.actorId;
    return this.service.searchAndCreatePolicyPayload(tenant.workspaceId, value);
  }

  @Get('policy-payloads/:payloadId')
  getPolicyPayload(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Param('payloadId') payloadId: string) {
    const tenant = session(request, workspaceId);
    return this.service.getPolicyPayload(tenant.workspaceId, payloadId);
  }

  @Post('policy-payloads/:payloadId/register-candidate') @HttpCode(201)
  registerCandidate(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Param('payloadId') payloadId: string, @Body() raw: unknown) {
    const tenant = session(request, workspaceId);
    const value = body(raw);
    if (value.actorId === undefined) value.actorId = tenant.actorId;
    return this.service.registerPolicyCandidate(tenant.workspaceId, payloadId, value);
  }

  @Post('policy-payloads/:payloadId/refs') @HttpCode(200)
  attachRefs(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Param('payloadId') payloadId: string, @Body() raw: unknown) {
    const tenant = session(request, workspaceId);
    return this.service.attachGovernanceRefs(tenant.workspaceId, payloadId, raw);
  }

  // 下列路由只是把请求原样委托给 #135 状态机；Facade 不创建本地同名状态。
  @Post('candidates/:candidateId/evaluate') @HttpCode(200)
  evaluate(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Param('candidateId') candidateId: string, @Body() raw: unknown) {
    const tenant = session(request, workspaceId);
    const value = body(raw);
    return this.gate(tenant.workspaceId).startEvaluation(tenant.workspaceId, candidateId, {
      expectedVersion: this.expectedVersion(value),
      actorId: tenant.actorId,
      reason: this.reason(value.reason),
    });
  }

  @Post('candidates/:candidateId/shadow') @HttpCode(201)
  shadow(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Param('candidateId') candidateId: string, @Body() raw: unknown) {
    return this.startCanary(request, workspaceId, candidateId, raw);
  }

  @Post('candidates/:candidateId/canary') @HttpCode(201)
  canary(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Param('candidateId') candidateId: string, @Body() raw: unknown) {
    return this.startCanary(request, workspaceId, candidateId, raw);
  }

  @Post('candidates/:candidateId/adopt') @HttpCode(200)
  adopt(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Param('candidateId') candidateId: string, @Body() raw: unknown) {
    const tenant = session(request, workspaceId);
    const value = body(raw);
    if (typeof value.rolloutId !== 'string' || !value.rolloutId.trim()) {
      throw new ProductionError(400, 'ASSET_RETRIEVAL_ROLLOUT_REQUIRED', 'Adopt 必须提供 #135 rolloutId。');
    }
    return this.gate(tenant.workspaceId).promote(tenant.workspaceId, value.rolloutId, {
      expectedVersion: this.expectedVersion(value),
      rolloutExpectedVersion: this.expectedVersion(value.rolloutExpectedVersion, 'rolloutExpectedVersion'),
      actorId: tenant.actorId,
      reason: this.reason(value.reason, true),
    });
  }

  @Post('registry/rollback') @HttpCode(200)
  rollback(@Req() request: FastifyRequest, @Param('workspaceId') workspaceId: string,
    @Body() raw: unknown) {
    const tenant = session(request, workspaceId);
    const value = body(raw);
    if (typeof value.candidateVersionId !== 'string' || !value.candidateVersionId.trim()) {
      throw new ProductionError(400, 'ASSET_RETRIEVAL_CANDIDATE_REQUIRED', 'Rollback 必须提供 candidateVersionId。');
    }
    return this.gate(tenant.workspaceId).rollback(tenant.workspaceId, value.candidateVersionId, {
      expectedVersion: this.expectedVersion(value),
      actorId: tenant.actorId,
      reason: this.reason(value.reason, true),
    });
  }

  private startCanary(request: FastifyRequest, workspaceId: string, candidateId: string, raw: unknown) {
    const tenant = session(request, workspaceId);
    const value = body(raw);
    return this.gate(tenant.workspaceId).startCanary(tenant.workspaceId, candidateId, {
      expectedVersion: this.expectedVersion(value),
      actorId: tenant.actorId,
      reason: this.reason(value.reason),
      routingKey: typeof value.routingKey === 'string' && value.routingKey.trim() ? value.routingKey : undefined,
      config: value.config && typeof value.config === 'object' && !Array.isArray(value.config)
        ? value.config as Record<string, never> : undefined,
    });
  }

  private gate(workspaceId: string): EvolutionGateService {
    const gate = this.service.evolutionGateService();
    if (!gate) throw new ProductionError(503, 'ASSET_RETRIEVAL_GATE_UNAVAILABLE',
      '#135 EvolutionGateService 未注入，不能执行该动作。');
    return gate;
  }

  private expectedVersion(value: unknown, field = 'expectedVersion'): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new ProductionError(400, 'ASSET_RETRIEVAL_INPUT_INVALID', `${field} 必须是不小于 1 的整数。`);
    }
    return value;
  }

  private reason(value: unknown, required = false): string | undefined {
    if (value === undefined || value === null) {
      if (required) throw new ProductionError(422, 'ASSET_RETRIEVAL_REASON_REQUIRED', '该动作必须提供人工理由。');
      return undefined;
    }
    if (typeof value !== 'string' || !value.trim() || value.length > 500) {
      throw new ProductionError(400, 'ASSET_RETRIEVAL_INPUT_INVALID', 'reason 必须是 1..500 字符。');
    }
    return value.trim();
  }
}
