const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  PRODUCTION_MEDIA_OBJECT_JOB_KIND,
  PRODUCTION_MEDIA_OBJECT_QUEUE,
  ProductionMediaObjectRecordError,
  ProductionMediaObjectService,
  ProductionMediaObjectWorker,
  createProductionMediaObjectPayload,
} = require('../dist/production-media');

const workspaceId = `ws_${'7'.repeat(32)}`;
const scope = { workspaceId };
const bytes = Buffer.from('movie');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const mediaId = `media_${sha256}`;
const now = '2026-11-08T00:00:00.000Z';

function localMedia(changes = {}) {
  return {
    limits: { maxBytes: 1024 },
    async content(requestedId) {
      assert.equal(requestedId, mediaId);
      return {
        object: { id: mediaId, sha256, bytes: bytes.length, mimeType: 'video/mp4', ...changes },
        bytes: Buffer.from(bytes),
      };
    },
  };
}

function payload() {
  return createProductionMediaObjectPayload(scope, {
    mediaId, provider: 'minio', bucket: 'lyra-media', sha256,
    sizeBytes: bytes.length, contentType: 'video/mp4',
  });
}

function persistentJob(body, changes = {}) {
  return {
    id: `job_${'a'.repeat(32)}`,
    workspaceId,
    queueName: PRODUCTION_MEDIA_OBJECT_QUEUE,
    kind: PRODUCTION_MEDIA_OBJECT_JOB_KIND,
    aggregateType: 'object_record',
    aggregateId: body.objectId,
    idempotencyKey: `object-projection:${body.objectId}`,
    payload: { ...body },
    state: 'running',
    priority: 60,
    maxAttempts: 5,
    attemptCount: 1,
    availableAt: now,
    leaseOwner: 'object-worker-one',
    fencingToken: 1,
    leaseExpiresAt: '2026-11-08T00:01:00.000Z',
    heartbeatAt: now,
    lastError: null,
    version: 2,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...changes,
  };
}

function lease(job, token = 1) {
  return {
    job: { ...job, attemptCount: token, fencingToken: token },
    attemptId: `jobatt_${String(token).repeat(32)}`,
    attemptNumber: token,
    workerId: 'object-worker-one',
    fencingToken: token,
    leaseExpiresAt: '2026-11-08T00:01:00.000Z',
  };
}

function record(body, jobId, changes = {}) {
  return {
    id: body.objectId,
    workspaceId,
    provider: body.provider,
    bucket: body.bucket,
    key: body.key,
    versionId: null,
    etag: null,
    sha256: body.sha256,
    sizeBytes: body.sizeBytes,
    contentType: body.contentType,
    purpose: body.purpose,
    ownerType: body.ownerType,
    ownerId: body.ownerId,
    jobId,
    status: 'uploading',
    lastError: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    verifiedAt: null,
    deletedAt: null,
    ...changes,
  };
}

class MemoryObjectStorage {
  constructor() {
    this.provider = 'minio';
    this.bucket = 'lyra-media';
    this.saved = new Map();
    this.putCalls = 0;
  }

  async put(request) {
    this.putCalls++;
    assert.equal(request.scope.workspaceId, workspaceId);
    const body = Buffer.from(request.body);
    const digest = createHash('sha256').update(body).digest('hex');
    assert.equal(digest, request.expectedSha256);
    const existing = this.saved.get(request.key);
    if (existing) {
      assert.equal(existing.sha256, digest);
      assert.deepEqual(existing.body, body);
      return { ...existing.descriptor };
    }
    const descriptor = { provider: this.provider, bucket: this.bucket, key: request.key,
      versionId: 'v1', etag: 'etag-one', sha256: digest, size: body.length,
      contentType: request.contentType };
    this.saved.set(request.key, { body, sha256: digest, descriptor });
    return { ...descriptor };
  }

  async get(request) {
    const saved = this.saved.get(request.key);
    if (!saved) throw new Error('missing');
    assert.equal(request.scope.workspaceId, workspaceId);
    assert.equal(request.expectedSha256, saved.sha256);
    return { object: { ...saved.descriptor }, body: Buffer.from(saved.body) };
  }

