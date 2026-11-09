# #123/#124 对象版本：真实字节、内部 ID 与可恢复物化

本次为冻结资产消费的底座，不代表 AssetPack、V2 视频、管理入口或全部生产验收已完成。

## 身份、事实与权限

- `object_records` 仍是原有对象拥有权/生命周期事实；新增 `object_versions` 固定已知源事实及受控副本，内部 ID 为 `objver_...`，不是供应商 VersionId、ETag 或数据库递增计数。
- 内部 ID 按完整来源事实确定并实际持久化；相同请求幂等，冲突不覆盖。客户端请求只有 objectId，不能提供 provider selector、存储 key、checksum 或伪造 Actor。
- 副本位于 workspace 前缀内 `production-media/objects/versions/<id>/<sha256>`，不可原地更新/删除。Local 没有供应商版本号，明确保留 null；其内部版本依靠受控不可变 key、PG 事实和每次读的实际 checksum，不伪造外部版本。
- 对象源被删除/撤权/换拥有者后不能继续读取版本字节；已验证过的历史元数据不是永久访问授权。版本 metadata 的 ready 不保证以后没有外部破坏，冻结和读取仍须验真。

## 单一任务/事件链

请求只在一个 PG 事务内保存 pending + 现有 jobs 任务 + 统一 DataOutbox 事件，不直接双写存储。现有 PersistentJobWorker 负责租户解析、心跳和 fencing；ObjectVersionJobHandler 物化与核验真实字节，领域状态/事件/job 完成在同一事务提交。没有第二个队列或 Outbox。

Worker 新增可选领域事务结算模式：领域处理器必须证明相同 fencing token 的任务已持久结算，通用 Worker 不再重复 complete；旧处理器默认路径不变。错误租户在处理器拿到权限前拒绝。旧租约即使留下受控副本也不能发布 ready；新租约可复用它。

副本存在时先完整 GET/SHA 验证后复用，不依赖原缓存仍在；不存在才从固定源读取并条件写入。上传后 DB/事件提交失败可回滚事实，再经既有任务重试恢复；不丢弃事件或把存储 HEAD 当作字节证明。未知错误文本不进入事件/响应，瞬态失败按 5 秒重试且最多由现有任务 maxAttempts 约束；永久失败不自动“复活”。显式永久失败恢复 API/GC 与运行时默认装配仍待实现。

## 冻结验证与兼容

- ProductionInputObjectVerifier 使用同一生命周期事务 client，锁住内部版本与源状态，再读取受控副本并独立计算 SHA/大小；不能只靠 PG metadata 或 HEAD 声称匹配。
- 040 对已验证 Snapshot 的 ShotSpec AssetPack.media 引用建立物理 FK/JSON 绑定保留。控制图/AssetPack 独立版本表的进一步引用链归对应 owner 后续接入，不能把这条桥接表当作所有媒体依赖已覆盖。
- 早期原型的 provider-only objectVersionId 只可作为不可证明历史读取，不能自动别名成内部版本后继续 freeze。040 遇既有 ready/frozen 不可证明引用整体失败回滚，不改写原 JSON、不猜版本。部署前必须备份、审计并人工处理。
- S3 兼容 get/head/签名 GET 支持显式真实 providerVersionId，响应缺失或替换它则拒绝，不回退 current。原生产媒体读取/恢复/签名也透传已登记的供应商 selector。无 selector 的旧调用保留既有行为，不冒充已完成 V1 全量迁移。

## 验证边界（2026-11-09）

- 使用真实 PG17.6 + 真实 LocalObjectStorage + 实际任务仓库/租户解析器/通用 Worker：幂等 reserve、真实字节物化、原对象替换后仍读副本、损坏拒绝、跨 workspace 拒绝、租约接管拒绝旧提交、重试与永久失败、Outbox ready 事件注入故障时领域/job/事件一起回滚，且原缓存随后消失仍能恢复正确副本。
- `test:rls` 7/7：4 项应用角色集成、3 项管理员隔离 schema 迁移测试；后 3 项不是 RLS 证据。既有 DB 27/27。对象源 ready 行是明确的测试 fixture，不能当作完整上传/资产授权/媒体格式校验流程的证据。
- 供应商 selector、拒绝回退、公开请求边界、Worker 结算与冻结验真相关单元 20/20（S3 为 SDK facade 桩，不是真实云服务）。已有 HEAD-only 正向夹具已改为“不能批准 provider-only 历史”的负向断言；正向证明由新真实 PG+磁盘测试承担，不删除或跳过验真要求。
- 全包构建成功；本地后端全量保留已有 Windows drawtext 字体失败（#111），不声称全量通过；当前提交 Linux CI 须单独验证。
- 没有真实云/MinIO 互通、付费模型、进程级故障接管、吞吐/SLO 或浏览器视觉验证。MIME 类型沿用原拥有者已登记的事实（Local GET 没有 MIME header），本层不冒充新的媒体格式 sniff/审核器。读取预算默认 64 MiB、服务端可配置；大模型/视频流式处理与资源上限仍需联调。

管理 API、默认 main Worker 注册、真实资产媒体入库/AssetPack owner、控制图和 V2 Video/其余媒体适配、正式策略/权限/能力装配、V1/灰度/完整 E2E 均未完成，#123 保持开放。对象 ready fixture 或正确字节不能替代资产准入与授权。必须非作者真人审查当前 head，并对齐 #124 前置；不自动合并、不触发真实付费。

开发期间检测到 #144 已由维护者合并，后续对象版本使用最新 dev 的独立 PR。另有 #145 预留 039_tool_and_skills.sql，本迁移使用 040，避免与并行贡献重复编号；未改写已发布迁移或伪造本地 schema_migrations。最终分支基于 d04758e，在全新专用数据库 lyra_object_versions_040_test 从 001 完整应用到 040（跳过未合并的 032/039），迁移成功；在该库重跑 test:db 27/27 与 test:rls 7/7。没有改写旧原型数据库的 schema_migrations。
