import type { FastifyRequest } from 'fastify';
import type { AuthenticatedRequest } from '../auth/contracts';
import { ProductionError } from '@lyra/shared';
/** Only server-authenticated workspace owners/admins may approve or change a publication. */
export function requireEvolutionPublisher(request: FastifyRequest): void {
  const tenant = (request as FastifyRequest & { auth?: AuthenticatedRequest }).auth?.tenant;
  if (!tenant?.userId || !tenant.workspaceId || !['owner', 'admin'].includes(tenant.role)) {
    throw new ProductionError(403, 'EVOLUTION_PUBLISHER_REQUIRED', '该治理操作需要当前工作区 owner 或 admin。');
  }
}
