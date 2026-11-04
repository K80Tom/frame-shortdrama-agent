# EvaluationRun 契约设计（#41 第一阶段）

状态：**Proposed**，等待契约评审。本文只冻结契约与持久化边界，不代表执行器、HTTP 或评分算法已实现。
契约版本：`lyra-evaluation-run/1`；快照版本：`lyra-evaluation-snapshot/1`。
共享实现：`packages/shared/src/evaluation-run.ts`；对应测试：`packages/main/tests/evaluation-run-contract.test.cjs`。

## 1. FrozenEvaluationSnapshot 示例

```json
{
  "schemaVersion": "lyra-evaluation-snapshot/1",
  "catalogKind": "shot_review",
  "dataset": {
    "datasetId": "evalds_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "revisionId": "evaldsrev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "digest": "<dataset revision digest, 64 hex>"
  },
  "rubric": {
    "rubricId": "evalrub_cccccccccccccccccccccccccccccccc",
    "revisionId": "evalrubrev_dddddddddddddddddddddddddddddddd",
    "digest": "<rubric revision digest, 64 hex>"
  },
  "evaluator": {
    "evaluatorId": "evaluator-local",
    "version": "1.0.0",
    "digest": "<evaluator contract digest, 64 hex>"
  },
  "candidates": [
    { "candidateId": "candidate-a", "version": "1", "digest": "<candidate digest>" },
    { "candidateId": "candidate-b", "version": "1", "digest": "<candidate digest>" }
  ],
  "modelConnection": {
    "connectionId": "connection-local",
    "revisionId": "connrev-1",
    "provider": "stub",
    "model": "deterministic",
    "digest": "<connection revision digest>"
  },
  "prompt": { "promptId": "prompt-shot", "version": "3", "digest": "<prompt digest>" },
  "workflow": { "workflowId": "workflow-shot", "version": "2", "digest": "<workflow digest>" },
  "code": {
    "version": "0.1.0",
    "commit": "abcdef1234567890abcdef1234567890abcdef12",
    "digest": "<code snapshot digest>"
  },
  "seed": "seed-001",
  "shards": { "shardCount": 2, "shardIndex": 0, "concurrency": 4, "timeoutMs": 120000, "samplesPerCase": 2 },
  "createdAt": "2026-11-03T00:00:00.000Z"
}
```

### 摘要字段

- `snapshotDigest = canonicalDigest({schemaVersion, catalogKind, dataset, rubric, evaluator, candidates, modelConnection, prompt, workflow, code, seed, shards})`。
- `createdAt` **不进摘要**；同一组冻结输入在不同时间创建必须得到相同 `snapshotDigest`。
- `candidates` 按 `candidateId` 排序后进摘要；等价快照不因输入顺序变化而换摘要。
- 快照引用的是 revision ID 与 digest，不复制数据集正文、量表正文、Prompt 全文、供应商响应或媒体。
- `requestDigest = canonicalDigest({idempotencyKey, snapshotDigest})`，用于识别“同一幂等键、不同请求”。

### 敏感字段黑名单

快照禁止出现以下字段（大小写与 `_`/`-` 归一后匹配）：
`apiKey`、`api_key`、`token`、`accessToken`、`refreshToken`、`authorization`、`password`、`secret`、`credential`、`credentials`、`providerResponse`、`rawResponse`、`rawText`、`quote`、`content`、`mediaBytes`、`binary`、`signedUrl`、`absolutePath`、`headers`、`cookie`。

值层面同时拒绝：私钥块、`Bearer` token、`sk-` 密钥、`data:*;base64` 媒体、带签名的 URL、用户绝对路径。

## 2. EvaluationRun 状态迁移表

| from | 允许到 | 说明 |
|---|---|---|
| `prepared` | `running`, `cancelled` | 快照已冻结，尚未执行 |
| `running` | `waiting_external`, `waiting_human`, `completed`, `failed`, `cancelled` | 执行中可暂停或结束 |
| `waiting_external` | `running`, `failed`, `cancelled` | 外部结果返回后恢复，或失败/取消 |
| `waiting_human` | `running`, `failed`, `cancelled` | 人工判断后恢复，或失败/取消 |
| `completed` | — | 终态只读 |
| `failed` | — | 终态只读 |
| `cancelled` | — | 终态只读 |

语义红线：

- `completed` 只表示执行结束，**不等于评测通过**；验收统计必须另有 `passed` 判定，不得用 `completed` 代替。
- `waiting_external`、`waiting_human`、`failed` 都不计入完成数或通过数。
- 终态不能覆盖结果、改状态或重新启动。
- Replay 必须创建新运行并写 `replayedFromRunId`；不得修改旧运行或复用旧 `runId`。

