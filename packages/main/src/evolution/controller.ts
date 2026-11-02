import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ProductionError, parseProductionRunId } from '@lyra/shared';
import type { AssetEvolutionService } from './service';

export const ASSET_EVOLUTION_SERVICE = Symbol('ASSET_EVOLUTION_SERVICE');

function emptyBody(body: unknown): void {
  if (body === undefined || body === null) return;
  if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw new ProductionError(400, 'INVALID_EVOLUTION_INPUT', '此操作不接受额外参数。');
  }
}
function id(value: string, prefix: string): string {
  if (!new RegExp(`^${prefix}_[a-zA-Z0-9_-]{1,96}$`, 'u').test(value)) {
    throw new ProductionError(400, 'INVALID_EVOLUTION_ID', '自进化资源标识无效。');
  }
  return value;
}
function governanceInput(body: unknown): { expectedPolicyDigest: string; reason: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProductionError(400, 'INVALID_EVOLUTION_INPUT', '采用或回滚参数无效。');
  const keys = Object.keys(body).sort();
  if (keys.join(',') !== 'expectedPolicyDigest,reason') throw new ProductionError(400, 'INVALID_EVOLUTION_INPUT', '必须提供当前策略摘要与人工原因。');
  const input = body as Record<string, unknown>;
  if (typeof input.expectedPolicyDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(input.expectedPolicyDigest)
    || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500) {
    throw new ProductionError(400, 'INVALID_EVOLUTION_INPUT', '策略摘要或人工原因无效。');
  }
  return { expectedPolicyDigest: input.expectedPolicyDigest, reason: input.reason.trim() };
}

@Controller('api/evolution/assets')
export class EvolutionController {
  constructor(@Inject(ASSET_EVOLUTION_SERVICE) private readonly evolution: AssetEvolutionService) {}
  @Get() summary() { return this.evolution.summary(); }

  @Post('evidence/:runId') @HttpCode(200)
  evidence(@Param('runId') runId: string, @Body() body: unknown) {
    emptyBody(body); return this.evolution.captureEvidence(parseProductionRunId(runId));
  }
  @Post('proposals/:proposalId/candidates') @HttpCode(200)
  candidate(@Param('proposalId') proposalId: string, @Body() body: unknown) {
    emptyBody(body); return this.evolution.createCandidate(id(proposalId, 'eproposal'));
  }
  @Post('candidates/:candidateId/probes') @HttpCode(200)
  probe(@Param('candidateId') candidateId: string, @Body() body: unknown) {
    emptyBody(body); return this.evolution.runProbe(id(candidateId, 'evocand'));
  }
  @Post('candidates/:candidateId/adopt') @HttpCode(200)
  adopt(@Param('candidateId') candidateId: string, @Body() body: unknown) {
    const input = governanceInput(body);
    return this.evolution.adopt(id(candidateId, 'evocand'), input.expectedPolicyDigest, input.reason);
  }
  @Post('registry/rollback') @HttpCode(200)
  rollback(@Body() body: unknown) {
    const input = governanceInput(body); return this.evolution.rollback(input.expectedPolicyDigest, input.reason);
  }
}
