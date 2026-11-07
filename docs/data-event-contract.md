# DataEventV1 与统一事务 Outbox 契约

状态：**基础实现已落地；Stage 1 多租户生产化待实现**。迁移 024、事务 Outbox、生产状态接入、Dispatcher、Projector、Checkpoint、死信/隔离与范围重放组件均已有代码和测试，但 Dispatcher 尚未接入独立常驻运行时；本文同时约束后续 `workspace_id` 兼容升级。

契约版本：`lyra.data.event/v1`；共享实现：`packages/shared/src/data-event.ts`；数据库迁移：`packages/main/migrations/024_data_event_outbox.sql`；测试入口：`packages/main/tests/data-event-contract.test.cjs`、`data-outbox-*.test.cjs`、`data-pipeline.test.cjs` 与 `data-projection.db.test.cjs`。

数据域、命名、敏感级别和保留期沿用 [数据治理 ADR](../packages/main/docs/adr/0001-data-domain-governance.md) 与 [机器可读目录](../packages/main/contracts/data-governance/catalog-v1.json)。事件敏感级别上限为 `internal`。

## 1. DataEventV1 示例

```json
{
  "eventId": "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "eventType": "production.run.succeeded",
  "schemaVersion": "lyra.data.event/v1",
  "aggregateType": "production_run",
  "aggregateId": "run_001",
  "aggregateVersion": 3,
  "occurredAt": "2026-11-03T00:00:00.000Z",
  "recordedAt": "2026-11-03T00:00:01.000Z",
  "correlationId": "corr_0001",
  "causationId": "evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "idempotencyKey": "production_run:run_001:3:production.run.succeeded",
  "authoritativeRef": {
    "kind": "production_run",
    "id": "run_001",
    "revisionId": "production_run:run_001:v3",
    "digest": "<run revision digest, 64 hex>"
  },
  "payload": { "status": "completed", "attemptCount": 1, "costMicros": 0 }
}
```

字段约束：

| 字段 | 约束 |
|---|---|
| `eventId` | `evt_` + 32 位小写 hex；全局唯一，不可变 |
| `eventType` | `<domain>.<aggregate>.<event_name>`，恰好 3 段小写 snake_case |
| `schemaVersion` | 当前构造器固定为 `lyra.data.event/v1`；后续版本必须显式新增契约，不能原地改 V1 |
| `aggregateType` | `novel_chapter` / `script` / `asset` / `production_run` / `production_attempt` / `external_operation` / `quality_check` / `delivery_artifact` / `evaluation_run` |
| `aggregateId` | 权威聚合的稳定 ID，不是显示名 |
| `aggregateVersion` | 单聚合内单调正整数；当前数据库约束同一聚合版本只能对应一个事件 |
| `occurredAt` | 业务事实发生时间，UTC ISO 8601 |
| `recordedAt` | 事实被记录/写入 Outbox 的时间，UTC；不得早于 `occurredAt` |
| `correlationId` | 跨事件关联 ID |
| `causationId` | 直接上游 `eventId`，没有则 `null` |
| `idempotencyKey` | 写入方生成，推荐 `dataEventIdempotencyKey(...)`；当前数据库不以它作为唯一约束 |
| `authoritativeRef` | 权威来源 `kind/id/revisionId/digest`；只存引用与摘要，不存正文 |
| `payload` | 只允许一层标量/标量数组，≤24 字段、≤4096 字节；只放投影必需的最小字段 |

`dataEventDigest` 覆盖全部业务字段；`publishedAt`、`attempts`、`lastError` 等投递状态不进入摘要。

## 2. 敏感字段黑名单

与 #48 目录 `forbiddenEventFields` 对齐，并在校验层额外覆盖常见凭据字段：

`rawText`、`quote`、`sourceIndex`、`promptSnapshot`、`content`、`mediaBytes`、`apiKey`、`token`、`authorization`、`providerResponse`、`signedUrl`、`absolutePath`、`secret`、`password`、`credential`、`headers`、`cookie`、`privateKey`、`binary`、`rawResponse`。

同时拒绝：私钥块、`Bearer` token、`sk-` 密钥、`data:*;base64` 媒体、带签名的 URL、用户绝对路径；payload 不允许嵌套对象，避免把原始响应塞进事件。

## 3. 统一事务 Outbox

### 已落地表结构（迁移 024）

`data_outbox_events`：

