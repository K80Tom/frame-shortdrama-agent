import { parseProductionRunId, ProductionError } from '@lyra/shared';
import type { PostgresDatabase } from '../db/client';
import { parseTenantContext } from '../tenancy/context';
import { PostgresFrozenProductionInputReader } from './frozen-input-reader';
import { PostgresProductionRepository } from './repository';

/** Run ID is the sole recovery handle. Never accepts a caller's replacement snapshot or current project state.
 * This reader proves historical identity/integrity, NOT current authorization for a paid submit. */
export class PostgresRunFrozenInputReader {
  constructor(private readonly database: PostgresDatabase) {}
  async load(tenantValue: unknown,runId: string) {
    const tenant=parseTenantContext(tenantValue),id=parseProductionRunId(runId);
    return this.database.runWithTenant(tenant,async()=>{
      const run=await new PostgresProductionRepository(this.database).get(id);
      if (!run) throw new ProductionError(404,'PRODUCTION_RUN_NOT_FOUND','生产运行不存在。');
      const binding=run.inputSnapshot;
      if (!binding) throw new ProductionError(409,'LEGACY_INPUT_INCOMPLETE','旧运行没有可证明的冻结输入，不能从当前项目补齐。');
      if (binding.workspaceId!==tenant.workspaceId) throw new ProductionError(404,'PRODUCTION_RUN_NOT_FOUND','生产运行不存在。');
      const loaded=await new PostgresFrozenProductionInputReader(this.database).load(tenant,binding.snapshotId,binding.snapshotDigest);
      if (loaded.snapshot.projectId!==run.projectId || loaded.snapshot.script.versionId!==run.scriptVersionId
        || loaded.snapshot.episodeId!==binding.episodeId) throw new ProductionError(409,'DIGEST_MISMATCH','运行与冻结输入的归属不一致。');
      return loaded;
    });
  }
}
