# 数据权威来源与 Owner 矩阵

契约版本：`lyra-data-governance/1`。规则与术语见 [ADR 0001](../adr/0001-data-domain-governance.md)；机器读取使用 [catalog-v1.json](../../contracts/data-governance/catalog-v1.json)。

本矩阵中的 Owner 是长期责任模块，不代表已经指定自然人。模块 Owner 负责口径与兼容性，代码合并仍按 `CODEOWNERS` 审批。表中没有 `updated_at` 的当前指针，其时间取导致该指针变化的版本或采用记录时间。

## 1. Owner 与逻辑权限

| Owner key | 责任模块 | 默认读/写 scope |
| --- | --- | --- |
| `novel` | `packages/main/src/novel`、`packages/shared/src/novel-*` | `project:read` / `project:write` |
| `script` | `packages/main/src/breakdown` 及共享剧本契约 | `project:read` / `project:write` |
| `asset` | `packages/main/src/assets`、`desktop-assets` | `asset:read` / `asset:write` |
| `production` | `packages/main/src/production`、`packages/shared/src/production.ts` | `production:read` / `production:operate` |
| `external` | `packages/main/src/models`，并由各调用链 Owner 协同评审 | 跟随调用链；供应商明细不公开 |
| `quality` | `packages/main/src/review` 与产生检查的业务模块 | 跟随被检查对象 / 由原业务写路径写入 |
| `delivery` | `packages/main/src/production-media`、`production/finalization` | `production:read` / `production:operate` |
| `cost` | `packages/main/src/production` 的预算与账本实现 | `cost:read` / 仅原预算写路径 |
| `evaluation` | 当前为 `packages/main/src/evolution`；通用评测由 #17 另行指定 | `evaluation:read` / `evaluation:write` |

权限是后续 Data API 的逻辑要求，不表示当前本地单用户系统已经实现多用户鉴权。

## 2. 核心事实的唯一权威来源

### 2.1 小说与章节（Owner：`novel`）

| 事实 | 唯一权威来源 | 主键 / 版本键 | 事件与记录时间 | 不可覆盖字段 | 保留期 / 敏感级 |
| --- | --- | --- | --- | --- | --- |
| 小说原文与出处 | `novel_sources` | `id` / `content_sha256` | `created_at` | `id/raw_text/content_sha256/source_url/created_at` | `project_lifetime` / `confidential` |
| 章节不可变修订 | `novel_revisions` | `(chapter_id,id)` / `id`（`revision_order` 只排序） | `created_at` | `id/chapter_id/parent_revision_id/created_by/content_json/created_at` | 同上 |
| 章节当前修订指针 | `novel_chapters.latest_revision_id` | `id` / `latest_revision_id` | 新指向修订的 `created_at` | `id/document_id/chapter_order/start_offset/end_offset`；指针只能经章节 CAS 改变 | 同上 |

跨章实体表是派生读模型，不是新的身份权威；不得凭同名覆盖章内修订。

### 2.2 剧本、计划与分镜（Owner：`script`）

| 事实 | 唯一权威来源 | 主键 / 版本键 | 事件与记录时间 | 不可覆盖字段 | 保留期 / 敏感级 |
| --- | --- | --- | --- | --- | --- |
| 项目来源与小说改编链 | `projects.source_json` | `id` / 来源中的 `documentSha256 + chapters[].revisionId` | 项目或对应剧本的 `created_at` | `kind/format/documentId/documentSha256/chapters`；不得随新模型或新章节静默变化 | `project_lifetime` / `confidential` |
| 剧本不可变版本 | `script_versions` | `id` / `id`（`version` 仅项目内显示） | `created_at` | `id/project_id/version/raw_text/content_sha256/source_index_json/created_at` | 同上 |
| 当前剧本指针 | `projects.current_script_version_id` | 项目 `id` / 指向的剧本 `id` | 新剧本 `created_at` | 只能经项目写路径改变，历史版本不删除 | 同上 |
| 制作计划候选 | `plan_revisions` | `id` / `id`（`revision_order` 只排序） | `created_at` | 原文、父版本、内容、要求、创建者、创建原因和输入执行关联 | 同上 |
| 当前采用计划 | `projects.active_plan_revision_id`；历史凭据为 `plan_adoptions` | 项目 `id` / 计划 `id` | 对应采用记录 `created_at` | 采用历史追加；当前指针只能经期望版本检查改变 | 同上 |
| 分镜候选 | `storyboard_revisions` | `id` / `id` | `created_at` | 来源计划、剧本、内容、输入摘要、模型与提示版本 | 同上 |
| 当前采用分镜 | `projects.active_storyboard_revision_id`；历史凭据为 `storyboard_adoptions` | 项目 `id` / 分镜 `id` | 对应采用记录 `created_at` | 采用历史追加；当前指针只能经原采用路径改变 | 同上 |

