# 资产 RAG 自进化 P1 + P2

## 范围

本期只实现 `AssetRetrievalPolicy` 的可控治理：不可变运行证据、确定性改进提案、策略候选、固定测试集离线回放、版本 Registry、人工采用与回滚。页面位于现有「自进化」工作台。

不包含视频 Prompt 进化、真实生成 A/B、视觉语义自动评审或模型证据分析 Agent；Probe 通过不代表视觉或创作质量提升。本期不会自动修改资产名称、别名、描述或图片，也不会自动重建 Milvus。资产元数据变更和向量重建仍需显式执行。

## 闭环

1. **Evidence**：仅对 `completed / partial / failed / cancelled` 运行生成；只保留最终仍 `open` 的问题，同时保存任务、尝试、规则/模型摘要、产物引用、实际 charge 费用和耗时。同一运行重复生成返回同一 Evidence。
2. **Proposal**：按 `family + failureSignature + scope` 去重。失败签名不包含运行 ID、时间、重试次数或自由文本；相同问题跨运行合并证据来源。资产歧义生成检索策略候选建议，资产元数据、媒体运行时、预算和剧本契约分别归类，不混作创作质量指标。
3. **Candidate**：从当前 Registry 基线创建。首个版本只包含自动复用阈值、歧义 margin、语义融合权重；默认基线为 `0.62 / 0.08 / 0.95`，schema 为 `asset-retrieval-policy/1`。
4. **Probe**：固定本地夹具和假 embedding/Milvus，无网络、真实模型或付费生成。覆盖唯一复用、歧义阻断、无关缺失、stale 向量 ID、跨类型过滤、低置信防误复用及 embedding 成本。
5. **人工采用**：必须存在当前基线/候选摘要一致的通过 Probe；候选基线、请求中的当前摘要和 Registry 当前摘要三者一致才允许 CAS 切换。
6. **回滚**：只追加新 Registry revision 和事件，不改写历史 Evidence、Probe 或 Registry 事件。

## 离线上采用门

候选必须满足：

- 误复用数量不增加；
- 安全阻断数量不减少；
- 正确复用数量不减少；
- 候选契约失败数为 0；
- embedding 预算计数不增加；
- `modelCalls = 0`。

这些门只证明固定离线检索契约未退化，不证明真实生成质量提升。

## 运行冻结与兼容

`ProductionService.create()` 在创建新运行时读取当前 Registry 并冻结到 `StoredProductionRun.assetRetrievalPolicy`。资产执行器使用该运行的阈值、margin 和语义权重，而不是读取后续全局值。幂等重放保留原冻结策略；历史运行不随采用变化。缺少该字段的旧数据继续使用内置基线。

策略摘要只覆盖 schema 和三个排序参数，不包含 Registry revision 或来源 candidate。资产目录仍是事实源，Milvus 仍是可重建投影。

## API

- `GET /api/evolution/assets`
- `POST /api/evolution/assets/evidence/:runId`
- `POST /api/evolution/assets/proposals/:proposalId/candidates`
- `POST /api/evolution/assets/candidates/:candidateId/probes`
- `POST /api/evolution/assets/candidates/:candidateId/adopt`
- `POST /api/evolution/assets/registry/rollback`

采用与回滚请求必须包含 `expectedPolicyDigest` 和人工 `reason`。所有 POST 沿用本机 `X-Shortdrama-Call: 1` 防护与 `no-store`。

## 持久化

`migrations/019_asset_evolution.sql` 创建 Evidence、Proposal、Candidate、Probe、Registry 和 RegistryEvent 表。Evidence、Probe、RegistryEvent 在 PostgreSQL 通过触发器禁止 UPDATE/DELETE；采用和回滚使用事务及 advisory lock 串行化。

应用迁移后才启用 PostgreSQL 后端治理服务：

```sh
npm run db:migrate
```

## 验证

```sh
node --test packages/main/tests/asset-evolution.test.cjs
npm --prefix packages/web test
npm test
```

真实 PostgreSQL 验证使用独立临时数据库，执行全部迁移、不可变触发器、CAS 和多版本回滚后删除该测试库：

```sh
npm --prefix packages/main run test:evolution-db
```

不要用内存测试代替真实迁移结论，也不要在正式项目数据库中写入不可变测试记录。
