# 候选发布事务与 HTTP 发布者权限（#164 局部修复）

- 日期：2026-11-10；分支：`fix/evolution-authoritative-gates`。
- 基线：`dev cc837c70887954495bd6bb0dfd6af6b1c8f9a356`。
- 状态：部分实现，必须经非作者真人审核；本变更不关闭 #164 或 #135。

## 实现范围

1. 两个治理 HTTP 入口的绑定、批准、拒绝、灰度、观测、停止、发布、回滚操作仅允许认证上下文中的 workspace owner/admin。body 中伪造 role/actor 不会增加权限。候选提案和评测启动不因此变为发布权限。
2. `EvolutionGateRepository.atomic` 是必需端口，没有逐条写入的兼容降级。全部写命令通过 scoped Service 执行；PostgreSQL 复用同一 tenant transaction/client，避免嵌套池连接或独立提交。Candidate、binding、rollout、Registry Revision、append-only audit 要么一起提交，要么全部回滚。
3. Promote 检查 Candidate expectedVersion、rollout expectedVersion 和 rollout CAS 返回值。Stop 同样校验调用方 Candidate 版本，不再静默采用当前版本。
4. Rollback 同事务追加 Registry Revision、更新 Candidate、暂停该 Candidate 的 active/paused rollout，防止回滚后继续路由。补齐共享状态机原本遗漏的 canary → rolled_back；paused/failed/promoted 的旧回滚路径保留。HTTP 字段不变，无 SQL 迁移。
5. InMemory 通过串行快照提交模拟命令事务；异常丢弃快照，读者不能看到未提交快照。生产仍以 PostgreSQL 为事实源。

## 已运行验证

- `npm run build` 全包构建成功。
- Gate/Canary + HTTP 角色测试 18/18；含并发配额和 InMemory 快照回滚。
- PostgreSQL 17、真实非特权应用角色：`node --test packages/main/tests/evolution-gate-atomic.db.test.cjs` 5/5，无跳过。实际数据库触发器注入 rollout 插入失败、Revision 冲突、最终审计失败、rollout 更新返回零行、Candidate 写失败；逐表比较失败前后完整 JSON，证明没有中间事实残留。两个并发 Promote 只有一个成功，Revision 仅追加一次；成功回滚后路由被拒绝，跨租户读取为空。
- `npm --prefix packages/main run test:db` 43 项：42 pass、1 skip（管理员连接下旧 RLS 检查跳过）；新事务测试仍使用独立非特权连接，不跳过。
- `npm --prefix packages/main run test:rls` 23/23，无跳过。
- Agent 35/35；Web 138/138。
- Main 全套 993 项：986 pass、2 fail、5 skip。两个失败是干净 dev 同样复现的 Windows 路径问题：workflow 文件发现返回反斜杠，以及 LocalBlobStorageDriver 合法路径被误判逃逸。没有改弱断言、跳过失败或声称 `npm test` 本地全绿。Linux 精确 head CI 另行核验。
- 数据库套件改为文件级串行，避免旧测试全表 TRUNCATE/全局 Outbox 断言相互污染；文件内并发场景仍实际运行。

## 未解决边界

- `bindGate` 仍接收旧的客户端 metrics/results。HTTP owner/admin 限制不等于可信评测，授权用户仍可自造通过证据；必须继续改成权威 Evaluation/Gate ID，并核验租户、subject/result digest、有效期、费用、Baseline Registry。
- 2026-11-11 补充：服务层发布命令已增加同事务实时成员鉴权，证据见[服务层鉴权](evolution-service-publisher-auth.md)；本节原始 HTTP fixture 仍不能代表真实数据库权限验证。权威评测来源仍待实现。
- 数据库测试使用受控评测 fixture，仅证明事务和隔离，不证明评测来源、真实评测器、模型质量或完整生产 E2E。
- 未调用付费模型、真实云供应商、未自动合并。没有新增第二套 Outbox，也未变更现有生产事件契约；本切片处理既有候选治理事务，不宣称统一生产发布链路已接通。