### 2.3 资产（Owner：`asset`）

| 事实 | 唯一权威来源 | 主键 / 版本键 | 事件与记录时间 | 不可覆盖字段 | 保留期 / 敏感级 |
| --- | --- | --- | --- | --- | --- |
| 资产登记 | `asset_catalog` | `id` / `id`；本地内容另有 `sha256` | `created_at` | `id/kind/name/description/resource_url/created_at` | `project_lifetime` / `confidential` |
| 本地图片字节与校验 | `asset_media` | `asset_id` / `sha256` | 对应资产 `created_at` | `asset_id/mime_type/sha256/content` | 同上；字节禁止入事件 |
| 章节正式资产绑定 | `novel_revisions.content_json.assetBindings` | `(revision_id,item_id)` / 所属修订 `id` | 所属修订 `created_at` | 绑定快照随修订不可变；修改只能新建修订 | 同上 |
| 生图候选与审核状态 | `asset_generation_candidates` | `id` / `version` | `created_at/updated_at` | `id/task_id/asset_id/chapter_id/item_id/provenance_json/created_at`；状态和接受关联只经审核路径更新 | `run_lifetime` / `confidential` |
| 生图执行状态 | `desktop_asset_jobs` | `id` / `version`；幂等键 `job_key` | `created_at/updated_at` | `id/job_key/chapter_id/created_at`；输入快照不得被另一任务覆盖 | 同上 |

候选进入 `asset_catalog` 不等于已接受；正式绑定与候选审核分别读取自己的权威来源。

### 2.4 整集生产（Owner：`production`）

| 事实 | 唯一权威来源 | 主键 / 版本键 | 事件与记录时间 | 不可覆盖字段 | 保留期 / 敏感级 |
| --- | --- | --- | --- | --- | --- |
| 当前生产聚合 | `production_runs.run_json` | `id` / `version` | 当前版本 `updatedAt`；创建 `createdAt` | 创建输入、`workflowVersion`、冻结方法包/策略、`createdAt`；`budgetMicros` 只能经审计的 `raiseBudget` 增加 | `run_lifetime` / `confidential` |
| 任务与当前状态 | `run_json.tasks` | `(runId,taskId)` / 任务 `version` + 聚合 `version` | 任务 `createdAt/updatedAt` | `id/runId/stage/scope/createdAt`；失效保留历史，不物理改写为成功 | 同上 |
| 执行尝试 | `run_json.attempts` | `(runId,taskId,number)` / `attemptId` | `startedAt/endedAt` | 已结束尝试的输入摘要、执行器、结果与错误；新执行新增尝试 | 同上 |
| 已发出生产事件序列 | `production_outbox_events` | `id`；顺序 `(run_id,sequence)` | `created_at` 为 v1 `recordedAt` | `id/run_id/sequence/event_type/payload_json/created_at`；`delivered_at` 仅传输状态 | `replay_lifetime` / 事件最高 `internal` |

`production_runs.status/version` 是受约束查询列，`run_json.outbox` 是聚合内副本；二者都不是独立事实源。

### 2.5 外部调用（Owner：`external`，按执行链分域）

