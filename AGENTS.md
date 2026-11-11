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

1. **只有 `main`** 能持有模型密钥、连接 PostgreSQL、执行付费提交，以及授权、验真并最终确认媒体写入。
2. **`agent` 不 import 数据库驱动、不读取密钥环境变量、不监听端口**；需要数据时通过 `shared`/本包定义的接口获取，由 `main` 注入实现（本地为进程内调用，未来可换 HTTP 实现）。
3. **`web` 与 `cli` 只是客户端**：控制面只调用 `main` 的 HTTP API，不直连模型或数据库。Stage 1 允许客户端使用 `main` 签发的短期、单对象、单操作签名 URL 与对象存储传输字节，但客户端不持有存储凭据，对象验真和 `ready` 状态仍由 `main` 提交。共享类型统一来自 `@lyra/shared`，不要从 `main` 内部实现文件反向 import。
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
- **PR 创建与模板纪律**：
  - 普通开发 PR 必须通过 CLI 创建，优先使用 `gh pr create --base dev`；环境没有 `gh` 时，使用 `curl` 调 GitHub REST API。严禁把 base 设为 `main`；`main` 只接受版本负责人发起的 `dev → main` 发版 PR。
  - 必须完整填写 `.github/PULL_REQUEST_TEMPLATE.md`，严禁原样提交空白模板：按实际改动把适用的 `[ ]` 改为 `[x]`；把 `Fixes # 或 Refs #` 替换为真实 Issue 号（如 `Fixes #76`）；改动概括必须列出具体的 1、2、3 点。
  - 用户已明确授权创建或提交 PR 后，若连接器只渲染表单而未真正创建，直接改用上述 CLI 完成同一操作，不再把表单交给用户点击或要求重复确认。创建后必须回读 PR 编号、URL、base/head、正文与 diff；只有表单或“成功”提示不得宣称已创建。目标或范围改变、缺少必填信息、凭据或权限失败时才暂停并说明。
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

## 6. 生产架构长期约束

- 生产架构与分阶段演进以 [docs/production-architecture-roadmap.md](docs/production-architecture-roadmap.md) 为准。文档中 Stage 1–3 是已定稿目标；实现、README 和部署文档必须区分“当前已实现”与“目标架构”，不得把尚未落地的容器、命令、数据表或高可用能力写成现状。
- **PostgreSQL 是结构化业务状态与元数据的唯一事实源。** 用户、workspace、成员、项目、完整对话、任务、权限、费用、对象引用与 Outbox 不得只保存在 Redis、Milvus、本地文件或消息系统；大型媒体的权威字节保存在对象存储。
- **Redis 是 Stage 1 必需的对话上下文快照、限流、实时推送与短期协调层。** 完整消息和任务最终状态仍落 PostgreSQL；Redis key 携带 `workspace_id`、快照携带会话版本，所有数据必须可重建或安全失效。
- **Milvus 是 Stage 1 必需但可重建的向量投影。** 资产目录、原文与权限仍以 PostgreSQL/对象存储为准；向量必须携带 `workspace_id` 和来源版本，检索命中后回 PostgreSQL 核验。付费 Embedding 和重建继续遵守显式授权、预算、冻结版本与审计纪律。
- **图片、音频、视频、原始文件、中间产物和成片的目标事实字节进对象存储。** 应用只依赖统一 `ObjectStorage` 端口；私有化/开发可选 MinIO，云环境选 S3、OSS 或 COS 之一。数据库保存 provider/bucket/object key/version/checksum/size 等元数据，不保存临时签名 URL。客户端直传只能使用 `main` 签发的最小权限 URL 写 staging key，由 `main` 验证 size/type/checksum 后才转为正式资产。迁移期现存 `asset_media.content BYTEA` 只是已记录的 Stage 1 例外；在它完成对象化迁移前，文档与发布说明必须如实披露，不得宣称所有媒体字节已迁移。
- **API 与 Worker 在 Stage 1 分进程/容器，但保持同仓库和 `@lyra/main` 主权边界。** API 不保存本机独有业务状态；Worker 执行模型、Embedding、媒体和 FFmpeg 任务，并必须实现原子领取、租约、心跳、步骤检查点、幂等与超时恢复。
- **跨存储同步统一经 PostgreSQL 事务 Outbox。** 复用现有 `data_outbox_events` / `DataOutbox` / `DataDispatcher` / `DataProjector`，不再建第二套 Outbox；禁止请求代码对 PostgreSQL 与 Redis、Milvus 或 Kafka 做不可恢复的直接双写。
- **租户上下文端到端传递。** Stage 1 的 Repository、任务、新版事件、Redis key、Milvus filter 与对象元数据均携带 `workspace_id`；私有对象只经短期签名 URL 访问，最终资源授权由 PostgreSQL 检查。现有 `DataEventV1` 不原地改摘要语义；租户事件通过版本化契约和可回滚迁移引入。
- Kubernetes、Kafka、数据库分片和跨地域双活不属于 Stage 1。它们只在路线文档定义的多机调度、独立消费者、吞吐、SLO 或灾备条件被实测触发后引入。

## 7. 已知边界与后续方向

- 剧本/小说拆解的领域实现目前仍在 `main`（`src/breakdown`、`src/novel`）；后续把 repository 留在 `main`、纯领域逻辑下沉到 `agent`，与 assistant 保持同一边界。
- 技术复核不等于视觉语义审核；3D 为 prompt-only；声音依赖供应商原生音轨。
- 阶段规划：五层提示词与视觉化转译、跨项目资产库与白名单匹配、知识库与长期记忆。