- `outbox_id` PK（`obox_` + 32 hex）
- `event_id` UNIQUE；`event_type`、`schema_version`
- `aggregate_type`、`aggregate_id`、`aggregate_version`
- `occurred_at`、`recorded_at`
- `correlation_id`、`causation_id`、`idempotency_key`
- `authoritative_ref_json`、`payload_json`、`event_digest`
- `legacy_source`、`legacy_event_id`（仅迁移行；UNIQUE `(legacy_source, legacy_event_id)`）
- `status`（`pending` / `published` / `failed` / `dead_letter`）、`attempts`、`available_at`、`published_at`、`last_error`、`created_at`
- UNIQUE `(event_id)`、`(aggregate_type, aggregate_id, aggregate_version)`、`(legacy_source, legacy_event_id)`
- 索引 `(available_at, occurred_at) WHERE status IN ('pending', 'failed')` 供 Dispatcher 扫描

迁移同时建立 `data_consumer_records`、`data_projection_records`、`data_consumer_checkpoints`、`data_dead_letters` 与 `data_quarantine_records`。`PostgresProjectionStore` 保证投影、已处理记录与 checkpoint 在同一事务提交。

### 事务边界（硬约束）

业务事实与 Outbox 事件必须在同一 `PoolClient` / 同一数据库事务提交：

```ts
await database.transaction(async client => {
  await client.query('INSERT INTO <business_table> ...');
  await appendDataEvent(client, event); // 只 INSERT，不 BEGIN/COMMIT
});
```

- `appendDataEvent(client, event)` 在类型和调用边界上显式要求 `PoolClient`；业务代码应通过现有事务或 `DataOutbox.transaction()` 获取它，不得传普通连接替代事务 client。
- 禁止“先提交业务数据，再另起事务写事件”，也禁止在 repository 内再嵌套 `database.transaction()`。
- 业务写入回滚时事件一起回滚，不留孤立事件。
- `packages/main/src/production/repository.ts` 的 create/replace 已在写 `production_runs` 的同一事务中追加统一 Outbox，新生产写入不再双写旧表。
- 新业务只写 `data_outbox_events`；旧 `production_outbox_events` 仅作为历史迁移来源保留。禁止重新引入长期双写。

### Stage 1 计划接入清单

当前只有 `production_run` 状态事件已接入统一 Outbox；其余聚合类型是后续接入要求，不得描述为现有写入链路。

| 业务事实 | aggregateType | 写入要求 |
|---|---|---|
| 章节修订 | `novel_chapter` | revision 写入与事件同事务；引用章节 revision ID + digest |
| 剧本 | `script` | 剧本版本写入与事件同事务 |
| 资产 | `asset` | 资产登记/状态变化与事件同事务 |
| 生产任务 | `production_run` | `production_runs` 状态流转与事件同事务 |
| 生产 attempt | `production_attempt` | attempt 创建/终态与事件同事务 |
| 外部操作 | `external_operation` | 外部请求登记/结论与事件同事务；只存引用，不存原始响应 |
| 质量检查 | `quality_check` | 检查结论与事件同事务；指标带 `method`/`ruleVersion`/范围 |
| 交付产物 | `delivery_artifact` | 交付记录与事件同事务；只存产物引用/摘要 |

不得只接新模块而漏掉现有生产状态流转；`production/repository.ts` 的 create/replace 两条路径都要覆盖。

## 4. Legacy `production_outbox_events` 迁移方案

`packages/main/migrations/015_production_orchestration.sql` 的 `production_outbox_events` 有 `id`、`run_id`、`sequence`、`event_type`、`payload_json`、`created_at`、`delivered_at`。`packages/main/src/data/legacy.ts` 已提供可重入映射，不修改旧表。

映射规则（显式 Legacy Schema，禁止猜业务语义）：

- `legacy_source = 'production_outbox_events'`，`legacy_event_id = old.id`。
- 新 `eventId = 'evt_' + sha256('production_outbox_events:' + old.id).slice(0, 32)`，确定性生成；重复执行不会产生第二个事件。
- `aggregateType = 'production_run'`，`aggregateId = old.run_id`，`aggregateVersion = old.sequence`。旧 sequence 是 run 内事件序号，映射后承担 Legacy 事件版本。
- `occurredAt = recordedAt = old.created_at`；旧数据无法区分发生/记录时间，二者同值，未知保持未知。
- `schemaVersion` 仍为 `lyra.data.event/v1`；`eventType` 保留旧值并通过当前 V1 校验。
- `payload` 先按字段名、形状和长度保留浅层标量/标量数组，再由 V1 对整个事件校验；如仍含敏感字段或敏感值，映射会被拒绝。没有可保留字段或事件为 `production.run.operations_reconciled` 时补 `legacySequence`。
- `authoritativeRef.kind = 'production_outbox_event'`，`id = old.id`；摘要覆盖旧行 ID、run、sequence、event type、payload 与时间字段。
- `delivered_at` 映射为 `published` / `pending` 和 `published_at`；历史投递次数未知，因此 `attempts` 保持 `0`。
- 旧表迁移后不再作为新写源，新 Dispatcher 只读 `data_outbox_events`；当前尚未施加数据库级只读保护。旧事件不能重复投影：`event_id` 唯一 + `(legacy_source, legacy_event_id)` 唯一 + 消费者 `(consumerName, eventId)` 处理记录三重保护。

