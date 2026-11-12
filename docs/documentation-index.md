# 文档有效性目录

最后盘点：2026-11-12；适用源码快照：`dev 2470f90`，加本 PR 文档增量。下表“最后修改”由 `git log -1 origin/dev -- <文件>` 查询，不是验收日期，也不表示该文件所有说法已重新验证。

当前工程/分支/审查安全规范以[根 AGENTS.md](../AGENTS.md)为准，能力边界以[功能台账](feature-status.md)分层记录；[生产架构路线](production-architecture-roadmap.md)是目标规范，不将未完成部署和故障演练写成现状。已有设计文档中的产品目标、技术候选与真实验收必须分别理解。

旧 OHAO / FRAME 名称和运行时兼容变量不能仅为改名直接删除。旧 agent 文件名保留兼容入口，正文和 applyTo 仅指向现行 packages 路径，不能借历史命名恢复旧分支/权限规则。`reference/` 为只读历史参考，不属于可运行产品。

| 文档 | dev 最后修改日期 / 提交 | 盘点适用快照 | 有效性与边界 |
| --- | --- | --- | --- |
| [项目工作区读模型](project-workspace.md) | 2026-11-12 / 本 PR | `fix/script-parse-feedback`（基于 dev 2470f90） | #182 六区段、结构化剧本、AI 解析与历史、对白修复和警告后采用；含真实 PostgreSQL 定向与隔离浏览器桩验收，未验真实付费供应商 |
| [项目入口收敛](project-entrypoints.md) | 2026-11-11 / 本 PR | `feat/project-entrypoints`（基于 dev df976eb） | #181 导航/新建/旧路由；真实浏览器+模拟 HTTP，不代表 #180 整体闭环 |
| [异构媒体预设协议拦截](media-preset-protocol-containment.md) | 2026-11-11 / 本 PR | `fix/media-preset-protocol-guard`（基于 dev df976eb） | #174 执行绑定/v3 升级/匹配路由及冻结能力校验；未验真实供应商，其他预设仍不可执行 |
| [AGENTS.md](../AGENTS.md) | 2026-11-08 / e5d3e42 | dev b264844 + 本 PR 文档增量 | 当前工程/分支/安全与真人审批规范；本 PR 不修改它 |
| [README.md](../README.md) | 2026-11-09 / 5b3af19 | dev b264844 + 本 PR 文档增量 | 当前入口与能力概览；不得替代功能台账或端到端验收 |
| [packages/main/README.md](../packages/main/README.md) | 2026-11-09 / 5b3af19 | dev b264844 + 本 PR 文档增量 | 当前 main 操作入口；命令存在不等于目标环境已部署 |
| [docs/data-event-contract.md](data-event-contract.md) | 2026-11-08 / 653c912 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [docs/agent-runtime-recovery.md](agent-runtime-recovery.md) | 2026-11-10 / 本 PR 新增 | `feat/resumable-agent-runtime` + 本 PR 文档增量 | #136A 恢复内核的范围、断点语义与验证边界；Worker/API 装配仍待后续 PR |
| [docs/ai-assisted-engineering-workflow.md](ai-assisted-engineering-workflow.md) | 2026-11-10 / 本 PR 新增 | `feat/ai-spec-workflow` + 本 PR 文档增量 | AI 辅助工程化 4 拍流水线指南、跨包硬约束与测试门禁规范 |
| [docs/director-scene-versions.md](director-scene-versions.md) | 2026-11-09 / bc9cc42 | dev b264844 + 本 PR 文档增量 | 已合并切片的进度/边界记录；文中测试/fixture 需按其适用提交理解，本轮未重跑 |
| [docs/documentation-index.md](documentation-index.md) | 2026-11-09 / 本 PR 新增 | dev b264844 + 本 PR 文档增量 | 本文档有效性与 Git 元数据目录；日期不是验收日期 |
| [docs/evolution-service-publisher-auth.md](evolution-service-publisher-auth.md) | 2026-11-11 / 本修复新增 | `fix/evolution-service-publisher-auth`，dev 53ea988 | 服务层实时成员鉴权与撤权锁实测；不替代权威评测来源 |
| [docs/evolution-publication-atomicity.md](evolution-publication-atomicity.md) | 2026-11-10 / 本修复新增 | `fix/evolution-authoritative-gates`，dev cc837c7 | #164 局部事务/HTTP权限修复；PG故障注入证据，权威评测及内部RBAC仍未完成 |
| [docs/evaluation-data-governance.md](evaluation-data-governance.md) | 2026-11-08 / 653c912 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [docs/evaluation-run-contract.md](evaluation-run-contract.md) | 2026-11-08 / 653c912 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [docs/feature-status.md](feature-status.md) | 2026-11-10 / 本 PR 新增 | dev ddd33d3 + 本 PR 文档增量 | 本 PR 更新的能力快照/证据入口；待审 PR 不算已合入 |
| [docs/frozen-production-run-progress.md](frozen-production-run-progress.md) | 2026-11-09 / bc9cc42 | dev b264844 + 本 PR 文档增量 | 已合并切片的进度/边界记录；文中测试/fixture 需按其适用提交理解，本轮未重跑 |
| [docs/production-architecture-roadmap.md](production-architecture-roadmap.md) | 2026-11-08 / e5d3e42 | dev b264844 + 本 PR 文档增量 | 当前目标架构规范；Stage 1–3 的目标不等于已经实现 |
| [docs/production-input-snapshot-progress.md](production-input-snapshot-progress.md) | 2026-11-09 / c7a86ef | dev b264844 + 本 PR 文档增量 | 已合并切片的进度/边界记录；文中测试/fixture 需按其适用提交理解，本轮未重跑 |
| [packages/main/docs/asset-evolution.md](../packages/main/docs/asset-evolution.md) | 2026-11-01 / a85a7d9 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/extraction-guide.md](../packages/main/docs/extraction-guide.md) | 2026-11-01 / 8501454 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/Lyra全流程自动制片实现-v0.1.md](../packages/main/docs/Lyra全流程自动制片实现-v0.1.md) | 2026-11-02 / 7a78e2c | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/Lyra全流程自动制片构思-v0.1.md](../packages/main/docs/Lyra全流程自动制片构思-v0.1.md) | 2026-11-01 / 439befb | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/候选计划-P0.3.md](../packages/main/docs/候选计划-P0.3.md) | 2026-11-01 / 8501454 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/单条视频自动化.md](../packages/main/docs/单条视频自动化.md) | 2026-11-01 / 8501454 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/受控阶段执行-P0.4.md](../packages/main/docs/受控阶段执行-P0.4.md) | 2026-11-01 / 8501454 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/小说拆解评测-2026-10-23.md](../packages/main/docs/小说拆解评测-2026-10-23.md) | 2026-11-01 / 8501454 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/小说资产引用.md](../packages/main/docs/小说资产引用.md) | 2026-11-01 / 8501454 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/小说逐章拆解.md](../packages/main/docs/小说逐章拆解.md) | 2026-11-02 / 4c5b27c | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/工程规范与协作指南.md](../packages/main/docs/工程规范与协作指南.md) | 2026-11-03 / bea94d6 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/总体设计.md](../packages/main/docs/总体设计.md) | 2026-11-08 / e5d3e42 | dev b264844 + 本 PR 文档增量 | 产品目标与约束参考；不是全部功能已验收清单 |
| [packages/main/docs/技术架构.md](../packages/main/docs/技术架构.md) | 2026-11-08 / e5d3e42 | dev b264844 + 本 PR 文档增量 | 架构/实现映射参考；需要结合当前台账、源码和限制，不外推成部署验收 |
| [packages/main/docs/持久化-P0.2.md](../packages/main/docs/持久化-P0.2.md) | 2026-11-01 / 8501454 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/数据结构-v0.1.md](../packages/main/docs/数据结构-v0.1.md) | 2026-11-02 / 4c5b27c | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/本地开发.md](../packages/main/docs/本地开发.md) | 2026-11-03 / 050f993 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/模型接入.md](../packages/main/docs/模型接入.md) | 2026-11-01 / 8501454 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/模型接入验证.md](../packages/main/docs/模型接入验证.md) | 2026-11-01 / 8501454 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/流程问题诊断与重构-v0.1.md](../packages/main/docs/流程问题诊断与重构-v0.1.md) | 2026-11-02 / 299be52 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/独立模型配置.md](../packages/main/docs/独立模型配置.md) | 2026-11-11 / 本 PR 增量 | `fix/media-preset-protocol-guard`（基于 dev df976eb） | 更新 v3 执行绑定/旧文件迁移与回退入口；未验真实供应商，其余历史段落不构成新验收 |
| [packages/main/docs/豆包桌面一键资产.md](../packages/main/docs/豆包桌面一键资产.md) | 2026-11-01 / 8501454 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/豆包桌面资产验证.md](../packages/main/docs/豆包桌面资产验证.md) | 2026-11-01 / 8501454 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |
| [packages/main/docs/首个里程碑实现.md](../packages/main/docs/首个里程碑实现.md) | 2026-11-01 / 8501454 | dev b264844 + 本 PR 文档增量 | 模块/历史参考；本轮未逐段重新核验，不构成当前工程规则或真实供应商验证 |

新增或提升文档有效性时，必须由 owner 对照源码/测试复核；若有真实环境或供应商结果，记录适用提交、日期、模型/环境、脱敏产物和预算，不用“文档更新/Issue关闭/PR通过”代替验收。

本 PR #109 尚待审核。待审 #110–#114、#121–#122、#132、#145、#147 的分支专用文档未合入本快照，不在这里冒充 dev 证据；后续合并后重新登记日期、范围与实际验证。合并/审批状态是 GitHub 快照，后续变更需刷新功能台账，不能根据静态列表自动批准或合并。
