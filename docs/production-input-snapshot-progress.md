# #123 冻结输入开发检查点

日期：2026-11-09。基线：dev ceacfa9。状态：本地开发中，尚未提 PR，不代表完成阶段 A 或整个 Issue。

已对照新版十五项路线修正 ShotSpecV2 原型：浏览器安全 shared DTO/闭合解析器覆盖 episode、来源版本、机位/焦段/构图、对白语气、版本化资产包与对象版本/checksum、七类控制（含 edge）、连续性、声音时间窗、生成策略和根 sourceRefs。未知机位/构图明确为 null，不冒充已验证控制。

main 计算/复核 contentDigest；规范化内容不含版本记录 ID、创建时间和创建者，字段顺序不影响摘要。不可变记录检查另比较完整记录，不能因内容摘要相同就允许原地修改审计字段。单镜头比较可区别画面、对白、字幕、时长等对下游节点的影响，但还不是跨镜头完整依赖图。

shared/main 构建通过，定向回归实际验证；未调用任何供应商。解析/摘要通过不是来源授权、许可、审核、对象存在或真实媒体验真。它们必须由后续 Repository/编译器与 PostgreSQL/对象存储共同检查，不能只凭客户端提交的 digest 宣称正式快照 ready。

仍待交付：ProductionInputSnapshot/比较/错误公共 DTO、当前项目只读候选编译、真实引用与来源校验；随后阶段 B 的不可变持久化/CAS/Outbox、阶段 C 的强制 Run 冻结与执行器改造、阶段 D 影响投影、阶段 E 显式 V1 兼容/灰度/回滚。现有 Production runtime 尚未切换；不能把新增文件存在当作历史运行漂移问题已解决。

根共享入口暂不导出新运行时模块；未来 Web/CLI 复用浏览器安全子入口，避免引入旧 shared 总入口的 Node crypto 依赖。最终提交 PR 前需完成可执行闭环及全套相关验证，而非提交空契约 PR。

## Snapshot 契约检查点

已补 ProductionInputSnapshot、版本引用、状态/缺失项及公共错误分类 DTO，以及 main 的内容摘要计算/复核。摘要覆盖有序镜头版本、来源版本、预算、策略、模型与能力等冻结输入，排除快照自身 ID、审核状态、findings 和创建审计；状态与审批权限仍必须由受信事务决定，计算摘要不能把客户端 ready 标记变成有效凭证。

shared/main 构建通过，镜头+快照契约回归 18/18（含真实浏览器 realm 的无 Node 加载）。仍未接通只读项目编译、引用授权/对象校验、数据库持久化和 Run；这些测试不能证明完整阶段 A 或历史冻结闭环已经完成。

## 引用验证核心检查点

新增 main 只读验证核心：先校验受信 tenant/project 访问，再解析精确 ShotSpec 版本、摘要和来源链，检查清单闭包、对象版本/checksum、资产包与媒体绑定、控制产物与对象绑定、原文范围、模型能力和 Gate；越权、缺失、篡改与能力不兼容分别报告。客户端即使提供 frozen 标志也必须重新执行全部检查。没有数据库写入或付费调用。

当前回归总计 24/24；其中验证适配器使用明确的服务桩，不能把它们当真实 Repository/ObjectStorage 授权证据。仍需实现实际项目读取/候选编译与这些只读端口的正式适配，然后才能称阶段 A 可执行闭环完成。验证报告不直接修改快照状态，不是可重用的授权凭证；采用/冻结时仍须在事务中重新检查项目 revision 和授权。

## 真实 PostgreSQL 来源读取检查点

新增 PostgresProductionInputSourceReader，直接复用 projects/script_versions/plan_revisions/storyboard_revisions，单条 MVCC SQL 读取同一视图的当前采用输入，JOIN 同时限制 workspace/project/script/plan 血缘。缺失或不匹配的来源返回 null，不能编造已就绪版本。inputSetDigest 仅是输入集合指纹，不冒充数据库单调 project revision 或 CAS 计数器。

