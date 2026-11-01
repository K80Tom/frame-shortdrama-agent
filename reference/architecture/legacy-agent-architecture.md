# 短剧 Agent 仓库架构与启动笔记

> 生成日期：2026-08-27  
> 仓库：`zhongwen-shortdrama-agent`  
> 关联仓库：`COL-RAG-INGEST-CO`（Main 主后端）、`zhongwen-shortdrama-cli`（CLI SDK）

---

## 1. 仓库定位

`zhongwen-shortdrama-agent` 是短剧平台的 **AI Agent 层**，架设在 Main 后端之上。Main 是"数据权威"（PostgreSQL + Milvus + TOS），Agent 是"智能调度"（理解自然语言、拆解任务、调用工具）。

### 两个仓库的关系

```
Agent 仓库（本仓库）          Main 仓库（COL-RAG-INGEST-CO）
─────────────────────        ─────────────────────────────
✅ 理解自然语言              ✅ 持有密钥（ARK_API_KEY 等）
✅ 拆解剧本                  ✅ 认证鉴权
✅ 调度工具                  ✅ 计费额度
❌ 不持有密钥                ✅ 审批审计
❌ 不直接调 Ark/TOS          ✅ 数据库 + 对象存储
```

---

## 2. 仓库总体结构

```
zhongwen-shortdrama-agent/
├── pi-http-wrapper/          ← 控制面板 HTTP 桥梁（本地开发用）
│   ├── src/pi_http_wrapper/  ← 核心引擎
│   │   ├── app.py            ← FastAPI 路由
│   │   ├── engine.py         ← Pi 对话引擎
│   │   ├── rpc_manager.py    ← Pi 子进程管理（stdin/stdout JSONL）
│   │   ├── main_chain.py     ← 20+ 个 Main API 工具
│   │   ├── tool_bridge.py    ← 工具回调桥接
│   │   ├── contract.py       ← 数据契约
│   │   ├── config.py         ← 环境变量配置
│   │   ├── skills.py         ← Skill 发现管理
│   │   └── extensions/
│   │       └── external-tools.ts  ← Pi 扩展（工具注入）
│   └── services/shortdrama_api/   ← 控制面板 API 服务
│
├── test-agent/               ← 核心 Agent（AgentKit 云端部署）
│   └── short_drama_agent/
│       ├── factory.py        ← Agent 组装
│       ├── knowledge_assets.py ← 知识库
│       ├── memory.py         ← 长期记忆
│       └── script_breakdown.py ← 剧本拆解
│
├── production-chain-agent/   ← 生产链定义库
│   └── production_chain/
│       ├── workflow.py       ← 四个 Skill + ReviewGate
│       ├── models.py         ← 不可变数据模型
│       └── llm.py            ← Ark API 客户端
│
├── sd-script-agent/          ← 剧本拆解 Agent（AgentKit 云端）
├── sd-asset-agent/           ← 资产匹配 Agent
├── sd-scene-agent/           ← 场景镜头 Agent
├── sd-generation-agent/      ← 画面生成 Agent
├── sd-orchestrator/          ← 总调度 Agent
│
├── agent_resources/          ← Agent 资源（Prompt、Skill）
├── docs/                     ← 架构决策、合约文档
├── security-action-design/   ← 安全设计文档
└── sync_production_chain.py  ← 同步 production_chain 到各子 Agent
```

---

## 3. pi-http-wrapper 核心架构

### 3.1 整体调用链

```
前端 AI 助手 (5173)
  → Main 后端 (8000) → PI_REMOTE 转发
    → pi-http-wrapper (8787)
      → rpc_manager.py: 启动 pi 子进程 (pi --mode rpc)
        → pi CLI (Node.js，全局安装)
          → 读 ~/.pi/agent/models.json → 知道用哪个 LLM
          → 调 LLM API
          → LLM 决定调工具 → 回调 wrapper /internal/tool-calls
            → main_chain.py → shortdrama_cli → Main API (8000)
          → 结果喂回 LLM → 生成最终回复
        ← 通过 stdout JSONL 返回
      ← HTTP 响应
    ← 返回前端
```

### 3.2 核心模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| HTTP 入口 | `app.py` | FastAPI 路由、鉴权、SSE 流式 |
| 子进程管理 | `rpc_manager.py` | 启动/停止 pi 子进程，stdin/stdout JSONL 通信 |
| 对话引擎 | `engine.py` | 每轮对话的生命周期：写 context → 发命令 → 读事件 |
| 工具桥接 | `tool_bridge.py` | 线程安全的 rendezvous：pi 发 tool call → 暂存 → 客户端回传结果 → 释放 |
| 业务工具 | `main_chain.py` | 20+ 个 shortdrama_* 工具，通过 shortdrama_cli 调 Main API |
| 数据契约 | `contract.py` | PromptRequest / PromptResponse / ToolCall / ToolResult |
| 配置 | `config.py` | 全部从环境变量读取，不读文件 |
| Pi 扩展 | `external-tools.ts` | 在 pi 内部注册工具、注入系统提示词 |

### 3.3 工具注入机制

```
1. pi 启动时加载 --extension external-tools.ts
2. external-tools.ts 注册了 "shortdrama-sync-context" 命令
3. 每轮对话前，wrapper 写 context 文件（系统提示词 + 工具定义）
4. wrapper 发 {"type": "shortdrama-sync-context"} 命令
5. pi 读 context 文件 → 动态注册所有工具
6. pi.on("before_agent_start") 注入系统提示词
```

### 3.4 pi 是什么

