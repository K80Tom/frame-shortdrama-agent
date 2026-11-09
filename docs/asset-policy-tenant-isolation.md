# 资产检索策略治理：workspace 隔离增量

日期：2026-11-08。关联：#128；基线：dev 0622a35。Owner：main / evolution 维护者。

## 状态与边界

本增量仅修复 Registry 和审计流的平台全局写入，不代表 #128 整体完成。模块仍只治理 threshold、ambiguityMargin、semanticWeight，不训练模型、不自动修改 Prompt 或资产。

现有 evidence/proposals/candidates/probes 已由 025/030 隔离；042 将 evolution_registry 与 evolution_registry_events 加入同样的 workspace NOT NULL、写入 guard、ENABLE/FORCE RLS。策略主键和事件 revision 唯一约束均包含 workspace；采用/回滚的 advisory lock 也按 workspace 分开。事务 scope 来自真实会话和 Worker 的受信上下文，不接受请求 body 指定所有者。

同一失败签名在不同 workspace 下生成不同 proposal key/id，因此不会因旧全局唯一键相互阻断或合并证据。未提供 tenant 的本地兼容工具保留旧 proposal ID；显式 system 工具只读取保留 workspace 的 Registry，而不是任意 workspace 的第一行。未授权的普通运行路径仍由数据库 RLS 拒绝；system scope 不是普通用户或 workspace owner 的平台管理权限。

采用/回滚继续使用人工请求、expectedPolicyDigest CAS 和追加式审计；同时间戳事件按 revision 排序。旧 Production Run 的冻结策略和既有结果不被改写。新 workspace 从默认策略开始，不继承其他 workspace 已采用的参数。

## 升级、兼容与回滚

1. 停止旧版 API/Worker 的治理写入，备份数据库；使用迁移管理员执行 `npm --prefix packages/main run db:migrate`。
2. 042 在事务内新增列、复合约束和 RLS；旧 Registry/不可变事件通过 ADD COLUMN 常量默认值归属 `ws_00000000000000000000000000000000`，不 UPDATE 原 JSON、不删除历史、不复制到其他租户。随后移除默认值，由事务 scope 写入 guard 提供所有者。保留 workspace 已由 first-admin bootstrap 接管时，原策略继续只属于它。
3. 部署新 API/Worker；API/Worker/session 和 first-admin bootstrap 要求迁移 042。未迁移时不得继续启用旧全局治理路径。普通客户端 DTO 不变，不需要重写旧运行或媒体。
4. **不可直接把旧镜像回滚到新 schema 上继续治理写入**：旧代码的 ON CONFLICT(domain) 已不适用，也不具备新隔离边界。应用故障时停止治理写入，优先向前修复；确需全量版本回退时，停写并从迁移前一致备份恢复，在隔离环境核验后再切换。不要删除 workspace 列、合并多个租户的策略或重写不可变事件来“回滚”。
5. PostgreSQL 应用角色必须非 superuser、无 BYPASSRLS；RLS 不声称约束迁移管理员。测试只使用独立临时数据库，不能把测试连接指向生产。

## 验证入口

- `npm run build`：全部包构建。
- `npm --prefix packages/main test`、`npm --prefix packages/web test`：既有回归。
- `DATABASE_URL=<非特权测试应用角色> DATABASE_ADMIN_URL=<隔离测试管理员> npm --prefix packages/main run test:rls`：真实 PostgreSQL 的迁移兼容、RLS、Service、真实数据库会话 HTTP、并发 CAS、陈旧回滚和不可变审计；已接入既有 CI 的 test:rls，不修改 workflow 权限。
- 数据库测试使用随机 fixture；不可变审计不通过删除/禁用 trigger 清理，应在结束后销毁整个专用测试数据库。

代码：`packages/main/migrations/042_evolution_registry_tenancy.sql`、`packages/main/src/evolution/{evidence,service,postgres-repository}.ts`。自动化证据：`packages/main/tests/evolution-tenant-isolation.db.test.cjs`、`asset-evolution.test.cjs`。

## #128 尚未交付

