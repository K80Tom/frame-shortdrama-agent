# 中文短剧主业务 API（TypeScript）

> 统一开发入口：先读 [`AGENTS.md`](AGENTS.md)，再从 [`docs/contracts/v0.2.0/README.md`](docs/contracts/v0.2.0/README.md) 进入产品、架构、数据、模型、测试和协作合同（历史版本合同在 `docs/contracts/v0.1*`）。版本计划真源：[`docs/design/version-plan.md`](docs/design/version-plan.md)。开发流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，凭据边界见 [`SECURITY.md`](SECURITY.md)。

这是 `zhongwen-shortdrama-main` 的 TypeScript 全栈服务，包含资产入库、媒体管理和语义检索 API，以及对应的 Dashboard 前端。

**当前状态（2026-08-02）**：v0.2.2「原型对齐版」已发测试站（tag `v0.2.2`，含段落工作台/剧本分镜/项目资产/备戏台四个新界面与资产登记、音频、注册配额后端，发版 e2e 全绿）；下一段按 R147 由统筹先完成终版 PRD、Figma 原型补全与核心页骨架重构,再拆工。分支约定：`main`=生产、`test`=测试站、`dev`=日常集成。

早期版本已经跑通：

- Excel 资产表上传与解析
- 使用大模型从 Excel 行中提取结构化资产字段
- Excel 内嵌图片提取并上传到火山 TOS
- 统一上传入口支持 Excel 批量入库和单张图片视觉识别入库
- 入库响应会在 `metadata.ingest_timing_ms` 返回耗时明细，前端会展示总耗时、模型、TOS、数据库等耗时徽标
- 结构化数据写入 PostgreSQL
- 资产文本生成 embedding 并写入 Milvus
- 通过自然语言进行资产语义检索，支持 LLM 查询理解、多 query 召回、结构化 SQL 辅助召回和融合排序
- 结构化 JSON 资产批量入库
- 图片视觉识别入库，自动上传 TOS、写入媒体表并后台同步向量
- RAG 检索评测样例和评测文档，用于量化 Hit@K、MRR 等指标
- 分镜 Excel 解析基础能力

## 当前能力

### Excel 入库

接口接收 Excel 文件，后端自动解析工作表，不需要前端手动传 `sheet_name`。

Excel 字段抽取模型固定读取 `.env` 里的 `DOUBAO_LLM_MODEL`；`DOUBAO_LLM_MODEL_2_0_LITE` 不再作为 Excel 字段抽取的优先模型。

入库完成后，每条返回 item 的 `metadata.ingest_timing_ms` 会包含 API 层耗时，例如 `api_save_upload`、`api_service_ingest_excel`、`api_cleanup_upload`、`api_total_before_response`，前端会用这些字段显示耗时徽标。

流程：

```text
上传 Excel
-> 临时保存到 runtime/uploads
-> 解析全部有效工作表
-> 按行提取字段和图片位置
-> 调用大模型提取 asset_entities 字段
-> 上传 Excel 内嵌图片到 TOS
-> 写入 asset_source_projects
-> 写入 asset_entities / asset_variants
-> 写入 asset_media
-> 同步 entity / variant 到 Milvus 向量库
```

### JSON 资产入库

对接方可以绕过 Excel，直接提交结构化 JSON 资产数据。后端会写入 `asset_entities`，并同步到资产向量库。

```text
POST /api/v1/asset-ingest/json/assets
```

适合外部资产系统、标注系统或上游 Agent 已经产出结构化字段的场景。

### 图片视觉入库

当资产来源只有图片、没有 Excel/JSON 字段时，可以通过统一上传接口提交单张图片。后端会调用豆包视觉模型识别 `asset_entities` 字段，上传图片到 TOS，写入 `asset_entities` / `asset_media`，并把向量同步放到后台任务，避免上传接口长时间等待。

### 分镜 Excel 解析

项目已加入分镜 Excel 解析模块，用于识别分镜 sheet、映射表头并标准化分镜行数据。当前分镜链路处于基础解析阶段；本次共享仓库上传不包含分镜设计文档。

