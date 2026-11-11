# 媒体预设执行协议与能力门禁（#174）

日期：2026-11-11。Owner：@K80Tom / @255308153。适用：`fix/media-preset-protocol-guard`，基于 `dev df976eb`。本页更新了最初 `130b5ba` 仅拦截已知协议的切片；以当前 PR head 为准。

## 执行事实与边界

- 公共 `ModelExecutionBinding` 明确 `providerId / adapter / protocol / presetCode / config`。参数 Schema 拒绝未知字段、密钥、类型/协议错配及不一致的默认配置。
- 目录 API 明确返回每个预设的执行绑定；Profile 将其持久化到现有私有配置库 `schemaVersion:3`，不再丢弃媒体能力参数。
- 当前选中 Profile 的运行路径注册 `openai-chat-v1`、`ark-image-v1`、`ark-video-v1`。所有内置文本预设和两个火山媒体预设进入各自匹配的客户端；其他预设为 `adapter:unavailable / protocol:metadata-only`，公开 Profile 为 `configured:false / execution:metadata-only`，不能分配用途或提交。
- `models/video-providers/` 中已有独立 Kling/MiniMax/Jimeng 商业适配器类，但不能把“类存在”当作这条 Profile/自动制作路径已接通。MiniMax 额外凭据、持久预算拦截、请求能力与恢复对账尚需完整装配；本 PR 不用假账本、假 GroupId 或缺失授权去开启它们。OpenAI/DashScope 媒体等也未因此启用。
- Main 的桌面资产、生产资产执行器、视频自动化通过绑定路由工厂，底层客户端再次校验，防止内部绕过 Profile。已知异构模型改 Endpoint、已知非 Ark 厂商主机改模型名也不能绕过旧配置拦截。

## 不可变身份与参数

- 显式预设 Profile 的 Endpoint、model、kind 不可通过编辑静默替换。名称、Key、超时等仍可正常维护。新模型需新建连接并重新选择/确认。
- 复制同一模型身份的服务端凭据时，同时复制原绑定与能力，不会悄悄降级成无约束连接；不回显 Key。
- 公共响应深拷贝，运行时绑定、能力对象及列表均冻结。HTTP 不接受客户端提供/弱化 `executionBinding`。
- 图片默认尺寸来自预设 `defaultWidth/defaultHeight`；请求尺寸的已声明分辨率/画幅限制在 transport 前验证。
- 视频消费声明的 `defaultDuration/defaultResolution/defaultAspectRatio`，校验时长范围/可选时长、分辨率、画幅及首尾帧开关。**支持列表不等于默认值**，不擅自取列表第一项。火山视频预设明确推荐 5 秒、720p、16:9；用户指定的合法值仍完整保留到请求体。
- 运行输入不合法或路由/凭据缺失时，本地拒绝，零上游请求；生产图片规划在费用预留前检查路由。上游超时/响应不确定仍维持原有 unknown/不自动重发纪律，不把它说成“未计费”。

## v1/v2 → v3 兼容升级与回退

1. 在实际升级前，维护者停止 API/Worker，将旧私有配置单独备份到受限位置，按明文密钥文件保护；绝不提交 Git、浏览器或测试产物。
2. API 初始化时原子写入 v3；保留角色分配、ID、revision、地址、模型、Key、清空状态及已有额度。只读 Worker 可以读取 v1/v2，但不写迁移文件，API 替换后正常刷新。
3. 旧手工连接保留其既有文本/Ark-compatible 契约，显式持久化为 `providerId:custom` 的对应协议。对已知火山模型补上安全限制，但**不注入预设的新默认值**，避免改变已确认任务参数；对已知异构媒体仅保留元数据并阻断。
4. v3 必须携带合法绑定；损坏协议、错配身份、未知版本均 fail closed，不覆写原文件、不回退到环境凭据。显式预设 Profile 保留冻结能力，不能从当前可变默认值重算替换。
5. 回退必须协调停止全部 API/Worker，恢复受保护的旧配置备份及相配套代码，再核对所有用途。旧程序不能读 v3 时会拒绝启动；不要删字段/改版本号来绕过校验。回退代码也必须保留媒体协议拦截，不能重新放开已知错误协议。升级后新配置应人工核对，不无声覆盖。

这是现有私有连接文件格式升级，**无 SQL 迁移**；不等于完成全局配置 PostgreSQL 化或多租户供应商账本验收。

## 实际离线证据

- `npm --prefix packages/shared test`：23/23；全包 `npm run build` 成功。
- `cd packages/main; node --test tests/model-execution-routing.test.cjs tests/media-protocol-guard.test.cjs tests/media-client.test.cjs tests/model-presets.test.cjs tests/model-connections.test.cjs tests/model-library.test.cjs`：114/114。
- 新路由测试逐一验证全部 11 个可执行预设的 `目录 → Profile → 私有文件 → 重启 → 真实客户端/模拟 transport`，核验授权头、确切 endpoint、协议请求体、默认值和视频 GET 轮询；未知/错配协议、能力越界、缺凭据和客户端弱化配置均在 transport 前拒绝。
- 另测 v1/v2 迁移、Worker 只读/刷新、旧异构配置阻断、CAS、深冻结、复制绑定及损坏文件不覆写。旧迁移断言升级为 schemaVersion 3，同时保留角色/凭据等行为断言，不删除安全测试。
- Main 全套：1043 项，1036 pass / 2 fail / 5 skipped。两项仍为既有 Windows 路径失败：`governance-workflows.test.cjs:171` 的分隔符、`storage-driver.test.cjs:60` 的对象路径判断；没有跳过/弱化断言，不声称本地全绿。
- Agent 44/44、Web 140/140。本 PR 不改界面布局/交互，只扩展前端响应类型；未进行浏览器人工验收。

以上是离线协议/路由回归，不是供应商实际模型、可用性、收费结果、画面质量或云上验收。没有真实付费调用。#172 的跨厂商快速连通与新增适配器、配置 UI 完整体验仍 partial。需非作者真人批准当前 head，不批准、不自动合并。
