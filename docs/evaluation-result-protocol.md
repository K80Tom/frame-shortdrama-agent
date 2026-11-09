# 统一评估结果协议（#42）

状态：**Implemented**（本地 commit，待契约评审合并）。
契约版本：`lyra-evaluator-result/1`。
共享实现：`packages/shared/src/evaluator.ts`；main 切片：`packages/main/src/evaluation-results/`；迁移：`packages/main/migrations/025_evaluation_results.sql`；测试：`packages/main/tests/evaluator-protocol.test.cjs`、`evaluation-results-migration.test.cjs`、`evaluation-results-persistence.db.test.cjs`。

本文只新增"结果/证据/适配/分层指标"这一层，复用 023 的 EvaluationRun、冻结快照、case/sample attempt 与事件/恢复，不新建第二套运行或状态机。

## 1. 五态语义

| status | 含义 | 是否对象有效判定 |
| --- | --- | --- |
| `pass` | 对象满足阈值，基于有效证据 | 是 |
| `fail` | 对象不满足阈值，基于有效证据 | 是 |
| `uncertain` | 证据不足或落在阈值区间；不计通过也不计失败 | 否 |
| `skipped` | 评估被显式跳过；对象未被评判 | 否 |
| `evaluator_error` | 评估器自身异常（适配器/超时/证据不可用/内部）；**不是对象 fail** | 否 |

未知与缺失永远是 `null` 或独立计数，绝不当 0，也不当通过。`evaluator_error` 结果必须带结构化 `EvaluatorError`；其他状态不能携带。

## 2. 结果身份与定位

`EvaluationResult` 闭合、可运行时校验、追加式不可变：

- 运行定位：`locator.{runId,caseId,sampleIndex}`，可逐级为 null；run 空则 case/sample 空，case 空则 sample 空。
- 对象定位：`subject.{kind,id,revisionId,digest}`。
- 评估器身份：`evaluator.{evaluatorId,version,digest}`；`EvaluatorDefinition` 固定适配器语义 `rule_based/model_based/human/hybrid` 与 `minSampleSize`。
- `resultDigest` 覆盖除 `recordedAt` 外的全部内容，是确定性幂等身份；重放同一内容由唯一约束返回既有记录。

## 3. 证据与指标

- `EvidenceRef`：来源系统、`sourceDigest`、定位（`entity/jsonPath/shotId/frameIndex/timecodeSec`）、可用性（available/missing/restricted）与可见性（public/internal/confidential）。证据本体不入结果。
- `MetricResult`：`key/layer/value/status`；`value` 为 null 表示未知，只有 pass/fail 才能带数值。
- 层级：`sample/case/scene/shot/run/version`。

## 4. 分层聚合

`summarizeMetric(key, layer, observations, minSampleSize, policy)` 顺序无关：

- 保留 `total/valid/missing/uncertain/skipped/error`；`mean/variance/p50/p95/coverage` 只对有效观测（pass/fail 且带数值）计算。
- Wilson 区间针对 pass/valid。
- 低于 `minSampleSize` 时 `effectiveStatus` 强制为 `uncertain`（纯 `evaluator_error` 例外）。
- 复用 `MissingResultPolicy`（uncertain/skipped/evaluator_error 各自 fail/exclude/review）决定整体结论，原始计数始终保留。

## 5. 旧结果适配（无损、类型约束、可往返）

适配器不虚构历史结果类型：保留的旧字段走受类型约束的 `legacy` 闭合联合，不用 `Record<string, unknown>`。

- `fromQualityCheck`：`QualityCheck.result` → status，`level: episode` → run 层，ruleVersion 进 evaluator/legacy。
- `fromAssetProbeCase`：离线 Probe case 的 `pass` 布尔 → pass/fail，fixtureVersion 保留。
- `fromNovelBreakdownCaseOutput`：基于期望/命中计数的 rule_based 比对（全中 pass、部分 uncertain、零命中 fail）。

round-trip 测试保证：适配产物经 `parseEvaluationResult` 后所有旧字段（id/runId/taskId/level/ruleVersion/fixtureVersion/caseId 等）仍可读出。

## 6. 持久化权威来源

`evaluation_results`（025）只允许 INSERT（BEFORE UPDATE/DELETE 触发器）；`result_digest` 唯一；复用 023 `evaluation_runs` 外键，不碰 production/novel/lineage 域。权威来源见 [data-governance/authority-matrix.md](data-governance/authority-matrix.md) §2.9 与机器目录 `contracts/data-governance/catalog-v1.json` 的 `evaluation.result` / `lyra.evaluation.result_status_count.v1`。
