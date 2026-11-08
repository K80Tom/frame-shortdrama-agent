# 评测数据治理：题库、量表与版本边界

状态：**目录治理基础已落地；Stage 1 租户与对象存储治理待实现**。本文件说明 Lyra 评测目录（Evaluation Catalog）的数据保留、脱敏、授权与版本不可变边界。

评测目录的权威来源登记见 [authority-matrix.md](../packages/main/docs/data-governance/authority-matrix.md) 第 2.9 节；机器可读版本见 [catalog-v1.json](../packages/main/contracts/data-governance/catalog-v1.json) 的 `evaluation` 域。

Issue #40 当时的交付范围只有**题库、量表和版本管理**：

- 当时不做 EvaluationRun、评分器、Promptfoo/Langfuse 接入、Web 页面或 CLI；随后 #41 已落地独立的 [EvaluationRun 基础契约与实现](evaluation-run-contract.md)，但仍没有正式评分器或 UI。
- `packages/shared` 只定义契约、纯校验、规范化与摘要；`packages/main` 负责持久化、生命周期、JSONL 与 HTTP API。
- 所有测试离线运行，不调用真实模型或媒体供应商。

## 1. 身份与 Revision

- Dataset 和 Rubric 各自有稳定身份：`datasetId` / `rubricId` 在派生新版本时不变。
- 内容以不可变 Revision 保存：`DatasetRevision` / `RubricRevision` 由 `(datasetId, revision)` 或 `(rubricId, revision)` 唯一确定。
- Revision 号在写入事务内单调分配，从 1 开始；并发派生不会重号。
- 两类摘要并存：
  - `digest` 覆盖身份、revision 号与全部内容，用于防陈旧覆盖。
  - `contentDigest` 只覆盖可跨 revision 比较的业务内容，用于“导出再导入一致”和内容去重。
- 生命周期状态（`status`、`frozenAt`、`deprecatedAt`）**不进入摘要**；废弃不会改写历史内容或摘要。
- 三种输入（小说拆解、资产检索、镜头审核）使用闭合字段集的判别联合，不使用 `Record<string, unknown>`。未知字段、缺字段和类型错配在契约边界被拒绝。

## 2. 生命周期、保留与废弃

状态只有三种：

| 状态 | 含义 | 能否追加内容 | 能否被新评测绑定 |
|---|---|---|---|
| `draft` | 可编辑草稿 | 是 | 否 |
| `frozen` | 已冻结基线 | 否 | 是 |
| `deprecated` | 已废弃 | 否 | 否 |

规则：

1. 创建产生 revision 1 的草稿；冻结后内容只读。
2. 修改已冻结内容只能从该冻结 revision 派生新草稿，旧 revision 原样保留。
3. 废弃只追加生命周期事件（`created` / `derived` / `frozen` / `deprecated`），不修改历史内容、`digest` 或 `contentDigest`。
4. 被 `evaluation_revision_usage` 引用的 revision 既不能修改也不能删除；冻结但未被引用的 revision 同样不能原地修改。
5. 本阶段不提供物理删除 API。所有 revision 与生命周期事件按追加方式保留，便于审计与回溯。
6. 不自动设置 TTL。保留期限由数据所有者按授权范围决定；如监管或授权要求清除，必须走独立维护流程并同时处理引用与审计要求，不能绕过 Service/数据库保护直接改写历史。

数据库层用 Trigger 和约束兜底（`022_evaluation_catalog.sql`）：

- `evaluation_dataset_revision_guard` / `evaluation_rubric_revision_guard`：冻结或废弃后拒绝 `UPDATE` / `DELETE`，被引用时拒绝修改。
- `evaluation_case_guard` / `evaluation_rubric_dimension_guard`：冻结 revision 下的 case / dimension 不可改删。
- `evaluation_usage_guard`：只允许把已冻结、未废弃 revision 登记为引用。
- `evaluation_usage_append_only` / `evaluation_lifecycle_append_only`：引用账本和生命周期事件只允许 `INSERT`。

Service 层与数据库层是两道独立防线；测试同时覆盖两层，避免“只有业务代码自检”。

## 3. 数据分级与脱敏

