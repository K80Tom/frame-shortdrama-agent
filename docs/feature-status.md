# 功能状态与证据（单一入口）

盘点日期：2026-11-09。适用代码快照：`dev b264844`（v0.2.0），加本 PR 的文档增量；不是部署或发布验收。Owner 为 CODEOWNERS 默认维护责任 `@K80Tom / @255308153`，不是个人贡献归属或验收背书。

## 判定与证据规则

- `not-started`：当前快照未发现该目标能力的正式实现入口，不以目录或依赖存在推断能力。
- `partial`：有实现，但整项 Issue 的契约、权限、异常恢复或 E2E 尚不完整/未核验。
- `implemented`：只对明确限定的范围，附适用提交、实际命令、结果及限制；不由 Issue 关闭或 PR 绿灯推断。
- `verified`：另有真实目标环境/供应商记录，包含日期、提交/模型版本、脱敏产物、预算与真人结论。离线桩不能替代。

源码入口、测试文件、实际执行、真实环境验证是不同字段。以下能力均未因此升级为 `verified`；本 PR 本地只做文档/治理静态校验，未重跑产品、数据库、模型或浏览器测试。引用合并 PR 的既有测试入口/记录时，只是证据导航，不冒称本轮独立复验。

## 当前 15 项 Issue 台账

各行适用上述快照；源码是已合入入口，待审代码另列。默认 owner 同上。无独立执行记录的项目写“本轮未重跑”，不代表失败，也不是通过。

