const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JobQueueError } = require('../dist/jobs/contracts');
const { PostgresJobQueueRepository } = require('../dist/jobs/repository');

const ws = `ws_${'1'.repeat(32)}`;
const jobId = `job_${'a'.repeat(32)}`;
const at = offset => new Date(Date.parse('2026-11-08T00:00:00.000Z') + offset).toISOString();

function initialJob() {
  return {
    id: jobId,
    workspace_id: ws,
    queue_name: 'model',
    kind: 'assistant.reply',
    aggregate_type: 'assistant_session',
    aggregate_id: 'assistant_session_001',
    idempotency_key: 'assistant-session-001-message-001',
    payload_json: { sessionId: 'assistant_session_001' },
    state: 'queued',
    priority: 50,
    max_attempts: 3,
    attempt_count: 0,
    available_at: at(0),
    lease_owner: null,
    fencing_token: 0,
    lease_expires_at: null,
    heartbeat_at: null,
    last_error: null,
    version: 1,
    created_at: at(0),
    updated_at: at(0),
    completed_at: null,
  };
}

class FakeDatabase {
  constructor() {
    this.job = initialJob();
    this.attempts = [];
    this.steps = [];
  }

  async transaction(work) {
    return work({ query: (sql, values = []) => this.query(sql, values) });
  }

  result(rows = []) { return { rows, rowCount: rows.length }; }

  async query(sql, values = []) {
    const normalized = sql.replace(/\s+/gu, ' ').trim();
    if (normalized.startsWith('SELECT id, workspace_id') && normalized.includes('FOR UPDATE SKIP LOCKED')) {
      const [queue, now] = values;
      const ready = this.job.queue_name === queue && (
        (this.job.state === 'queued' && this.job.available_at <= now)
        || (this.job.state === 'running' && this.job.lease_expires_at <= now)
      );
      return this.result(ready ? [{ ...this.job }] : []);
    }
    if (normalized.startsWith('SELECT id, workspace_id') && normalized.endsWith('FOR UPDATE')) {
      const [workspaceId, id] = values;
      return this.result(this.job.workspace_id === workspaceId && this.job.id === id ? [{...this.job}] : []);
    }
    if (normalized.startsWith('SELECT 1 FROM job_steps')) {
      const [workspaceId, id, stepKey] = values;
      return this.result(this.steps.some(step => step.workspace_id === workspaceId
        && step.job_id === id && step.step_key === stepKey) ? [{'?column?': 1}] : []);
    }
    if (normalized.startsWith("UPDATE job_attempts SET status = 'lost'")) {
      const [id, token, now] = values;
      const attempt = this.attempts.find(item => item.job_id === id
        && item.fencing_token === Number(token) && item.status === 'running');
      if (attempt) { attempt.status = 'lost'; attempt.ended_at = now; }
      return this.result([]);
    }
    if (normalized.startsWith("UPDATE jobs SET state = 'dead_letter'")) {
      this.job.state = 'dead_letter';
      this.job.lease_owner = null;
      this.job.lease_expires_at = null;
      this.job.heartbeat_at = null;
      this.job.completed_at = values[1];
      return this.result([]);
    }
    if (normalized.startsWith("UPDATE jobs SET state = 'running'")) {
      const [, worker, now, leaseMs] = values;
      this.job.state = 'running';
      this.job.attempt_count += 1;
      this.job.lease_owner = worker;
      this.job.fencing_token += 1;
      this.job.heartbeat_at = now;
      this.job.lease_expires_at = new Date(Date.parse(now) + leaseMs).toISOString();
      this.job.updated_at = now;
      this.job.version += 1;
      return this.result([{ ...this.job }]);
    }
    if (normalized.startsWith("UPDATE jobs SET state = 'queued'")) {
      const [workspaceId, id, version, availableAt, error] = values;
      if (this.job.workspace_id !== workspaceId || this.job.id !== id
        || this.job.version !== version || !['failed', 'dead_letter'].includes(this.job.state)) return this.result([]);
      this.job.state = 'queued';
      this.job.max_attempts = Math.max(this.job.max_attempts, this.job.attempt_count + 1);
      this.job.available_at = availableAt;
      this.job.last_error = error;
      this.job.completed_at = null;
      this.job.updated_at = availableAt;
      this.job.version += 1;
      return this.result([{...this.job}]);
    }
    if (normalized.startsWith('INSERT INTO job_attempts')) {
      const [id, workspaceId, idValue, number, token, worker, now] = values;
      this.attempts.push({ id, workspace_id: workspaceId, job_id: idValue,
        attempt_number: number, fencing_token: Number(token), worker_id: worker,
        status: 'running', started_at: now, ended_at: null });
      return this.result([]);
    }
    if (normalized.startsWith('UPDATE jobs SET heartbeat_at')) {
      const [workspaceId, id, worker, token, now, leaseMs] = values;
      const held = this.job.workspace_id === workspaceId && this.job.id === id
        && this.job.state === 'running' && this.job.lease_owner === worker
        && this.job.fencing_token === token && this.job.lease_expires_at > now;
      if (!held) return this.result([]);
      this.job.heartbeat_at = now;
      this.job.lease_expires_at = new Date(Date.parse(now) + leaseMs).toISOString();
      this.job.updated_at = now;
      this.job.version += 1;
      return this.result([{ ...this.job }]);
    }
    if (normalized.startsWith('UPDATE jobs SET state = $6')) {
      const [workspaceId, id, worker, token, now, state, error, availableAt, terminal] = values;
      const held = this.job.workspace_id === workspaceId && this.job.id === id
        && this.job.state === 'running' && this.job.lease_owner === worker
        && this.job.fencing_token === token && this.job.lease_expires_at > now;
      if (!held) return this.result([]);
      this.job.state = state;
      this.job.lease_owner = null;
      this.job.lease_expires_at = null;
      this.job.heartbeat_at = null;
      this.job.last_error = error;
      if (availableAt) this.job.available_at = availableAt;
      this.job.completed_at = terminal ? now : null;
      this.job.updated_at = now;
      this.job.version += 1;
      return this.result([{ ...this.job }]);
    }
    if (normalized.startsWith('UPDATE job_attempts SET status = $4')) {
      const [id, workspaceId, token, status, now] = values;
      const attempt = this.attempts.find(item => item.job_id === id
        && item.workspace_id === workspaceId && item.fencing_token === token && item.status === 'running');
      if (attempt) { attempt.status = status; attempt.ended_at = now; }
      return this.result([]);
    }
    if (normalized.startsWith('INSERT INTO job_steps')) {
      const [workspaceId, id, stepKey, checkpoint, now] = values;
      this.steps.push({workspace_id: workspaceId, job_id: id, step_key: stepKey,
        checkpoint_json: JSON.parse(checkpoint), created_at: now});
      return this.result([]);
    }
    throw new Error(`Unexpected SQL in fake: ${normalized}`);
  }
}