| 事实范围 | 唯一权威来源 | 主键 / 版本键 | 时间 | 不可覆盖与特别约束 | 保留期 / 敏感级 |
| --- | --- | --- | --- | --- | --- |
| 文字拆解模型调用 | `model_calls` | `id` / `operation_key`；供应商 `provider_request_id` 仅对账 | `created_at/ended_at` | 操作键、请求摘要、供应商与模型不覆盖；`response_json` 禁止扩散 | `run_lifetime` / `confidential` |
| 整集生产外部操作 | `run_json.externalOperations` | `id` / `operationKey`；关联 `attemptId` | `createdAt/updatedAt` | 操作键、任务、尝试、供应商不覆盖；未知结果不得重新提交 | 同上 |
| 小说拆解尝试 | `novel_attempts` | `id` / `attempt_order` | `started_at/ended_at` | 期望基准、模型与产出修订关联不覆盖；未知保留原记录 | 同上 |
| 小说生图任务 | `desktop_asset_jobs` | 见资产域 | 见资产域 | 审核状态不在这里取值 | 同上 |
| 独立单段视频 | `video_automation_runs.run_json` | `id` / `version`；幂等键 `client_request_id` | `created_at/updated_at` | 创建输入、冻结连接和供应商任务 ID 不覆盖；不套用整集运行状态或成本 | 同上 |

### 2.6 质量与审核（Owner：`quality`）

| 事实 | 唯一权威来源 | 主键 / 版本键 | 时间 | 不可覆盖字段 | 保留期 / 敏感级 |
| --- | --- | --- | --- | --- | --- |
| 计划程序检查与问题 | `plan_checks`、`plan_issues` | 各自 `id` / `rule_version + content_digest` | `created_at` | 检查对象、规则、方法、结果、摘要与问题定位；新检查新增记录 | `project_lifetime` / `confidential` |
| 生产技术检查 | `run_json.qualityChecks` | `id` / `ruleVersion` | `createdAt` | 任务、范围、结果、规则、摘要和问题；历史检查不随新产物改写 | `run_lifetime` / `confidential` |
| 生产问题 | `run_json.issues` | `id` / 聚合 `version` | `createdAt/resolvedAt` | 创建时的任务、阶段、范围、严重度和建议；解决追加时间与状态 | 同上 |
| 人工复核决定 | `run_json.reviews` | `id` / `id` | `createdAt` | 任务、候选/问题、决定、反馈和时间；不得反向覆盖旧决定 | 同上 |
| 生图候选接受/拒绝 | `asset_generation_candidates` | 见资产域 | 见资产域 | 人工接受不等于视觉语义质检通过 | 同上 |

### 2.7 交付（Owner：`delivery`）

| 事实 | 唯一权威来源 | 主键 / 版本键 | 时间 | 不可覆盖字段 | 保留期 / 敏感级 |
| --- | --- | --- | --- | --- | --- |
| 生产产物登记 | `run_json.artifacts` | `id` / `id + sha256` | `createdAt` | 任务、类型、内容哈希、来源元数据；替代只改变状态并保留历史 | `run_lifetime` / `confidential` |
| 时间线修订 | `run_json.timeline` | `id` / `version` | `createdAt` | 有序轨道、产物引用、时长；采用/替代状态按原流程变化 | 同上 |
| 交付状态 | `run_json.delivery` | `id` / `artifactId` | `createdAt/verifiedAt` | 运行、任务、产物和交付规格；`ready` 必须有核验时间与有效产物 | 同上 |
| 本地 MP4 字节与技术清单 | 私有媒体目录中的内容寻址对象及 `production-local-video/1` 清单 | `media_<sha256>` / `sha256` | 清单 `createdAt` | 哈希、字节数、MIME、相对路径、来源与探测信息；绝对路径不外发 | 同上；字节禁止入事件 |

### 2.8 预算与成本（Owner：`cost`）

