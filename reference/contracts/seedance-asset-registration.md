# Seedance 可信素材登记合同（V0.2.0）

> 2026-08-05 增量：Assets OpenAPI 字段、素材组幂等、`ListAssets` 回读、
> 通用 `/api/v1/assets/registrations` 接口和本地—云端映射以
> [`../v0.3.0/volc-asset-registration.md`](../v0.3.0/volc-asset-registration.md)
> 为准。本文的来源血缘、权限、`asset://` 使用门禁和 15 分钟 freshness 规则继续有效；
> 本文旧的 `assetName` / `assetDesc` / `userName`、静态组必填和 `GetAsset` 刷新描述
> 不再作为供应商请求合同。

## 目的与边界

火山素材登记是把**已持久化到 TOS 的一个本地素材**登记到 Ark 私有素材库的
用户触发动作。兼容 HTTP 路由仍可由人单独点击登记；正式 MCP 入口由 S71 在同一次
`upload_asset_image` 调用中完成上传和登记。两者都不得变成后台批量或夜间自动注册。
它不是生成任务，也不会自动触发付费生成。

**触发策略（2026-08-19 裁定，替代「仅显式人工点击」）**：除人工点击外，媒体
**成为资产主变体**时自动登记，这是唯一自动触发：

- Lite 设主图/主音频（`PATCH .../lite/assets/:id/primary-media`，含生成图物化后翻转）；
- 任何上传端点带 `is_primary=true`（共享 `POST /assets/:id/media`，Lite 首图自动主图与
  完整版上传主图同规则）。

绝不因报价、提交、组包或生成结果副作用触发登记。自动登记同样受本节状态机与
fail-closed 约束：登记行先以 `pending` 持久化，翻转提交后后台异步执行 CreateAsset；
失败落 `failed`/`unknown` 并可由前端重试，不得因自动触发放松幂等或并发领取纪律。
自动登记只覆盖**被选中成为主变体**的媒体，非主变体不登记。

- PostgreSQL 保存本地素材、登记状态和审计尝试，是唯一正式事实；Ark Asset ID 只是外部引用。
- 仅 `Active` 的远端素材，且只在 `usage_mode=reference` 时，才会在 Seedance 请求中映射为
  `asset://<remoteAssetId>`。
- `first_frame` 与 `last_frame` 仍使用原 TOS 图片 URL；当前合同没有把锚帧映射到 `asset://`。
- 注册动作不改变素材审核结论。由生成产物提升出的个人参考资产属于个人域，初始即为
  `approved`；只有进入通用库的资产才使用资产审核状态机。

## S49 来源分流与生命周期

2026-08-19 裁定：**自产信任通道整体退役**。官方答复「资产登记没有时间限制」使
30 天信任窗口失去前提；新模型下「可作视频参考的图片必须已登记」是唯一规则，
所有来源统一走 CreateAsset 登记通道：

| 来源 | 必经通道 |
| --- | --- |
| 本账号模型自产、没有外来输入祖先的原始产物 | CreateAsset（成为主变体自动登记，或人工登记） |
| 第三方原始图片 | CreateAsset |
| 第三方图片经 Seedream 5 Pro 图生图的产物 | CreateAsset（外来血缘不会因模型加工消失） |
| 其他外来或来源不明的图片 | CreateAsset（来源不明时 fail-closed 到注册通道） |
| 方舟预置虚拟人像或已授权真人素材 | 绑定既有 Asset ID |

`seedance_self_produced_trust` 表、`SEEDANCE_SELF_PRODUCED_TRUST_WINDOW_MS`、
`qualifiesForSelfProducedTrust` 及全部直链信任准入随本次变更删除；直接定稿引用
（上一镜定稿图做下一镜参考）不再有 30 天宽限，定稿图必须已登记（「存进资产库」）
或已成为主变体才能引用，否则 422 引导登记。

`provider_library` 的既有 Asset ID 绑定是保守导入，不是一次已验证的可用性声明：
创建或更新绑定时登记必须为 `unknown`，且不得调用 `GetAsset`。只有用户明确发起
`refresh` 后才可调用 `GetAsset`，并在远端结果确认可用时转为 `active`。

### 来源血缘真源

来源判断必须是 PostgreSQL 中由服务端生成的正式事实，不能相信客户端传入的
metadata、文件名、模型名或 C2PA 自述。S49 至少要持久化：

```text
source_channel =
  first_party_generation | external_upload | provider_library | unknown

direct_parent_edges =
  child_media_result -> parent_media_result | parent_asset_media

contains_external_image_ancestor = boolean  // 服务端按祖先闭包派生
```

