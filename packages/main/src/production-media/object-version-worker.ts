import type {JobHandler,JobHandlerContext} from '../jobs/worker';
import {JobQueueError} from '../jobs/contracts';
import {validateMaxBytes,type ObjectStorage} from '../infrastructure/object-storage';
import {PostgresObjectVersionRepository,OBJECT_VERSION_QUEUE,OBJECT_VERSION_JOB_KIND} from './object-versions';
import type {PostgresDatabase} from '../db/client';

/** Shares main's configured storage and database. Construction neither enqueues nor copies bytes. */
export async function createObjectVersionRuntime(database:PostgresDatabase,objects:ObjectStorage){
  if(!await database.hasMigrations(['044']))return null;
  const repository=new PostgresObjectVersionRepository(database);
  return {repository,handler:new ObjectVersionJobHandler(repository,objects)};
}

/** Existing PersistentJobWorker provides claim, tenant resolution, heartbeat and fencing. No second queue/Outbox. */
export class ObjectVersionJobHandler implements JobHandler {
  readonly queueName=OBJECT_VERSION_QUEUE;readonly kind=OBJECT_VERSION_JOB_KIND;readonly settlement='domain_transaction' as const;
  constructor(private readonly versions:PostgresObjectVersionRepository,private readonly objects:ObjectStorage,private readonly maxBytes=64*1024*1024){validateMaxBytes(maxBytes);}
  async handle(context:JobHandlerContext){
    try{await this.versions.materialize(context.tenant,context.lease,this.objects,context.assertLease,this.maxBytes);}
    catch(error){
      if(error instanceof JobQueueError&&error.code==='JOB_LEASE_LOST')throw error;
      const raw=error&&typeof error==='object'&&'code' in error?error.code:undefined;
      const code=typeof raw==='string'&&/^[A-Z][A-Z0-9_]{2,95}$/u.test(raw)?raw:'OBJECT_VERSION_UNAVAILABLE';
      await this.versions.fail(context.tenant,context.lease,code,['OBJECT_VERSION_UNAVAILABLE','OBJECT_STORAGE_UNAVAILABLE'].includes(code));
    }
  }
}
