# DataEventV1 与统一事务 Outbox 设计（#49 第一阶段）

状态：**Proposed**，等待契约评审。本文只冻结事件契约、Outbox 边界与 Legacy 迁移方案，不代表 Dispatcher/Projector 已实现。
契约版本：`lyra.data.event/v1`；共享实现：`packages/shared/src/data-event.ts`；测试：`packages/main/tests/data-event-contract.test.cjs`。

依赖口径：`#48` 的 ADR `packages/main/docs/adr/0001-data-domain-governance.md`（`lyra-data-governance/1`，当前 `Proposed`）与目录 `packages/main/contracts/data-governance/catalog-v1.json`。本文不另造数据域、命名、敏感级别或保留期；关闭 #49 前 #48 必须先合入。事件敏感级别上限沿用目录的 `eventSensitivityCeiling: "internal"`。

## 1. DataEventV1 示例

```json
{
  "eventId": "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "eventType": "production.run.succeeded",
  "schemaVersion": "lyra.production.run/v1",
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
| `schemaVersion` | `lyra.<domain>.<fact>/v<major>`，如 `lyra.production.run/v1` |
| `aggregateType` | `novel_chapter` / `script` / `asset` / `production_run` / `production_attempt` / `external_operation` / `quality_check` / `delivery_artifact`（评测适配器后续再加 `evaluation_run`） |
| `aggregateId` | 权威聚合的稳定 ID，不是显示名 |
| `aggregateVersion` | 单聚合内单调正整数；同一版本 + 事件类型唯一 |
| `occurredAt` | 业务事实发生时间，UTC ISO 8601 |
| `recordedAt` | 事实被记录/写入 Outbox 的时间，UTC；不得早于 `occurredAt` |
| `correlationId` | 跨事件关联 ID |
| `causationId` | 直接上游 `eventId`，没有则 `null` |
| `idempotencyKey` | 写入方生成，推荐 `dataEventIdempotencyKey(...)` |
| `authoritativeRef` | 权威来源 `kind/id/revisionId/digest`；只存引用与摘要，不存正文 |
| `payload` | 只允许一层标量/标量数组，≤24 字段、≤4096 字节；只放投影必需的最小字段 |

`dataEventDigest` 覆盖全部业务字段；`publishedAt`、`attempts`、`lastError` 等投递状态不进入摘要。

## 2. 敏感字段黑名单

与 #48 目录 `forbiddenEventFields` 对齐，并在校验层额外覆盖常见凭据字段：

`rawText`、`quote`、`sourceIndex`、`promptSnapshot`、`content`、`mediaBytes`、`apiKey`、`token`、`authorization`、`providerResponse`、`signedUrl`、`absolutePath`、`secret`、`password`、`credential`、`headers`、`cookie`、`privateKey`、`binary`、`rawResponse`。

同时拒绝：私钥块、`Bearer` token、`sk-` 密钥、`data:*;base64` 媒体、带签名的 URL、用户绝对路径；payload 不允许嵌套对象，避免把原始响应塞进事件。

## 3. 统一事务 Outbox

### 表结构（建议，迁移编号由协调人分配）

`data_outbox_events`：

- `outbox_id` PK（`obox_` + 32 hex）
- `event_id` UNIQUE；`event_type`、`schema_version`
- `aggregate_type`、`aggregate_id`、`aggregate_version`
- `occurred_at`、`recorded_at`
- `correlation_id`、`causation_id`、`idempotency_key` UNIQUE
- `authoritative_ref_json`、`payload_json`、`event_digest`
- `legacy_source`、`legacy_event_id`（仅迁移行；UNIQUE `(legacy_source, legacy_event_id)`）
- `published_at`、`publish_attempts`、`last_error`
- UNIQUE `(aggregate_type, aggregate_id, aggregate_version, event_type)`，禁止同一事实重复版本
- 索引 `(published_at, occurred_at, outbox_id) WHERE published_at IS NULL` 供 Dispatcher 扫描

`data_consumer_checkpoints` 与投影表由 D 阶段实现，本阶段只冻结命名空间规则。

### 事务边界（硬约束）

业务事实与 Outbox 事件必须在同一 `PoolClient` / 同一数据库事务提交：

```ts
await database.transaction(async client => {
  await client.query('INSERT INTO <business_table> ...');
  await appendDataEvent(client, event); // 只 INSERT，不 BEGIN/COMMIT
});
```

- `appendDataEvent(client, event)` 必须显式接收 `PoolClient`；没有 client 直接报 `DATA_OUTBOX_TRANSACTION_REQUIRED`。
- 禁止“先提交业务数据，再另起事务写事件”，也禁止在 repository 内再嵌套 `database.transaction()`。
- 业务写入回滚时事件一起回滚，不留孤立事件。
- 现有 `packages/main/src/production/repository.ts` 的 create/replace 是首批改造点：保留同一事务内写 `production_runs`，把两处 `production_outbox_events` 直插改为统一 Outbox 追加。
- 切换期只允许一条写路径：新业务写 `data_outbox_events`；旧 `production_outbox_events` 停止新增，只保有历史数据。禁止长期双写两套格式。

### 首批接入

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

现状：`packages/main/migrations/015_production_orchestration.sql` 的 `production_outbox_events` 有 `id`、`run_id`、`sequence`、`event_type`、`payload_json`、`created_at`、`delivered_at`；旧事件只有 `createdAt`，没有 aggregate version、correlation、authoritative digest。

映射规则（显式 Legacy Schema，禁止猜业务语义）：

- `legacy_source = 'production_outbox_events'`，`legacy_event_id = old.id`。
- 新 `eventId = 'evt_' + sha256('legacy:production_outbox_events:' + old.id).slice(0, 32)`，确定性生成；重复回填不会产生第二个事件。
- `aggregateType = 'production_run'`，`aggregateId = old.run_id`，`aggregateVersion = old.sequence`。**明确说明**：旧 sequence 只是 run 内事件序号，不是业务聚合版本；迁移后它进入 Legacy 命名空间，不与新事件的版本空间混用。
- `occurredAt = recordedAt = old.created_at`；旧数据无法区分发生/记录时间，二者同值，未知保持未知。
- `schemaVersion = 'lyra.production.outbox_legacy/v1'`；`eventType` 保留旧 `event_type` 并登记为 legacy 映射（不是新事件命名）。
- `payload = { legacySequence: old.sequence }`；旧 `payload_json` 不复制进新事件，原文保留在旧表供审计，避免把未知全文/供应商内容带进新 Outbox。
- `authoritativeRef = { kind: 'production_run', id: old.run_id, revisionId: 'production_run:' + old.run_id + ':v' + run.version, digest: sha256(canonical(run.run_json)) }`；由迁移脚本读取 `production_runs.run_json` 计算，不依赖 SQL 近似。
- `publishedAt = old.delivered_at`；未投递为 `null`；`publishAttempts = old.delivered_at IS NULL ? 0 : 1`，只表达已知投递状态。
- 旧表迁移后保留只读；新 Dispatcher 只读 `data_outbox_events`。旧事件不能重复投影：`event_id` 唯一 + `(legacy_source, legacy_event_id)` 唯一 + 消费者 `(consumerName, eventId)` 处理记录三重保护。

迁移步骤：

1. 建新表与唯一约束/索引，不改旧表。
2. 迁移前核对：旧事件总数、`id` 集合、按 `run_id` 的 sequence 范围、`delivered_at` 已投递/未投递数量、关联 `production_runs.version`。
3. 分批回填（单批一个事务，记录游标）；每批再核对行数与 ID 集合。
4. 切换写入：业务 repository 只写新 Outbox；旧表置为只读（Trigger 或权限），禁止双写。
5. 迁移后核对：新旧数量一致、每个旧 ID 恰好一个新事件、aggregateVersion 与旧 sequence 一一对应、`publishedAt` 与旧 `delivered_at` 状态一致、`production_runs` 交付状态不变。
6. 回滚：保留旧表与旧读取路径；停止新 Dispatcher，恢复旧读取；新表可保留但不得作为第二写源。

必须提供迁移前后核对测试：数量、ID 集合、aggregate version、交付状态四项；以及“同一旧事件只投影一次”的消费者测试。

## 5. 错误码

校验层：`DATA_EVENT_INPUT_INVALID`、`DATA_EVENT_SENSITIVE_FIELD`、`DATA_EVENT_PAYLOAD_TOO_LARGE`、`DATA_EVENT_DIGEST_MISMATCH`。
事务 Outbox 层：`DATA_OUTBOX_TRANSACTION_REQUIRED`、`DATA_OUTBOX_DUPLICATE_EVENT`、`DATA_OUTBOX_AGGREGATE_VERSION_CONFLICT`、`DATA_OUTBOX_IDEMPOTENCY_CONFLICT`、`DATA_OUTBOX_NOT_FOUND`。
Legacy 层：`DATA_OUTBOX_LEGACY_MAPPING_INVALID`、`DATA_OUTBOX_LEGACY_DUPLICATE`、`DATA_OUTBOX_LEGACY_COUNT_MISMATCH`。

## 6. 边界

- 首期不接 Kafka、不做完整投影 UI、不从缺失值推断成功/失败。
- 消费者不得回写业务状态；事件不携带原始媒体、全文、密钥、令牌或完整供应商响应。
- 单 aggregate 有序、范围重放、dry-run 由 D 阶段实现，但命名空间与事件契约在本阶段冻结。
- 评测事件适配器（`EvaluationEvent → DataEventV1`）不在本期强制绑定；#41 先用自己的 append-only 事件表。