test('expired lease is reclaimed with a higher fence and stale worker cannot commit', async () => {
  const database = new FakeDatabase();
  const repository = new PostgresJobQueueRepository(database);

  const first = await repository.claim({ queueName: 'model', workerId: 'worker-a', leaseMs: 2_000, now: at(0) });
  assert.equal(first.fencingToken, 1);
  assert.equal(first.attemptNumber, 1);
  const heartbeat = await repository.heartbeat({ workspaceId: ws, jobId, workerId: 'worker-a',
    fencingToken: 1, leaseMs: 2_000, now: at(1_000) });
  assert.equal(heartbeat.leaseExpiresAt, at(3_000));

  await assert.rejects(repository.heartbeat({ workspaceId: ws, jobId, workerId: 'worker-stale',
    fencingToken: 1, leaseMs: 2_000, now: at(1_500) }), error => {
    assert.ok(error instanceof JobQueueError);
    assert.equal(error.code, 'JOB_LEASE_LOST');
    return true;
  });

  const second = await repository.claim({ queueName: 'model', workerId: 'worker-b', leaseMs: 4_000, now: at(3_001) });
  assert.equal(second.fencingToken, 2);
  assert.equal(second.attemptNumber, 2);
  assert.equal(database.attempts[0].status, 'lost');

  await assert.rejects(repository.complete({ workspaceId: ws, jobId, workerId: 'worker-a',
    fencingToken: 1, now: at(3_500) }), error => {
    assert.ok(error instanceof JobQueueError);
    assert.equal(error.code, 'JOB_LEASE_LOST');
    return true;
  });
  const completed = await repository.complete({ workspaceId: ws, jobId, workerId: 'worker-b',
    fencingToken: 2, now: at(3_500) });
  assert.equal(completed.state, 'succeeded');
  assert.equal(database.attempts[1].status, 'succeeded');
});
test('terminal requeue is idempotent and preserves attempts/checkpoints instead of resetting paid work', async () => {
  const database = new FakeDatabase();
  database.job.state = 'dead_letter';
  database.job.attempt_count = 3;
  database.job.max_attempts = 3;
  database.job.completed_at = at(3_000);
  database.job.version = 9;
  database.steps.push({workspace_id: ws, job_id: jobId, step_key: 'provider.submitted',
    checkpoint_json: {providerTaskId: 'paid-provider-task'}});
  const repository = new PostgresJobQueueRepository(database);
  const input = {workspaceId: ws, jobId, expectedVersion: 9,
    recoveryKey: 'operator-recovery-0001', reason: 'provider reconciliation confirmed safe replay',
    availableAt: at(4_000)};
  const first = await repository.requeueTerminal(input);
  assert.equal(first.requeued, true);
  assert.equal(first.job.state, 'queued');
  assert.equal(first.job.attemptCount, 3);
  assert.equal(first.job.maxAttempts, 4);
  assert.equal(database.steps.some(step => step.step_key === 'provider.submitted'), true);
  const replay = await repository.requeueTerminal(input);
  assert.equal(replay.requeued, false);
  assert.equal(database.job.max_attempts, 4);
  assert.equal(database.steps.filter(step => step.step_key.startsWith('requeue.')).length, 1);
});
