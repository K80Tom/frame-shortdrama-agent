# 领域 Agent 运行时：可恢复执行断点（#136A）

状态：**恢复内核已落地；Worker/API 生产装配与真实领域 Agent 绑定仍在后续 PR。**
适用源码：`feat/resumable-agent-runtime`（基 `4707a52`）；迁移 `053_agent_runtime_checkpoints.sql`。

## 1. 边界

- 本切片只实现 #136A：Attempt 生命周期、Checkpoint、失败注入后的幂等恢复、Outbox 投影与迁移。
- 不新建第二套 Tool Registry、Outbox、Agent 微服务或 Kafka；Agent 事件走既有 `data_outbox_events`。
- 不提供 `agent-runs` HTTP API、前端恢复面板或真实付费工具；这些属于后续独立 PR。
- Run 状态机与 14 态契约不变；恢复链固定为 `running(旧 Attempt) → interrupted → queued → running(新 Attempt)`。

## 2. 权威数据

- `agent_run_attempts`：每次领取一行；旧 Attempt 不覆盖，只追加新 Attempt。
- `agent_runs.current_attempt_id`：指向当前 Attempt；迁移 053 追加格式 CHECK。
- `agent_run_checkpoints`：按 `(workspace_id, run_id, sequence)` 唯一，`pending_invocation_id` 指向尚未确认结果的 Invocation；对 attempt / invocation / run 建 workspace 级外键。
- `agent_events`：新增 `checkpoint` 事件；事件与 Outbox 在同一 PostgreSQL 事务提交，`aggregate_version = agent_events.sequence`。

`agent_context_snapshots` 仍只存可恢复上下文；执行断点不塞进该表。Checkpoint 只保存公开编排状态（轮次、调用索引、工具提案、观察摘要、终态结果），不保存模型隐藏推理。

## 3. 恢复路径

`runResumableAgentToolLoop` 在每次 Tool 调用前写 `before_tool`，结果确认后写 `after_tool`，planner 收束时写 `run_completed`。恢复时按最新 Checkpoint：

1. `run_completed`：直接重放已保存的终态，不调用 planner，不再执行工具。
2. `pending_invocation_id` 存在：先按持久化 Invocation 回读，不信任 Checkpoint 副本，交给 `ToolKernel.recover`：
   - `succeeded`：复用结果并补结算，绝不再次执行；
   - `failed / cancelled / inconclusive / reconciling`：释放预留，复用既有结果或报终态错误；
   - `queued / approved`：正常执行；
   - `running` 且内部只读、具备幂等策略：把旧 Tool Attempt 标为 failed（`AGENT_TOOL_WORKER_INTERRUPTED`），重新排队后执行，同一 Idempotency-Key 保证业务影响最多一次；
   - `running` 且 `external_write / paid_external` 或 `idempotency=none`：不自动重试，写 `inconclusive` 结果并进入 `reconciling`，等待人工对账；
   - `waiting_external`：不重新提交，结果未知时进入对账并保留预留。
3. 没有 pending：按 `round / callIndex / calls` 续跑剩余调用；本轮已全部确认时直接进入下一轮 planner。

审批仍未决定时，恢复保持 `WAITING_CONFIRMATION`，不把“等人”当成失败。

## 4. 并发与重复投递

- Run 领取仍是 version CAS；两个 Worker 并发领取最多一个成功，只有一个 Attempt。
- Checkpoint sequence 由最新已写断点推导，数据库唯一约束拒绝并发重复 sequence；重复投递返回 `AGENT_CHECKPOINT_STALE`。
- Tool Attempt 与 Invocation 使用既有 CAS / 幂等键；恢复只补结算仍为 `reserved` 的预算，重复结算幂等。

## 5. 验证与未完成

- `npm run build` 通过（shared → agent → main → cli → web）。
- `npm --prefix packages/agent test`：35/35，覆盖每次调用前后 Checkpoint、结果落库前崩溃复用、running 恢复、completed 重放、并发领取与新 Attempt。
- `DATABASE_URL=... npm --prefix packages/main run test:db`：34 pass / 1 skip（既有 DB 用例）；053 在全新库与增量库均迁移通过；非超管 `lyra_app` 验证跨 Workspace 读不到 Checkpoint。
- 未完成：生产 Worker 调度器与 HTTP API；真实进程 kill / 租约过期自动回收演练；真实领域 Agent 绑定与付费工具；真实供应商对账。
