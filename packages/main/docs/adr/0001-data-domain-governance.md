# ADR 0001：冻结数据域、权威来源与数据治理契约



* 状态：Accepted

* 日期：2026-11-03

* Issue：#48；父 Epic：#47

* 契约版本：`lyra-data-governance/1`

* 配套文件：[权威来源与 Owner 矩阵](../data-governance/authority-matrix.md)、[机器可读目录](../../contracts/data-governance/catalog-v1.json)

本文中的 “必须 / 禁止” 是后续 #49～#55 的准入条件。本文只冻结数据契约，不建设投影、Data API 或 UI，也不重新设计业务状态机。

## 1. 背景与问题

当前业务事实分别保存在 PostgreSQL 表、不可变版本快照、`production_runs.run_json`、媒体清单和私有模型连接中。生产运行还存在状态列、JSON 聚合和 outbox 副本。如果直接从任意副本计算指标，会出现：



* 同一状态有多个 “当前值”，指标口径随读取位置变化；

* 当前指针、不可变内容、执行历史和传输事件混为一谈；

* 原文、媒体、提示词、供应商响应或密钥被复制进事件；

* 历史缺字段时被误判为成功、失败或零成本。

因此先确定 “哪份数据说了算”，再允许事件和投影消费。

## 2. 决策



1. **现有业务系统继续是权威来源。** 首期继续使用主应用与 PostgreSQL，不引入 Kafka、ClickHouse 或独立微服务。

2. **一项事实只有一个权威来源。** 状态列、API 摘要、Milvus、页面时间线和未来 Data API 都是可重建副本，不能反写业务。

3. **当前指针与不可变内容分开。** `projects.current_script_version_id`、`active_plan_revision_id`、`active_storyboard_revision_id` 和 `novel_chapters.latest_revision_id` 决定当前选择；版本表保存不可变内容。

4. **当前状态与事件流分开。** `production_runs.run_json` 是生产当前聚合的权威来源；`production_outbox_events` 是已发出事件序列的权威来源；`run_json.outbox` 只供聚合内时间线读取，不作为重放来源。

5. **不同执行链分别定界。** 文字拆解、整集生产、独立单段视频和小说生图不是同一种运行，不因字段相似就合并状态或成本。

6. **版本优先于显示序号。** ID 是不透明字符串；`version/revision/order` 只用于各自作用域内的排序或 CAS，不跨表比较，不用数组下标代替身份。

7. **事件只携带安全引用和结论。** 原文、完整引用、媒体字节、密钥、令牌、完整供应商响应、鉴权头、私有连接、绝对路径和签名 URL 禁止进入事件。

8. **未知保持未知。** 历史缺字段、供应商结果不明或证据不足时使用 `unknown` 并记录完整度，禁止推断成功、失败、零成本或空集合。

9. **技术检查不等于语义审核。** 指标必须带 `method`、`ruleVersion` 和检查范围；技术 `pass` 不能转成人物、剧情、表演或连续性的语义通过。

10. **金额是账本事实，不是页面估算。** 金额使用整数 micros 和币种；预留、释放、实扣、供应商核验值和保守预算扣减分别表达，不跨币种直接求和。

11. **Owner 先是责任模块，不伪造个人分工。** 模块 Owner 负责字段与指标口径；具体自然人评审仍由 `CODEOWNERS` 和项目分工决定。

12. **所有破坏性变更先兼容再迁移。** 事件、投影、回填、回滚和废弃必须按本文流程执行，不能直接改字段含义让旧消费者失效。

## 3. 权威来源的判读规则

详细到事实和字段的矩阵见配套文件。判读顺序固定为：



1. 先确定事实属于哪个执行链和数据域；

2. 再查矩阵中的唯一 `systemOfRecord`；

3. 当前值读取当前记录或当前指针，历史值读取不可变版本或追加记录；

4. 事件和投影只证明 “某事实曾被发布 / 计算”，不能覆盖权威来源；

5. 两处副本不一致时，以权威来源为准重建副本，并记录数据质量问题，不修改历史事件。

特别规定：



* `production_runs.status/version` 是与 `run_json` 同事务写入的受约束列，便于数据库查询，但领域读取仍以 `run_json` 为准。

* `asset_catalog` 中存在资产生成记录，不代表候选已接受；候选审核状态只认 `asset_generation_candidates`。

* HTTPS 登记链接不证明远程内容不可变；本地资产字节只认 `asset_media`，生产 MP4 只认私有媒体对象及其清单。

* `model_calls.response_json` 可用于故障复盘，但禁止复制到事件、指标投影或公开导出。

* 独立视频和小说生图没有完整金额账本时，成本必须记为 `unknown`，不能套用整集生产的估算值。

## 4. 命名、ID 与 schema 版本