当前迁移在一个事务中按 `created_at, id` 遍历旧行，使用 `legacy_source + legacy_event_id` 跳过已迁移记录，并核对旧表当前行数与映射数。迁移和投影测试覆盖可重入、计数、版本、交付状态与消费者去重。大数据量环境在执行前仍需补充分批游标、旧表数据库级只读保护与对应回滚演练；这些不能被文档误写成现有保障。

## 5. 错误码

校验层：`DATA_EVENT_INPUT_INVALID`、`DATA_EVENT_SENSITIVE_FIELD`、`DATA_EVENT_PAYLOAD_TOO_LARGE`、`DATA_EVENT_DIGEST_MISMATCH`。
事务 Outbox 层：`DATA_OUTBOX_TRANSACTION_REQUIRED`、`DATA_OUTBOX_DUPLICATE_EVENT`、`DATA_OUTBOX_AGGREGATE_VERSION_CONFLICT`、`DATA_OUTBOX_NOT_FOUND`。
Legacy 层：`DATA_OUTBOX_LEGACY_DUPLICATE`、`DATA_OUTBOX_LEGACY_COUNT_MISMATCH`。

## 6. 当前 Dispatcher、投影与重放边界

- `DataDispatcher` 已支持批量扫描、指数退避、最大尝试次数与 dead-letter 状态；`DataProjector` 已支持幂等、单聚合版本检查、未知 schema 隔离和原子 checkpoint。
- `DataReplayService` 已支持按时间、聚合和事件类型范围重放，以及不写任何状态的 dry-run；重放使用独立消费者命名空间，不推进线上 checkpoint。
- 消费者不得回写业务状态；事件不携带原始媒体、全文、密钥、令牌或完整供应商响应。
- 当前这些组件是可复用底座，尚未由主应用注册为持续运行的 Dispatcher 循环；独立 Worker/Dispatcher 进程、租户隔离与生产运维仍属于 Stage 1 实现工作。Dispatcher 达到最大尝试次数时会把 Outbox 行标为 `dead_letter`，当前不会同步写 `data_dead_letters` 消费者表。

## 7. Stage 1 多租户兼容规则

1. `DataEventV1` 没有 `workspaceId`。不得给 V1 原地加字段或改变 `dataEventDigest`，否则历史事件会失去可验证性。
2. 新建 `DataEventV2`（或等价的版本化租户 envelope），把顶层 `workspaceId` 纳入摘要与校验；Dispatcher 和消费者在历史 V1 仍可重放期间持续双读 V1/V2，除非历史事件已完成可核验迁移或归档。
3. Outbox 通过新增可空列/映射表把历史 V1 归到明确的默认 workspace，不改旧 payload、事件摘要或事件 ID；完成回填和核对后再收紧约束。
4. 消费者命名空间、checkpoint、去重键与投影记录都必须包含租户作用域。Redis、Milvus、通知及需要异步同步的对象元数据统一消费 PostgreSQL Outbox，业务请求不得跨存储直接双写；媒体字节仍通过 `ObjectStorage` 端口或受控签名 URL 传输，并由 `main` 验真。

## 8. 与 EvaluationRun、Kafka 的关系

- `evaluation_run_events` 是单次评测运行的 append-only 领域历史，不是第二套跨存储 Outbox。需要向 Redis、Milvus、通知或分析投影时，应在同一 PostgreSQL 事务追加统一 `data_outbox_events`；当前适配尚未接入。
- Stage 1 不接 Kafka。Stage 3 如达到多消费者和长期回放触发条件，由 Outbox Relay 发布到 Kafka；Kafka 可以承载终态事件，但不是媒体字节或任务最终状态的权威存储，PostgreSQL 仍是业务事实源。