### 向量检索

检索流程：

```text
用户 query
-> LLM 查询理解，抽取名称、项目、年龄、身高、风格标签等结构化意图
-> 生成最多 2 条适合向量检索的 rewrite
-> 原始 query 向量召回 + rewrite query 向量召回
-> 基于 name / display_name / source_project_name / style_tags 的结构化 SQL 召回
-> 多路结果按 source_table + source_id 合并去重
-> 融合排序、同主体轻微降权、0-1 相关性分数校准
-> 回 PostgreSQL 补完整资产信息和主图 URL
```

当前检索为混合检索，不强制区分 `character` / `scene`。返回结果中会包含 `asset_kind`、`source_table`、`source_id`、`metadata.search_debug` 等字段，调用方可以据此展示、调试或二次筛选。

更详细的检索流程、分数权重和评测结论见 `docs/rag提升文档/当前检索方法与分数权重说明.md`。

### RAG 评测

项目新增了检索评测闭环：

- `docs/rag_eval_queries.example.jsonl`：接口级评测样例，适合快速跑 `/api/v1/asset-search/semantic`。
- `docs/rag提升文档/`：RAG 提升 spec、计划、任务、验收清单和阶段性评测记录。
- 可使用 `docs/rag_eval_queries.example.jsonl` 作为接口级检索测试数据。

## TypeScript 项目结构

生产运行时目录为 `src/`：`src/server.ts` 是 Node 入口，`src/app.ts` 创建 Fastify 应用，`src/http/` 提供 API，`src/services/` 编排资产入库和语义检索，`src/repositories/` 访问 PostgreSQL，`src/integrations/` 对接 Ark/Doubao、TOS 和 Milvus。前端入口为 `frontend/shortdrama-rag-demo/src/app.ts`。

项目运行代码只保留 TypeScript/Node.js 实现，前端 Dashboard 与后端一起构建，但通过独立目录维护。

## 分层约定

- `src/http`：接收 HTTP 请求，做 Zod 校验，调用 service，不直接写业务逻辑和 SQL。
- `src/services`：编排 Excel 入库、图片上传、向量同步、语义检索等业务流程。
- `src/repositories`：封装 Drizzle PostgreSQL 读写，不处理复杂业务。
- `src/db`：数据库连接和表结构映射。
- `src/integrations`：Ark/Doubao、TOS、Milvus 等外部服务适配器。
- `src/config`：集中读取环境变量。

## 环境变量

复制 `.env.example` 为 `.env`，并填入真实配置。

```text
APP_NAME=Shortdrama Agent
APP_VERSION=0.1.0
DEBUG=false

DATABASE_URL=
VNEXT_DATABASE_URL=
POSTGRES_HOST=...
POSTGRES_PORT=5432
POSTGRES_DB=...
POSTGRES_USER=...
POSTGRES_PASSWORD=...
POSTGRES_SCHEMA=app

ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_API_KEY=...
ARK_LLM_MODEL=...
DOUBAO_LLM_MODEL=...
DOUBAO_EMBEDDING_MODEL=...
DOUBAO_VISION_MODEL=
DOUBAO_LLM_MODEL_2_0_LITE=

TOS_BUCKET=...
TOS_ENDPOINT=
TOS_SDK_ENDPOINT=https://tos-cn-beijing.volces.com
TOS_PUBLIC_BASE_URL=https://<bucket>.tos-cn-beijing.volces.com
TOS_REGION=cn-beijing
TOS_ACCESS_KEY=...
TOS_SECRET_KEY=...

MILVUS_URI=...
MILVUS_USER=...
MILVUS_PASSWORD=...
MILVUS_COLLECTION_ASSET_ENTITY=asset_entity_vectors
MILVUS_COLLECTION_PROJECT_STORYBOARD=project_storyboard_vectors
```

说明：