  async createPresignedGet(request) {
    assert.equal(request.scope.workspaceId, workspaceId);
    return { method: 'GET', url: 'https://objects.example.test/signed', expiresAt: now };
  }
}

class FakeJobs {
  constructor(leases) {
    this.leases = [...leases];
    this.claimCalls = 0;
    this.heartbeats = [];
    this.steps = [];
  }

  async claim(input) {
    this.claimCalls++;
    assert.equal(input.queueName, PRODUCTION_MEDIA_OBJECT_QUEUE);
    return this.leases.shift() ?? null;
  }

  async heartbeat(input) {
    this.heartbeats.push(structuredClone(input));
    return persistentJob(payload());
  }

  async saveStep(input) {
    this.steps.push(structuredClone(input));
  }
}

test('projection service freezes verified media into one deterministic idempotent job', async () => {
  const enqueued = new Map();
  const records = {
    async enqueue(receivedScope, body, at) {
      assert.deepEqual(receivedScope, scope);
      assert.equal(at, now);
      const existing = enqueued.get(body.objectId);
      if (existing) return { ...existing, created: false };
      const job = persistentJob(body, { state: 'queued', leaseOwner: null, fencingToken: 0,
        leaseExpiresAt: null, heartbeatAt: null, version: 1 });
      const result = { record: record(body, job.id), job, created: true };
      enqueued.set(body.objectId, result);
      return result;
    },
  };
  const storage = new MemoryObjectStorage();
  const service = new ProductionMediaObjectService(localMedia(), storage, records,
    { now: () => new Date(now) });
  const first = await service.enqueue(scope, mediaId);
  const duplicate = await service.enqueue(scope, mediaId);
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.id, first.job.id);
  assert.equal(duplicate.record.id, first.record.id);
  assert.equal(enqueued.size, 1);
  assert.equal(storage.putCalls, 0, 'the request path must not upload before the durable job exists');
});

test('media access requires a ready tenant record and re-verifies object bytes', async () => {
  const body = payload();
  const storage = new MemoryObjectStorage();
  await storage.put({ scope, key: body.key, body: bytes, contentType: body.contentType,
    expectedSha256: body.sha256 });
  let current = record(body, persistentJob(body).id, { status: 'uploading' });
  const records = {
    async findByMedia(receivedScope, requestedMediaId) {
      assert.deepEqual(receivedScope, scope); assert.equal(requestedMediaId, mediaId); return current;
    },
  };
  const service = new ProductionMediaObjectService(localMedia(), storage, records);
  await assert.rejects(service.content(scope, mediaId), error => error.code === 'OBJECT_MEDIA_NOT_READY');
  current = record(body, persistentJob(body).id, { status: 'ready', versionId: 'v1', etag: 'etag-one',
    verifiedAt: now });
  const content = await service.content(scope, mediaId);
  assert.deepEqual(content.bytes, bytes);
  assert.equal(content.record.workspaceId, workspaceId);
  assert.equal((await service.access(scope, mediaId)).method, 'GET');
});