| 事实 | 唯一权威来源 | 主键 / 版本键 | 时间 | 不可覆盖字段 | 保留期 / 敏感级 |
| --- | --- | --- | --- | --- | --- |
| 运行预算上限与授权 | `run_json.budgetMicros/currency/allowPaid` | `runId` / 聚合 `version` | `createdAt`；提额由对应 outbox 事件记录 | 初始授权与币种；`budgetMicros` 只能经 `raiseBudget` 增加 | `run_lifetime` / `confidential` |
| 预算账本 | `run_json.budgetLedger` | `id` / `id` | `createdAt` | 追加式 `estimate/reserve/charge/release`、金额、币种、依据和关联操作 | 同上 |
| 外部操作费用观察 | `run_json.externalOperations.actualCostMicros/billingBasis` | `operationId` / `operationKey` | `updatedAt` | 供应商实报与预算估算必须区分；不能覆盖为更“好看”的值 | 同上 |

没有账本的调用链不生成“零成本”指标。成本报表默认按运行和币种分组，估算与供应商核验值分列。

### 2.9 评测（Owner：`evaluation`）

| 事实 | 唯一权威来源 | 主键 / 版本键 | 时间 | 不可覆盖字段 | 保留期 / 敏感级 |
| --- | --- | --- | --- | --- | --- |
| 终态运行证据 | `evolution_evidence` | `id` / `runDigest`；`run_id` 唯一 | `created_at` | 整份证据不可更新或删除 | `run_lifetime` / `confidential` |
| 改进建议与候选状态 | `evolution_proposals`、`evolution_candidates` | 各自 `id`；候选另有策略摘要 | `updated_at/created_at` | 来源证据、策略与基准摘要；状态只能走既定采用流程 | `project_lifetime` / `confidential` |
| 离线 Probe 报告 | `evolution_probes` | `id` / `fixtureVersion + policyDigest` | `created_at` | 整份报告不可变，`modelCalls` 必须为 0 | `run_lifetime` / `confidential` |
| 当前策略 Registry | `evolution_registry` | `domain` / 当前策略修订 | `updated_at` | 当前值只能由 Registry 事件推进，不能回写历史运行 | `project_lifetime` / `confidential` |
| Registry 采用/回滚历史 | `evolution_registry_events` | `id`；`(domain,revision)` | `created_at` | 整份事件不可变；回滚是追加新版本 | `project_lifetime` / `internal` |

这里只覆盖当前资产检索离线评测事实。通用评测数据集、标注、授权和评分由 #53/#17 扩展，不得直接把 Probe 结果当作通用质量分。

## 3. 字段 Owner 与扩散规则

| 字段或字段组 | Owner | 允许进入事件的形式 | 禁止或备注 |
| --- | --- | --- | --- |
| `novel_sources.raw_text/source_url`、`script_versions.raw_text` | `novel` / `script` | ID、`contentSha256`、修订 ID | 禁止原文、完整引用和来源全文。 |
| `source_index_json`、`content_json.sourceRefs` | `novel` / `script` | 安全定位键、摘要 | 禁止 `quote` 和整份索引；内部读取仍需项目权限。 |
| `plan_revisions.content_json`、`storyboard_revisions.content_json` | `script` | 修订 ID、内容摘要、检查结论 | 禁止整份计划/分镜快照。 |
| `projects.*revision_id`、`novel_chapters.latest_revision_id` | `script` / `novel` | 当前指针及前后版本 | 修改只能走原业务 CAS/采用路径。 |
| `asset_catalog.resource_url` | `asset` | 资产 ID、内容哈希（本地内容） | 不将远程 URL 当不可变版本；签名 URL 禁止入事件。 |
| `asset_media.content`、生产媒体字节 | `asset` / `delivery` | `mediaId`、SHA-256、MIME、字节数 | 禁止 Base64、二进制、绝对路径。 |
| `desktop_asset_jobs.task_json` | `asset` | 任务 ID、状态、候选 ID、安全错误摘要 | 禁止内部 `jobKey`、完整提示词、私有快照。 |
| `asset_generation_candidates.provenance_json` | `asset` | 候选、输入修订、模型修订、结果摘要 | 禁止提示词快照、完整条目快照和供应商原始内容。 |
| `model_calls.request_digest/provider_request_id` | `external` | 操作 ID、请求摘要、状态；供应商 ID按权限提供 | 不据此推断结果不明调用的成功或失败。 |
| `model_calls.response_json` | `external` | 安全错误码、用量和结果摘要 | 禁止完整供应商响应进入事件、看板或公开导出。 |
| 私有模型连接与密钥 | `external` | 只允许 `modelConnectionRevision` | `secret`；禁止密钥、令牌、鉴权头和连接明文。 |
| `run_json.tasks/attempts` | `production` | ID、版本、状态、输入摘要、开始/结束时间 | 不用数组下标识别任务或尝试。 |
| `run_json.externalOperations` | `external` | 操作键、状态、供应商任务 ID、费用依据 | `unknown` 必须保留；不得自动重发。 |
| `run_json.qualityChecks` | `quality` | 结果、方法、规则版本、检查范围 | 技术结果必须带技术范围，不能改名为语义通过。 |
| `run_json.reviews`、候选审核备注 | `quality` / `asset` | 决定、目标 ID、时间；备注仅安全摘要 | 完整人工反馈按 `confidential` 处理。 |
| `run_json.artifacts/timeline/delivery` | `delivery` | 产物/媒体 ID、哈希、状态、规格 | 禁止临时供应商 URL、绝对路径和未入库媒体作为交付。 |
| `budgetMicros/budgetLedger/actualCostMicros` | `cost` | 整数 micros、币种、账目类型、费用依据 | 禁止浮点、跨币种裸求和、把估算冒充实报。 |
| `evidence_json/probe_json/event_json` | `evaluation` | 证据/报告/事件 ID、版本、摘要和安全指标 | 原始证据不得复制进另一套“当前事实”。 |
| 所有 `createdAt/updatedAt/*EndedAt` | 对应事实 Owner | ISO 8601 时间，按 ADR 区分三种时间 | 不用投影处理时间覆盖业务发生时间。 |

