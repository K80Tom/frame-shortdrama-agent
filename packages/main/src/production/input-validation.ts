import { ProductionError } from '@lyra/shared';
import type { InputVersionRef, ShotSpecV2, ShotSourceRef, ShotControl, ShotAssetPack } from '@lyra/shared';
import { PRODUCTION_INPUT_ERROR_CODES, type ProductionInputFinding, type ProductionInputSnapshot } from '@lyra/shared';
import { parseTenantContext, type TenantContext } from '../tenancy/context';
import { verifyProductionInputSnapshot } from './input-snapshot';
import { verifyShotSpecV2 } from './shot-spec';

export type InputReferenceKind = 'script' | 'plan' | 'storyboard' | 'asset_pack' | 'director_scene' | 'control'
  | 'method_pack' | 'prompt_pack' | 'model_connection' | 'model_capability' | 'retrieval_policy' | 'quality_gate' | 'budget_policy';
/** Main-owned, read-only adapters. Never expose these callbacks as user-supplied code or provider execution. */
export interface ProductionInputValidationPorts {
  authorizeProject(tenant: TenantContext, projectId: string): Promise<boolean>;
  loadShot(tenant: TenantContext, revisionId: string): Promise<unknown | null>;
  checkVersion(tenant: TenantContext, kind: InputReferenceKind, ref: InputVersionRef): Promise<ProductionInputFinding['code'] | null>;
  checkObject(tenant: TenantContext, value: { objectId: string; versionId: string; checksum: string }): Promise<ProductionInputFinding['code'] | null>;
  checkSource(tenant: TenantContext, ref: ShotSourceRef): Promise<ProductionInputFinding['code'] | null>;
  checkAssetBinding(tenant: TenantContext, binding: ShotAssetPack): Promise<ProductionInputFinding['code'] | null>;
  checkControl(tenant: TenantContext, control: ShotControl): Promise<ProductionInputFinding['code'] | null>;
  checkCapabilities(tenant: TenantContext, snapshot: ProductionInputSnapshot, shots: readonly ShotSpecV2[]): Promise<ProductionInputFinding[]>;
}
function hidden(): never { throw new ProductionError(404, 'REFERENCE_NOT_FOUND', '生产输入资源不存在。'); }
/** Validate a server-compiled candidate; does not persist/adopt/freeze a snapshot or call paid providers. */
export async function validateProductionInputCandidate(tenantValue: unknown, snapshotValue: unknown, ports: ProductionInputValidationPorts) {
  const tenant = parseTenantContext(tenantValue), snapshot = verifyProductionInputSnapshot(snapshotValue);
  if (tenant.workspaceId !== snapshot.workspaceId) hidden();
  try { if (!await ports.authorizeProject(tenant, snapshot.projectId)) hidden(); } catch { hidden(); }
  const findings: ProductionInputFinding[] = [], seen = new Set<string>();
  const add = (code: ProductionInputFinding['code'], referenceId: string | null) => {
    const safe = PRODUCTION_INPUT_ERROR_CODES.includes(code) ? code : 'REFERENCE_NOT_FOUND';
    const key = JSON.stringify([safe, referenceId]);
    if (!seen.has(key)) { seen.add(key); findings.push({ code: safe, referenceId }); }
  };
  async function check(work: () => Promise<ProductionInputFinding['code'] | null>, referenceId: string) {
    try { const code = await work(); if (code !== null) add(code, referenceId); }
    catch { add('REFERENCE_NOT_FOUND', referenceId); }
  }
  const versionChecks = new Map<string, Promise<void>>();
  const checkVersion = (kind: InputReferenceKind, ref: InputVersionRef) => {
    const key = JSON.stringify([kind, ref]);
    if (!versionChecks.has(key)) versionChecks.set(key, check(() => ports.checkVersion(tenant, kind, ref), ref.id));
    return versionChecks.get(key)!;
  };
  const singles: Array<[InputReferenceKind, InputVersionRef]> = [['script', snapshot.script], ['plan', snapshot.plan],
    ['storyboard', snapshot.storyboard], ['retrieval_policy', snapshot.retrievalPolicy], ['budget_policy', snapshot.budgetPolicy.version]];
  const groups: Array<[InputReferenceKind, InputVersionRef[]]> = [['asset_pack', snapshot.assetPacks], ['director_scene', snapshot.directorScenes],
    ['control', snapshot.controls], ['method_pack', snapshot.methodPacks], ['prompt_pack', snapshot.promptPacks], ['quality_gate', snapshot.qualityGates]];
  for (const [kind, ref] of singles) await checkVersion(kind, ref);
  for (const [kind, refs] of groups) for (const ref of refs) await checkVersion(kind, ref);
  for (const model of snapshot.modelConnections) {
    await checkVersion('model_connection', model.connection); await checkVersion('model_capability', model.capability);
  }
  if (!snapshot.modelConnections.some(m => m.role === 'video') || !snapshot.qualityGates.length) add('CAPABILITY_INCOMPATIBLE', null);
  const contains = (refs: InputVersionRef[], ref: InputVersionRef) => refs.some(r => r.id === ref.id && r.versionId === ref.versionId && r.digest === ref.digest);
  const requireListed = (refs: InputVersionRef[], ref: InputVersionRef) => { if (!contains(refs, ref)) add('REFERENCE_NOT_FOUND', ref.id); };
  const shots: ShotSpecV2[] = [];
  for (const expected of snapshot.shots) {
    let shot: ShotSpecV2;
    let value: unknown;
    try { value = await ports.loadShot(tenant, expected.revisionId); }
    catch { add('REFERENCE_NOT_FOUND', expected.revisionId); continue; }
    try {
      if (value === null) { add('REFERENCE_NOT_FOUND', expected.revisionId); continue; }
      shot = verifyShotSpecV2(value);
    } catch { add('DIGEST_MISMATCH', expected.revisionId); continue; }
    if (shot.workspaceId !== tenant.workspaceId || shot.projectId !== snapshot.projectId || shot.episodeId !== snapshot.episodeId) {
      add('REFERENCE_FORBIDDEN', expected.revisionId); continue;
    }
    if (shot.revisionId !== expected.revisionId || shot.shotId !== expected.shotId || shot.contentDigest !== expected.contentDigest) {
      add('DIGEST_MISMATCH', expected.revisionId); continue;
    }
    if (shot.scriptVersionId !== snapshot.script.versionId || shot.planRevisionId !== snapshot.plan.versionId
      || shot.storyboardRevisionId !== snapshot.storyboard.versionId) add('DIGEST_MISMATCH', expected.revisionId);
    if (shot.generation.candidatePolicy.mode !== snapshot.candidatePolicy.mode || shot.generation.candidatePolicy.limit !== snapshot.candidatePolicy.limit) {
      add('CAPABILITY_INCOMPATIBLE', expected.revisionId);
    }
    for (const pack of shot.assetPacks) {
      requireListed(snapshot.assetPacks, pack.pack);
      await check(() => ports.checkAssetBinding(tenant, pack), pack.pack.id);
      for (const media of pack.media) await check(() => ports.checkObject(tenant,
        { objectId: media.objectId, versionId: media.objectVersionId, checksum: media.checksum }), media.objectId);
    }
    for (const control of shot.controls) {
      requireListed(control.kind === 'director_scene' ? snapshot.directorScenes : snapshot.controls, control.artifact);
      await check(() => ports.checkControl(tenant, control), control.artifact.id);
    }
    for (const ref of shot.generation.methodPackRevisions) requireListed(snapshot.methodPacks, ref);
    requireListed(snapshot.promptPacks, shot.generation.promptPackRevision);
    requireListed(snapshot.modelConnections.map(m => m.capability), shot.generation.modelCapabilityRevision);
    const sourceRefs = [...shot.sourceRefs, ...shot.dialogue.map(d => d.sourceRef), ...shot.actions.flatMap(a => a.sourceRefs)];
    for (const ref of sourceRefs) await check(() => ports.checkSource(tenant, ref), ref.scriptVersionId);
    shots.push(shot);
  }
  if (shots.length === snapshot.shots.length) {
    try {
      const capabilityFindings = await ports.checkCapabilities(tenant, snapshot, shots);
      if (!Array.isArray(capabilityFindings) || capabilityFindings.length > 1000) throw new Error();
      for (const finding of capabilityFindings) {
        if (!finding || !PRODUCTION_INPUT_ERROR_CODES.includes(finding.code)
          || finding.referenceId !== null && (typeof finding.referenceId !== 'string' || /[\r\n]/u.test(finding.referenceId) || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(finding.referenceId))) throw new Error();
        add(finding.code, finding.referenceId);
      }
    } catch { add('CAPABILITY_INCOMPATIBLE', null); }
  }
  // Report only. A ready report is NOT a durable state transition or signed authorization token.
  return { snapshotId: snapshot.id, snapshotDigest: snapshot.snapshotDigest,
    state: findings.length ? 'blocked' as const : 'ready' as const, findings, checkedShotCount: shots.length };
}
