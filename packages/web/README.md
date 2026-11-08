# Lyra · STORY STUDIO

Lyra 是面向中文短剧的可部署创作与自动制片工作台。界面在 2026-10-22 至 2026-10-23 参考 Liblib 的信息组织方式完成重构：中性黑灰底色、荧绿强调、紧凑卡片和分组侧栏，并统一使用 **Lyra / STORY STUDIO** 品牌。Stage 1 通过同源 HTTPS 入口连接 `main-api`，浏览器不直连数据库、模型、Redis、Milvus 或对象存储管理面。

## Stage 1 会话与部署交互

- 首屏先请求 `GET /api/auth/session`；只有明确返回 `AUTH_NOT_CONFIGURED` 才进入可见的 Legacy 兼容模式，401 会显示真实登录页，网络或格式错误不会绕过登录。
- 登录页根据后端公开认证配置决定是否显示注册入口。默认 `LYRA_REGISTRATION_MODE=disabled`；受信自托管显式设为 `workspace` 后，注册会创建独立用户、独立 workspace 和 owner 成员关系，前端不能选择既有租户或自定角色。
- 会话凭据使用 HttpOnly `lyra_session` Cookie；可读 `lyra_csrf` Cookie 只用于向同源 POST 添加 `X-CSRF-Token`，不是登录凭据。
- 后端会话返回当前用户可访问的 workspace。切换后所有同源 `/api/**` 请求携带 `X-Workspace-Id`；绝不向跨域 URL 转发 workspace 或 CSRF 上下文。若存在未保存内容，切换前必须再次确认。
- 设置页的系统状态面板分开展示 API、Worker、PostgreSQL、Redis、Milvus 和对象存储。“Healthy”只表示对应探针成功，不代表队列已清空、回填/历史投影已完成、签名 URL 已公网可达或故障演练已通过；Worker 项来自 PostgreSQL 心跳，不是 Worker 暴露的 HTTP 端点。
- 退出成功会清理会话与本地 workspace 选择；退出请求失败时保留当前会话并显式报错，不在前端伪造已退出。
- 仓库和前端不提供默认明文密码。公网开放注册前仍需邮箱验证、CAPTCHA/边缘防滥用和租户额度/计费控制；当前注册模式只面向受信自托管环境。

项目采用 React、TypeScript 和 Vite，使用 hash 路由。既有 `frame:*` 浏览器存储键与内部数据协议继续兼容。

## 核心亮点：整集全流程自动制片

`#/automation` 已是整集「自动制作」总控，不再是单条文本生视频页面。用户选择一个已保存的剧本版本，设置画幅、目标时长、视觉风格、质量档位、自动化模式、每镜候选数、3D 策略和预算后，可以建立一条持久、可暂停、可恢复的生产运行：

```text
剧本拆解
  → 自动匹配已有资产 / 为真正缺失的资产生成候选
  → 分镜设计与采用
  → 按需生成规则式 3D 白模约束
  → 每镜生成多个视频候选
  → 技术抽卡与镜头技术复核
  → 携带失败项进行有限局部返修
  → FFmpeg 按分镜顺序合片
  → 成片复核与私有对象存储 MP4 交付
```

总控界面提供十阶段进度轨道、镜头级任务矩阵、问题收件箱、任务详情、候选采用、整组重做、检查点确认、预算摘要、事件时间线、暂停/继续、局部重试、运行历史和最终交付入口。运行数据保存在 PostgreSQL；刷新页面或重启服务后可继续读取真实状态。

自动化支持三种模式：

- **全自动**：通过确定性检查的文字候选由 Agent 采用，自动选择技术推荐视频，并在上限内建立局部返修。
- **关键节点确认**：在拆解、资产、分镜和交付等关键阶段等待确认。
- **共同导演**：更多可见阶段停下，由用户逐步决定。

所有模式都会遵守预算、配置、关键事实、未知外部状态和质量门禁。创建请求使用稳定的 `clientRequestId`；响应丢失时页面只查询原运行，不自动重复提交付费任务。运行可暂停、继续和从最小受影响范围重试。

原来的独立单条视频工具保留在 `#/automation/video`，用于测试一个画面描述和生视频连接。它不建立整集生产 DAG，也不替代 `#/automation`。

## 工作台界面

