import { requireEvolutionPublisher } from './gate-authorization';
// 候选门禁闭环 HTTP 接口（#135 H 子集）。
// 工作区与操作者身份全部来自认证会话（request.auth.tenant，由 app.ts 的
// preHandler 写入 AsyncLocalStorage；PostgreSQL RLS 消费同一会话变量），
// 绝不信任请求体中的租户。所有状态变更要求 expectedVersion（CAS，409）；
// 审批/停止/Promote/回滚要求非空 reason（422）。
//
// 发布/审批/灰度变更由认证 workspace owner/admin 执行；成员仍可提出候选与启动评测。

import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ProductionError } from '@lyra/shared';
import { AuthenticatedRequest } from '../auth/contracts';
import type { EvaluationResultLike } from '@lyra/shared';
import type { EvolutionGateService } from './gate-service';
import type { BindGateInput, CreateCandidateInput, EvolveInput, ObserveInput } from './gate-service';

export const EVOLUTION_GATE_SERVICE = Symbol('EVOLUTION_GATE_SERVICE');

const HEX64 = /^[0-9a-f]{64}$/;

function session(request: FastifyRequest): { workspaceId: string; actorId: string } {
  const auth = (request as typeof request & { auth?: AuthenticatedRequest }).auth;
  if (!auth?.tenant?.workspaceId) {
    throw new ProductionError(403, 'EVOLUTION_WORKSPACE_REQUIRED', '缺少有效的工作区会话。');
  }
  return { workspaceId: auth.tenant.workspaceId, actorId: auth.tenant.userId || 'unknown' };
}

function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProductionError(400, 'EVOLUTION_GATE_INPUT_INVALID', '请求体必须是 JSON 对象。');
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new ProductionError(400, 'EVOLUTION_GATE_INPUT_INVALID', `缺少字段 ${field}。`);
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ProductionError(400, 'EVOLUTION_GATE_INPUT_INVALID', `字段 ${field} 必须是 1..${max} 字符。`);
  }
  return value.trim();
}

function expectedVersionOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ProductionError(400, 'EVOLUTION_GATE_INPUT_INVALID', 'expectedVersion 必须是不小于 1 的整数。');
  }
  return value;
}

function hex64(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    throw new ProductionError(400, 'EVOLUTION_GATE_INPUT_INVALID', `字段 ${field} 必须是 sha256 hex。`);
  }
  return value;
}

function candidateId(value: string): string {
  if (!/^evocand_[a-f0-9]{32}$/.test(value)) {
    throw new ProductionError(400, 'EVOLUTION_GATE_INPUT_INVALID', '候选标识无效。');
  }
  return value;
}

function rolloutId(value: string): string {
  if (!/^evoroll_[a-f0-9]{32}$/.test(value)) {
    throw new ProductionError(400, 'EVOLUTION_GATE_INPUT_INVALID', '灰度标识无效。');
  }
  return value;
}

function evolveInput(raw: Record<string, unknown>): Omit<EvolveInput, 'actorId'> {
  return {
    expectedVersion: expectedVersionOf(raw.expectedVersion),
    reason: string(raw.reason, 'reason', 500, false),
  };
}

function evaluationResultLike(value: unknown): EvaluationResultLike[] {
  if (!Array.isArray(value)) {
    throw new ProductionError(400, 'EVOLUTION_GATE_INPUT_INVALID', '评测结果必须是数组。');
  }
  return value.map(item => {
    const row = body(item);
    const subject = body(row.subject);
    return {
      resultId: string(row.resultId, 'resultId', 160, true) as string,
      resultDigest: hex64(row.resultDigest, 'resultDigest'),
      subject: {
        kind: string(subject.kind, 'subject.kind', 80, true) as string,
        id: string(subject.id, 'subject.id', 160, true) as string,
        revisionId: subject.revisionId == null ? null : string(subject.revisionId, 'subject.revisionId', 160, false),
        digest: hex64(subject.digest, 'subject.digest'),
      },
      status: row.status,
      metrics: Array.isArray(row.metrics) ? row.metrics : [],
    } as EvaluationResultLike;
  });
}

