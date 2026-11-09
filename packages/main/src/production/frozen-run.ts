import {
  assetRetrievalPolicyDigest, parseCreateProductionRun, parseCreateSnapshotProductionRun,
  ProductionError, type CreateSnapshotProductionRun, type FrozenAssetRetrievalPolicy, type FrozenMethodPack,
  type FrozenProductionInput, type StoredProductionRun,
} from '@lyra/shared';
import { parseTenantContext, type TenantContext } from '../tenancy/context';
import { compileProductionRun } from './blueprint';
import { verifyProductionInputSnapshot } from './input-snapshot';
import { verifyShotSpecV2 } from './shot-spec';
import type { ProductionRepository } from './repository';

/** Main-owned resolution of EXACT frozen versions, including full-content/permission checks in each domain owner.
 * Never implemented with a registry's current value or with a browser supplied bundle. */
export interface FrozenProductionRunInputs {
  input: FrozenProductionInput;
  assetRetrievalPolicy: FrozenAssetRetrievalPolicy;
  methodPacks: FrozenMethodPack[];
}
function invalid(code: string): never { throw new ProductionError(409,code,'冻结输入不满足运行创建要求。'); }

export function compileFrozenProductionRun(tenantValue: unknown, requestValue: unknown, resolved: FrozenProductionRunInputs,
  at: string): StoredProductionRun {
  const tenant=parseTenantContext(tenantValue), request=parseCreateSnapshotProductionRun(requestValue);
  if (tenant.role==='viewer') throw new ProductionError(403,'REFERENCE_FORBIDDEN','当前角色不能创建生产运行。');
  const snapshot=verifyProductionInputSnapshot(resolved.input.snapshot);
  if (snapshot.workspaceId!==tenant.workspaceId) throw new ProductionError(404,'REFERENCE_NOT_FOUND','冻结输入不存在。');
  if (snapshot.id!==request.snapshotId || snapshot.snapshotDigest!==request.snapshotDigest) invalid('DIGEST_MISMATCH');
  if (snapshot.state!=='frozen') invalid('SNAPSHOT_NOT_READY');
  if (!snapshot.executionPolicy || !snapshot.budgetPolicy.allowPaid) invalid('CAPABILITY_INCOMPATIBLE');
  const shots=resolved.input.shots.map(verifyShotSpecV2);
  if (shots.length!==snapshot.shots.length) invalid('DIGEST_MISMATCH');
  shots.forEach((shot,index)=>{
    const expected=snapshot.shots[index]!;
    if (shot.workspaceId!==tenant.workspaceId || shot.projectId!==snapshot.projectId || shot.episodeId!==snapshot.episodeId
      || shot.revisionId!==expected.revisionId || shot.shotId!==expected.shotId || shot.contentDigest!==expected.contentDigest
      || shot.scriptVersionId!==snapshot.script.versionId || shot.planRevisionId!==snapshot.plan.versionId
      || shot.storyboardRevisionId!==snapshot.storyboard.versionId || shot.ratio!==snapshot.executionPolicy!.ratio) invalid('DIGEST_MISMATCH');
  });
  const policy=structuredClone(resolved.assetRetrievalPolicy), methods=structuredClone(resolved.methodPacks);
  if (policy.schemaVersion!=='asset-retrieval-policy/1' || !Number.isSafeInteger(policy.registryRevision) || policy.registryRevision<0
    || policy.policyDigest!==snapshot.retrievalPolicy.digest || assetRetrievalPolicyDigest(policy)!==snapshot.retrievalPolicy.digest) invalid('DIGEST_MISMATCH');
  if (methods.length!==snapshot.methodPacks.length || new Set(methods.map(m=>m.id)).size!==methods.length
    || methods.some(m=>!snapshot.methodPacks.some(r=>r.id===m.id && r.digest===m.digest))) invalid('DIGEST_MISMATCH');
  const input=parseCreateProductionRun({ ...snapshot.executionPolicy, projectId:snapshot.projectId,scriptVersionId:snapshot.script.versionId,
    automationMode:snapshot.automationMode,candidatePolicy:snapshot.candidatePolicy.mode,candidateLimit:snapshot.candidatePolicy.limit,
    budgetMicros:snapshot.budgetPolicy.limitMicros,currency:snapshot.budgetPolicy.currency,allowPaid:true,clientRequestId:request.clientRequestId });
  const run=compileProductionRun(input,at,undefined,policy);
  run.methodPacks=methods;
  run.inputSnapshot={schemaVersion:'lyra-production-binding/1',workspaceId:tenant.workspaceId,episodeId:snapshot.episodeId,
    snapshotId:snapshot.id,snapshotDigest:snapshot.snapshotDigest};
  // V2 already freezes global asset references. Never run the V1 mutable catalog/re-generation coordinator.
  // Per-shot asset tasks still resolve and verify the exact frozen packs/objects before video submission.
  const assets=run.tasks.find(t=>t.stage==='assets')!;
  assets.status='skipped';assets.blockingReason={code:'FROZEN_ASSET_REFS',message:'全局资产引用已冻结，精确对象绑定由镜头任务完成。'};
  run.tasks.find(t=>t.stage==='storyboard')!.dependencies=[run.tasks.find(t=>t.stage==='breakdown')!.id];
  for (const task of run.tasks) {
    task.inputManifest=task.inputManifest.filter(ref=>ref.kind!=='script');
    task.inputManifest.unshift({kind:'productionInput',id:snapshot.id,revisionId:snapshot.id,digest:snapshot.snapshotDigest},
      {kind:'script',id:snapshot.script.id,revisionId:snapshot.script.versionId,digest:snapshot.script.digest});
  }
  run.outbox[0]!.payload={...run.outbox[0]!.payload,snapshotId:snapshot.id,snapshotDigest:snapshot.snapshotDigest};
  return run;
}
function sameRequest(run: StoredProductionRun, request: CreateSnapshotProductionRun, tenant: TenantContext) {
  return run.clientRequestId===request.clientRequestId && run.inputSnapshot?.workspaceId===tenant.workspaceId
    && run.inputSnapshot.snapshotId===request.snapshotId && run.inputSnapshot.snapshotDigest===request.snapshotDigest;
}
/** Not exposed by HTTP until the frozen-input executor pipeline is installed. No mutable sourceCatalog callback. */
export class FrozenProductionRunCreator {
  constructor(private readonly repository: ProductionRepository,
    private readonly resolve: (tenant: TenantContext, request: CreateSnapshotProductionRun)=>Promise<FrozenProductionRunInputs>,
    private readonly now: ()=>Date=()=>new Date()) {}
  async create(tenantValue: unknown,value: unknown) {
    const tenant=parseTenantContext(tenantValue), request=parseCreateSnapshotProductionRun(value);
    if (tenant.role==='viewer') throw new ProductionError(403,'REFERENCE_FORBIDDEN','当前角色不能创建生产运行。');
    const previous=await this.repository.getByClientRequestId(request.clientRequestId);
    if (previous) {
      if (!sameRequest(previous,request,tenant)) invalid('PRODUCTION_REQUEST_REUSED');
      return previous; // preserve exact original facts; do not resolve a newer registry value on retry
    }
    const resolved=await this.resolve(tenant,request);
    const run=compileFrozenProductionRun(tenant,request,resolved,this.now().toISOString());
    const saved=await this.repository.create(run);
    if (!sameRequest(saved,request,tenant)) invalid('PRODUCTION_REQUEST_REUSED');
    return saved;
  }
}
