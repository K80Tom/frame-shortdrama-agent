# #123 阶段 C：Run 绑定与冻结执行核心

状态：分阶段实现，**阶段 C 与整个 Issue 尚未完成**。基线 `origin/dev ceacfa9`，接续 PR #144 的冻结输入基础库；同 Issue 更新既有 PR，不另提重复依赖 diff。

## 已落地

- Snapshot 可选 executionPolicy（画幅、风格、时长、质量档、导演策略）进入 digest。旧正文保持可读和原 digest，没有该字段不能从当前默认值补齐后创建新冻结 Run。
- 闭合请求只允许 snapshotId、snapshotDigest、clientRequestId、allowPaid；main-owned exact-version resolver 必须核验领域 owner 的全内容/版本/授权，尚未实际装配生产入口。
- 创建核心固定全部运行配置/预算/候选策略，校验冻结归属、镜头集合/摘要/来源链、实际检索参数摘要及方法引用集合；task manifest、created event 均绑定 snapshotDigest。幂等重试不重读当前 Registry。
- 037 为 production_runs 增加 JSON 生成列、workspace/project 复合 FK；SQL guard 验证真实 frozen 状态、策略/预算，禁止 V2 原地修改冻结字段，也禁止普通 UPDATE 将 V1 冒充已迁移。
- 新租户 Run 事件走 DataEventV2/workspace，仍与领域变化同一 DataOutbox 事务；真实非特权测试发现并修正了旧 V1 事件误落 legacy workspace 的问题，旧历史事件不重写。
- Run-ID Reader 从持久绑定恢复精确历史快照；没有绑定则 LEGACY_INPUT_INCOMPLETE，不从 current/active 指针补齐。
- 服务层在 prepare/reconcile 前重读并核验冻结 bundle，将其以独立副本传入执行器；支持标识未声明或装配缺失时拒绝进入旧可变读取器。摘要包裹 snapshotDigest，付费 operation key 与预算 attempt 因而绑定同一输入。
- 付费或非零成本执行在持久 claim 后、供应商调用前要求 main-owned 当前授权/能力复查。缺失/撤权明确未提交、按零实际费用释放预留，不误标为未知扣费；查询已有外部操作不创建新付费提交。
- 实际 Preflight、Breakdown、Storyboard 执行器已适配：只消费冻结引用/ShotSpec，不再生成/采用当前版本。Storyboard 用冻结 ShotSpec 顺序、版本及参数派生镜头任务，而不是按可变项目重建。冻结全局资产引用不再跑旧重检索/生成协调器；真正的镜头资产任务仍是后续媒体消费门禁。

## 验证（2026-11-09）

- 新增/扩展冻结 Run 单元测试 13/13：拒绝 override、缺授权、getter、旧快照补默认值；不可变/幂等/并发；实际源执行器零当前读取；篡改 bundle 与未适配执行器在 claim 前拒绝；固定桩的 paid operation 摘要/恢复不重提；撤权和缺适配的零费用结算。
- 真实 PostgreSQL 17.6、非特权 RLS 4/4；既有 DB 27/27；升级 037 成功。真实来源生命周期额外验证：项目已采用新剧本后，按 Run ID 用新连接恢复原快照，三个全新 ProductionService 实例先后运行实际 Preflight/Breakdown/Storyboard 并派生精确旧镜头，所有 current-reader/generator 用 Proxy 禁用，调用数为零；没有外部操作或费用。
- 全包构建成功；后端全量 702 通过、1 个既有 Windows drawtext 字体失败、3 跳过（#111 修复），未删/跳过断言。不把本地全量称为通过。
- 模型 transport、付费操作单元测试为固定桩；领域能力/策略仍为显式 oracle，真实来源/冻结/Run/事件为 PostgreSQL。没有付费调用、真实云 HEAD 或进程级 Worker 杀进程/租约接管演练；新服务实例恢复不等同于完整 Worker 容灾验证。

## 剩余工作与启用边界

还未接 HTTP/客户端或默认启用 V2；旧 Run API 行为不变。需要实际完成资产包/导演场景/控制图精确版本读取、Director/Assets/Video 以及候选/评测/合片/交付执行器适配，不能把未适配路径的拒绝当成完成。正式 profile/resolver/领域 owner、当前付费权限/能力复查实现、V1CompatibilityReader、历史回填/灰度、跨镜头影响和完整编辑→执行→交付 E2E 仍缺。

冻结证明的是历史输入，不是永久付费授权。本次核心服务测试不等于完整生产 E2E。合并前必须与 #124 前置契约对齐，并由非作者真人审查当前 head；不自动合并，不删除已有冻结事实以回滚。