@Controller('api/evolution/gate')
export class EvolutionGateController {
  constructor(@Inject(EVOLUTION_GATE_SERVICE) private readonly gate: EvolutionGateService) {}

  @Post('candidates') @HttpCode(201)
  create(@Req() request: FastifyRequest, @Body() raw: unknown) {
    const { workspaceId, actorId } = session(request);
    const value = body(raw);
    const diff = body(value.diff);
    const input: CreateCandidateInput = {
      domain: string(value.domain, 'domain', 40, true) as CreateCandidateInput['domain'],
      scope: string(value.scope, 'scope', 20, true) as CreateCandidateInput['scope'],
      projectId: value.projectId == null ? null : string(value.projectId, 'projectId', 160, false),
      baselineRevision: string(value.baselineRevision, 'baselineRevision', 160, true) as string,
      baselineDigest: hex64(value.baselineDigest, 'baselineDigest'),
      candidateRevision: string(value.candidateRevision, 'candidateRevision', 160, true) as string,
      diff: Object.fromEntries(Object.entries(diff).map(([key, change]) => {
        const pair = body(change);
        return [key, { from: pair.from ?? null, to: pair.to ?? null }];
      })),
      summary: string(value.summary, 'summary', 500, true) as string,
      generatedBy: string(value.generatedBy, 'generatedBy', 10, true) as CreateCandidateInput['generatedBy'],
      generatorVersion: string(value.generatorVersion, 'generatorVersion', 80, true) as string,
      tokenLimit: typeof value.tokenLimit === 'number' ? value.tokenLimit : Number.NaN,
      costLimitMinor: typeof value.costLimitMinor === 'number' ? value.costLimitMinor : Number.NaN,
      currency: string(value.currency, 'currency', 3, false),
      proposalKey: string(value.proposalKey, 'proposalKey', 200, false),
      maxCandidatesPerProposal: typeof value.maxCandidatesPerProposal === 'number' ? value.maxCandidatesPerProposal : undefined,
      createdBy: actorId,
    };
    return this.gate.createCandidate(workspaceId, input);
  }

  @Post('candidates/:candidateId/evaluation') @HttpCode(200)
  startEvaluation(@Req() request: FastifyRequest, @Param('candidateId') id: string, @Body() raw: unknown) {
    const { workspaceId, actorId } = session(request);
    return this.gate.startEvaluation(workspaceId, candidateId(id), { ...evolveInput(body(raw)), actorId });
  }

  @Post('candidates/:candidateId/gate') @HttpCode(200)
  bindGate(@Req() request: FastifyRequest, @Param('candidateId') id: string, @Body() raw: unknown) {
    requireEvolutionPublisher(request);
    const { workspaceId, actorId } = session(request);
    const value = body(raw);
    const input: BindGateInput = {
      expectedVersion: expectedVersionOf(value.expectedVersion),
      actorId,
      baselineResults: evaluationResultLike(value.baselineResults),
      candidateResults: evaluationResultLike(value.candidateResults),
      coreMetricKey: string(value.coreMetricKey, 'coreMetricKey', 80, false),
      ruleVersion: string(value.ruleVersion, 'ruleVersion', 80, false),
    };
    return this.gate.bindGate(workspaceId, candidateId(id), input);
  }

  @Post('candidates/:candidateId/approvals') @HttpCode(200)
  approve(@Req() request: FastifyRequest, @Param('candidateId') id: string, @Body() raw: unknown) {
    requireEvolutionPublisher(request);
    const { workspaceId, actorId } = session(request);
    return this.gate.approve(workspaceId, candidateId(id), { ...evolveInput(body(raw)), actorId });
  }