敏感等级：

| 等级 | 使用边界 |
|---|---|
| `public` | 已公开发布、可公开引用；仍须标注来源。 |
| `internal` | 仅限内部评测与研发使用，不进入公开仓库或外部演示。 |
| `confidential` | 限定项目/团队范围；导入前去除直接标识与不必要的原文。 |
| `restricted` | 最高限制；必须显式声明 `restrictions`，否则契约拒绝。 |

落地要求：

- 夹具只放合成文本、别名、摘要引用和最小元数据；禁止媒体二进制、密钥、完整供应商响应、未授权作品全文。
- 来源用 `sourceRefs` 的 `refId` / `locator` / `digest` 记录，不把本地绝对路径或个人账号写进内容。
- `contentSummary` 只写可披露的摘要，不复制受限原文。
- 受限数据必须同时有明确 `restrictions` 与授权依据；没有授权依据的数据不得进入目录。
- 导出沿用原 revision 的敏感等级和授权字段；导入方不得借“重新导入”降级敏感等级或删除限制。

## 4. 授权状态与冻结限制

每个 dataset revision 和 rubric revision 都携带：

```ts
interface EvaluationAuthorization {
  status: 'granted' | 'pending' | 'denied';
  basis: string;       // 合同、内部审批或数据中台登记号
  scope: string;       // 允许用途，不能只写“评测”
  grantedBy: string;
  grantedAt: string;   // YYYY-MM-DD
  expiresAt: string | null;
  restrictions: string[];
}
```

- `status` 不是 `granted` 时，契约直接以 `EVALUATION_AUTHORIZATION_DENIED` 拒绝，数据不能落库。
- `scope` 必须写明用途范围；超出 scope 的使用不得绑定该 revision。
- `expiresAt` 到期后不得创建新的引用；历史引用记录保留用于审计。
- 冻结不等于授权永久有效。冻结只固定内容，授权范围仍按 `authorization` 字段判断。
- 新评测只能绑定 `frozen` 且未废弃的 revision；草稿和已废弃版本返回 `EVALUATION_REVISION_NOT_BINDABLE`。
- 引用关系写入 `evaluation_revision_usage`，重复登记同一 `usageKind + usageRef` 幂等返回同一条记录。

## 5. JSONL 导入与导出

格式为“manifest + 记录行”：

- 首行必须是 `{"type":"manifest","schemaVersion":"lyra-evaluation-jsonl/1","entity":"dataset"|"rubric",...}`。
- dataset 后续每行为 `{"type":"case",...完整 case...}`。
- rubric 后续每行为 `{"type":"dimension",...完整 dimension...}`。
- rubric manifest 可选 `revisionId`，只用于首次导入新量表时确定性引用其 revision。

导入规则：

1. 默认创建新 revision 或派生新草稿；导入已有数据集/量表必须提供当前最新 revision 的 `expectedDigest`，否则返回 `EVALUATION_EXPECTED_DIGEST_REQUIRED`。
2. 导入原子化：先完整解析和校验，再一次性写入；任何错误都不留下数据集或半份 revision。
3. 校验范围包括 Schema 版本、Case ID 重复、内容完全重复、输入相同但期望不同、授权缺失/拒绝、非法版本引用。
4. 错误统一返回 `line`、`caseId`、`path`、`code`、`message`；外层错误码为 `EVALUATION_JSONL_INVALID` 时，`details` 保留具体子错误码（如 `EVALUATION_AUTHORIZATION_DENIED`、`EVALUATION_VERSION_REF_INVALID`）。
5. 导出再导入后 `contentDigest` 与规范化内容一致；`digest` 包含 revision 号，按同一身份和 revision 比较。
6. 镜头审核 case 引用的量表 revision 必须存在、已冻结、类型为 `shot_review`，且引用摘要与量表 revision 摘要一致。

## 6. 运行结果与人工修改不会自动成为标准答案

EvaluationRun 与评测目录是独立边界，当前实现不会把运行结果或人工修正回写冻结题库。人工判断要成为标准答案，只能通过受控的目录变更：

- 新建或派生 revision；
- 显式编辑 `expectation`；
- 重新计算摘要；
- 冻结后由新评测引用。