## 4. 指标 Owner 与最小口径

下表只冻结跨任务需要复用的基础指标。#51、#52 和评测看板可以添加维度，但不能在不升级版本的情况下改变公式。

| 指标 ID | 公式 / 过滤 | 权威输入 | Owner |
| --- | --- | --- | --- |
| `lyra.production.run_count.v1` | 按快照时刻的 `runId` 去重计数，按当前 `status` 分组；不推断缺失状态 | `production_runs.run_json` | `production` |
| `lyra.production.task_count.v1` | 当前聚合内按 `(runId,taskId)` 计数；`invalidated/superseded` 与有效任务分组，不混为失败 | `run_json.tasks` | `production` |
| `lyra.production.external_unknown_count.v1` | 当前聚合中 `externalOperations.status=unknown` 的操作数；不是失败数 | `run_json.externalOperations` | `external` |
| `lyra.delivery.ready_count.v1` | `delivery.status=ready` 且 `verifiedAt`、有效产物和 SHA-256 均存在的交付数 | `run_json.delivery/artifacts` 与媒体清单 | `delivery` |
| `lyra.quality.check_count.v1` | 按 `level/result/ruleVersion/method` 分组的检查记录数；技术与语义维度分开 | `plan_checks` 或 `run_json.qualityChecks`，不得混算 | `quality` |
| `lyra.cost.charge_micros.v1` | 按 `runId/currency/basis` 汇总 `budgetLedger.kind=charge`；reserve/release/estimate 不计入 | `run_json.budgetLedger` | `cost` |
| `lyra.cost.budget_debit_micros.v1` | `charge` 加未释放 `reserve`，按运行和币种分组；表示预算占用，不表示供应商账单 | `run_json.budgetLedger` | `cost` |
| `lyra.evaluation.probe_case_count.v1` | 按 `fixtureVersion/verdict` 统计 Probe case；离线 Probe 与模型/人工评测分开 | `evolution_probes` | `evaluation` |

比率指标若后续增加，必须显式写出分子、分母、排除状态、快照时间和缺失值处理。不能把 `partial` 当成功，也不能把未知成本当 0。

## 5. 副本与禁止反写清单