test('projection worker retries safely after upload succeeded but metadata commit failed', async () => {
  const body = payload();
  const baseJob = persistentJob(body);
  const jobs = new FakeJobs([lease(baseJob, 1), lease(baseJob, 2)]);
  const storage = new MemoryObjectStorage();
  let completes = 0;
  const failures = [];
  const records = {
    async enqueue() { throw new Error('not used'); },
    async complete(currentLease, descriptor) {
      completes++;
      if (completes === 1) throw new ProductionMediaObjectRecordError(
        'OBJECT_PROJECTION_PERSISTENCE_UNAVAILABLE', 'simulated transaction failure');
      return record(body, currentLease.job.id, { status: 'ready', versionId: descriptor.versionId,
        etag: descriptor.etag, version: 3, verifiedAt: now });
    },
    async fail(currentLease, errorCode, retryable) {
      failures.push({ errorCode, retryable });
      return { record: record(body, currentLease.job.id, { version: 2, lastError: errorCode }),
        job: { ...currentLease.job, state: retryable ? 'queued' : 'failed' } };
    },
  };
  const worker = new ProductionMediaObjectWorker(localMedia(), storage, jobs, records,
    { workerId: 'object-worker-one', now: () => new Date(now), retryBackoffMs: 5_000 });
  const first = await worker.runOnce();
  assert.equal(first.status, 'retry_scheduled');
  assert.deepEqual(failures, [{ errorCode: 'OBJECT_PROJECTION_PERSISTENCE_UNAVAILABLE', retryable: true }]);
  assert.equal(storage.saved.size, 1, 'the uploaded object remains immutable for retry');

  const second = await worker.runOnce();
  assert.equal(second.status, 'succeeded');
  assert.equal(second.objectId, body.objectId);
  assert.equal(storage.putCalls, 2, 'the retry re-verifies the same deterministic key');
  assert.equal(storage.saved.size, 1, 'retry must not create a second object');
  assert.deepEqual(jobs.steps.map(step => step.stepKey),
    ['local_verified', 'object_verified', 'local_verified', 'object_verified']);
});

test('projection worker makes a frozen local-media mismatch terminal without uploading', async () => {
  const body = payload();
  const currentLease = lease(persistentJob(body), 1);
  const jobs = new FakeJobs([currentLease]);
  const storage = new MemoryObjectStorage();
  let failure;
  const records = {
    async enqueue() { throw new Error('not used'); },
    async complete() { throw new Error('must not complete'); },
    async fail(receivedLease, errorCode, retryable) {
      failure = { errorCode, retryable };
      return { record: record(body, receivedLease.job.id, { status: 'failed', lastError: errorCode }),
        job: { ...receivedLease.job, state: 'failed' } };
    },
  };
  const worker = new ProductionMediaObjectWorker(localMedia({ bytes: bytes.length + 1 }),
    storage, jobs, records, { workerId: 'object-worker-one', now: () => new Date(now) });
  const result = await worker.runOnce();
  assert.equal(result.status, 'failed');
  assert.deepEqual(failure, { errorCode: 'OBJECT_PROJECTION_LOCAL_MISMATCH', retryable: false });
  assert.equal(storage.putCalls, 0);
  assert.deepEqual(jobs.steps, []);
});