## 3. 运行与 attempt 结构

- `EvaluationRun`：`runId`、`status`、`snapshot`、`snapshotDigest`、`requestDigest`、`idempotencyKey`、`version`（CAS）、`createdAt`、`updatedAt`、`startedAt`、`endedAt`、`replayedFromRunId`。
- `EvaluationCaseAttempt`：`caseAttemptId`、`runId`、`caseId`、`shardIndex`、`attemptNumber`、`status`、起止时间、`error`、`samples`。
- `EvaluationSampleAttempt`：`sampleAttemptId`、`caseAttemptId`、`sampleIndex`、`status`、`outputDigest`、`durationMs`、`costMicros`、`currency`、`error`。
- `EvaluationRunEvent`：`eventId`、`runId`、`sequence`、`eventType`、`occurredAt`、最小 `payload`（状态、case/attempt、sample 序号、错误码、原因）。

每个 sample 独立保存输出摘要、耗时、成本和错误；本地确定性 Executor 的 `costMicros` 必须为 `0`，不得伪造付费账单。

## 4. 持久化设计（待迁移编号分配）

迁移编号由协调人按实际合入顺序统一分配，本设计不占用编号。

表：

- `evaluation_runs`：`run_id` PK、`status`、`snapshot_json`、`snapshot_digest`、`request_digest`、`idempotency_key` UNIQUE、`run_version`、`replayed_from_run_id`（自引用）、时间戳。
- `evaluation_case_attempts`：`case_attempt_id` PK、`run_id` FK、`case_id`、`shard_index`、`attempt_number`、`status`、错误、时间戳；UNIQUE `(run_id, case_id, attempt_number)`。
- `evaluation_sample_attempts`：`sample_attempt_id` PK、`case_attempt_id` FK、`sample_index`、`status`、`output_digest`、`duration_ms`、`cost_micros`、`currency`、错误；UNIQUE `(case_attempt_id, sample_index)`。
- `evaluation_run_events`：`event_id` PK、`run_id` FK、`sequence`、`event_type`、`occurred_at`、`payload_json`、`event_digest`；UNIQUE `(run_id, sequence)`。

约束与 Trigger：

- 创建时在同一事务写 run、case attempt、sample attempt、事件。
- `evaluation_runs.idempotency_key` 唯一；相同键 + 相同 `request_digest` 返回原运行，相同键 + 不同 `request_digest` 报 `EVALUATION_RUN_IDEMPOTENCY_CONFLICT`。
- 更新 run 用 `WHERE run_id=$1 AND run_version=$2` CAS；冲突报 `EVALUATION_RUN_VERSION_CONFLICT`。
- Trigger 禁止 UPDATE/DELETE 终态 run；禁止 UPDATE 已终态 case/sample attempt；历史 attempt 行不能覆盖，只能新增后续 `attemptNumber`。
- `evaluation_runs` 不建立到 `production_runs` 的外键，也不写生产表。需要生产引用时只存不可变 ID + digest，并通过只读 reader 读取。
- Repository 返回防御性拷贝；Service 是唯一写入口。

## 5. 错误码

校验层：`EVALUATION_RUN_INPUT_INVALID`、`EVALUATION_RUN_SNAPSHOT_DIGEST_MISMATCH`、`EVALUATION_RUN_SENSITIVE_FIELD`。
持久化/服务层：`EVALUATION_RUN_IDEMPOTENCY_CONFLICT`、`EVALUATION_RUN_VERSION_CONFLICT`、`EVALUATION_RUN_NOT_FOUND`、`EVALUATION_RUN_TERMINAL_IMMUTABLE`、`EVALUATION_RUN_TRANSITION_INVALID`、`EVALUATION_RUN_CASE_ATTEMPT_IMMUTABLE`、`EVALUATION_RUN_SAMPLE_ATTEMPT_IMMUTABLE`、`EVALUATION_RUN_REPLAY_INVALID`。
执行层：`EVALUATION_RUN_TIMEOUT`、`EVALUATION_RUN_CANCELLED`、`EVALUATION_RUN_EXECUTOR_FAILED`、`EVALUATION_RUN_PRODUCTION_READER_FORBIDDEN`。

## 6. 边界

- 不调用真实模型、不跑真实付费评测、不做评分算法和 UI。
- 不创建生产任务、不改生产状态；Executor 只能注入 `EvaluationProductionRunReader { get(id): Promise<unknown | null> }`。
- #41 不依赖 #49；评测事件先用本表 `evaluation_run_events` append-only。两个 Issue 完成后再评估薄适配器。