- **首页**：点阵新建入口、快捷工具、最近项目、特色能力和创作参考，支持快速查找（⌘/Ctrl K）与响应式导航。
- **项目**：集中展示剧本项目、小说原文和浏览器练习，支持搜索、类型筛选、网格/列表切换及指定 ID 跳转。
- **资产**：管理人物、场景和道具资产；支持 HTTPS 素材登记、本地 PNG/JPEG/静态 WebP 导入、详情查看和示例参考。小说中确认的实体可关联已有资产或标记待补。
- **插件**：内置能力目录，集中进入小说拆解、剧本拆解、分镜、自动制作、3D 导演台、草稿导出与单镜头实验；尚未实现的工具明确标为规划中。
- **自动制作**：把整集运行的配置、阶段、镜头、候选、问题、预算和交付放在同一页面展示。

## 页面与链接

| 链接 | 用途 |
| --- | --- |
| `#/studio` | Lyra 首页与创作入口。 |
| `#/projects` | 剧本项目、小说原文与本地练习目录。 |
| `#/assets` | 已登记的个人资产库。 |
| `#/assets/references` | 资产工作区的示例参考页签。 |
| `#/plugins` | 内置工具与能力目录。 |
| `#/automation` | 已实现的整集全流程自动制片总控。 |
| `#/automation/video` | 独立单条视频连接与任务实验。 |
| `#/production/<id>` / `#/novel/<id>` | 直接打开指定剧本项目或小说；ID 使用 URL 编码。 |
| `#/production/new` / `#/novel/new` | 新建剧本项目或导入小说。 |
| `#/production` / `#/novel` | 兼容入口，读取目录后打开已有内容。 |
| `#/script` / `#/storyboard` | 浏览器内剧本与手写分镜练习。 |
| `#/director` | 浏览器内 3D 白模导演台。 |
| `#/settings/models` | 按拆解、生图、生视频和通用用途管理模型连接。 |
| `#/flow/1` 至 `#/flow/9` | 九步创作指南；旧 `#step-1` 至 `#step-9` 链接继续可用。 |

小说、剧本、资产、模型配置和未提交的自动制作设置都有离页保护。已经创建的后端任务离开页面后继续执行，重新进入后读取持久状态。

## 其他已实现能力

- 小说逐章拆解、原文引用定位、人物/地点/道具/对白校对、不可变版本历史与资产引用。
- 真实剧本项目、剧本版本、事实拆解、程序检查、人工校对、候选采用及分镜生成。
- 资产视觉简报、逐次授权的单图候选、候选留存、人工接受/拒绝和本地资产导入。
- 浏览器分镜练习：TXT 导入、原文/对白对照、镜头编辑、本地草稿和 JSON 导出。
- 3D 导演台：人物体型与姿势、关节微调、几何物体、群众阵列、GLB 导入、机位/焦段、光照、画幅、构图线、场景保存，以及 PNG、机位宫格、深度图和 WebM 运镜导出。
- 模型连接按用途保存于后端私有共享配置；当前 Stage 1 仍是共享卷中的明文 JSON，密钥不进入浏览器存储或仓库，生产验收前仍需迁入 Secret Manager/KMS。

## 自动制作的真实边界

整集视频请求会带入镜头已绑定的有序参考图片，并请求视频供应商的原生音频。视频完成后必须先安全下载到 Worker 的受控私有暂存区，经过哈希与 `ffprobe` 校验，再通过持久任务投影到对象存储，才能进入候选抽卡、复核、FFmpeg 合片和交付。

当前“镜头技术复核”验证容器与哈希，检查画幅、时长和音轨，并读取分辨率参与候选评分。它不表示人物长相、动作、剧情、对白、连续性或审美已通过视觉语义审核，成片仍需要人工观看。

生产流程中的 3D 环节会按确定性规则生成白模快照，并把活动机位、焦距、运镜、人物站位与姿态转成视频 prompt 约束。当前是 **prompt-only**，没有把 3D 渲染图作为供应商输入，也不等于供应商原生相机控制或 AI 视觉导演。

当前时间线保留视频供应商随镜头生成的原生音轨，还没有独立配音、口型同步、音效、配乐、混音和字幕子流程。技术抽卡与返修不会把这些未实现能力描述成已经完成。

完整流程代码和离线验证已经打通，但没有为了验收自动触发真实付费全链路。真实运行需要在部署环境的后端私有配置中提供相应用途的模型连接，并由用户在创建该次运行时明确勾选授权和设置预算上限。

