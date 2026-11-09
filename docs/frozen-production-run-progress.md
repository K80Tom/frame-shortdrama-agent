# #123 阶段 C：Run 绑定开发检查点

状态：本地开发，尚未提交新的 PR，**阶段 C 尚未完成**。独立 worktree 从最新 origin/dev `ceacfa9` 创建后快进依赖 PR #144 的 `2fc5199`；不向 dev 重复提交基础库 diff，#144 当前待审 head 不变。

## 本轮事实

- Snapshot 增加可选 executionPolicy（画幅、风格、目标时长、质量档、导演策略）。没有此字段的旧快照仍按原正文/digest 读取；不能按默认值或当前项目补齐后创建新冻结 Run。新增字段进入 snapshotDigest。
- 新建冻结 Run 请求只有 snapshotId、snapshotDigest、clientRequestId、allowPaid；闭合解析器拒绝创作/预算覆盖和 getter。main-owned exact-version resolver 负责来源与领域 owner 的全内容/版本/授权核验，尚未装配为生产接口。
- 创建核心校验冻结归属、逐镜头版本与摘要、实际检索参数摘要和方法引用集合；固定执行配置/预算/候选策略，所有 task manifest 和 created event 带 snapshotDigest。重复请求保留原事实，不重解析当前 Registry。
- Repository 不允许移除/替换绑定、改写冻结预算/检索参数或丢失 task manifest。
- 037 为 production_runs 增加由 JSON 生成的 snapshot ID/digest 列和 workspace/project 复合 FK。SQL guard 验证真实 frozen 状态、归属、策略与预算一致，V2 运行冻结输入禁止原地改写，V1 不能借普通 UPDATE 冒充已迁移。
- 新租户运行事件使用 DataEventV2 workspace；集成初测准确发现沿用 V1 会写入 legacy workspace 被 RLS 拒绝，现已修复。旧运行事件不重写。
- Run ID 恢复 Reader 从持久绑定读取精确快照，旧 Run 没有绑定则 LEGACY_INPUT_INCOMPLETE，不跟随项目 current/active 指针。

## 当前验证与边界

新增单元测试 8/8，相关回归共 17/17。真实 PostgreSQL 17.6 升级 037 成功，非特权 RLS 4/4，既有 DB 27/27。生命周期测试使用真实生成/采用来源、冻结和新连接恢复，额外覆盖 Run 物理绑定、幂等、V2 Outbox、直接 SQL 改绑定/预算/检索参数拒绝、非冻结引用拒绝；领域能力/策略 oracle 和模型 transport 桩不变，预算为零，未调用付费服务。

**还没有 HTTP/客户端入口，也未切换真实执行器。** 为避免未切换的执行器继续读取 current 项目，V2 Run 暂时被服务显式阻止进入旧执行路径；这只是开发中的安全防线，不是阶段 C 完成证据。下一步必须实际接通冻结 bundle 的 prepare/execute/reconcile、Director/Assets/Video 消费及 operation key/预算绑定，替换这条临时防线，再测试并提交。正式 resolver/profile、当前付费权限/能力复查、V1 兼容和灰度仍缺；不能把本文单元/数据库测试说成生产执行 E2E。

全包 `npm run build` 成功；前端 131/131。后端全量 697 通过、1 个既有 Windows drawtext 字体失败、3 跳过；该失败由 #111 处理，未删断言/跳过。专用 PostgreSQL 已停止，保留测试数据供后续续测。
