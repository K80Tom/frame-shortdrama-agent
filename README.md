<div align="center">

<h1>OHAO</h1>

<p><strong>把一集剧本，自动推进成可检查、可恢复、可交付的短剧成片。</strong></p>

<p>面向中文短剧的 AI 制片工作台 · monorepo</p>

<p>
  <img src="https://img.shields.io/badge/status-early_preview-F59E0B?style=flat-square" alt="Early Preview">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB" alt="React">
  <img src="https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/FFmpeg-007808?style=flat-square&logo=ffmpeg&logoColor=white" alt="FFmpeg">
</p>

</div>

OHAO 把剧本拆解、资产准备、分镜、镜头生成、复核、返修和合片连接成一次完整的生产运行。每一步都有状态和输入，失败可以停在具体节点；刷新页面或重启服务后，可以从 PostgreSQL 保存的进度继续。

## 仓库结构

```text
frame-shortdrama-agent/
├── packages/
│   ├── shared/   # 公共契约：模型与生产的请求/响应、错误、资产与小说领域类型（零服务依赖）
│   ├── main/     # 数据与付费主权：NestJS API + PostgreSQL + 生产 DAG + 媒体链 + 模型密钥 + 迁移
│   ├── agent/    # 智能能力层：AI 工作区编排、只读工具、估价状态机（无状态、不持密钥、不连数据库）
│   ├── web/      # React 工作台（含 AI 工作区侧栏），只调 main 的 HTTP API
│   └── cli/      # 命令行客户端，只调 main 的 HTTP API；付费遵循 计划 → 人工确认 → 提交
├── reference/    # 旧平台精选参考（合同 / 架构 / 拆解实现，只读，不参与构建）
└── AGENTS.md     # 工程规则与跨包硬约束
```

**边界（写进 AGENTS.md 的硬约束）**

1. 只有 `main` 能持有模型密钥、连接 PostgreSQL、执行付费提交。
2. `agent` 不 import 数据库驱动、不读取密钥环境变量；需要数据时通过接口由 `main` 注入实现。
3. `web` 与 `cli` 只是客户端，运行时只走 `main` 的 API，不直连模型或数据库。
4. 任何付费动作都必须"估价/计划 → 人工确认 → 提交"，不留一键到底的后门。

这样的划分是为**上线预留**的：现在一台机器、本地 PG 与文件存储即可开发；以后 `main`/`agent` 可分开部署，`agent` 的接口实现换成 HTTP、存储换成云 PG 与对象存储，都只动适配层。

## 快速开始

准备 **Node.js ≥ 22.19** 与 Docker Compose。

```sh
npm run setup          # 安装各包依赖
npm run db:up          # 启动本地 PostgreSQL
npm run db:migrate     # 应用迁移
npm run dev            # 启动 main：http://127.0.0.1:8788
```

另开终端启动前端：

```sh
npm run dev:web        # http://127.0.0.1:5173
```

完整生产运行需要在本机配置拆解、生图、生视频等模型连接，并安装 FFmpeg / ffprobe。密钥只保存在本机后端，不进入浏览器或仓库；只有用户对某次运行明确授权预算后才可能调用付费模型。详见 [main 包指南](packages/main/README.md)。

## 命令行客户端

```sh
npm run cli -- doctor                 # 后端连通性与模型配置
npm run cli -- project list           # 项目列表
npm run cli -- run get <runId>        # 运行状态与阻断原因

# 付费纪律：create 只生成计划（不提交、不扣费），submit 才提交同一份冻结请求
npm run cli -- run create --project <id> --script-version <id> --duration 60 --budget 30
npm run cli -- run submit
```

`--api` 或 `OHAO_API` 可指向其他环境；`--json` 输出便于脚本与其他 Agent 消费。

## AI 工作区

工作台右侧提供 AI 工作区（`⌘J / Ctrl+J` 开合）：流式对话、白名单只读工具调用、会话回放，以及对话内的"估价卡 → 人工确认 → 提交生产"闭环。实现位于 `packages/agent`（编排与状态机）与 `packages/main`（HTTP/SSE 与 PostgreSQL 持久化）。模型未配置或失败时如实报错，不生成模拟回答。

## 验证

```sh
npm test        # 依次构建 shared/agent/main/cli/web，并运行后端与前端测试
```

也可以按包运行：`npm --prefix packages/main test`、`npm --prefix packages/web test`。所有测试不提交真实付费模型任务。

## 当前能力边界

- **技术复核不是视觉语义审核**：自动检查验证容器、画幅、时长、音轨与哈希，不能替代人工观看剧情、表演与连续性。
- **3D 目前是 prompt-only 约束**：白模机位与站位被写入提示词，没有把 3D 渲染图或原生相机控制传给视频模型。
- **声音使用视频供应商原生音轨**：暂无独立配音、口型同步与混音子图。
- **仍是本地单机部署**：尚未提供分布式调度、对象存储与多用户权限（结构已为其预留边界）。

## 文档导航

| 想了解什么 | 从这里开始 |
| --- | --- |
| 后端启动、功能与路线图 | [packages/main/README.md](packages/main/README.md) |
| 前端工作台 | [packages/web/README.md](packages/web/README.md) |
| 工程规则与跨包约束 | [AGENTS.md](AGENTS.md) |
| 旧平台设计与合同参考 | [reference/README.md](reference/README.md) |
| 反馈问题或想法 | [GitHub Issues](https://github.com/K80Tom/frame-shortdrama-agent/issues) |

## 来源与许可

3D 导演台与所用组件的来源、适配与许可记录见 [第三方代码说明](packages/web/THIRD_PARTY_NOTICES.md)。旧平台仅存的参考资料位于 `reference/`，完整历史工程可从 Git 历史找回。项目尚未声明统一开源许可证；使用与分发时请核对各代码、样例和素材的来源与许可。

---

<div align="center">
  <p><strong>从剧本开始，让每个生产节点都可见、可控、可继续。</strong></p>
</div>