## 部署与开发预览

Stage 1 单受信 workspace 试运行由根目录 [`deploy/compose.yaml`](../../deploy/compose.yaml) 构建并由 Web 容器同源反向代理。详细的 HTTPS Origin、管理员 bootstrap、健康检查、备份恢复和待执行验收目标见 [Stage 1 部署手册](../../deploy/README.md)。

仅在贡献代码时使用 Vite 开发服务：

```sh
npm --prefix packages/web ci
npm --prefix packages/web run dev
npm --prefix packages/web test
npm --prefix packages/web run build
```

开发兼容模式不是生产部署方案。FFmpeg/ffprobe、数据库、对象存储或对应模型连接不可用时，受影响节点必须明确停止，不会伪造成功产物。

## 2026-11-08 验证记录

- 前端 117 项自动化测试和 TypeScript/Vite 生产构建通过，新增覆盖会话恢复、登录/退出、CSRF/workspace 请求头、Legacy 兼容和六项系统状态。
- 自动化验证没有使用真实模型、API Key 或付费媒体调用，不能替代部署环境的 HTTPS/Cookie、租户越权、备份恢复和人工成片验收。

## 数据与存储

- 示例分镜草稿保存于当前浏览器的 `frame:ui-draft:v1`；它不是生产计划数据库。
- 3D 白模使用 IndexedDB `frame-director-v1` 保存，清理网站数据会删除本机场景，应通过 JSON 导出备份。
- 项目、小说、资产、完整对话、模型任务和整集生产运行由 `main` 与 PostgreSQL 持久化；Redis 只保存可重建快照。
- Stage 1 已为生产视频/成片接入 local/MinIO/S3/OSS/COS 对象存储端口、租户化 key、`object_records`、持久任务、Outbox、常驻投影 Worker、租户化对象读取和 `/api/production-media/:id/access` 签名入口；API/Worker 共享私有卷只保留本地暂存/过渡/恢复副本。导入资产图片仍保存于 PostgreSQL `asset_media.content`，后续需完成对象化迁移，并验证云环境中浏览器可达的公网 HTTPS 签名 endpoint、授权边界和孤儿对象 GC。
- 模型密钥仅由后端保存；前端不使用 `VITE_` 变量携带密钥。
- 外部素材链接仅允许受控 HTTPS 登记；登记本身不证明授权、可达性或长期有效性。

## 主要文件

- `src/App.tsx` / `src/navigation.ts`：整体布局、侧栏、路由、命令菜单和离页保护。
- `src/AuthBoundary.tsx` / `src/auth.ts`：会话恢复、登录/退出、Legacy 边界与会话用户状态。
- `src/WorkspaceSwitcher.tsx` / `src/deployment.ts`：workspace 切换、全局租户/CSRF 请求头与部署状态契约。
- `src/SystemStatusPanel.tsx`：API、Worker、PostgreSQL、Redis、Milvus 和对象存储状态。
- `src/WorkspaceHome.tsx` / `src/home.css`：首页与最近项目。
- `src/ProjectsPage.tsx` / `src/projects.css`：项目目录、搜索、筛选和视图切换。
- `src/AssetWorkspace.tsx` / `src/AssetLibrary.tsx`：个人资产库、示例参考、素材登记与详情。
- `src/LibraryPages.tsx` / `src/library.css`：插件与内置工具目录。
- `src/ProductionAutomationPage.tsx` / `src/production-automation.ts` / `src/production-automation.css`：整集自动制作总控、运行解析、真实进度与操作。
- `src/VideoAutomationPage.tsx` / `src/video-automation.ts`：保留的独立单条视频工具。
- `src/production.tsx` / `src/NovelBreakdown.tsx`：真实剧本项目与小说逐章拆解。
- `src/ModelConnections.tsx` / `src/model-connections.ts`：按用途管理模型连接。
- `src/director/`：浏览器 3D 白模导演台；来源见 [第三方代码说明](THIRD_PARTY_NOTICES.md)。

整集实现、恢复策略、媒体安全链与详细边界见[全流程自动制片实现](../docs/Lyra全流程自动制片实现-v0.1.md)。旧的独立九步教学页面保留在 `../flow-explainer/`，不属于本次 Lyra 工作台视觉系统。