- **pi** 是开源 AI Agent CLI 工具（`earendil-works/pi`），npm 全局安装
- 它提供 **Agent 循环**（LLM 调用 → 工具执行 → 喂回 LLM → 继续），wrapper 不需要自己写
- wrapper 通过 `--extension` 注入业务工具，pi 负责调度
- pi 读 `~/.pi/agent/models.json` 知道用哪个 LLM 提供商

---

## 4. 两条部署线

### 4.1 本地开发线（pi-http-wrapper）

- 用途：控制面板 AI 助手对话
- 部署：本地 `pi-http-wrapper` 命令
- 框架：FastAPI + pi CLI 子进程
- 模型：通过 `~/.pi/agent/models.json` 配置

### 4.2 云端生产线（AgentKit）

- 用途：短剧生产自动化（剧本拆解 → 资产匹配 → 图片生成）
- 部署：火山云 AgentKit（`agentkit-sdk-python`）
- 框架：VeADK + Google ADK
- 模型：环境变量注入 `MODEL_AGENT_API_KEY`

---

## 5. 启动步骤

### 5.1 前置条件

- Python 3.12+
- Node.js（pi CLI 依赖）
- pi CLI 全局安装：`npm install -g @earendil-works/pi-coding-agent`
- `shortdrama-cli` 本地安装：`pip install -e .`（在 `zhongwen-shortdrama-cli` 目录）
- Main 后端运行在 `127.0.0.1:8000`

### 5.2 安装 pi-http-wrapper

```powershell
cd zhongwen-shortdrama-cli
pip install -e .

cd zhongwen-shortdrama-agent\pi-http-wrapper
pip install -e .
```

### 5.3 修复 Windows GBK 编码

`rpc_manager.py` 第 89 行，`subprocess.Popen` 需要加 `encoding="utf-8"`：

```python
process = subprocess.Popen(
    command,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=None,
    text=True,
    encoding="utf-8",   # ← 必须加，否则 GBK 解码 UTF-8 输出会崩溃
    bufsize=1,
    env=self._environment,
)
```

### 5.4 启动

```powershell
cd zhongwen-shortdrama-agent\pi-http-wrapper

$env:PI_WRAPPER_BEARER_TOKENS = "dev-token"
$env:PI_WRAPPER_INTERNAL_TOKEN = "dev-internal-token"
$env:SHORTDRAMA_ENV = "dev"
$env:SHORTDRAMA_AGENT_TOKEN = "<从 Main 登录获取的 token>"

pi-http-wrapper
```

### 5.5 获取 SHORTDRAMA_AGENT_TOKEN

```powershell
curl -X POST http://127.0.0.1:8000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"dev-admin-password-123"}'
# 返回 → {"token": "xxx..."}
```

### 5.6 Main 的 .env 配置

```env
PI_REMOTE_API_URL=http://127.0.0.1:8787
PI_REMOTE_API_TOKEN=dev-token
PI_REMOTE_MODEL=mewcode-local
```

---

## 6. 关键环境变量

### pi-http-wrapper 侧

| 变量 | 说明 | 示例 |
|------|------|------|
| `PI_WRAPPER_BEARER_TOKENS` | Main 调用 wrapper 的鉴权 token | `dev-token` |
| `PI_WRAPPER_INTERNAL_TOKEN` | 内部工具回调鉴权 | `dev-internal-token` |
| `SHORTDRAMA_ENV` | Main 环境名（prod/test/dev） | `dev` |
| `SHORTDRAMA_AGENT_TOKEN` | 调用 Main API 的鉴权 token | 从 Main 登录获取 |
| `PI_BIN` | pi CLI 路径 | `pi.cmd`（Windows） |

### Main 侧

| 变量 | 说明 |
|------|------|
| `PI_REMOTE_API_URL` | pi-http-wrapper 地址 |
| `PI_REMOTE_API_TOKEN` | 与 `PI_WRAPPER_BEARER_TOKENS` 一致 |
| `PI_REMOTE_MODEL` | 模型名（`mewcode-local`） |

---

## 7. 常见问题

### 7.1 "AI 助手暂未就绪"

原因：pi-http-wrapper 没启动，或 Main 的 `PI_REMOTE_*` 没配。

### 7.2 "Connection error" / "Bad access"

原因：防火墙拦截了出站 443 连接。需要添加 Windows 防火墙规则：

```powershell
netsh advfirewall firewall add rule name="Allow Node.js Outbound" dir=out action=allow program="C:\Program Files\nodejs\node.exe" enable=yes
netsh advfirewall firewall add rule name="Allow pi Outbound" dir=out action=allow program="C:\Users\<用户名>\AppData\Roaming\npm\pi.cmd" enable=yes
```

### 7.3 GBK 编码崩溃

`rpc_manager.py` 的 `subprocess.Popen` 缺少 `encoding="utf-8"`，导致 pi 的 UTF-8 输出被 GBK 解码失败。

### 7.4 shortdrama_capabilities 返回 ApiRequestError

`SHORTDRAMA_ENV` 和 `SHORTDRAMA_AGENT_TOKEN` 未设置 → `build_main_chain_adapter` 返回 `None` → 所有工具调用失败。

---

## 8. 安全设计要点

- Agent 不持有任何火山云密钥（ARK_API_KEY、TOS 密钥等）
- Agent 只能通过 Main API 间接操作数据
- 付费生成必须经过 Main 的审批流程（Quote → Confirm → Submit）
- 网络分区：Agent 无公网访问，Generation Gateway 仅出站 Ark，Asset Worker 仅出站 TOS
- 端点白名单：`SHORTDRAMA_ENV` 只接受 prod/test/dev，不接受 URL

详见 `security-action-design/` 目录下的设计文档。
