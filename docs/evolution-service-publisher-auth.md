# Evolution 服务层发布鉴权（Refs #164）

- 日期：2026-11-11；owner：ffffff55；分支：`fix/evolution-service-publisher-auth`。
- 基线：`dev 53ea98823a6e1db608766027c2fbfeda669fe963`；状态：部分交付、待真人评审。
- 这是已合入 #169 的补充，不关闭 #164，不替代权威评测来源修复。

## 行为与兼容性

`EvolutionGateRepository.authorizePublisher` 是必需端口。bindGate、approve、reject、startCanary、observe、stopCanary、promote、rollback 在命令事务内、读取业务对象之前调用它；直接调用 Service 或经 Tool 调用同样受限，不能绕过 HTTP Controller 获得发布权限。

PostgreSQL 校验事务设置的 `lyra.workspace_id` 和 `lyra.user_id`，并加载数据库中有效的 workspace_members、users、workspaces；必须为 active human owner/admin；service/migration 身份不能冒充人工发布者。输入 actorId 如提供，必须与当前主体相同。旧上下文声称 owner 但成员已降级/停用、用户禁用、工作区暂停、伪造 actor、租户不符或缺少上下文均返回 403。observe 没有 actorId 字段，仍必须存在可信租户用户及实时发布权限；不为 system bypass 或 Worker 伪造人工身份。

成员、用户、工作区记录通过 `FOR SHARE` 锁定至整个命令事务提交；并发撤销需等待先开始的授权命令结束，撤销完成后的新命令拒绝执行。没有使用客户端 role、请求体 actor 或过期上下文 role 作为最终授权事实。

InMemory 仓储默认拒绝发布。测试/本地嵌入若确需放行，必须显式注入可信同步 publisherPolicy；该策略跟随 scoped snapshot，不提供默认全放行兼容降级。自定义仓储实现必须增加此端口。HTTP 请求字段不变，无 shared 改动、无 SQL 迁移、无新预算/Outbox。

## 已实际验证

- `npm run build` 全包构建成功。同步最新 dev 后曾遇到 file: shared 副本未刷新的 Web 类型错误；重新构建 shared，并对 Agent/Web 执行 `npm ci --install-links` 后重跑成功，不修改依赖版本掩盖问题。
- Gate/Canary、HTTP RBAC、检索治理定向测试 27/27；InMemory 默认拒绝覆盖 8 个发布命令，原有成功场景显式使用受控策略。
- PostgreSQL 17、非特权应用角色：事务/RBAC 定向测试 7/7。member/viewer 调用 8 个服务命令均拒绝且所有治理表完全不变；owner/admin 实际会员校验放行；伪 actor、无上下文、租户不符、inactive member、disabled user、suspended workspace、service/migration 身份和 system bypass 拒绝。原有 Revision 冲突/审计故障/零行 CAS/并发唯一赢家仍通过。
- 使用真实并发数据库连接与 `pg_stat_activity.wait_event_type = Lock` 验证撤权被授权事务阻塞；释放事务后撤权完成，后续鉴权拒绝。不是只靠 sleep 推断锁存在。
- `npm --prefix packages/main run test:db`：45 项，44 pass、1 管理员连接下旧 RLS skip；本次安全测试使用独立非特权连接，无跳过。
- `npm --prefix packages/main run test:rls`：26/26，无跳过；Agent 44/44、Web 140/140。
- Main 全套 1015 项：1008 pass、2 fail、5 skip。两项为未改动的 Windows workflow 路径分隔符与 LocalBlobStorageDriver 路径故障，已在干净 dev 复现；没有删除或弱化断言，不声称本地 npm test 全绿。精确 head Linux CI 另行记录。

## 仍未完成

- bindGate 仍接受旧客户端评测 metrics/results；即便调用者是 owner/admin，也不能据此宣称权威证据。仍须正式 Evaluation/Gate ID、冻结 Run/Result、有效期、授权/费用、Baseline Registry 及同条件校验。
- 本测试证明服务发布授权及事务，不证明真实评分器、视觉质量、遥测真实性或整套 Tool Registry/MCP 的所有授权语义。
- 无真实供应商/付费调用，无自动批准或合并；涉及授权安全，必须由非作者真人针对最终 head 明确批准。