test('projection worker claims as system and executes storage plus atomic completion as a real tenant', async () => {
  const body = payload();
  const jobs = new FakeJobs([lease(persistentJob(body), 1)]);
  const storage = new MemoryObjectStorage();
  const calls = [];
  let authority = 'none';
  const executionScope = {
    runAsSystem(reason, work) {
      calls.push(`system:${reason}`);
      assert.equal(authority, 'none');
      authority = 'system';
      return Promise.resolve(work()).finally(() => { authority = 'none'; });
    },
    runWithTenant(tenant, work) {
      calls.push(`tenant:${tenant.workspaceId}:${tenant.userId}`);
      assert.equal(authority, 'none');
      authority = 'tenant';
      return Promise.resolve(work()).finally(() => { authority = 'none'; });
    },
  };
  const originalClaim = jobs.claim.bind(jobs);
  jobs.claim = async input => {
    assert.equal(authority, 'system');
    calls.push('claim');
    return originalClaim(input);
  };
  const originalStep = jobs.saveStep.bind(jobs);
  jobs.saveStep = async input => {
    assert.equal(authority, 'tenant');
    calls.push(`step:${input.stepKey}`);
    return originalStep(input);
  };
  const originalPut = storage.put.bind(storage);
  storage.put = async request => {
    assert.equal(authority, 'tenant');
    calls.push('put');
    return originalPut(request);
  };
  const tenant = { userId: `usr_${'8'.repeat(32)}`, workspaceId, role: 'owner',
    requestId: `worker:${persistentJob(body).id}` };
  const records = {
    async enqueue() { throw new Error('not used'); },
    async complete(currentLease, descriptor) {
      assert.equal(authority, 'tenant');
      calls.push('complete');
      return record(body, currentLease.job.id, { status: 'ready', versionId: descriptor.versionId,
        etag: descriptor.etag, version: 2, verifiedAt: now });
    },
    async fail() { throw new Error('must not fail'); },
  };
  const resolver = { async resolve(receivedWorkspaceId, operationId) {
    assert.equal(authority, 'none');
    assert.equal(receivedWorkspaceId, workspaceId);
    assert.equal(operationId, persistentJob(body).id);
    calls.push('resolve');
    return tenant;
  } };
  const worker = new ProductionMediaObjectWorker(localMedia(), storage, jobs, records, {
    workerId: 'object-worker-one', now: () => new Date(now),
    tenantResolver: resolver, executionScope,
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls, [
    'system:object.projection.claim', 'claim', 'resolve',
    `tenant:${workspaceId}:${tenant.userId}`,
    'step:local_verified', 'put', 'step:object_verified', 'complete',
  ]);
  assert.equal(authority, 'none');
});

test('tenant resolution failure atomically reschedules object metadata and its job under system scope', async () => {
  const body = payload();
  const jobs = new FakeJobs([lease(persistentJob(body), 1)]);
  const storage = new MemoryObjectStorage();
  const calls = [];
  let authority = 'none';
  const executionScope = {
    runAsSystem(reason, work) {
      calls.push(`system:${reason}`);
      assert.equal(authority, 'none');
      authority = 'system';
      return Promise.resolve(work()).finally(() => { authority = 'none'; });
    },
    runWithTenant() { throw new Error('must not enter tenant scope'); },
  };
  const records = {
    async enqueue() { throw new Error('not used'); },
    async complete() { throw new Error('must not complete'); },
    async fail(currentLease, errorCode, retryable) {
      assert.equal(authority, 'system');
      calls.push(`fail:${errorCode}:${retryable}`);
      return { record: record(body, currentLease.job.id, { lastError: errorCode, version: 2 }),
        job: { ...currentLease.job, state: 'queued' } };
    },
  };
  const resolver = { async resolve() {
    calls.push('resolve');
    const error = new Error('no active member');
    error.code = 'JOB_TENANT_UNAVAILABLE';
    throw error;
  } };
  const worker = new ProductionMediaObjectWorker(localMedia(), storage, jobs, records, {
    workerId: 'object-worker-one', now: () => new Date(now),
    tenantResolver: resolver, executionScope,
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'retry_scheduled');
  assert.equal(result.errorCode, 'JOB_TENANT_UNAVAILABLE');
  assert.deepEqual(calls, [
    'system:object.projection.claim', 'resolve',
    'system:object.projection.tenant_failure', 'fail:JOB_TENANT_UNAVAILABLE:true',
  ]);
  assert.equal(storage.putCalls, 0);
  assert.equal(authority, 'none');
});

test('projection worker start and stop provide one idempotent abortable polling loop', async () => {
  const body = payload();
  const jobs = new FakeJobs([lease(persistentJob(body), 1)]);
  const storage = new MemoryObjectStorage();
  let completed;
  const completedOnce = new Promise(resolve => { completed = resolve; });
  const records = {
    async enqueue() { throw new Error('not used'); },
    async complete(currentLease, descriptor) {
      completed();
      return record(body, currentLease.job.id, { status: 'ready', versionId: descriptor.versionId,
        etag: descriptor.etag, version: 2, verifiedAt: now });
    },
    async fail() { throw new Error('must not fail'); },
  };
  const worker = new ProductionMediaObjectWorker(localMedia(), storage, jobs, records, {
    workerId: 'object-worker-one', now: () => new Date(now), pollIntervalMs: 10,
  });
  worker.start();
  worker.start();
  await completedOnce;
  await worker.stop();
  const claimsAfterStop = jobs.claimCalls;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(jobs.claimCalls, claimsAfterStop, 'stop must leave no background polling timer');
  assert.ok(jobs.claimCalls >= 1);
  assert.equal(storage.saved.size, 1);
});
