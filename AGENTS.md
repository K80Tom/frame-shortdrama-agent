# Lyra monorepo 工程指南

## 1. 仓库定位

本仓库是短剧智能生产系统 **Lyra** 的 monorepo。唯一的应用代码在 `packages/`；`reference/` 是旧平台的只读精选参考，不参与构建、测试或部署。

```text
packages/
  shared/   公共契约与类型（模型、生产、资产、小说领域），零服务依赖
  main/     数据与付费主权：NestJS API、PostgreSQL 与迁移、生产 DAG、媒体链、模型密钥
  agent/    智能能力层：AI 工作区编排、只读工具、估价状态机（纯逻辑库，不起服务）
  web/      React 工作台（含 AI 工作区侧栏）
  cli/      命令行客户端
```

## 2. 跨包硬约束（必须遵守）

1. **只有 `main`** 能持有模型密钥、连接 PostgreSQL、执行付费提交与媒体写入。
2. **`agent` 不 import 数据库驱动、不读取密钥环境变量、不监听端口**；需要数据时通过 `shared`/本包定义的接口获取，由 `main` 注入实现（本地为进程内调用，未来可换 HTTP 实现）。
3. **`web` 与 `cli` 只是客户端**：运行时只调用 `main` 的 HTTP API，不直连模型或数据库。共享类型统一来自 `@lyra/shared`，不要从 `main` 内部实现文件反向 import。
4. **付费纪律**：任何付费动作都必须"估价/计划 → 人工确认 → 提交"。`cli` 的 `run create` 只生成计划，`run submit` 才提交；AI 工作区只允许生成估价确认卡，建卡不扣费。
5. 公共契约（请求/响应、错误、事件、领域类型）放在 `shared`；新增跨包类型优先进 `shared`，不要在包间互相引用内部实现。

## 3. 协作与分支纪律

- **双主干分支模型（`dev` 集成，`main` 发布）**：
  - `main`：生产就绪发布分支，代表稳定可发布版本。受分支规则保护，禁止直接推送或普通 PR 合入。
  - `dev`：主日常集成分支。所有日常新功能（`feat/*`）、修复（`fix/*`）与重构从最新 `origin/dev` 创建短分支，通过 PR 统一合入 `dev`。
  - **发版 PR（`dev → main`）**：由版本负责人发起，必须通过全量构建测试并由至少一名非提交者负责人真人 Approve 才能合入。
- **Worktree 开发隔离**：
  - 任何功能或修复都必须从最新 `origin/dev` 创建独立短分支和专属 worktree（`git worktree add ../lyra-<topic> -b feat/<topic> origin/dev`），一个 worktree 只开发一件事；不得在主工作区或其他任务的 worktree 中开发、暂存或提交。
  - 各 worktree 独立安装依赖、构建和测试并错开服务端口；数据库迁移只在约定环境执行。验证后通过 PR 合入 `dev`，合并完成后移除对应 worktree 与已合并分支。
- **审查与合并治理**：
  - GitHub Actions 仅作为只读 CI 门禁，严禁持有写入权限、模型密钥或自动合并能力。代码审查与合并由已连接的 GitHub App PR 管家或真人维护者执行。
  - 低风险 PR 只有在目标为 `dev`、当前 head 的 required checks 全绿、与最新 base 同步、无冲突、无未解决线程或有效 `CHANGES_REQUESTED`，且完整 diff 审查确认有明确项目收益时，才允许 PR 管家 squash 合并。
  - 修改 `.github/**`、`AGENTS.md`、`CODEOWNERS`、数据库迁移、`shared` 公共契约、认证授权、付费/媒体/预算链路，或总改动超过 300 行的高风险 PR，必须由至少一名非作者开发者针对当前 head 真人批准；代码更新后旧 Approval 作废。
  - 发版 PR（`dev → main`）始终属于高风险范围，除全量构建测试外必须满足上一条真人批准要求，不允许自动绕过 ruleset。
- 按模块设置负责人：共享契约、数据库迁移、付费链路和跨包改动必须由对应负责人评审。团队使用 `CODEOWNERS` 落实审核责任，但不借审批流程替代实际验证。
- `shared` 契约变更先说明兼容性与影响范围，再修改调用方；旧数据回退、迁移与回滚路径必须明确。人数增长时优先加强模块负责与自动化，不引入无实际需要的长期分支。

## 4. 常用命令

在仓库根目录：

```sh
npm run setup        # 安装各包依赖（file: 链接 shared/agent）
npm run build        # 按 shared → agent → main → cli → web 顺序构建
npm test             # 构建并运行后端与前端全部测试
npm run dev          # 启动 main：http://127.0.0.1:8788
npm run dev:web      # 启动 web：http://127.0.0.1:5173
npm run db:up        # 启动本地 PostgreSQL
npm run db:migrate   # 应用数据库迁移
npm run cli -- ...   # 使用命令行客户端
```

按包验证：

```sh
npm --prefix packages/main test        # 后端测试（含 assistant、production、novel 等）
npm --prefix packages/web test         # 前端测试
npm --prefix packages/main run test:db # 真实 PostgreSQL 持久化测试（需已启动并迁移）
```

## 5. 变更纪律

- 不提交密钥、Token、真实账号、私有 URL、供应商原始响应或个人本地路径；`.env`、`node_modules`、`dist`、`outputs` 已在根 `.gitignore`。
- 未经用户明确授权，不推送、不部署、不触发付费模型或媒体生成；测试一律使用桩模型。
- 修改功能时同步更新相关文档、样例、校验与测试；未实际运行的验证不得宣称通过。
- 提交前检查 `git status`，不要把他人的未提交改动裹进不相关的提交。
- `reference/` 只读：引用旧平台规则时在 `packages/` 内用本地等价物实现，不恢复旧平台的数据库、对象存储、密钥或部署体系。
- `树干转场复刻/` 等素材目录不属于代码迁移对象，不要改动。

## 6. 已知边界与后续方向

- 剧本/小说拆解的领域实现目前仍在 `main`（`src/breakdown`、`src/novel`）；后续把 repository 留在 `main`、纯领域逻辑下沉到 `agent`，与 assistant 保持同一边界。
- 技术复核不等于视觉语义审核；3D 为 prompt-only；声音依赖供应商原生音轨。
- 阶段规划：五层提示词与视觉化转译、跨项目资产库与白名单匹配、知识库与长期记忆。
