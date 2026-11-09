import type { PoolClient } from 'pg';
import { ProductionError } from '@lyra/shared';
import type { InputVersionRef, ShotAssetPack, ShotControl, ShotSpecV2 } from '@lyra/shared/dist/shot-spec';
import type { ProductionInputFinding, ProductionInputSnapshot } from '@lyra/shared/dist/production-input-snapshot';
import type { ObjectStorage } from '../infrastructure/object-storage';
import { parseTenantContext, type TenantContext } from '../tenancy/context';
import { verifyProductionInputSnapshot } from './input-snapshot';
import { PostgresProductionInputReferenceReader } from './input-reference-reader';
import { ProductionInputObjectVerifier } from './input-object-verifier';
import type { InputReferenceKind, ProductionInputValidationPorts } from './input-validation';

type DomainReferenceKind = Exclude<InputReferenceKind,'script'|'plan'|'storyboard'>;
type Check = ProductionInputFinding['code'] | null;
/** Implemented by domain owners (#126/#127/#131/#134/#135), not by a second registry inside production. */
export interface ProductionInputDomainValidators {
  versions?: Partial<Record<DomainReferenceKind,(ref: InputVersionRef) => Promise<Check>>>;
  assetBinding?: (binding: ShotAssetPack) => Promise<Check>;
  controlBinding?: (control: ShotControl) => Promise<Check>;
  capabilities?: (snapshot: ProductionInputSnapshot, shots: readonly ShotSpecV2[]) => Promise<ProductionInputFinding[]>;
}
export type ProductionInputDomainValidatorsFactory = (client: PoolClient, tenant: TenantContext, snapshot: ProductionInputSnapshot)
  => ProductionInputDomainValidators | Promise<ProductionInputDomainValidators>;

/** Production wiring: all PostgreSQL reads share the lifecycle transaction; absent domain support is blocked. */
export async function createProductionInputValidationPorts(client: PoolClient, tenantValue: unknown, snapshotValue: unknown,
  objects?: Pick<ObjectStorage,'provider'|'bucket'|'head'>, domainsFactory?: ProductionInputDomainValidatorsFactory): Promise<ProductionInputValidationPorts> {
  const tenant = parseTenantContext(tenantValue), snapshot = verifyProductionInputSnapshot(snapshotValue);
  const denied = (): never => { throw new ProductionError(404,'REFERENCE_NOT_FOUND','生产输入资源不存在。'); };
  if (snapshot.workspaceId !== tenant.workspaceId) denied();
  const source = new PostgresProductionInputReferenceReader(client,tenant,snapshot.projectId);
  const objectVerifier = objects ? new ProductionInputObjectVerifier(client,objects) : null;
  const domains = domainsFactory ? await domainsFactory(client,tenant,snapshot) : {};
  const bound = (value: TenantContext) => {
    const actual = parseTenantContext(value);
    if (actual.workspaceId !== tenant.workspaceId || actual.userId !== tenant.userId || actual.role !== tenant.role) denied();
  };
  return {
    async authorizeProject(ctx,projectId) { bound(ctx); return projectId === snapshot.projectId && await source.authorizeProject(); },
    async loadShot(ctx,id) { bound(ctx); return source.loadShot(id); },
    async checkVersion(ctx,kind,ref) {
      bound(ctx);
      if (kind === 'script' || kind === 'plan' || kind === 'storyboard') return source.checkVersion(kind,ref);
      const check = domains.versions?.[kind]; return check ? check(ref) : 'CAPABILITY_INCOMPATIBLE';
    },
    async checkSource(ctx,ref) { bound(ctx); return source.checkSource(ref); },
    async checkObject(ctx,ref) { bound(ctx); return objectVerifier ? objectVerifier.check(tenant,ref) : 'CAPABILITY_INCOMPATIBLE'; },
    async checkAssetBinding(ctx,binding) { bound(ctx); return domains.assetBinding ? domains.assetBinding(binding) : 'CAPABILITY_INCOMPATIBLE'; },
    async checkControl(ctx,control) { bound(ctx); return domains.controlBinding ? domains.controlBinding(control) : 'CAPABILITY_INCOMPATIBLE'; },
    async checkCapabilities(ctx,value,shots) {
      bound(ctx);
      if (value.workspaceId !== tenant.workspaceId || value.projectId !== snapshot.projectId || value.id !== snapshot.id
        || value.snapshotDigest !== snapshot.snapshotDigest) denied();
      return domains.capabilities ? domains.capabilities(value,shots) : [{ code:'CAPABILITY_INCOMPATIBLE',referenceId:null }];
    },
  };
}