| 项目                   | 统一规则                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| PostgreSQL 物理字段      | 保持 `snake_case`，不因数据目录另建同义列。                                                                     |
| JSON、事件和 Data API 字段 | 使用 `camelCase`。                                                                                  |
| 新事件类型                | `<domain>.<aggregate>.<event_name>`，例如 `production.run.budget_raised`；旧事件名保留映射，不批量改写。            |
| 新 schema ID          | `lyra.<domain>.<fact>/v<major>`；已有 `ohao-production/1`、`asset-run-evidence/1` 等继续有效，由目录登记，不强制改名。 |
| 指标 ID                | `lyra.<domain>.<metric_name>.v<major>`；任何分子、分母、过滤或状态含义变化都升级主版本。                                  |
| ID                   | 程序生成的不透明字符串；只在声明的作用域内唯一。禁止按名称、创建时间或数组位置猜测身份。                                                     |
| 版本键                  | 不可变内容使用 `revisionId` 或内容摘要；可变聚合使用 `version` CAS；事件顺序使用 `(runId, sequence)`。三者不可互换。               |
| 摘要                   | 内容摘要是小写十六进制 SHA-256；摘要算法或规范化规则变化时升级 schema，不能沿用旧字段假装同口径。                                         |

每个跨包或事件结构必须包含 `schemaVersion`。目录记录其位置、Owner 和兼容级别；没有进入目录的结构不得成为 #49～#55 的输入契约。

## 5. 时间契约

统一使用三种时间，禁止混用：



* `occurredAt`：业务事实实际发生或状态生效的时间。

* `recordedAt`：权威系统把事实持久化或事件写入 outbox 的时间。

* `processedAt`：某个投影处理该事实的时间，只保存在投影检查点，不回写事件。

规则：



1. PostgreSQL 使用 `TIMESTAMPTZ`；JSON/Data API 使用带时区的 ISO 8601 字符串，输出统一为 UTC `Z`。

2. 不可变记录的 `createdAt/created_at` 同时作为初始 `occurredAt` 与 `recordedAt`；可变记录用 `updatedAt/updated_at` 表示当前版本时间，历史时间从追加记录或事件获得。

3. 现有 outbox 只有 `createdAt` 时，它同时承担 v1 的 `recordedAt`；#49 若区分业务发生时间，必须新增可选 `occurredAt`，不能改写旧事件含义。

4. 投影必须保存 `(source, projectionVersion, lastEventId/lastSequence, processedAt)`；重放不得刷新原事件的 `occurredAt`。

5. `startedAt < endedAt`、`createdAt <= updatedAt` 是校验规则；时钟异常进入数据质量隔离，不自动改写成当前时间。

## 6. 货币、用量与成本



* 币种字段为 ISO 4217 三位大写代码；金额为整数 `*Micros`，一货币单位等于 1,000,000 micros，禁止使用浮点累加。

* JSON 数值必须是 JavaScript 安全整数；超过安全范围时新契约使用十进制字符串并升级 schema，不能静默舍入。

* `estimate/reserve/release/charge` 是不同账目；可用预算为 “上限－有效 charge－未释放 reserve”。`estimate` 不是成本，`release` 不是收入。

* `actualCostMicros` 只有在供应商返回可核验金额时才代表供应商实报；带 `billingBasis=estimate` 或 `basis=frameAssessmentCeiling` 的值必须标为预算扣减估算。

* 成本事实至少携带 `currency`、`basis`、`sourceOperationId`、`recordedAt`；缺少任一关键口径时标 `unknown`。

* 跨币种报表分行展示；只有存在带日期和来源的汇率版本时才允许折算，#48 不定义汇率。

## 7. 错误类别与未知结果

所有新事件和 Data API 错误摘要使用统一的 `errorCategory`，同时保留原始 `code` 用于排查：



| `errorCategory`   | 含义与现有映射示例                                           |
| ----------------- | --------------------------------------------------- |
| `validation`      | 输入、结构或确定性规则不通过；对应 `validation`、`*_INVALID`。         |
| `versionConflict` | 基准版本、CAS 或幂等请求冲突；对应 `versionConflict`、`*_CONFLICT`。 |
| `storyAmbiguity`  | 关键剧情事实未确认。                                          |
| `quality`         | 具体质量门槛未通过；必须区分技术与语义检查。                              |
| `budget`          | 预算不足、授权缺失或费用边界不可保证。                                 |
| `configuration`   | 模型、迁移、存储或必要配置缺失。                                    |
| `execution`       | 本地执行、媒体处理或内部任务失败。                                   |
| `provider`        | 已明确的外部供应商失败，不包含结果不明。                                |
| `permission`      | 无读取、操作、导出或保留期处理权限。                                  |
| `unknown`         | 提交或结果无法确认；不是失败，也不能转成成功。                             |