| Issue / 能力 | 状态 | 已合入源码 / 测试入口 | 执行与真实验证 | 缺口与启用边界 |
| --- | --- | --- | --- | --- |
| [#123 主流程冻结](https://github.com/K80Tom/frame-shortdrama-agent/issues/123) | partial | [ShotSpec/快照/Run](../packages/main/src/production/)；[冻结测试](../packages/main/tests/production-frozen-run.test.cjs)、[PG 生命周期](../packages/main/tests/production-input-lifecycle.db.test.cjs) | [#144 合并切片记录](production-input-snapshot-progress.md)、[Run 边界](frozen-production-run-progress.md)、[导演场景](director-scene-versions.md)；本轮未重跑/未验真实模型 | 已有不可变版本、双 CAS、冻结与绑定，以及部分精确消费；不是全部默认 V2。正式 AssetPack/控制图、Assets/Video 等消费与灰度/E2E 尚未齐；#147 对象版本待审 |
| [#124 部署底座](https://github.com/K80Tom/frame-shortdrama-agent/issues/124) | partial | [启动](../packages/main/src/main.ts)、[jobs](../packages/main/src/jobs/)、[部署](../deploy/README.md)；[Worker](../packages/main/tests/stage1-worker-runtime.test.cjs)、[租户 PG](../packages/main/tests/stage1-tenant-isolation.db.test.cjs) | 本轮未重跑/未验目标环境 | API/Worker、会话/RLS、Redis/Milvus/对象投影有实现；旧调度全面接管、云签名权限、GC、备份恢复、SLO 与故障演练未全部验收；asset_media BYTEA 仍是例外 |
| [#125 AI 工作区](https://github.com/K80Tom/frame-shortdrama-agent/issues/125) | partial | [agent](../packages/agent/src/assistant/)、[HTTP](../packages/main/src/assistant/controller.ts)；[测试](../packages/main/tests/assistant.test.cjs) | 2026-11-10 本轮 `npm --prefix packages/main test`：856 pass / 1 skipped，`npm --prefix packages/web test`：138 pass；确认卡已带预计耗时与费用明细（迁移 046）；未验真实供应商 | 有会话、SSE、只读工具与确认卡；预计耗时是离线推算不是供应商 SLA；不能据此宣称任意领域执行或完整预算授权 E2E |
| [#126 资产与检索](https://github.com/K80Tom/frame-shortdrama-agent/issues/126) | partial | [资产契约](../packages/shared/src/assets.ts)、[资产包仓储](../packages/main/src/assets/asset-pack-repository.ts)、[迁移 050](../packages/main/migrations/050_asset_pack_versions.sql)、[检索/解释](../packages/main/src/assets/retrieval.ts)、[混合召回](../packages/main/src/assets/vector/hybrid.ts)；[单测](../packages/main/tests/asset-pack.test.cjs)、[DB 测试](../packages/main/tests/asset-pack.db.test.cjs) | 2026-11-10 本轮 `npm run build` + `npm --prefix packages/main test`：943 tests / 941 pass / 2 skipped；`ASSET_TEST_DATABASE_URL=... node --test tests/asset-pack.db.test.cjs` 1/1；全新 PG 15 库应用 49 条迁移（含 050），050 可重跑；未验真实 Milvus 或召回质量 | 已落地不可变 `AssetPackVersion`（多角度/表情服装/授权审核/采用）、050 三表 FORCE RLS、PostgreSQL 预筛 `assetIds` 的混合召回与角度/约束/语义/词法解释、Milvus 不可达降级与命中回表强验真；仍缺 API/UI、黄金集与召回质量、全量索引生命周期/alias 切换、Production Snapshot 与 `ShotAssetPack` 正式对接 |
| [#127 视频与强约束](https://github.com/K80Tom/frame-shortdrama-agent/issues/127) | partial | [控制契约](../packages/shared/src/video-control.ts)、[请求编译](../packages/main/src/video-generation/control-plan.ts)、[首尾帧适配](../packages/main/src/video-automation/adapter.ts)、[商用适配器](../packages/main/src/models/video-providers/)、[生成 Worker](../packages/main/src/production/video-worker.ts)；[编译测试](../packages/main/tests/video-generation.test.cjs)、[适配测试](../packages/main/tests/video-control-adapter.test.cjs)、[供应商测试](../packages/main/tests/video-providers.test.cjs)、[Worker 测试](../packages/main/tests/video-worker.test.cjs) | 2026-11-10 本轮 `npm --prefix packages/main test`：891 pass / 2 skipped；DB 套件（超管）30 pass / 1 skipped；未调用真实视频供应商、未验视觉质量 | 已落地版本化能力矩阵、控制帧/候选/修复契约、applied/transformed/unsupported/blocked 编译决策、首尾帧 asset 提交与 `provider_scratch` 音轨边界；本轮新增 Seedance（方舟 content 协议、首尾帧 role、1.0 系音画同生显式拒绝）与 Kling/Jimeng/MiniMax/Seedance 四家任务轮询、`video.generate` Worker（验真→提交→有界轮询→受控下载→驱动落盘→046 台账），控制帧持久化与采用状态机、Director 设备导出入库、单镜语义检查、跨镜连续性和风险候选策略仍需接入 |
| [#128 检索策略治理](https://github.com/K80Tom/frame-shortdrama-agent/issues/128) | partial | [evolution](../packages/main/src/evolution/)；[测试](../packages/main/tests/asset-evolution.test.cjs) | 本轮未重跑/无真实 shadow probe | 固定离线候选/Probe、人工采用/回滚存在；Registry 租户修复 #132/042 待审，真实遥测、授权集、canary 与生产门槛未完成 |
| [#129 生产画布](https://github.com/K80Tom/frame-shortdrama-agent/issues/129) | partial | [后端](../packages/main/src/canvas/)、[前端](../packages/web/src/canvas/)；[测试](../packages/web/tests/canvas.test.mjs) | 2026-11-10 本轮 `npm --prefix packages/web test`：138 pass；新增节点 generate 端点与 runtime-view 队列/进度/成片字段；未做浏览器视觉验收 | 有后端版本事实、commands、比较/采用/报价/运行入口；节点触发复用该 revision 的整条运行，不是单镜独立生产；未装配领域 Service 的命令仍明确拒绝 |
| [#130 声音与字幕](https://github.com/K80Tom/frame-shortdrama-agent/issues/130) | partial | [声音契约](../packages/shared/src/audio-production.ts)、[对白轨](../packages/main/src/audio-production/dialogue.ts)、[授权](../packages/main/src/audio-production/authorization.ts)、[TTS 编排](../packages/main/src/production-media/audio/tts.ts)、[混音与成片装配](../packages/main/src/production-media/audio/assembly.ts)、[音频/字幕资产库](../packages/main/src/production-media/audio/audio-store.ts)；[契约测试](../packages/main/tests/audio-production.test.cjs)、[声音装配测试](../packages/main/tests/audio-assembly.test.cjs) | 2026-11-10 本轮 `npm --prefix packages/main test`：861 pass / 3 skipped；`LYRA_TEST_FFMPEG=1 node --test tests/audio-assembly.test.cjs` 7/7，用本机 FFmpeg 4.3.2 实跑 2 镜头 + 对白 + BGM + 烧录字幕，产物 4.02s/360×640/AAC；对白段相对对白后 BGM 的 220Hz 窄带实测约 -6dB，且对白结束后 BGM 恢复；未调用真实 TTS 供应商、未做完整听觉验收 | 已落地授权门禁 TTS 编排、内容寻址音频/字幕资产、`sidechaincompress` 自动 ducking、`drawtext` 烧录与 SRT sidecar、真实 `CueSheetVersion`（对白/BGM/SFX cue）与 Mix/Delivery 候选；仍缺真实 TTS 供应商适配与预算/Attempt 持久化、口型、CueSheet 编辑器、实测响度/true peak（mix quality 标记 inconclusive）及 DB/API/UI 接入；成片装配目前是服务级入口，尚未接入 Production finalization |
| [#131 方法包](https://github.com/K80Tom/frame-shortdrama-agent/issues/131) | partial | [prompt-packs](../packages/main/src/prompt-packs/)；[测试](../packages/main/tests/prompt-packs.test.cjs) | 本轮未重跑/未验生成质量 | 提示参考、导入与部分运行冻结存在；工作区准入/项目配置/正式不可变方法包治理与完整装配未全部完成；#145 待审 |
| [#133 数据中台](https://github.com/K80Tom/frame-shortdrama-agent/issues/133) | partial | [data](../packages/main/src/data/)；[流水线](../packages/main/tests/data-pipeline.test.cjs)、[Worker](../packages/main/tests/stage1-worker-runtime.test.cjs) | 本轮未重跑/未验目标部署 | 已有统一 Outbox、租户 V2、pump/Projector/checkpoint；全业务统一事实、血缘/成本、可重放证据链及 API/运维仍需逐项验收 |
| [#134 评测中台](https://github.com/K80Tom/frame-shortdrama-agent/issues/134) | partial | [evaluation](../packages/main/src/evaluation/)、[run](../packages/main/src/evaluation-run/)；[测试](../packages/main/tests/evaluation-run.test.cjs) | 本轮未重跑/无真实质量回归证据 | 已有运行/契约基础；同条件评测、正式评估器、预算化评审、人工裁决与 E2E 未齐。#110 统计、#113 离线门禁待审，不能当成已装配 |
| [#135 自进化](https://github.com/K80Tom/frame-shortdrama-agent/issues/135) | partial | [evolution](../packages/main/src/evolution/)；[测试](../packages/main/tests/asset-evolution.test.cjs) | 本轮未重跑/无真实灰度质量记录 | 现有资产策略固定离线 Probe/人工采用不等于通用评测门禁、在线灰度、自动回滚或真实改善 |
| [#136 Agent 架构](https://github.com/K80Tom/frame-shortdrama-agent/issues/136) | partial | [assistant](../packages/agent/src/assistant/)；[测试](../packages/main/tests/assistant.test.cjs) | 本轮未重跑/未验领域协作恢复 | 已有纯逻辑编排/持久对话入口；正式领域 Agent 的恢复、权限、协作协议与生产状态闭环未全部实现；#145 待审 |
| [#137 Tool Registry](https://github.com/K80Tom/frame-shortdrama-agent/issues/137) | partial | [生产工具目录](../packages/agent/src/production-tools/catalog.ts)、[Registry 装配](../packages/agent/src/production-tools/registry.ts)、[main 执行/视图](../packages/main/src/tool-registry/service.ts)；[目录测试](../packages/agent/tests/production-tools.test.cjs)、[HTTP 测试](../packages/main/tests/tool-registry-http.test.cjs) | `npm --prefix packages/agent test` 28/28；`npm --prefix packages/main test` 797 pass/2 skip（本地 2026-11-09）；未跑数据库 e2e、未触发真实付费 | 已发布 19 个 frozen ToolDefinition（含 2 个 Workflow-only 付费工具）并接 `/api/tools`；16 个写/付费 Adapter 仍 fail-closed，真实领域执行、双 Worker 租约、重启恢复与付费对账未落地 |
| [#138 MCP](https://github.com/K80Tom/frame-shortdrama-agent/issues/138) | partial | [MCP 管理服务](../packages/main/src/mcp-management/service.ts)、[配置控制器](../packages/main/src/tool-registry/controller.ts)、[出站准入](../packages/agent/src/mcp/mcp-guard.ts)；[HTTP 测试](../packages/main/tests/tool-registry-http.test.cjs) | `npm --prefix packages/main test` 覆盖 `/api/mcp` 私有地址/URL 凭据/查询密钥拒绝与 revision CAS；未做真实 MCP 握手 | 仅管理面：Server 配置/停用、Secret 引用、SSRF 门禁；无持久化表、discover/probe/admissions、连接 OAuth、工具映射与 invocations/reconcile，不能宣称受控互操作闭环 |

## 已合入切片与待审 PR 必须分开

截至本次 GitHub 盘点，#144（冻结输入/Run/导演场景）与 #146（画布/Assistant）已由维护者合并；合并不意味着其关联大 Issue 全部验收。本 PR 不自行批准或合并任何 PR。

| 待审 PR | 范围 | 当前台账处理 |
| --- | --- | --- |
| [#147](https://github.com/K80Tom/frame-shortdrama-agent/pull/147) | 内部对象版本、真实副本、认证 metadata API、Worker 恢复 | 未合入本快照；局部单元/PG/CI 不替代正式资产准入或完整生产 E2E |
| 本分支 `feat/model-generation` | #127/#130 执行层：预算拦截器、ComfyUI 原生客户端与工作流校验、Kling/Jimeng/MiniMax/Seedance 请求组装与任务轮询、`video.generate` Worker（044 对象验真 → 提交 → 轮询 → 成品落盘 → 046 台账）、TTS、FFmpeg 混音/Ducking/字幕烧录 | 未合入、未推送；`packages/main` 全量 891 pass / 2 skipped（2026-11-10）；DB 套件（超管）30 pass / 1 skipped，迁移 046 已在本地克隆库实跑；RLS 套件在共享库上被另一活跃 worker 实例的租约阻塞（stash 对照证明与本分支无关）；字幕烧录用本机 FFmpeg 7.1.1 验证；未调用真实供应商，未接 Director 编排 |
| [#132](https://github.com/K80Tom/frame-shortdrama-agent/pull/132) | Registry 租户隔离与未发布迁移 042 | 未合入；不能将 dev 正式 Canvas032 写成治理迁移，也不能改已应用迁移记录 |
| [#145](https://github.com/K80Tom/frame-shortdrama-agent/pull/145) | 工具/MCP/方法包/Agent Runtime 候选 | 其他贡献者待审代码，不重复宣称已在 dev 运行；迁移编号需维护者协调 |
| [#110](https://github.com/K80Tom/frame-shortdrama-agent/pull/110)、[#113](https://github.com/K80Tom/frame-shortdrama-agent/pull/113) | 统计 helper / 离线回归门禁 | 不等于评测流水线、生产质量或置信度 |
| [#112](https://github.com/K80Tom/frame-shortdrama-agent/pull/112) | ID-only 生产拒绝诊断 | 不是全仓错误/持久化 UI 脱敏、诊断包或日志基础设施 |
| [#111](https://github.com/K80Tom/frame-shortdrama-agent/pull/111)、[#114](https://github.com/K80Tom/frame-shortdrama-agent/pull/114)、[#121](https://github.com/K80Tom/frame-shortdrama-agent/pull/121)、[#122](https://github.com/K80Tom/frame-shortdrama-agent/pull/122) | Windows 字体、预检、安全修复 | 均未合入；按对应当前 head 的测试和真人审核单独验收 |
| [#109 本 PR](https://github.com/K80Tom/frame-shortdrama-agent/pull/109) | 文档/证据入口与协作路径修正 | 只是静态治理增量，模板提醒不是强制 CI、分支保护或真人批准的替代 |

## 旧 Issue 与稳定导航锚点

旧 Issue 的关闭状态不是新需求验收；保留原导航，具体范围按上表及关联 Issue 验证。

| 锚点 / 历史能力 | 当前入口与边界 |
| --- | --- |
| <a id="novel"></a>小说 | [novel](../packages/main/src/novel/)、[测试](../packages/main/tests/novel-workflow.test.cjs)；本轮未重跑，原文/采用/跨章传播不可由单测存在推定完整 |
| <a id="script"></a>剧本 | [breakdown](../packages/main/src/breakdown/)、[测试](../packages/main/tests/breakdown-persistence.test.cjs)；完整编辑/比较/按场重做须实测 |
| <a id="repair"></a>字段修复 | [执行测试](../packages/main/tests/extract-facts-execution.test.cjs)；局部修复不能静默改原文事实 |
| <a id="assets"></a>资产 | 见 #126/#128，不以单图或向量命中当资产包准入 |
| <a id="previs"></a>预演 | 见 #123/#127；prompt-only 与正式版本存储均不证明强约束生成 |
| <a id="review"></a>视觉复核 | [review](../packages/main/src/review/)；技术复核不是视觉语义/连续性验收 |
| <a id="audio"></a>声音字幕 | 见 #130 |
| <a id="reconcile"></a>付费核对 | [编排测试](../packages/main/tests/production-orchestration.test.cjs)；unknown 不可重复提交，需查询原外部任务 |
| <a id="editing"></a>时间线交付 | [交付测试](../packages/main/tests/production-finalization.test.cjs)；不代表可复现整集版本编辑全部完成 |
| <a id="evaluation"></a>评测 | 见 #134 |
| <a id="data"></a>数据 | 见 #133 |
| <a id="runtime"></a>调度 | 见 #124/#136；部分 jobs 底座不等于旧业务全部接管 |
| <a id="preflight"></a>预检 | [执行器](../packages/main/src/production/executor.ts)；#114 尚待审 |
| <a id="contract"></a>HTTP | [shared](../packages/shared/src/)；类型存在不代表所有 HTTP 边界已运行时闭合 |
| <a id="e2e"></a>E2E | 必须区分离线、真实 PG、真实存储、真实模型与目标部署，不能跨层外推 |
| <a id="observability"></a>诊断 | #112 尚待审；日志不是权威业务事件 |
| <a id="security"></a>安全 | #121/#122 尚待审；已有 DNS/媒体测试不证明所有地址和资源上限已覆盖 |
| <a id="backup"></a>备份 | [数据库](../packages/main/src/db/)；目标级备份/PITR/组合恢复没有本轮验证记录 |

## 更新与验证记录

功能 PR 更新适用提交、owner、代码/测试、实际命令、结果与限制；未变化时在 PR 说明原因。真实验证只收脱敏摘要与可审计产物，不提交凭据、私有 URL、个人路径或原始供应商响应。每次更新需检查本地链接、锚点、声明命令是否存在，以及待审/已合入快照边界；日期不是验收结论。

本轮文档静态校验结果与当前 head CI 在本 PR 正文记录；[文档有效性目录](documentation-index.md)区分当前规范、目标规范、范围记录和历史参考。新增 Issue 必须登记本表；关闭旧任务不自动升级新 Epic。治理 Issue #80 的历史关闭状态不等于强制自动验证或产品验收。


### 2026-11-09 本轮静态校验记录

针对本 PR 的 9 个 Markdown 文件，检查 135 个本地链接、7 个链接锚点、18 个原有导航锚点保留、4 份 YAML frontmatter、10 个实际匹配的 applyTo glob、35 条文档 Git 最后修改元数据，全部通过。声明的 npm scripts 在对应 package.json 中存在，但本轮没有运行这些产品命令。

同时对照 GitHub 当前列表核对 15 个开放 Issue 与 11 个开放 PR，确认 #144/#146 的合并提交在本基线祖先链中；未把待审分支写入已合入源码列。CODEOWNERS 原有 owner 成员与 /.github/ 保护不变，仅把旧产品路径替换为 /packages/；根 AGENTS.md 与 workflows 无 diff。git diff --check 通过。

这些是一次性只读静态校验，不是新增强制 CI 检查器、真人审批或产品/数据库/真实模型验收。当前 head 的 GitHub CI 结果须独立记录在 PR，不能引用旧 head 的通过。