历史原文校验按精确 scriptVersionId 查询，不跟随当前项目指针，复核原文字节摘要及 Unicode 码点引用。真实本地 PostgreSQL 17.6 + 非特权 NOBYPASSRLS 应用角色测试通过：跨租户不可读、错误项目不可读、emoji 范围精确、项目切换后历史引用仍有效、原文摘要错误被阻断。test:rls 2/2（含既有隔离回归），相关契约测试 24/24；已接入既有 test:rls 入口。没有真实模型调用。

这还不是完整编译器：仍需版本化 ShotSpec 读取/采用、episode 与 project revision 正式模型、对象/资产包/方法包/模型能力等正式验证适配，以及候选 Snapshot 构造；不能把来源 reader 或 inputSetDigest 当作完整 Run 冻结已完成。

## 不可变版本底座检查点（033，尚未发布）

新增正式 episode 归属、不可变 shot_spec_versions、带版本 FK 的 shot_spec_heads。全部使用 workspace 复合 FK 和 FORCE RLS；版本 JSON 的身份/digest envelope 必须与列一致（包括拒绝 JSON null），不可 UPDATE/DELETE。只是数据库底座，尚无可用的采用 API/Repository，也未发布领域事件，不能因此宣称完整采用已交付。

projects.input_revision 为真实 bigint 计数器，现有 script/plan/storyboard 指针变化由数据库 trigger 自动递增，展示字段变化和外部直接伪改计数器不会递增。Snapshot 的 baseProjectRevision 改为无精度损失的十进制字符串；reader 返回真实计数器而不是拿 inputSetDigest 冒充 revision。后续 ShotSpec head 正式采用还必须接通同事务的项目 revision 推进与 Outbox，当前计数器只覆盖旧三类采用指针，不能声称覆盖新正式镜头采用。

已在全新专用 PostgreSQL 17.6 数据库实际应用 001–031、033（没有依赖未合并的 #132/032）。非特权角色 test:rls 2/2，额外验证计数器、episode/version 租户 FK、null 身份拒绝、版本不可变、错误 shot/version head 外键拒绝；相关契约24/24。第一次本地迁移草案数据库不继续复用，新验证库名为 lyra_input_versions_test。无真实模型调用。

## 采用事务与统一 Outbox 检查点（以本节覆盖早期 counter 限制）

已修订尚未发布的 033：正式 ShotSpec head 插入/变更通过嵌套 trigger 原子推进 projects.input_revision；同版本 no-op 不推进，外部直接伪改 counter 仍被抑制。增加 PostgresShotSpecRepository 的 episode/create/get/adopt：不可变版本重复创建不追加事件，采用要求 expectedCurrentVersion + expectedProjectRevision，锁定项目/当前 head，校验失败回滚，viewer 写入拒绝。采用事务接受 main 内部的同事务只读引用验证回调，绝不作为客户端代码执行入口。

创建和采用使用既有 DataOutbox transaction 发布 shot_spec.created.v2 / shot_spec.adopted.v2，不新建队列。shared 聚合枚举新增 shot_spec，034 对既有 Outbox 的 aggregate_type CHECK 做兼容扩展；旧事件/摘要不重写。真实数据库发现缺少该 CHECK 扩展会使 Outbox 插入失败，现已通过 034 修正，不隐藏失败或跳过事件。

已在全新 lyra_shot_adoption_test 库执行 001–031/033/034；非特权 PostgreSQL 验证创建幂等、一事件、跨租户读取拒绝、校验失败回滚、并发采用仅一个成功、项目 revision 2→3、旧 CAS 冲突、同 head no-op 不额外推进、只追加一次采用事件。test:rls2/2；既有 DB 矩阵27/27；契约/事件相关31/31；构建通过。采用回调在此事务测试中是桩，仅证明事务/CAS/Outbox，不证明真实资产授权已接通。

旧测试库上的 033 草案不再用于当前迁移 checksum 验证。仍需正式引用验证适配、候选编译、Snapshot 记录/采用/冻结、HTTP/客户端与 Run 执行器切换后，才能交付整个 #123。