`status=unknown` 与 `errorCategory=unknown` 都必须保留 `operationKey/providerTaskId`（若存在）供对账。禁止仅因 `providerTaskId=null`、`response_json=null` 或历史字段缺失就创建第二次付费任务。

## 8. 授权、敏感级别与保留期

### 8.1 敏感级别



* `public`：可公开的契约文档和不含业务值的 schema 目录。

* `internal`：普通 ID、状态码、版本号、无内容的安全指标。

* `confidential`：小说 / 剧本原文、计划快照、提示词、媒体、审核意见、成本、供应商响应和可关联到项目的业务明细。

* `secret`：API key、令牌、鉴权头、私钥和私有连接明文；只允许现有服务端私有配置使用。

事件最高只允许携带 `internal` 数据；若业务需要读取 `confidential` 内容，通过带项目授权的数据查询另行获取，不把内容塞进事件。

### 8.2 逻辑权限

`project:read/write`、`asset:read/write`、`production:read/operate`、`cost:read`、`evaluation:read/write`、`retention:purge` 是后续 Data API 必须执行的逻辑 scope。当前本地单用户部署没有完整多用户权限系统，本契约不宣称这些 scope 已经实现。

### 8.3 保留期类别



* `project_lifetime`：项目 / 小说及其版本、资产和审核历史保留到获得明确授权的删除；v1 无自动 TTL。

* `run_lifetime`：运行、外部操作、账本、交付和相关评测至少保留到运行及其交付被授权清理，且对账不再需要进行；v1 无自动 TTL。

* `replay_lifetime`：outbox 保留到所有需要它的投影均能重建且备份周期结束；清理必须经过数据 Owner 评审，不能只按 `delivered_at` 删除。

删除必须同时处理数据库引用和 media 字节，并输出删除清单。需要保留匿名指标时，先证明不可逆且不含原文、媒体、供应商标识或可关联 ID。

## 9. 事件兼容规则

同一主版本内只允许：



* 新增可选字段；

* 新增消费者可忽略的事件类型；

* 在不改变旧枚举含义的前提下追加枚举值，消费者必须把未知枚举按 `unknown` 处理而非崩溃。

以下变化必须升级主版本并保留旧版本读取能力：改名、删字段、改类型、改单位、改状态含义、改分子 / 分母、改摘要算法、收紧旧数据无法满足的必填约束。

消费者必须忽略未识别字段；生产者不得把完整业务 JSON 当作事件 payload。事件 payload 只包含白名单中的 ID、版本、时间、状态、错误摘要、摘要值、用量和带币种 / 依据的金额。

## 10. 投影迁移、回填、回滚与废弃

### 10.1 新投影或升级



1. 创建带新版本号的投影和检查点，不覆盖旧投影。

2. 从权威来源或 outbox 幂等回填；同一 `eventId` 或 `(runId, sequence)` 不得重复入账。

3. 记录 `completeness=complete|partial|unknown` 与原因，缺失值不猜。

4. 按记录数、关键 ID、版本、状态分布和金额分组对账；差异进入隔离区。

5. 对账通过后切换只读流量，保留旧投影到回滚窗口结束。

### 10.2 历史回填

回填任务必须有 `backfillId`、输入范围、schema / 规则版本、开始 / 结束时间、成功 / 失败 / 未知计数和检查点。只写目标投影，不反写业务表，不触发模型、媒体生成或付费操作。

### 10.3 回滚

优先回滚读取指针或消费者代码，保留新事件和新投影以便排查。禁止用删除新事件、篡改历史账本或把未知改成失败来回滚。涉及数据库迁移的回滚必须先备份并证明旧代码不会破坏新数据。

### 10.4 废弃

字段、事件或指标废弃时，必须登记 Owner、替代项、开始废弃版本、停止写入版本和读取移除版本。所有消费者完成迁移前继续可读；到期后先停写再移除，不能只改文档。

## 11. 变更与验收

ADR、权威来源矩阵和 JSON 目录必须在同一变更中更新。新增字段或指标时，Owner 必须同时给出：权威来源、键 / 版本、时间、不可变性、保留期、权限、敏感级别和兼容策略。

\#49～#55 的设计与 PR 必须引用 `lyra-data-governance/1`；如果必须偏离，先修订本 ADR 和目录，不允许在子任务里另立一套口径。

端到端验收使用[小说到交付链](../data-governance/authority-matrix.md#6-小说到交付链验证)，检查 ID、版本、时间和权限均无歧义。目录另用 JSON Schema 和跨引用检查验证。

## 12. 影响与非目标

收益是后续事件、血缘、指标、成本、评测和 Data API 可以共用同一套事实定义。代价是新增字段需要维护目录，重复副本需要明确降级为投影，部分历史数据必须保留 `unknown`。

本 ADR 不创建完整投影、Data API、UI 或新的业务状态机，不宣称已有逻辑权限已经实现，也不要求一次性清理全部历史 JSON。