约束：

1. 生成请求冻结时写入直接父输入边，任务提交后不可由客户端改写；
2. 任一父图是 `external_upload`、已带外来祖先或 `unknown`，子产物的
   `contains_external_image_ancestor` 必须为 true；
3. 只有同账号 provider 生成、没有图片型外来/unknown 祖先且原始字节资格仍成立的
   产物，才可标为 `first_party_generation`；
4. 历史无法证明来源的行回填为 `unknown`，不得批量猜成自产；
5. 该派生值由服务端和数据库约束保护，客户端 API 不接受覆盖字段。

### 生成提交门禁

- 图片只有在 CreateAsset 登记处于当前可用状态时，才能进入 Seedance provider
  请求；否则在报价/提交或组包阶段 fail-closed。自产原始图不再有免登记直链资格，
  与外来/unknown 图片同一规则。
- `active` 仅在 `last_verified_at + 15 minutes` 内为当前可用状态。15 分钟是本项目的
  保守 freshness 裁决，**不是 Ark 官方承诺的有效期**；官方确认登记本身无时间限制。
  超过该窗口时必须拒绝提交并要求用户显式 `refresh`。
- 报价、提交和 provider 组包是热路径：它们只能读取 PostgreSQL 中的登记真源，绝不
  隐式调用 `GetAsset`，也不会因过期而静默刷新。
- **禁止**无 Active/可用登记时回退 TOS URL。`providerReferenceUrl()` 的普通 URL
  fallback 只允许用于已登记且 `remote_asset_id` 缺失的非 reference 位（锚帧），
  不能用于未登记的参考图片。

## API

所有路由均要求当前用户有该对象的管理权限，响应包装沿用 `{ ok, data }`。

```text
POST /api/v1/media-results/:media_result_id/seedance-registration
GET  /api/v1/media-results/:media_result_id/seedance-registration
POST /api/v1/media-results/:media_result_id/seedance-registration/refresh

POST /api/v1/assets/:asset_id/media/:media_id/seedance-registration
GET  /api/v1/assets/:asset_id/media/:media_id/seedance-registration
POST /api/v1/assets/:asset_id/media/:media_id/seedance-registration/refresh
```

`POST` 只对应用户的一次明确点击。对已 `active` 的登记返回既有记录；`processing` 只查询状态；
`submitting` 与 `unknown` 不会自动重新调用 CreateAsset，避免远端重复登记。

返回的 `registration` 至少包含：

```json
{
  "id": "uuid",
  "asset_media_id": "uuid",
  "source_media_result_id": "uuid | null",
  "remote_asset_id": "string | null",
  "status": "pending | submitting | processing | active | unavailable | failed | unknown",
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601",
  "activated_at": "ISO-8601 | null",
  "last_verified_at": "ISO-8601 | null",
  "fresh_until": "ISO-8601 | null",
  "authorization_expires_at": "ISO-8601 | null",
  "latest_error": { "code": "string", "message": "string" }
}
```

## 状态与幂等

| 状态 | 含义 | 后续人工动作 |
| --- | --- | --- |
| `pending` | 已建立本地登记，尚未发起远端调用 | 点击登记 |
| `submitting` | 一个 CreateAsset 已被数据库原子领取 | 等待，不重复点击 |
| `processing` | 已拿到远端 ID，等待 Ark 异步处理 | 点击刷新 |
| `active` | 最近一次远端/授权核验时可用 | 仅在 `last_verified_at + 15 minutes` 内使用；过期后显式刷新 |
| `unavailable` | 远端明确删除、撤权、授权到期或不再可用 | 禁止生成，人工核对 |
| `failed` | Ark 给出了明确失败结果 | 人工确认后可再次点击登记 |
| `unknown` | 网络/协议结果不明 | 先人工核对远端，系统不自动重发 |

同一 `asset_media` 或同一来源 `media_result` 在数据库中只能有一条有效登记映射。
每个状态写入都会附加一条尝试审计；审计仅记录动作、结果、RequestId、HTTP 状态、错误码与
远端 Asset ID，禁止写入 URL、Authorization、AK/SK、token 或供应商原始错误文本。

`active` 是有时间点的可用性观察，不是永久授权。其 freshness 固定为
`last_verified_at + 15 minutes`；此窗口是我方保守裁决，不是 Ark 官方期限，完成真实
provider 验证后可调整。过期记录必须由用户明确调用 `refresh`；刷新必须真实查询远端
或授权事实，不能直接返回旧记录。远端明确不可用时转 `unavailable`，查询结果不明时转
`unknown`。生成提交热路径不得为此隐式调用 `GetAsset`。