- `DATABASE_URL` 设置后优先使用；为空时使用 `POSTGRES_*` 拼接 PostgreSQL 连接。
- `VNEXT_DATABASE_URL` 使用独立的 `NOINHERIT` 登录身份；该身份只加入 `vnext_app`，供 vNext 专用连接显式 `SET ROLE`。不得复用主应用/迁移登录。
- `POSTGRES_SCHEMA` 所有环境固定 `app`（见 `docs/contracts/environment-governance.md` §2）。不要填 `common`，那是团队旧系统的活数据 schema。
- `DOUBAO_LLM_MODEL` 用于 Excel 资产字段抽取；如果没有配置会直接报错，不再回退到 `DOUBAO_LLM_MODEL_2_0_LITE`。
- `ARK_LLM_MODEL` / `DOUBAO_LLM_MODEL` 用于检索 Query Understanding。
- `DOUBAO_EMBEDDING_MODEL` 用于资产文本、query 和评测脚本的 embedding。
- `doubao_seedence_mini` / `DOUBAO_LLM_MODEL_2_0_LITE` / `DOUBAO_VISION_MODEL` / `DOUBAO_LLM_MODEL` 用于图片视觉入库，按这个顺序选择可用模型。
- `TOS_ENDPOINT` 是兼容变量；业务代码优先读取 `TOS_SDK_ENDPOINT` 和 `TOS_PUBLIC_BASE_URL`。
- 不要提交 `.env`。仓库只提交 `.env.example`。

## 启动

安装依赖：

```powershell
npm install
```

启动 Node + TypeScript 服务：

```powershell
npm run dev
```

打开接口文档：

```text
http://127.0.0.1:8000/docs
```

### Docker 服务镜像（本地/dev/test）

以下 Compose 命令只用于本地开发和 dev/test。正式生产入口是
[`deploy/k8s/README.md`](deploy/k8s/README.md)，不使用仓内 Compose 数据库或 Caddy。

构建镜像：

```powershell
docker compose build app
```

运行服务：

```powershell
docker compose up -d app
```

Docker 镜像使用 Node.js 运行 `dist/server.js`，并包含前端静态构建产物；`.env` 和 `runtime/` 不进入镜像。容器安全、数据库地址、局域网和端口说明见 [`docs/runtime/docker-v0.1.md`](docs/runtime/docker-v0.1.md)。

服务依赖以根目录 `package.json` / `package-lock.json` 为准。

## TypeScript 运行方式

应用运行时使用 Node.js + TypeScript，主入口为 `src/server.ts`。

```powershell
npm install
npm run typecheck
npm run build
npm start
```

Docker（仅本地/dev/test）：

```powershell
docker compose build app
docker compose up -d app
```

Node 服务启动后，前端首页为 `/`，健康检查为 `GET /api/v1/health`，OpenAPI 文档为 `/docs`。

## API

### 健康检查

```text
GET /api/v1/health
```

### 统一上传并自动入库

前端默认调用这个统一入口。后端会根据文件后缀自动选择 Excel 批量入库或图片视觉入库。

```text
POST /api/v1/asset-ingest/upload
```

表单参数：

- `file`：Excel 文件或图片文件；Excel 支持 `.xlsx` / `.xlsm`，图片支持 `.jpg` / `.jpeg` / `.png` / `.webp` / `.bmp`
- `source_project_name`：可选，不传则 Excel 从文件名提取，图片使用文件名作为兜底项目名
- `batch_size`：Excel 每批调用大模型的行数，默认 `5`；图片上传时会忽略该参数
- `asset_kind_hint`：可选，仅图片上传使用，用于提示视觉模型资产类型

响应里的 `mode` 会返回 `excel` 或 `image`。返回 item 的 `metadata.ingest_timing_ms` 会包含耗时明细，前端会展示为耗时徽标。

示例：

```powershell
curl.exe -X POST "http://127.0.0.1:8000/api/v1/asset-ingest/upload" `
  -F "file=@C:\Users\Firebat\Desktop\《天尊》人设和场景表.xlsx" `
  -F "batch_size=5"
```

