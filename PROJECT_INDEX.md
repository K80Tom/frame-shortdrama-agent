# Lyra 项目索引

> 初版：2026-11-11。当前产品基线为 `v0.2.0 / Stage 1 单受信 workspace 试运行`。本文件只做定位、摘要与路由，不替代工程规则、功能证据或验收记录；项目状态未变化时不机械更新日期。

## 项目定位

Lyra 是面向中文短剧生产的 TypeScript monorepo，把小说/剧本拆解、资产、分镜、空间预演、镜头生成、候选选择、复核、返修与 FFmpeg 合片组织成可检查、可恢复、可交付的生产链。应用代码位于 `packages/`，`reference/` 仅是旧平台只读参考。

当前主链、工作台、PostgreSQL 事实源及多个 Stage 1 基础设施基线已有实现。**实现不等于目标环境验收**：旧调度迁移、资产图片对象化、公网签名与对象 GC、向量回填、密钥托管、备份/PITR 和恢复演练仍有缺口；`asset_media.content BYTEA` 是已披露的媒体存储例外。当前待验收项见 [NOW.md](NOW.md)。

## 按任务选择入口

| 要做什么 | 先读 | 使用方式 |
| --- | --- | --- |
| 看项目里程碑、阻塞或待验收 | [NOW.md](NOW.md) | 团队共享；任务归属与合并状态回 Issue/PR |
| 接续个人开发 | `NOW.local.md` | 记录个人分支、HEAD、下一步；被 Git 忽略，模板见 [示例](NOW.local.example.md) |
| 找代码、文档或版本边界 | [MAP.md](MAP.md) | 团队共享稳定路径；实际 worktree 见被忽略的 `MAP.local.md` |
| 安装、运行、构建、测试、交付 | [RUNBOOK.md](RUNBOOK.md) | 先满足前置条件；机器差异可用被忽略的 `RUNBOOK.local.md` 补充 |
| 做架构取舍或解决设计冲突 | [DECISIONS.md](DECISIONS.md) | 先读现行决定；变更时新增/取代，不改写历史结论 |
| 迁移、付费、公开发布等高风险操作 | [RISKS.md](RISKS.md) | 按触发器读取风险与动作，不用测试绿灯替代安全验收 |
| 查过程与历史背景 | [history/](history/) | 先搜索再读命中上下文；不回填个人状态 |

## 权威事实与规则

| 内容 | 权威入口 | 边界 |
| --- | --- | --- |
| 工程、分支、审核和跨包约束 | [AGENTS.md](AGENTS.md) | 优先级高于本索引概括 |
| 产品能力与运行概览 | [README.md](README.md) | 概览不是端到端验收证明 |
| 能力状态、源码和测试证据 | [docs/feature-status.md](docs/feature-status.md) | 区分实现与验证、待审与已合入 |
| 文档有效性和适用快照 | [docs/documentation-index.md](docs/documentation-index.md) | 修改日期不是验收日期 |
| Stage 1–3 目标架构 | [docs/production-architecture-roadmap.md](docs/production-architecture-roadmap.md) | 目标不得反写成现状 |
| Stage 1 部署操作 | [deploy/README.md](deploy/README.md) | 公网、密钥、备份和恢复需独立验收 |

Git 是分支与 HEAD 的事实源，Issue/PR 是任务与评审状态的事实源；共享文档不复制个人高频状态。

## 代码速查

`packages/shared` 放公共契约；`packages/agent` 放无服务依赖的编排与纯逻辑；`packages/main` 独占数据库、密钥、媒体确认和付费提交；`packages/web`、`packages/cli` 只调用 main API。完整路径见 [MAP.md](MAP.md)。

## 记录维护约定

1. 项目里程碑或验收变化时更新共享 NOW；能力证据同步功能台账。个人状态只更新本地文件。
2. MAP 只保留稳定路径与同步边界；个人及时清理本地失效 worktree 映射，不堆发布流水。
3. RUNBOOK 保存可重复步骤；一次性输出进入带日期、提交和环境的脱敏历史记录。
4. DECISIONS 记录“为什么”，RISKS 记录“何时危险、如何控制”，history 记录可复用过程，不复制整段聊天。
5. 文档交付前运行 `npm run docs:check` 与 `git diff --check`；未实际运行的验证不得写为通过，真实模型、付费、部署和公网多租户结论必须有独立证据。
