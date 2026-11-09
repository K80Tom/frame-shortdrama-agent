import { ProductionError, type FrozenProductionInput, type StoredProductionRun } from '@lyra/shared';
import { verifyProductionInputSnapshot } from './input-snapshot';
import { verifyShotSpecV2 } from './shot-spec';

/** Validate every loader boundary, including recovery. A frozen flag alone is never trusted. */
export function verifyFrozenExecutionInput(run: Readonly<StoredProductionRun>,value: FrozenProductionInput): FrozenProductionInput {
  function fail():never {throw new ProductionError(409,'DIGEST_MISMATCH','运行与冻结输入不一致。');}
  const binding=run.inputSnapshot;
  if (!binding) fail();
  const snapshot=verifyProductionInputSnapshot(value.snapshot);
  if (snapshot.state!=='frozen' || snapshot.id!==binding.snapshotId || snapshot.snapshotDigest!==binding.snapshotDigest
    || snapshot.workspaceId!==binding.workspaceId || snapshot.projectId!==run.projectId || snapshot.episodeId!==binding.episodeId
    || snapshot.script.versionId!==run.scriptVersionId || !snapshot.executionPolicy) fail();
  const policy=snapshot.executionPolicy;
  if (policy.ratio!==run.ratio || policy.visualStyle!==run.visualStyle || policy.targetDurationSec!==run.targetDurationSec
    || policy.qualityPreset!==run.qualityPreset || policy.directorPolicy!==run.directorPolicy
    || snapshot.budgetPolicy.limitMicros!==run.budgetMicros || snapshot.budgetPolicy.currency!==run.currency
    || snapshot.budgetPolicy.allowPaid!==run.allowPaid || snapshot.automationMode!==run.automationMode
    || snapshot.candidatePolicy.mode!==run.candidatePolicy || snapshot.candidatePolicy.limit!==run.candidateLimit) fail();
  if (!Array.isArray(value.shots) || value.shots.length!==snapshot.shots.length) fail();
  const shots=value.shots.map(verifyShotSpecV2);
  shots.forEach((shot,index)=>{
    const ref=snapshot.shots[index]!;
    if (shot.revisionId!==ref.revisionId || shot.contentDigest!==ref.contentDigest || shot.shotId!==ref.shotId
      || shot.workspaceId!==binding.workspaceId || shot.projectId!==run.projectId || shot.episodeId!==binding.episodeId
      || shot.scriptVersionId!==snapshot.script.versionId || shot.planRevisionId!==snapshot.plan.versionId
      || shot.storyboardRevisionId!==snapshot.storyboard.versionId || shot.ratio!==policy.ratio) fail();
  });
  return {snapshot,shots};
}

/** Executor invariant: binding present means a verified bundle is required, never a legacy fallback. */
export function requireFrozenExecutionInput(run: Readonly<StoredProductionRun>,value?: FrozenProductionInput) {
  if (!value) throw new ProductionError(409,'SNAPSHOT_NOT_READY','缺少已验证的冻结执行输入。');
  return verifyFrozenExecutionInput(run,value);
}