## CreateAsset 仓库实现契约

以下形态由 DC 提供，属于**仓库实现契约，不是本次官网逐字确认结果**：

```text
POST <SEEDANCE_OPENAPI_ENDPOINT，默认
https://ark.cn-beijing.volcengineapi.com>
  ?Action=CreateAsset&Version=2024-01-01

body = {
  GroupId,
  URL,            // TOS storageUrl
  AssetType: "Image" | "Audio",   // 2026-08-19 起允许主变体音频登记
  ProjectName,
  assetName,
  assetDesc,
  userName?       // 可选
}

response asset id = Result.Id
并兼容 Result/result 与 Id/id 的大小写外壳
```

音频登记遵循与图片同一触发规则：只有成为主变体的音频才登记；服务端 `volcAssetType`
与 CreateAsset 入参统一映射 `audio -> "Audio"`。真实 `AssetType=Audio` 的
CreateAsset 供应商核验属付费动作，上线前由人工冒烟脚本单独确认。

## S71 正式 MCP 薄 adapter 合同

S49 只定义登记生命周期、HTTP 合同和 application service 的行为；正式 MCP adapter
实现移至 S71，不属于 S49 验收或 `S49-DONE` 的阻塞项。S71 必须位于主仓，作为薄
adapter 调用现有 application service：不得复制 provider 客户端，不得让 agent 仓直接
写 PostgreSQL、`asset_entities`、`asset_media` 或登记表。

S71 的 `upload_asset_image` 接口契约如下：

```text
调用者鉴权/对象管理权限校验
  -> 以 caller + idempotency_key 原子领取同一用户明确动作
  -> application service 持久化 TOS 上传结果
  -> application service 调用 CreateAsset 并持久化登记
  -> 同一数据库事务（或受审计 outbox）写 asset_entities / asset_media /
     seedance_asset_registrations 及 metadata 投影
  -> 返回本地 asset、asset_media、registration、remote_asset_id、status、fresh_until

显式 refresh
  -> 同一 application service 调用 GetAsset
  -> 事务性更新 registration 真源与 metadata 投影
  -> 返回更新后的 registration（含 status、last_verified_at、fresh_until）
```

鉴权失败、对象无管理权限、缺少/冲突的幂等键、TOS 上传失败、CreateAsset 不可确定结果
和数据库提交失败都必须 fail-closed，并返回统一的可执行错误；不向 MCP 返回供应商原始
响应或任何凭据。`CreateAsset` 结果不明时本地状态为 `unknown`，不得自动重发。S71
不得在生成提交热路径调用 `GetAsset`；`provider_library` bind 必须先写 `unknown`，只有
显式 refresh 才允许查询并转 `active`。

PostgreSQL 的 `seedance_asset_registrations.remote_asset_id` 是 Seedance ID 的
**唯一正式事实**。`asset_media.metadata.seedance_asset_id` 只是兼容 MCP 返回和
检索的可重建投影：

- 生成与权限判断只读登记表，不单独信任 metadata；
- 登记表和 metadata 投影在同一数据库事务或受审计 outbox 中更新；
- 投影写失败不得产生第二条 CreateAsset；应由幂等重放修复；
- 必须有漂移检测和修复测试，禁止双真源。

当前本仓实现与 S71 目标仍有差异：现有适配器是 `ArkAssetRegistryClient`，上传与注册
是分开的 HTTP 流程，远端 ID 位于独立登记表，仓内也没有
`upload_asset_image` / `HttpSeedanceProvider.registerImage` 符号。该差异应在 S71
回执中逐项说明已适配和未适配项；本合同不把目标描述为已接通。

## 与 Seedance 2.0 `asset://` 的关系

### 官方资料已确认

- 已授权真人素材取得 Asset ID 后，可在视频生成 API 中以
  `asset://<asset_id>` 作为 `reference_image`。
- Assets API、CreateAsset、真人/虚拟人像入库和私域素材配额属于 Seedance 2.0
  的同一素材产品面。
- 官方国际版 BytePlus ModelArk 文档直接串起
  `CreateAsset`、`Version=2024-01-01`、资产 `Active` 和
  `asset://<Asset ID>`；它只能补证机制，不能证明中国区 endpoint、权限、响应
  外壳或 Asset ID 与国际区互通。

### 工程推断与采用方式

高置信推断是：CreateAsset 与 `asset://` 属于同一素材资产体系里的两个阶段，
前者负责注册入库，后者负责推理时消费已可用的 Asset ID。我们的采用方式是：

