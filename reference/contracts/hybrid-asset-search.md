# V0.2.0 混合资产检索合同

## 目标

用户只面对一个搜索框与一个结果列表。PostgreSQL 是资产和权限的正式真源；Milvus
只提供可重建的语义候选。前端不展示“语义/全文/降级”等实现模式。

## 接口

`POST /api/v1/asset-search`

请求：

```json
{
  "query": "雨夜巷口，冷色追逐",
  "scope": "可选 personal 或 common",
  "project_id": "可选 UUID",
  "page": 1,
  "page_size": 20
}
```

- `query` 为 1–255 个字符；`page` 为 1–100；`page_size` 为 1–50。
- `scope=personal`：只检索当前用户自己的个人资产；`scope=common`：只检索已通过的
  通用资产。`scope` 与 `project_id` 不能同时传。
- `scope` 与 `project_id` 均未传：兼容既有调用，检索当前用户个人资产和已通过通用资产。
- 传入 `project_id`：先按 `ProjectAccessService.require(actor, project_id, "read")`
  鉴权；通过后才增加该项目有效 `project_asset_refs` 可见的资产。非成员返回
  404，不泄露项目存在性。

响应：

```json
{
  "ok": true,
  "data": {
    "items": [],
    "page": 1,
    "page_size": 20,
    "has_more": false,
    "diagnostics": {
      "status": "results",
      "semantic_available": true,
      "lexical_available": true,
      "relaxed_once": false
    }
  }
}
```

`items` 沿用既有资产搜索项字段，并明确返回 `scope` 与 `status`，使客户端不会把个人
资产和通用资产的审核/编辑能力混用。`diagnostics.reason` 只在需要排查空结果或
放宽表达时出现，值只能为 `ranking_issue`、`retriever_no_recall`、
`query_expression_problem`、`true_absence`；不包含供应商错误、隐藏资产数量或
内部对象 ID。

## 召回与排序

1. PostgreSQL 用 `pg_trgm` 对 `asset_entities.search_text` 和
   `asset_variants.search_text` 做全文式词法召回；017 迁移维护字段与 GIN 索引。
2. embedding + Milvus 使用原始 query 召回语义候选，不调用 LLM，不创建 `ai_calls`。
3. 两路统一为 `asset_entities:<id>` / `asset_variants:<id>`，以
   `1 / (60 + rank)` 做 RRF 去重融合。
4. embedding 或 Milvus 不可用时仍返回 PostgreSQL 词法结果；网络、`UNAVAILABLE` 和
   `DEADLINE_EXCEEDED` 等可重建投影故障走此降级。PostgreSQL 失败不伪装成空结果。
5. 首轮无候选时，只允许去掉开头的低置信意图前缀（如“帮我找”“搜索”）重试一次。
   用户明示的对象、风格、版权、授权和安全限制一律不自动放宽。

每一页的两路召回窗口都会随 `page × page_size` 增长，并额外取一个候选来判断
`has_more`；不存在旧资产目录那种固定截断 500 条后假装“没有更多”的行为。为保护
  单次查询资源，页码上限为 100（最多可遍历 5,000 个候选位置）；超出时 API 明确返回参数错误，
  而不是静默截断。

## 权限与媒体锁

- `clearance.search=false`、回收站资产和回收站变体不参与任何召回或 hydration。
- 非本人个人资产只能从已授权项目的有效引用进入结果。
- 这类资产的媒体 URL 必须遵循引用锁：`asset_media_id` 只允许该媒体；
  `asset_variant_id` 只允许该变体媒体；旧的仅实体引用保留既有“整实体共享”兼容语义。
  没有已允许媒体时不得退回实体/变体的来源 URL。
- 对于非本人私有资产的项目引用，`metadata` 不透传；它可能含历史主图 URL 或供应商
  原始载荷。唯一可返回的媒体入口是已经过引用锁校验的 `source_file_url`。
- 新接口不能替换或改变 `POST /api/v1/asset-search/semantic` 的既有合同。

## 数据库前置

017 是 schema-scoped migration，不创建数据库级扩展。部署前由数据库管理员在目标
实例启用 `pg_trgm`；未启用时迁移以明确错误原子失败，不能跳过或静默退化。