```powershell
curl.exe -X POST "http://127.0.0.1:8000/api/v1/asset-ingest/upload" `
  -F "file=@C:\Users\Firebat\Desktop\asset.png" `
  -F "source_project_name=图片资产库" `
  -F "asset_kind_hint=character"
```

### 上传 Excel 并自动入库

```text
POST /api/v1/asset-ingest/excel/upload
```

这是 Excel 专用兼容接口；新前端使用上面的统一上传入口。

表单参数：

- `file`：Excel 文件，支持 `.xlsx` / `.xlsm`
- `source_project_name`：可选，不传则从文件名提取，优先取 `《...》` 中的内容
- `batch_size`：每批调用大模型的行数，默认 `5`

示例：

```powershell
curl.exe -X POST "http://127.0.0.1:8000/api/v1/asset-ingest/excel/upload" `
  -F "file=@C:\Users\Firebat\Desktop\《天尊》人设和场景表.xlsx" `
  -F "batch_size=5"
```

### JSON 资产批量入库

```text
POST /api/v1/asset-ingest/json/assets
```

请求体示例：

```json
{
  "source_project_name": "天尊",
  "assets": [
    {
      "asset_kind": "character",
      "name": "叶逍遥",
      "display_name": "叶逍遥",
      "intro": "男主，天资卓绝，性格坚韧。",
      "appearance": "青年男性，五官清俊，气质沉稳。",
      "style_tags": ["古装", "仙侠"],
      "source_file_url": "https://example.com/images/ye-xiaoyao.png",
      "metadata": {
        "source": "external_json"
      }
    }
  ]
}
```

更完整的字段说明见 `docs/json_asset_ingest_api.md`。

### 资产语义检索

```text
POST /api/v1/asset-search/semantic
```

请求体：

```json
{
  "query": "老奸巨猾的某市龙头",
  "limit": 5
}
```

返回结果会包含：

- `score`：0-1 校准后的相关性分数，不是 Milvus 原始向量分
- `source_table`：`asset_entities` 或 `asset_variants`
- `source_id`：结构数据库中的主键 ID
- `asset_kind`：资产类型，如 `character` / `scene`
- `name` / `display_name`
- `parent_entity_id` / `parent_entity_name`：变体结果所属的主体资产
- `source_file_url`：主图 URL，前端可直接用 `<img src="...">` 展示
- `metadata`：包含原始 metadata；如果命中媒体图，会补 `primary_image`
- `metadata.search_debug`：包含 query understanding、召回来源、融合原因和内部排序分，便于排查
- `vector_text`：生成向量时使用的文本，便于调试

## 本地验证

```powershell
npm run typecheck
npm run build
```

## 数据表关系

```text
asset_source_projects
  -> asset_entities.source_project_id

asset_entities
  -> asset_media.asset_entity_id
  -> asset_variants.asset_entity_id

asset_variants
  -> asset_media.asset_variant_id

Milvus metadata
  -> source_table
  -> source_id
```

结构库是资产真实数据源，Milvus 是语义检索索引。检索命中后，通过 `metadata.source_table` 和 `metadata.source_id` 回 PostgreSQL 查询完整资产。

## 当前注意事项

- Excel 会先保存到 `runtime/uploads`，用于后续 ExcelJS 解析和图片抽取；该目录已被 `.gitignore` 忽略。
- 本次共享仓库上传不包含 `tests/` 和 `分镜docs/`，相关内容仅保留在开发工作区。
- 语义检索目前是混合检索，不做强制类型过滤；`asset_kind_hint` 已由 LLM 解析，但当前主要用于调试和后续扩展。
- Query Understanding 会调用大模型；检索接口除了 embedding 模型，还需要配置 `ARK_LLM_MODEL` 或 `DOUBAO_LLM_MODEL`。
- 如果旧数据存在乱码或早期错误向量，建议清空 Milvus collection 后重新同步。
- `asset_media` 当前未做严格防重复，重复入库时可能产生重复媒体记录，后续可按 `sha256` 或 `storage_path` 做去重。
- TOS 图片 URL 如果 bucket 非公开读，需要后续改为签名 URL。
