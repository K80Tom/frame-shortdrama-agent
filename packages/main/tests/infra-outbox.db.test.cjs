const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Client: PgClient } = require('pg');

if (!process.env.DATABASE_URL) {
  test('Infra outbox PostgreSQL integration requires DATABASE_URL', { skip: 'Set DATABASE_URL before test:db.' }, () => {});
} else {
  const { PostgresDatabase } = require('../dist/db/client');
  const { PostgresOutboxTaskStore } = require('../dist/production/outbox/repository');
  const { PostgresWorkerLeaseStore } = require('../dist/runtime/postgres-lease-store');
  const { PostgresJobTenantResolver } = require('../dist/jobs/tenant');

  const connectionString = process.env.DATABASE_URL;
  // 独立清理连接：不与被测 PostgresDatabase 共享池，避免 after 钩子顺序导致 pool 已关闭。
  const cleanupWithClient = async work => {
    const client = new PgClient({ connectionString });
    await client.connect();
    try {
      // 清理走系统作用域（会话级）：否则 RLS 会静默过滤 DELETE 导致外键清理失败。
      await client.query("SELECT set_config('lyra.system_bypass', 'on', false)");
      await work(client);
    } finally { await client.end(); }
  };
  const token = () => randomBytes(16).toString('hex');
  const OWNED_TABLES = [
    'infra_outbox_tasks', 'infra_outbox_consumer_records', 'infra_outbox_replay_runs',
    'worker_leases', 'worker_lease_events',
  ];

  test('037/038 迁移对象、RLS 与租约/出件箱全链路', async t => {
    const database = new PostgresDatabase({ connectionString });
    t.after(async () => {
      await database.close();
    });
    await database.verifyConnection();
    assert.equal(await database.hasMigrations(['037', '038']), true, 'Run npm run db:migrate before test:db.');
    const currentRole = await database.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    if (currentRole.rows[0]?.rolsuper) {
      // 超级用户绕过 RLS，跨租户隔离断言必然失真：本测试必须以非超级用户角色运行
      // （例如本地创建的 lyra_app，NOSUPERUSER NOBYPASSRLS + 全表 DML 授权）。
      t.skip('RLS 隔离断言需要非超级用户 DATABASE_URL（超级用户会绕过 RLS）。');
      return;
    }

    const suffix = token();
    const userId = `usr_${suffix}`;
    const workspaceId = `ws_${suffix}`;
    const now = new Date().toISOString();
    await database.transaction(async client => {
      await client.query(`
        INSERT INTO users (id, subject, display_name, kind, status, created_at, updated_at)
        VALUES ($1, $2, 'Infra outbox db test', 'human', 'active', $3, $3)
      `, [userId, `test:${suffix}`, now]);
      await client.query(`
        INSERT INTO workspaces (id, slug, name, status, created_by_user_id, created_at, updated_at)
        VALUES ($1, $2, 'Infra outbox db test', 'active', $3, $4, $4)
      `, [workspaceId, `test-${suffix}`, userId, now]);
      await client.query(`
        INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
        VALUES ($1, $2, 'owner', 'active', $3, $3)
      `, [workspaceId, userId, now]);
    });
    t.after(async () => {
      await cleanupWithClient(async client => {
        await client.query('DELETE FROM infra_outbox_consumer_records WHERE workspace_id = $1', [workspaceId]);
        await client.query('DELETE FROM infra_outbox_tasks WHERE workspace_id = $1', [workspaceId]);
        await client.query('DELETE FROM infra_outbox_replay_runs WHERE workspace_id = $1', [workspaceId]);
        await client.query('DELETE FROM worker_leases WHERE owner_instance_id = ANY($1::text[])', [leaseOwners]);
        await client.query('DELETE FROM worker_lease_events WHERE owner_instance_id = ANY($1::text[])', [leaseOwners]);
        await client.query('DELETE FROM workspace_members WHERE workspace_id = $1', [workspaceId]);
        await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
        await client.query('DELETE FROM users WHERE id = $1', [userId]);
      });
    });
    const leaseOwners = [];

    // 1) 本迁移自有对象清单：表结构与 RLS 强制开启。
    const objects = await database.query(`
      SELECT c.relname AS table_name,
             COALESCE((SELECT array_agg(a.attname ORDER BY a.attname)
               FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '{}') AS columns,
             c.relrowsecurity AS rls_enabled,
             c.relforcerowsecurity AS rls_forced,
             (SELECT count(*) FROM pg_trigger tg WHERE tg.tgrelid = c.oid AND NOT tg.tgisinternal) AS trigger_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
    `, [OWNED_TABLES]);
    const byName = new Map(objects.rows.map(row => [row.table_name, row]));
    assert.deepEqual([...byName.keys()].sort(), [...OWNED_TABLES].sort());
    for (const table of OWNED_TABLES) {
      const row = byName.get(table);
      assert.equal(row.rls_enabled, true, `${table} 必须启用 RLS`);
      assert.equal(row.rls_forced, true, `${table} 必须 FORCE RLS`);
    }
    for (const column of ['task_id', 'workspace_id', 'task_type', 'state', 'fencing_token', 'idempotency_key']) {
      assert.ok(byName.get('infra_outbox_tasks').columns.includes(column));
    }
    for (const column of ['owner_instance_id', 'role', 'fencing_token', 'lease_expires_at']) {
      assert.ok(byName.get('worker_leases').columns.includes(column));
    }
    assert.equal(Number(byName.get('worker_leases').trigger_count), 0, '平台租约表不挂 workspace 守卫');
    assert.ok(Number(byName.get('infra_outbox_tasks').trigger_count) >= 1, '任务表必须挂租户守卫触发器');

    const store = new PostgresOutboxTaskStore(database);
    const resolver = new PostgresJobTenantResolver(database);
    const tenant = await resolver.resolve(workspaceId, `outbox:${suffix}`);

    // 2) 追加与幂等键去重（同工作区唯一）。
    const task = await store.append({
      taskType: 'runtime.smoke', idempotencyKey: `db-outbox-${suffix.slice(0, 8)}`,
      payload: { message: 'pg' }, workspaceId, availableAt: now,
    });
    assert.match(task.taskId, /^iobx_[a-f0-9]{32}$/);
    const duplicate = await store.append({
      taskType: 'runtime.smoke', idempotencyKey: `db-outbox-${suffix.slice(0, 8)}`,
      payload: { message: 'pg' }, workspaceId,
    });
    assert.equal(duplicate.taskId, task.taskId);
    await assert.rejects(() => database.transaction(async client => {
      await store.appendWithClient(client, {
        taskType: 'runtime.smoke', idempotencyKey: 'short', payload: {}, workspaceId,
      });
    }));

    // 3) 领取（系统作用域内部）→ 租户作用域完成投递 + 消费者记录。
    const claimed = await store.claimBatch({
      workerId: `wkri_${suffix}`, batchSize: 10, leaseMs: 30_000, now,
    });
    const claimedTask = claimed.find(item => item.taskId === task.taskId);
    assert.ok(claimedTask, '任务必须被领取');
    assert.equal(claimedTask.state, 'delivering');
    assert.equal(claimedTask.fencingToken, 1);
    const delivered = await database.runWithTenant(tenant, () => store.completeDelivery({
      taskId: task.taskId, workspaceId, consumerName: 'main-worker',
      workerId: `wkri_${suffix}`, fencingToken: 1, result: { echo: 'pg' }, now,
    }));
    assert.equal(delivered, 'delivered');
    const record = await database.runWithTenant(tenant, () => store.getConsumerRecord({
      consumerName: 'main-worker', taskId: task.taskId,
    }));
    assert.equal(record.result.echo, 'pg');

    // 4) RLS 隔离：其他 workspace 的租户作用域看不到该任务。
    const otherTenant = { userId, workspaceId: `ws_${token()}`, role: 'owner', requestId: 'worker:other' };
    const crossTenant = await database.runWithTenant(otherTenant, () =>
      store.getTask({ taskId: task.taskId }));
    assert.equal(crossTenant, null, '跨租户读取必须被 RLS 过滤');
    await assert.rejects(() => database.runWithTenant(otherTenant, () => store.completeDelivery({
      taskId: task.taskId, workspaceId, consumerName: 'main-worker',
      workerId: `wkri_${suffix}`, fencingToken: 1, result: {},
    })), error => error.code === 'OUTBOX_TASK_NOT_FOUND');

    // 5) 失败退避与死信（领取时间必须晚于退避后的 available_at）。
    const retryTask = await store.append({
      taskType: 'storage.staging_gc', idempotencyKey: `db-retry-${suffix.slice(0, 8)}`,
      payload: {}, workspaceId, availableAt: now, maxAttempts: 3,
    });
    await store.claimBatch({ workerId: `wkri_${suffix}`, batchSize: 10, leaseMs: 30_000, now });
    let current = await database.runWithTenant(tenant, () => store.markFailed({
      taskId: retryTask.taskId, workspaceId, workerId: `wkri_${suffix}`,
      fencingToken: 1, message: 'boom', retryBaseMs: 1000, now,
    }));
    assert.equal(current.state, 'failed');
    assert.equal(current.attempts, 1);
    current = await database.runWithTenant(tenant, () => store.markFailed({
      taskId: retryTask.taskId, workspaceId, workerId: `wkri_${suffix}`,
      fencingToken: Number.MAX_SAFE_INTEGER, message: 'stale', retryBaseMs: 1000, now,
    })).catch(error => error);
    assert.equal(current.code, 'OUTBOX_TASK_CONFLICT', 'fencing 不符的失败登记必须被拒绝');
    // dead_letter：重新领取两次并失败（第 2/3 次退避分别为 2s/4s）。
    const retryClock = [new Date(Date.parse(now) + 3_000).toISOString(),
      new Date(Date.parse(now) + 8_000).toISOString()];
    for (let round = 0; round < 2; round += 1) {
      const next = await store.claimBatch({ workerId: `wkri_${suffix}`, batchSize: 10, leaseMs: 30_000, now: retryClock[round] });
      const match = next.find(item => item.taskId === retryTask.taskId);
      assert.ok(match, `第 ${round + 2} 次领取必须命中重试任务`);
      await database.runWithTenant(tenant, () => store.markFailed({
        taskId: retryTask.taskId, workspaceId, workerId: `wkri_${suffix}`,
        fencingToken: match.fencingToken, message: 'boom again', retryBaseMs: 1000, now: retryClock[round],
      }));
    }
    const dead = await store.getTask({ taskId: retryTask.taskId });
    assert.equal(dead.state, 'dead_letter');
    assert.equal(dead.attempts, 3);

    // 6) 崩溃恢复：delivering 租约过期后回收为 pending。
    const crashTask = await store.append({
      taskType: 'runtime.smoke', idempotencyKey: `db-crash-${suffix.slice(0, 8)}`,
      payload: {}, workspaceId,
    });
    await store.claimBatch({ workerId: `wkri_${suffix}`, batchSize: 10, leaseMs: 30_000, now: retryClock[1] });
    const recovered = await store.recoverExpiredLeases({
      now: new Date(Date.parse(retryClock[1]) + 60_000).toISOString(),
    });
    assert.ok(recovered >= 1, '至少回收本用例的过期租约');
    const recoveredTask = await store.getTask({ taskId: crashTask.taskId });
    assert.equal(recoveredTask.state, 'pending');
    assert.equal(recoveredTask.leaseOwner, null);

    // 7) 范围重放登记 + delivered/failed 推回 pending。
    const replay = await store.requeueForReplay({
      replayId: `rply_${suffix}`, requestedBy: 'db-test', reason: '演练范围重放',
      workspaceId, now,
    });
    assert.ok(replay.scanned >= 2, 'delivered 与 dead_letter 任务都必须进入重放范围');
    assert.equal(replay.requeued, replay.scanned);
    const replayRun = await store.getReplayRun({ replayId: `rply_${suffix}` });
    assert.equal(replayRun.requestedBy, 'db-test');
    const replayedTask = await store.getTask({ taskId: task.taskId });
    assert.equal(replayedTask.state, 'pending');
    // 重放后重新消费：消费者记录命中 → 幂等跳过。
    const reClaimed = await store.claimBatch({ workerId: `wkri_${suffix}`, batchSize: 10, leaseMs: 30_000, now });
    const reClaimedTask = reClaimed.find(item => item.taskId === task.taskId);
    assert.ok(reClaimedTask);
    const skipped = await database.runWithTenant(tenant, () => store.completeDelivery({
      taskId: task.taskId, workspaceId, consumerName: 'main-worker',
      workerId: `wkri_${suffix}`, fencingToken: reClaimedTask.fencingToken,
      result: { skipped: true }, now,
    }));
    assert.equal(skipped, 'delivered');

    // 8) 实例租约：互斥、过期抢占 fencing+1、事件链、平台 RLS。
    const leaseStore = new PostgresWorkerLeaseStore(database);
    const ownerA = `wkri_${suffix}`;
    const ownerB = `wkri_${token()}`;
    leaseOwners.push(ownerA, ownerB);
    const acquired = await leaseStore.acquire({ ownerInstanceId: ownerA, role: 'worker', leaseMs: 30_000, now });
    assert.equal(acquired.fencingToken, 1);
    assert.equal(await leaseStore.acquire({ ownerInstanceId: ownerB, role: 'worker', leaseMs: 30_000, now }), null);
    const renewed = await leaseStore.renew({ ownerInstanceId: ownerA, role: 'worker', leaseMs: 30_000, now });
    assert.equal(renewed.fencingToken, 1);
    const takeover = await leaseStore.acquire({
      ownerInstanceId: ownerB, role: 'worker', leaseMs: 30_000,
      now: new Date(Date.parse(now) + 31_000).toISOString(),
    });
    assert.equal(takeover.fencingToken, 2);
    await assert.rejects(() => leaseStore.renew({
      ownerInstanceId: ownerA, role: 'worker', leaseMs: 30_000,
      now: new Date(Date.parse(now) + 32_000).toISOString(),
    }), error => error.code === 'LEASE_PREEMPTED');
    await leaseStore.release({ ownerInstanceId: ownerB, role: 'worker', now: new Date(Date.parse(now) + 33_000).toISOString() });
    const events = await leaseStore.events('worker', 10);
    assert.deepEqual(events.map(event => event.eventType).reverse(),
      ['acquired', 'renewed', 'preempted', 'acquired', 'released']);
    const tenantLeaseRows = await database.runWithTenant(tenant, () =>
      database.query('SELECT * FROM worker_leases'));
    assert.equal(tenantLeaseRows.rowCount, 0, '平台租约表对租户作用域必须不可见');
    assert.equal(await leaseStore.activeLease('worker', new Date(Date.parse(now) + 34_000).toISOString()), null);
  });

  test('037 迁移约束：delivering 必须携带租约、delivered 必须携带时间戳', async t => {
    const database = new PostgresDatabase({ connectionString });
    t.after(() => database.close());
    await database.verifyConnection();
    const suffix = token();
    const userId = `usr_${suffix}`;
    const workspaceId = `ws_${suffix}`;
    const now = new Date().toISOString();
    await database.transaction(async client => {
      await client.query(`
        INSERT INTO users (id, subject, display_name, kind, status, created_at, updated_at)
        VALUES ($1, $2, 'Constraint db test', 'human', 'active', $3, $3)
      `, [userId, `test:${suffix}`, now]);
      await client.query(`
        INSERT INTO workspaces (id, slug, name, status, created_by_user_id, created_at, updated_at)
        VALUES ($1, $2, 'Constraint db test', 'active', $3, $4, $4)
      `, [workspaceId, `test-${suffix}`, userId, now]);
    });
    t.after(async () => {
      await cleanupWithClient(async client => {
        await client.query('DELETE FROM infra_outbox_tasks WHERE workspace_id = $1', [workspaceId]);
        await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
        await client.query('DELETE FROM users WHERE id = $1', [userId]);
      });
    });
    const store = new PostgresOutboxTaskStore(database);
    const task = await store.append({
      taskType: 'runtime.smoke', idempotencyKey: `constraint-${suffix.slice(0, 8)}`,
      payload: {}, workspaceId,
    });
    await assert.rejects(() => database.query(`
      UPDATE infra_outbox_tasks SET state = 'delivering' WHERE task_id = $1
    `, [task.taskId]), error => error.code === '23514', 'delivering 缺租约必须违反 CHECK');
    await assert.rejects(() => database.query(`
      UPDATE infra_outbox_tasks SET state = 'delivered' WHERE task_id = $1
    `, [task.taskId]), error => error.code === '23514', 'delivered 缺时间戳必须违反 CHECK');
  });
}
