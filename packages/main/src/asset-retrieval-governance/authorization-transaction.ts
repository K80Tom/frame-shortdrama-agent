import { EvaluationService } from '../evaluation/service';
import { PostgresEvaluationRepository } from '../evaluation/postgres-repository';
import { EvaluationServiceAssetRetrievalRegistrar } from './evaluation-registrar';
import type { PostgresDatabase } from '../db/client';
import { PostgresAssetPackRepository } from '../assets/asset-pack-repository';
import { PostgresAssetRetrievalGovernanceRepository } from './repository';
import { AssetRetrievalGovernanceService } from './service';
import { assetRetrievalAuthorization } from './authorization';
/** Exact authority reads and label/dataset insertion use ONE tenant-scoped connection.
 * SHARE excludes concurrent version/adoption writes until commit; no network/model call is allowed here.
 * This is intentionally a short, conservative table lock; a per-asset revision protocol may replace it later. */
export function assetRetrievalAuthorizationTransaction(database: PostgresDatabase, now = () => new Date()) {
  return <T>(work: (service: AssetRetrievalGovernanceService) => Promise<T>): Promise<T> => database.transaction(async client => {
    await client.query('LOCK TABLE asset_pack_versions, asset_pack_adoptions IN SHARE MODE');
    const scoped: Pick<PostgresDatabase, 'query' | 'transaction'> = {
      query: (sql, values = []) => client.query(sql, [...values]),
      transaction: fn => fn(client),
    };
    const service = new AssetRetrievalGovernanceService(new PostgresAssetRetrievalGovernanceRepository(scoped), {
      now, evaluationRegistrar: new EvaluationServiceAssetRetrievalRegistrar(new EvaluationService(new PostgresEvaluationRepository(scoped), { now })),
      verifyAuthorization: assetRetrievalAuthorization(new PostgresAssetPackRepository(scoped), now),
    });
    return work(service);
  });
}