任何运行页面或评分器都不得直接修改已冻结 revision，也不得把人工临时修正静默写回 `expectation`。如需吸收人工结论，应生成新的 dataset revision，并在 PR/评审中说明依据。

## 7. 后续数据中台授权登记的接入位置

当前授权字段由 dataset/rubric 创建与 JSONL manifest 提供。后续接入数据中台时，授权登记应落在以下边界，而不是绕过契约直接写表：

1. **写入点**：`EvaluationService.createDataset` / `createRubric` / `importDatasetJsonl` / `importRubricJsonl` 是唯一的内容入口；数据中台登记结果应组装成 `EvaluationAuthorization` 后经这些入口写入。
2. **登记号**：`authorization.basis` 保存数据中台登记号或合同/审批编号；`grantedBy` 保存授权主体，`scope` 保存用途范围。
3. **映射**：数据中台的授权状态映射到 `granted` / `pending` / `denied`；未授权或已撤回的登记不得导入。
4. **时效**：中台到期时间映射到 `expiresAt`；到期后由绑定校验拒绝新引用，历史账本保留。
5. **限制**：中台的限制条款写入 `restrictions`；`restricted` 等级必须非空。
6. **审计**：当前 EvaluationRun 尚未自动登记 usage；Stage 1 创建运行时必须登记 `usageKind='evaluation_run'` 与 `usageRef`，通过 `evaluation_revision_usage` 关联到具体 revision，并与运行创建保持可恢复的一致性。

数据中台接入不得改变本期的不可变语义；如需批量回填历史授权，应作为独立迁移与人工审批事项处理。

## 8. Stage 1 多租户与对象存储治理

1. **目录作用域显式化。** 平台公共目录与 workspace 私有目录必须有明确作用域；公共不等于匿名可写，私有目录不能被其他 workspace 搜索、绑定或导出。
2. **租户过滤在 Repository 落实。** Dataset、Rubric、Revision、Usage、授权与对象元数据都携带 `workspace_id` 或明确的平台作用域；Repository 接收 `TenantContext`，禁止只按资源 ID 裸查。对象 key 或 Milvus filter 不能代替 PostgreSQL 授权。
3. **PostgreSQL 保存事实与元数据。** 授权、版本、生命周期、usage 和对象引用以 PostgreSQL 为准；Redis/Milvus 只保存可重建的缓存或检索投影。
4. **大型字节进入对象存储。** 大型 JSONL、媒体和评测证据使用统一 `ObjectStorage`，目录只保存 provider、bucket、object key、version、checksum、size、content type 等不可变引用。数据库和事件不得保存临时签名 URL。
5. **签名 URL 不是授权。** 上传/下载前先由 PostgreSQL 校验 workspace 权限，再签发短期、单对象、单操作 URL；上传完成后由 `main` 验证大小、类型和 checksum 才能标记 ready。
6. **旧摘要保持可验证。** 现有 v1 行、JSON 与摘要不原地改写；后续迁移向 022 创建的表新增可空租户/作用域字段，再按“历史数据映射 platform/default workspace → 核对 → 收紧约束”的顺序引入租户边界。

## 9. 离线夹具与验证命令

夹具位于 `packages/main/fixtures/evaluation/`：

- `novel-breakdown.jsonl`：合成文本片段、实体别名、来源引用和时空范围。
- `asset-retrieval.jsonl`：固定 Query、资产元数据、固定命中与期望结果。
- `shot-review.jsonl`：镜头描述、媒体摘要引用、四维量表与帧证据要求。
- `shot-review-rubric.jsonl`：镜头审核四维量表（构图、连续性、光照、运镜），含 uncertain/skipped/evaluator_error 三态策略。

验证：

```sh
npm run build
npm test
npm --prefix packages/main run test:db
```

`npm test` 覆盖契约、生命周期、JSONL 与 HTTP 端到端；`test:db` 在真实 PostgreSQL 上验证 022 迁移、不可变 Trigger、引用保护、并发编号和夹具导入。数据库测试使用独立评测表并在每个用例前清空，不依赖也不修改其他业务数据。