| 副本/投影 | 权威来源 | 规则 |
| --- | --- | --- |
| `production_runs.status/version` | `run_json` | 仅作受约束查询列，由同一事务更新。 |
| `run_json.outbox` | `production_outbox_events` | 页面时间线副本；重放以表为准。 |
| Milvus 与资产检索索引 | `asset_catalog` 及资产服务 | 可重建；陈旧命中必须回目录 hydrate。 |
| 跨章实体表 | `novel_revisions` | 只读派生；不自动合并身份。 |
| API 摘要、看板、导出 | 本矩阵对应来源 | 必须带 schema、条件和快照；不得反写。 |
| Evidence / Probe | 终态运行或固定离线用例 | 是独立评测事实，不修改原运行或业务状态。 |

## 6. 小说到交付链验证

以下使用带说明的占位 ID，不是实际业务数据，也不要求为满足现有 ID 正则而伪造真实记录。

| 步骤 | 必须能唯一解析的引用 | 版本与时间检查 | 权限与敏感检查 |
| --- | --- | --- | --- |
| 1. 小说原文 | `novel_sources.id=<novel-id>` | `content_sha256=<document-sha>`；`created_at` 存在 | `project:read`；原文不进入事件 |
| 2. 章节修订 | `novel_chapters.id=<chapter-id>`，`latest_revision_id=<novel-revision-id>` | 修订的 `chapter_id` 必须等于章节 ID，父修订同属一章；取修订 `created_at` | 同上 |
| 3. 采用为剧本 | `projects.source_json.documentId=<novel-id>`，`chapters[]` 含上述章节和修订；`projects.id=<project-id>` | `documentSha256` 与步骤 1 相同，章节顺序固定；项目/剧本 `created_at` 不早于来源 | `project:write` 才能采用；事件只传 ID 与摘要 |
| 4. 剧本版本 | `projects.current_script_version_id=script_versions.id=<script-version-id>` | `script_versions.project_id=<project-id>`，`content_sha256` 与原文一致 | 原文为 `confidential` |
| 5. 计划与分镜 | 项目当前指针分别指向 `<plan-revision-id>`、`<storyboard-revision-id>` | 两者的 `script_version_id` 都是上述剧本；采用记录时间存在 | 快照不进事件，检查只传结论 |
| 6. 资产 | 正式绑定指向 `<asset-id>`；若来自生图，候选 `<candidate-id>` 必须为 `accepted` | 绑定所属小说修订或生产输入修订固定；本地哈希与媒体一致 | 媒体和提示词不扩散；需要 `asset:read` |
| 7. 生产运行 | `production_runs.id=<production-run-id>`，`project_id`、`script_version_id` 对应步骤 3–4 | 创建输入与 `workflowVersion` 冻结；当前 `version` 与 CAS 一致 | `production:read/operate`；付费须有原运行授权 |
| 8. 尝试与外部操作 | `runId/taskId/attemptId/operationId` 在聚合内唯一且逐级存在 | `operationKey` 稳定；`startedAt/endedAt` 完整或显式未知 | 供应商响应、密钥和完整提示词禁止入事件 |
| 9. 检查与媒体 | 检查 `<quality-check-id>` 指向具体任务；产物 `<artifact-id>` 指向 `<media-id>` 和 SHA-256 | 检查 `ruleVersion` 固定；媒体清单哈希、字节数与对象一致 | 技术 `pass` 只表示技术范围；媒体需要授权读取 |
| 10. 时间线与交付 | 时间线引用有序产物；`delivery.artifactId=<final-artifact-id>` | `ready` 必须有 `verifiedAt`、有效当前产物及所需 episode 检查；无开放阻断 | 交付字节为 `confidential`，导出需 `production:read` |
| 11. 事件与投影 | outbox 的 `run_id=<production-run-id>`，每个 `sequence` 唯一 | `occurredAt <= recordedAt <= processedAt`；处理时间不覆盖事件时间 | 事件最高 `internal`，投影处理拒绝越权字段 |

### 具体值样例（虚拟）

以下值只用于验收关联规则，不对应真实项目、媒体或密钥，也不表示 #48 已实现新事件。