  @Post('candidates/:candidateId/rejections') @HttpCode(200)
  reject(@Req() request: FastifyRequest, @Param('candidateId') id: string, @Body() raw: unknown) {
    requireEvolutionPublisher(request);
    const { workspaceId, actorId } = session(request);
    return this.gate.reject(workspaceId, candidateId(id), { ...evolveInput(body(raw)), actorId });
  }

  @Post('candidates/:candidateId/rollback') @HttpCode(200)
  rollback(@Req() request: FastifyRequest, @Param('candidateId') id: string, @Body() raw: unknown) {
    requireEvolutionPublisher(request);
    const { workspaceId, actorId } = session(request);
    return this.gate.rollback(workspaceId, candidateId(id), { ...evolveInput(body(raw)), actorId });
  }

  @Post('candidates/:candidateId/canary') @HttpCode(201)
  startCanary(@Req() request: FastifyRequest, @Param('candidateId') id: string, @Body() raw: unknown) {
    requireEvolutionPublisher(request);
    const { workspaceId, actorId } = session(request);
    const value = body(raw);
    return this.gate.startCanary(workspaceId, candidateId(id), {
      expectedVersion: expectedVersionOf(value.expectedVersion),
      actorId,
      reason: string(value.reason, 'reason', 500, false),
      routingKey: string(value.routingKey, 'routingKey', 160, false),
      config: (value.config && typeof value.config === 'object' && !Array.isArray(value.config))
        ? value.config as Record<string, never> : undefined,
    });
  }

  @Post('rollouts/:rolloutId/route') @HttpCode(200)
  route(@Req() request: FastifyRequest, @Param('rolloutId') id: string, @Body() raw: unknown) {
    const { workspaceId } = session(request);
    const routingKey = string(body(raw).routingKey, 'routingKey', 160, true) as string;
    return this.gate.route(workspaceId, rolloutId(id), routingKey);
  }

  @Post('rollouts/:rolloutId/observations') @HttpCode(200)
  observe(@Req() request: FastifyRequest, @Param('rolloutId') id: string, @Body() raw: unknown) {
    requireEvolutionPublisher(request);
    const { workspaceId } = session(request);
    const value = body(raw);
    const input: ObserveInput = {
      expectedVersion: expectedVersionOf(value.expectedVersion),
      anomaly: value.anomaly === true,
      routedToCandidate: value.routedToCandidate === true,
      reason: string(value.reason, 'reason', 500, false),
    };
    return this.gate.observe(workspaceId, rolloutId(id), input);
  }

  @Post('rollouts/:rolloutId/stop') @HttpCode(200)
  stop(@Req() request: FastifyRequest, @Param('rolloutId') id: string, @Body() raw: unknown) {
    requireEvolutionPublisher(request);
    const { workspaceId, actorId } = session(request);
    const value = body(raw);
    return this.gate.stopCanary(workspaceId, rolloutId(id), {
      expectedVersion: expectedVersionOf(value.expectedVersion),
      rolloutExpectedVersion: expectedVersionOf(value.rolloutExpectedVersion),
      actorId,
      reason: string(value.reason, 'reason', 500, true) as string,
    });
  }

  @Post('rollouts/:rolloutId/promote') @HttpCode(200)
  promote(@Req() request: FastifyRequest, @Param('rolloutId') id: string, @Body() raw: unknown) {
    requireEvolutionPublisher(request);
    const { workspaceId, actorId } = session(request);
    const value = body(raw);
    return this.gate.promote(workspaceId, rolloutId(id), {
      expectedVersion: expectedVersionOf(value.expectedVersion),
      rolloutExpectedVersion: expectedVersionOf(value.rolloutExpectedVersion),
      actorId,
      reason: string(value.reason, 'reason', 500, true) as string,
    });
  }

  @Get('candidates/:candidateId/audit')
  audit(@Req() request: FastifyRequest, @Param('candidateId') id: string) {
    const { workspaceId } = session(request);
    return this.gate.history(workspaceId, candidateId(id));
  }
}
