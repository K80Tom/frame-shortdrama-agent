# 基础设施 Worker 拓扑：实例租约与异步任务出件箱

本文覆盖 #124（Stage 1 底座 API/Worker/Redis/存储拓扑生产硬化）与本 PR 新增的
基础设施 Outbox 能力：与业务事实同事务提交、由独立 Worker 进程异步消费的
任务出件箱，以及支撑它的实例级租约与崩溃抢占机制。

## 1. 三类异步机制的边界（避免第二套运行时）

| 机制 | 表 / 模块 | 语义 | 归属 |
| --- | --- | --- | --- |
| 领域事件投影 | `data_outbox_events` + `data/*` | DataEventV1/V2 → 投影/checkpoint | #133（既有） |
| 周期调度与长任务 | `jobs` + `jobs/*` | PersistentJobWorker：job 级租约、SKIP LOCKED 领取 | 既有 |
| 基础设施任务出件箱 | `infra_outbox_tasks` + `production/outbox/*` | 与业务事实同事务提交的 Worker 异步任务 | 本模块 |

基础设施 Outbox 不承载领域事件语义，也不替代 jobs；只负责
"业务事务内落一条待消费任务 → Worker 推进 pending → delivering →
delivered / failed / dead_letter 状态机"。

## 2. 实例租约（`worker_leases`，迁移 043）

- PostgreSQL 是租约与 fencing 的权威事实源：`worker_leases` 用部分唯一索引
  `(role) WHERE state='active'` 保证同角色全局最多一个 active 实例。
- Redis 只是快速互斥锁（SET NX PX + Lua compare-owner 续约/释放，
  `runtime/redis-lease.ts`）；Redis 不可用时自动降级为纯 PostgreSQL CAS，
  不损失正确性。连接仅在校验过的 `REDIS_URL`（含 `REDIS_HOST_ALLOWLIST`）上建立。
- 崩溃抢占：新实例只有在旧 active 租约过期后才能接管，接管时旧行置
  `preempted`、新行 `fencing_token = 旧行 + 1`；旧实例此后的一切续约与写入
  都会被状态/fencing 校验拒绝（`LEASE_PREEMPTED` / `OUTBOX_TASK_CONFLICT`）。
- `worker_lease_events` 保留 acquired/renewed/released/preempted 完整证据链。
- 心跳默认 `leaseMs/3`（`LYRA_WORKER_LEASE_MS` 默认 30000，可用
  `LYRA_WORKER_HEARTBEAT_MS` 覆盖）；租约丢失时 WorkerRuntime 中止全部任务，
  专用 worker 进程会退出并等待编排层重启接管。
- 平台表不携带 workspace_id：仅审计系统作用域可读写，租户连接被 FORCE RLS 拒绝。

## 3. 任务出件箱（`infra_outbox_*`，迁移 042）

- 业务代码在自身事务内通过 `appendWithClient(client, …)` 落任务
  （UNIQUE(workspace_id, idempotency_key) 幂等）；HTTP 提交走
  `POST /api/runtime/outbox/tasks`（类型白名单 + 租户作用域）。
- 消费（`OutboxTaskConsumer`，每轮 pollOnce）：
  1. 系统作用域领取：先回收过期 `delivering` 租约（崩溃恢复），再
     `SELECT … FOR UPDATE SKIP LOCKED` 原子领取，`fencing_token + 1`；
  2. 逐条进入任务工作区租户作用域（复用 `PostgresJobTenantResolver`）：
     消费者记录已存在 → 幂等跳过；否则执行 handler；
  3. 同租户事务完成投递：条件 UPDATE（state/lease_owner/fencing 三重校验）
     + `infra_outbox_consumer_records` 幂等写入；失败按指数退避重试
     （`LYRA_OUTBOX_RETRY_BASE_MS`），次数用尽进入 `dead_letter`。
- 投递语义 at-least-once：handler 副作用必须幂等，消费者记录
  `(consumer_name, task_id)` 是去重与审计证据。
- 重放：`requeueForReplay` 登记 `infra_outbox_replay_runs`（发起人/原因/
  过滤条件/统计）后把 failed/dead_letter/delivered 推回 pending；重放已应用
  的任务由消费者记录命中自动跳过副作用。

## 4. 统一存储驱动（`storage/*`）

- `OBJECT_STORAGE_*` 环境变量驱动：`PROVIDER/BUCKET/ENDPOINT/REGION/
  ACCESS_KEY/SECRET_KEY/PREFIX/LOCAL_ROOT`，厂商画像
  （`storage/profiles.ts`）补齐 endpoint 模板、path-style、region 默认值，
  支持 `local / memory / minio / s3 / oss / cos / qiniu_kodo / ctyun_zos /
  generic_s3`（含旧别名归一）。
- 所有 key 强制位于 `.lyra-driver/` 托管前缀内，驱动层拒绝路径穿越与
  符号链接逃逸；本地驱动先写临时文件再原子 rename。
- 与应用侧 `infrastructure/object-storage` 端口互补：业务对象仍走既有
  ObjectStorage；本驱动服务 Worker 拓扑（如 staging GC）。

## 5. 部署与验收

- 独立进程：`LYRA_RUNTIME_ROLE=api` / `worker`（`deploy/compose.yaml` 已有
  `main-api` / `main-worker` 两个服务）；Worker 启动即领取实例租约，
  同角色已有存活实例时快速失败，避免双实例并发消费。
- CLI 验收：

```sh
npm run cli -- outbox submit --type runtime.smoke --message hello
npm run cli -- outbox status <taskId>   # 等待 state: delivered
```

- 环境变量：`LYRA_OUTBOX_BATCH_SIZE`（1-200，默认 20）、
  `LYRA_OUTBOX_POLL_MS`（50-60000，默认 750）、
  `LYRA_OUTBOX_RETRY_BASE_MS`（100-300000，默认 2000）、
  `LYRA_OUTBOX_MAX_ATTEMPTS`（1-100，默认 5）、
  `LYRA_WORKER_LEASE_MS`（5000-3600000，默认 30000）、
  `LYRA_WORKER_HEARTBEAT_MS`（可选）。
- 测试：`npm --prefix packages/main test`（单测全内存/桩存储，含崩溃恢复与
  租约续期）；`npm --prefix packages/main run test:db`（真实 PostgreSQL，
  需 `DATABASE_URL`，含 RLS 隔离与迁移对象断言）。
