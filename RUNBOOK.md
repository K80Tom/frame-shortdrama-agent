# RUNBOOK — 运行、验证与交付

> 初版：2026-11-11。命令默认在所属 worktree 根目录执行。先确认分支、工作区和目标环境；不要把开发命令直接用于共享或生产数据库。命令是已配置入口，不构成执行授权；历史结果不等于当前证据，未执行的命令必须明确标注。

## 1. 前置条件

- Node.js `>=22.19.0` 与 npm；数据库/Compose 场景需要 Docker。
- 已阅读 [AGENTS.md](AGENTS.md)；跨包、迁移、付费或媒体改动同时阅读 [DECISIONS.md](DECISIONS.md) 和 [RISKS.md](RISKS.md)。
- 不提交 `.env`、Token、真实账号、私有 URL、供应商原始响应或个人路径；未获明确授权不触发付费模型、部署或推送。
- 个人机器专用端口、环境别名和补充命令可记入被忽略的 `RUNBOOK.local.md`，模板见 [RUNBOOK.local.example.md](RUNBOOK.local.example.md)；具有团队复用价值的稳定步骤应回归本文件。

## 2. 首次安装与构建

```sh
git status --short --branch
node --version
npm run setup
npm run build
```

`setup` 安装并链接各包依赖；`build` 按 shared → agent → main → cli → web 顺序执行。新 worktree 独立安装和构建，不复用其他 worktree 的 `dist` 结论。

## 3. 本地开发

```sh
npm run db:up
npm run db:migrate
npm run dev       # main，http://127.0.0.1:8788
npm run dev:web   # web，http://127.0.0.1:5173
```

`db:migrate` 会修改 schema，只指向约定的本地/测试库；执行前核对环境变量和目标库。`LYRA_RUNTIME_ROLE=all` 是开发兼容模式，不是 Stage 1 部署拓扑。更完整的模型配置见 [本地开发](packages/main/docs/本地开发.md)。

## 4. 验证与验收

```sh
npm run docs:check
npm test
npm --prefix packages/agent test
npm --prefix packages/main test
npm --prefix packages/web test
npm --prefix packages/main run test:db
```

- 根 `npm test` 会先完整构建，再跑 agent/main/web 测试；前端改动还需真实浏览器体验验收。
- `test:db` 需要已启动并迁移的真实 PostgreSQL；RLS/迁移测试按对应文档使用非特权角色和隔离数据库。
- 记录实际命令、日期、HEAD、通过/失败/跳过数量及环境。跳过、未运行、既有失败和本轮失败必须分开，不能统称“全绿”。
- 离线桩只证明离线范围；真实 PG、Milvus、对象存储、模型、浏览器和目标部署分别验收，不跨层外推。
- 文档改动先运行 `npm run docs:check`，检查必需入口、本地链接、个人文件误提交、共享 NOW/MAP 的个人状态、忽略规则和索引大小，再执行 `git diff --check`；CI 的 `Project records` job 使用同一命令做只读复核。未运行产品测试时明确写“仅静态校验”。

## 5. CLI 与付费边界

```sh
npm run cli -- doctor
npm run cli -- project list
npm run cli -- run create --project <id> --script-version <id> --duration 60 --budget 30
npm run cli -- run submit
```

`run create` 只生成冻结计划，`run submit` 才可能提交付费执行；必须遵循“估价/计划 → 人工确认 → 提交”。外部结果 unknown 时查询原任务并对账，不重新提交。session 认证模式下，CLI 在受控会话接入前不作为生产管理入口。

## 6. Stage 1 部署与恢复

标准拓扑和完整步骤以 [deploy/README.md](deploy/README.md) 为准，编排文件为 [deploy/compose.yaml](deploy/compose.yaml)。前置条件：独立密钥已填写、公开 HTTPS Origin 已确定、迁移管理员与应用角色分离、只发布 Web 入口，且不预置默认密码。

```sh
cd deploy
test -f .env || cp .env.example .env
docker compose config --quiet
docker compose up -d
```

首次管理员、注册开关、云 provider、备份与回滚必须继续按部署手册执行。Compose 启动成功不代表公网多租户、Secret/KMS、PITR 或故障恢复验收完成；恢复顺序见 [生产路线 §10](docs/production-architecture-roadmap.md)。

## 7. 开发交付

1. 从最新 `origin/dev` 创建主题分支和独立 worktree；先定义契约与验收场景，再实现和自验。
2. 完成目标包测试、全量构建/测试及必要的人工体验；保存真实结果和限制。
3. 项目里程碑或验收变化时更新共享 [NOW.md](NOW.md)，个人接续只更新 `NOW.local.md`；能力变化同步 [feature-status.md](docs/feature-status.md)，长期决策或风险分别登记。
4. 检查 `git status`、实际 diff 和 `git diff --check`，不裹入他人的未提交改动。
5. 经明确授权后推送，用 `gh pr create --base dev` 并完整填写 PR 模板。高风险改动等待非作者真人批准；不直接推送 main，不自行发布或合并。