真实检索遥测与授权数据集、真实 Embedding/Milvus shadow probe、有界参数搜索、canary、真实评测指标与采用门槛、终态 Outbox 自动 Evidence、产品命名和 UI 改造仍需后续实现。固定 6 案例仅是无付费契约测试；本增量没有真实供应商质量证据，也没有真实调用或自动采用。不能以本测试通过宣称策略召回提升或整体上线验收完成。

## 本地验证记录（2026-11-08）

Node 24.15.0 / Windows。使用仅监听 127.0.0.1 的独立 PostgreSQL 17.6 测试实例（不是内存数据库或 SQL mock），当时完整执行 001–032（本 PR 未合并草稿编号）的迁移；下述旧计数为历史，不代表最新基线验证。非特权应用角色已由 verifyTenantRole 校验；升级测试另外实际执行带旧 Registry/审计数据的 019 → 原 032 草稿（现改名 042）的变换，确认原 JSON、ID、revision 和不可变 trigger 保留。

- 全部包构建通过。
- test:rls：10/10，通过且无跳过，包含跨租户三角色、真实数据库会话 HTTP、并发采用与回滚、system 工具保留 workspace 限制。
- test:db：27/27，通过且无跳过，包含既有生产/Outbox/租约/对象存储事务矩阵。
- evolution/auth/worker/migration 定向回归：32/32；前端：117/117。
- 完整后端：645 项，641 通过、3 项 Windows 符号链接平台跳过、1 项既有 FFmpeg drawtext 字体失败。dev 的字体列表仅含 macOS/Linux 路径；此工作树未改 composer 或该断言，独立修复在 PR #111。没有删/跳过/放宽断言来制造全绿，因此不宣称本机 npm test 全套通过。Linux CI 仍需对当前提交独立验收。

这里只证明上述离线/数据库行为；没有真实模型、真实检索召回质量或生产部署演练结果。

## 2026-11-09 最新 dev 同步与验证

维护者已合并 #144/#146，dev b264844 正式占用 032_canvas_documents 与 039_assistant_turns。本 PR 原 032_evolution_registry_tenancy 尚未合并，改为 042，未改动已合并历史 SQL 或篡改任何数据库迁移记录；040 留给 #147 对象版本，041 留作工具/MCP 并行协调。若使用过本 PR 旧草稿测试库，必须使用独立新库验证或审计后人工迁移，不能把旧 schema_migrations 的 032 名称/校验和直接改成新编号冒充升级成功。

已保留正式 Canvas 的 032 就绪检查，并仅将本 PR 的安全基线/治理/first-admin 检查切换到 042。test:rls 合并保留当前 dev 的生产输入/来源保留套件与本 PR 的 evolution 套件，不能解决冲突时删除任一侧的测试。最新验证结果见下文。

### 最新本地验证结果（2026-11-09，b264844 基线）

- 全新专用 lyra_evolution_042_test 实际执行 001–039 与 042（本 PR 不引入并行未合并 040/041），正常迁移成功；旧测试库的迁移表没有被改号或修改校验和。
- test:rls 14/14，无跳过：包含 4 类应用角色真实集成（evolution 父用例含 7 个子用例）、3 项管理员临时 schema 迁移；不是 14 个独立 RLS 实验。生产输入/保留与本 PR 隔离测试同时执行，没有丢掉 dev 的测试。
- test:db 27/27（管理员测试连接，不作为 RLS 证据）；全包构建通过；Web 135/135。
- 后端全量 717 项：713 pass / 1 项既有 Windows drawtext 字体失败（#111）/ 3 平台 skipped，未改或放宽字体断言。
- 新增迁移版本预检：在连接数据库前拒绝相同版本号的两个文件（即使 SQL 完全相同），并检查正式 032 Canvas、039 Assistant 与 042 Evolution 保持独立。只读文件预检不改 SQL 或已应用历史；SQLite/mock 不能替代上述真实 PG 验证。
- 没有真实模型、Embedding/Milvus 查询质量或部署多进程演练；当前 head CI 仍须单独验证。该 PR 继续是高风险权限/迁移改动，必须非作者真人审核，不自动合并。
