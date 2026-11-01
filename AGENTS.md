# OHAO monorepo 工程指南

## 1. 仓库定位

本仓库是短剧智能生产系统 **OHAO** 的 monorepo。唯一的应用代码在 `packages/`；`reference/` 是旧平台的只读精选参考，不参与构建、测试或部署。

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
3. **`web` 与 `cli` 只是客户端**：运行时只调用 `main` 的 HTTP API，不直连模型或数据库。共享类型统一来自 `@ohao/shared`，不要从 `main` 内部实现文件反向 import。
4. **付费纪律**：任何付费动作都必须"估价/计划 → 人工确认 → 提交"。`cli` 的 `run create` 只生成计划，`run submit` 才提交；AI 工作区只允许生成估价确认卡，建卡不扣费。
5. 公共契约（请求/响应、错误、事件、领域类型）放在 `shared`；新增跨包类型优先进 `shared`，不要在包间互相引用内部实现。

## 3. 常用命令

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

## 4. 变更纪律

- 不提交密钥、Token、真实账号、私有 URL、供应商原始响应或个人本地路径；`.env`、`node_modules`、`dist`、`outputs` 已在根 `.gitignore`。
- 未经用户明确授权，不推送、不部署、不触发付费模型或媒体生成；测试一律使用桩模型。
- 修改功能时同步更新相关文档、样例、校验与测试；未实际运行的验证不得宣称通过。
- 提交前检查 `git status`，不要把他人的未提交改动裹进不相关的提交。
- `reference/` 只读：引用旧平台规则时在 `packages/` 内用本地等价物实现，不恢复旧平台的数据库、对象存储、密钥或部署体系。
- `树干转场复刻/` 等素材目录不属于代码迁移对象，不要改动。

## 5. 已知边界与后续方向

- 剧本/小说拆解的领域实现目前仍在 `main`（`src/breakdown`、`src/novel`）；后续把 repository 留在 `main`、纯领域逻辑下沉到 `agent`，与 assistant 保持同一边界。
- 技术复核不等于视觉语义审核；3D 为 prompt-only；声音依赖供应商原生音轨。
- 阶段规划：五层提示词与视觉化转译、跨项目资产库与白名单匹配、知识库与长期记忆。