| 环节 | 固定值 |
|---|---|
| 小说与章节 | `documentId=doc_example_001`；`documentSha256=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`；`chapterId=chapter_example_001`；`revisionId=revision_example_004`；`chapter_order=0` |
| 剧本与生产版本 | `projectId=prj_example_001`；`scriptVersionId=script_example_003`；`planRevisionId=plan_example_003`；`storyboardRevisionId=storyboard_example_002` |
| 正式资产 | `assetId=asset_example_001`；绑定仍由 `revision_example_004` 的 `assetBindings` 决定 |
| 运行与质量 | `runId=run_example_001`；`runVersion=7`；`taskId=task_example_009`；`attemptNumber=1`；`sequence=12`；`checkId=check_example_001`；`method=technical`；`ruleVersion=video-technical/1` |
| 交付 | `deliveryId=delivery_example_001`；`artifactId=artifact_example_001`；`mediaId=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` |

写操作主体具有 `production:operate`，读取运行另有 `production:read`，读取资产另有 `asset:read`，成本明细另有 `cost:read`，清理另有 `retention:purge`；任一权限都不隐含其他权限。以下是与 `DataEventV1` 对齐的安全事件示例；现有 Legacy Outbox 仍按既有契约读取：

```json
{
  "eventId": "evt_00000000000000000000000000000001",
  "eventType": "production.delivery.ready",
  "schemaVersion": "lyra.production.delivery_ready/v1",
  "aggregateType": "production_run",
  "aggregateId": "run_example_001",
  "aggregateVersion": 7,
  "occurredAt": "2026-01-01T00:00:00Z",
  "recordedAt": "2026-01-01T00:00:02Z",
  "correlationId": "corr_example_001",
  "causationId": null,
  "idempotencyKey": "production_run:run_example_001:7:production.delivery.ready",
  "authoritativeRef": {
    "kind": "production_run",
    "id": "run_example_001",
    "revisionId": "version_7",
    "digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  },
  "payload": {
    "projectId": "prj_example_001",
    "runId": "run_example_001",
    "runVersion": 7,
    "sequence": 12,
    "scriptVersionId": "script_example_003",
    "storyboardRevisionId": "storyboard_example_002",
    "deliveryId": "delivery_example_001",
    "artifactId": "artifact_example_001",
    "mediaId": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "status": "ready",
    "sensitivity": "internal"
  }
}
```

`processedAt=2026-01-01T00:00:05Z` 由投影 checkpoint 记录，不写入事件，也不覆盖原事件时间。

用 `runId` 读取权威聚合并核对项目、剧本与版本，再沿 `source_json` 和当前修订指针回到小说、章节、Plan 与 Storyboard；资产接受状态回到章节修订，交付对象回到私有媒体存储。事件不含原文、提示词、媒体字节、绝对路径或供应商原始响应。

### 必须通过的断言

1. 任一 ID 在其声明作用域内只解析到一个对象，跨域引用不被同名记录替代。
2. 从交付反向追溯时，能够依次定位运行、剧本、计划/分镜、资产、外部操作、检查和媒体版本。
3. 从小说正向追踪时，`source_json` 中的章节修订与文档摘要没有被最新章节或最新模型静默替换。
4. 任一历史缺口都产生 `partial/unknown` 与原因；例如旧项目缺少 `source_json` 时不得补猜小说来源。
5. 同一事件重放不会产生重复成本、交付或评测记录；同一未知外部操作不会被再次提交。
6. 权限检查发生在读取 confidential 内容之前；仅拥有事件读取能力不代表能读取原文、媒体或供应商响应。

## 7. #48 自检映射

- 数据域 ADR：ADR 0001。
- 权威来源矩阵：本文第 2 节及 JSON 目录。
- 原文、二进制、密钥、令牌和完整供应商响应禁入事件：ADR 第 8–9 节、本文第 3 节。
- 小说到交付的 ID、版本、时间和权限验证：本文第 6 节。
- 数据域/字段/指标 Owner：本文第 1、3、4 节及 JSON 目录。
- 后续子任务引用契约：ADR 第 11 节规定为 #49～#55 的准入条件；实际引用需在各子任务实施时检查。