1. 外来图片：TOS → CreateAsset → 确认可用 → 保存 Asset ID →
   Seedance 请求按能力使用 `asset://`；
2. 预置虚拟人像/已授权真人素材：绑定并使用既有 Asset ID，不重复 CreateAsset；
3. 本账号自产原始产物：成为主变体时自动 CreateAsset 登记，或经「存进资产库」
   人工登记；不再有免登记的 30 天信任窗口。

官方答复「资产登记没有时间限制」→ 已 Active 的登记不因时间推移自动失效，
`last_verified_at + 15 分钟` freshness 仍是我方保守裁决，用于热路径防漂移。

中国区“CreateAsset 返回的任意图片 Asset ID 是否适用于全部 Seedance 2.0
输入角色”仍未确认，真实合同验证前不得扩大结论。完整证据与限制见
[`docs/research/s49-seedance-asset-channel-reconciliation.md`](../../research/s49-seedance-asset-channel-reconciliation.md)。

## 配置与安全

默认关闭：`SEEDANCE_ASSET_REGISTRATION_ENABLED=false`。

启用所需的配置名：

```text
SEEDANCE_ASSET_REGISTRATION_ENABLED
SEEDANCE_ASSET_GROUP_ID
SEEDANCE_ASSET_PROJECT_NAME
SEEDANCE_ASSET_REGISTRATION_ENDPOINT
SEEDANCE_ASSET_REGISTRATION_REGION
VOLCENGINE_ACCESS_KEY_ID          # secret
VOLCENGINE_SECRET_ACCESS_KEY      # secret
VOLCENGINE_SECURITY_TOKEN         # 可选 secret，STS 使用
```

使用 [CreateAsset](https://www.volcengine.com/docs/82379/2318271?lang=zh) 和
[GetAsset](https://www.volcengine.com/docs/82379/2318274?lang=zh) 的 AK/SK V4 协议。
配置缺失或开关关闭时必须在发出任何远端请求前返回 503。

生产开启前，AK/SK 必须通过 KMS/IRSA 的受控注入路径提供；不得把值放进仓库、日志、请求记录或
前端。dev 冒烟仍须满足现有付费链：估价 → 人工确认 → 单次提交。

## 验收

1. 并发双击只会有一个本地 `submitting` 领取者，因而最多一次 CreateAsset。
2. CreateAsset 成功后，经用户显式 refresh 的 GetAsset 核验变 `Active`；在 15 分钟
   freshness 窗口内，该素材在 `reference` 位映射为 `asset://`。
3. 网络结果不明时转 `unknown`，不自动补发。
4. 未开启配置时返回人话 503，且没有远端调用或审计中的敏感值。
5. 真实 dev 冒烟需单独记录：登记、查询到 Active、报价、人工确认、单次提交、TOS 持久化和账本。
6. 自产信任通道已退役：自产原始图与外来/unknown 同一规则，缺少当前可用 CreateAsset
   登记时 fail-closed；不再有 30 天直链宽限，也没有任何自动续期或自动补登记。
7. 第三方图片经 Seedream 5 Pro 图生图后仍被路由到 CreateAsset；来源不明也不能
   进入任何免登记通道。
8. CreateAsset 合同测试覆盖 `assetName` / `assetDesc` / 可选 `userName`、
   响应大小写外壳兼容和远端 ID 的唯一持久化；`AssetType` 契约允许 `Image | Audio`。
9. 任何图片缺少当前可用登记时，报价/提交/组包 fail-closed，测试断言 provider
   未收到 TOS URL fallback。
10. 来源血缘测试覆盖直接外来、跨一代图生图、跨多代派生和历史 unknown；客户端
    伪造自产字段必须被忽略或拒绝。
11. 已 Active 的登记超过 15 分钟后，生成入口拒绝且不会隐式调用 GetAsset；用户可显式
    刷新为 `active` / `unavailable` / `unknown`。
12. `remote_asset_id` 真源与 metadata 投影的同事务/outbox、幂等重放和漂移修复
    测试通过。
13. `provider_library` bind 只写 `unknown` 且不调用 GetAsset；只有用户显式 refresh
    才查询并可转 `active`。正式 MCP adapter 的鉴权、幂等、TOS 上传、CreateAsset /
    GetAsset、事务真源与返回形状端到端测试属于 S71。
14. 主变体自动登记触发测试：Lite 设主图/主音频后登记行以 `pending` 落库且后台执行
    CreateAsset；上传 `is_primary=true` 同样触发；报价/提交/组包不产生登记副作用。
15. 音频登记测试：主变体音频经 `AssetType=Audio` 走 CreateAsset；非主变体音频不登记。
