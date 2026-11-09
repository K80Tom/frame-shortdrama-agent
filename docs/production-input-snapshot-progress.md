# #123：冻结输入基础库（分阶段交付）

基线：`origin/dev` 的 `ceacfa9`。本改动交付阶段 A 的契约/编译核心、阶段 B 的持久化/事务服务，并接续阶段 C 的核心（见下文补充）；**不关闭 #123，不代表生产 Run 已切换到冻结输入**。

## 已实现范围

- shared 公共入口导出 ShotSpecV2、ProductionInputSnapshot、引用、错误、解析器与冻结输入 DTO。解析器无 Node 依赖，闭合字段、有界复制并拒绝 getter、稀疏数组、循环与未知字段。
- main 计算/核验规范化 digest；镜头字段比较提供单镜头下游影响摘要，尚非跨镜头影响图。
- PostgreSQL 权威来源 Reader 以单 MVCC 查询读取正式来源与有序镜头 head；Compiler 只读生成 draft，不执行模型、不自行采用、不伪造缺失版本。
- 不可变 ShotSpec、分集、正式 head、Snapshot 正文/有序引用/独立状态。采用执行版本与 project revision 双 CAS；变更原子推进 project revision。
- 同事务验证/冻结：draft → validating → ready/blocked；freeze 对 ready 重新校验。失败回滚状态及事件；frozen 不可变，同版本重试幂等。
- 复用统一 DataOutbox，不另建队列；事实事件带 workspace、稳定 ID、摘要与最小审计信息。
- workspace 复合外键、FORCE RLS；来源保留 FK 防止已验证/冻结快照的 script/plan/board 被删。
- Frozen Reader 只按冻结 ID 和 digest 恢复历史来源/镜头；项目采用新剧本后不跟随 current/active 指针。

## 未实现与安全边界

- 尚无 Controller、HTTP/客户端入口、正式 profile 解析/领域 owner 装配；这些类不会改变现有 Run 创建路径。
- Run 创建、报价、预算预留、Worker/Director/资产/视频执行器尚未接入，当前 Run 读取可变项目的根问题仍待后续阶段解决。
- 检索策略、方法/Prompt 包、模型能力、预算策略、质量 Gate 等精确版本由各领域 owner 提供。默认未注册 adapter 明确 blocked，不能把测试 oracle 当作生产准入证据。
- 对象验真读取真实 PG 元数据，HEAD 为桩测试；未实际验证 S3/MinIO。无 provider versionId 的后端返回 CAPABILITY_INCOMPATIBLE，不以 ETag/本地路径伪造版本。
- 冻结记录不是永久授权凭证；真实执行前仍须重新检查权限、能力、预算与人工付费确认。
- 尚无跨镜头影响图、局部派生、V1CompatibilityReader、历史 Run 回填、灰度切换或完整 E2E。
- Snapshot 契约本次为尚未发布的基础版本；后续执行策略/Run 绑定变化必须审查 schema 兼容，不能从当前项目补充字段后冒充冻结事实。

## 迁移、兼容与回滚

新增 033–036，不修改旧 Run JSON 或旧业务读取器。033 为既有项目增加 input_revision，旧来源采用路径也通过触发器推进它；034/035 扩展现有 Outbox 聚合枚举。036 对 ready/frozen 保留精确历史来源，孤儿链导致整笔迁移失败回滚，不能跳过或猜测替代来源。

部署须先备份并在隔离 PostgreSQL 演练全部迁移；与 #124 的实际运行时/对象存储/Worker 契约对齐后才可批准合并。不要在已有验证数据上直接 DROP 或删除保留引用。应用回滚保留新增事实和约束，旧应用不启用本次服务；未来启用新入口时需独立功能开关与回滚演练。本次没有开启付费入口，也没有完成线上回滚演练。

shared 新增导出不删除旧 DTO；Outbox 枚举是向前扩展，下游不认识的新事件不得当成已投影成功。合并前必须由非作者真人审查当前 head（公共契约、迁移和权限均属高风险）。

## 本地验证（2026-11-09）

- 根目录 `npm run build`：shared/agent/main/cli/web 全部成功（现有 Vite 大 chunk 警告保留）。
- ShotSpec/production-input 定向单测：38 通过；无 DB 环境的同次命令另有 3 个 DB 测试跳过，**不计为通过**。真实 DB 测试另行运行如下。
- 非特权应用角色 `test:rls`：4/4，通过真实来源生成/采用、冻结、撤权转 blocked、并发 CAS、事务回滚、跨租户拒绝、新连接恢复历史内容、来源保留和 036 回填/孤儿原子回滚。
- 既有 PostgreSQL `test:db`：27/27（管理连接执行旧测试）；RLS 证据仅来自上述非特权测试。
- 前端：131/131。
- 后端全量：689 通过、1 失败、3 跳过；失败为既有 Windows FFmpeg drawtext 字体问题，同步 dev 的独立 #132 worktree 可复现同一失败，修复由 #111 处理。本 PR 未改媒体路径、未删除/跳过该断言；不能声明本地全量通过，交付还需 Linux CI 验证当前 head。
- 模型 transport 为固定桩；策略/能力域显式 oracle；没有真实付费调用，没有真实云对象 HEAD，也没有进程级 Worker 接管演练。

测试专用 PostgreSQL 与业务服务隔离。不得把上述库级/数据库验证描述为完整生产编辑→执行→交付 E2E。

## Run 核心接续说明

后续已增加 Run 不可变绑定/037 物理约束、按 Run 恢复与冻结输入服务上下文，以及实际 Preflight/Breakdown/Storyboard 的消费；此节更新早期“尚无 Run 绑定”的开发边界。最新范围、验证和未完成项以 [冻结 Run 核心说明](frozen-production-run-progress.md) 为准。仍没有 HTTP/默认切换，媒体执行器/正式 owner 装配及整个 #123 尚未完成。
