# MAP — 路径、版本与同步边界

> 初版：2026-11-11。本文件由团队共享，只保存稳定的仓库路径和同步规则，不记录个人绝对路径、密钥或本地账号。实际 worktree 映射放入被 Git 忽略的 `MAP.local.md`，模板见 [MAP.local.example.md](MAP.local.example.md)。

## 代码与资料映射

| 路径 | 内容 | 同步 / 修改边界 |
| --- | --- | --- |
| `packages/shared/` | 跨包公共契约、领域类型 | 零服务依赖；变更先说明兼容性，再改调用方，高风险评审 |
| `packages/agent/` | AI 编排、只读工具、估价状态机、方法包索引 | 不连数据库、不读密钥、不监听端口；由 main 注入实现 |
| `packages/main/` | NestJS API、PostgreSQL/迁移、生产 DAG、媒体与模型链 | 独占数据、密钥、媒体确认和付费提交主权 |
| `packages/web/` | React 工作台 | 只调用 main HTTP API；共享类型来自 `@lyra/shared` |
| `packages/cli/` | 命令行客户端 | 只调用 main API；`run create` 计划与 `run submit` 提交分离 |
| `deploy/` | Stage 1 Compose、镜像、Nginx 与部署手册 | 只发布 Web 入口；实际部署与验收记录不写入路径表 |
| `docs/` | 当前架构、能力证据、专题进度与治理文档 | 先读 [documentation-index](docs/documentation-index.md) 判断有效性 |
| `design-system/lyra/` | 视觉规范与界面说明 | 界面改动同步核对，不把设计稿当作功能验收 |
| `reference/` | 旧平台精选参考 | **只读**，不参与构建、测试、部署，不恢复旧密钥/存储体系 |
| `history/` | 有复用价值的过程归档 | 不是当前状态源；当前项目状态回 [NOW.md](NOW.md) |

## Worktree 使用规则

新功能或修复从最新 `origin/dev` 建短分支和专属 worktree，例如 `git worktree add ../lyra-<topic> -b feat/<topic> origin/dev`。一个 worktree 只做一件事，独立安装依赖、构建和测试并错开端口；不得在其他主题的 worktree 中开发或提交。

个人用 `git worktree list` 刷新 `MAP.local.md` 的实际映射，合并完成后按真实状态清理已合并 worktree/分支及本地失效项。共享 MAP 不随安装、拉取或 worktree 增减机械更新。

## 版本与文档边界

| 需要判断的内容 | 使用入口 | 不采用的做法 |
| --- | --- | --- |
| 当前产品概览 | [README.md](README.md) + [功能台账](docs/feature-status.md) | 不根据目录、截图或旧演示推断已实现/已验收 |
| 当前工程规则 | [AGENTS.md](AGENTS.md) | 不用旧 OHAO/FRAME 文档恢复旧权限或分支规则 |
| 目标生产架构 | [production-architecture-roadmap.md](docs/production-architecture-roadmap.md) | 不把 Stage 1–3 目标写成当前事实 |
| 分阶段开发过程 | `docs/*progress*.md`、专题修复文档、[history/](history/) | 不用过程记录覆盖最新功能台账 |
| 早期 v0.1 / P0.x 设计 | `packages/main/docs/` 对应命名文档 | 不将历史构思、旧数据结构和旧命令当作现行契约 |
| 旧平台实现 | `reference/` | 不复制旧平台部署、数据库或密钥体系到 packages |

## 分支同步边界

- `dev` 是日常集成分支；普通 PR 必须 `gh pr create --base dev`，并完整填写模板。
- `main` 只接受版本负责人发起的 `dev → main` 发版 PR；功能分支不得直接以 main 为 base。
- 数据库迁移只在约定环境执行；本地未提交/未跟踪内容不自动属于任何任务，提交前检查 `git status` 和实际 diff。
- 本文件不记录安装、拉取、推送或发布流水；有长期价值的证据按主题进入 `history/` 或 PR 验收记录。
