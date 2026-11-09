import {copyBoundedProductionInput} from './shot-spec';
/** Internal version identity. Never substitute a provider VersionId, ETag or mutable row counter. */
export interface ObjectVersion {
  schemaVersion:'lyra-object-version/1';id:string;objectId:string;workspaceId:string;
  status:'pending'|'ready'|'failed';checksum:string;sizeBytes:number;contentType:string;
  createdBy:string;createdAt:string;verifiedAt:string|null;version:number;
}
export class ObjectVersionContractError extends Error{
  readonly status=400;readonly code='OBJECT_VERSION_INVALID';
  constructor(){super('对象版本请求无效。');this.name='ObjectVersionContractError';}
}
export function parseObjectVersionRequest(value:unknown):{objectId:string}{
  let r:Record<string,unknown>;
  try{r=copyBoundedProductionInput(value) as Record<string,unknown>;}
  catch{throw new ObjectVersionContractError();}
  if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length!==1||typeof r.objectId!=='string'
    ||r.objectId.length!==36||!/^obj_[a-f0-9]{32}$/u.test(r.objectId)){
    throw new ObjectVersionContractError();
  }
  return {objectId:r.objectId};
}
