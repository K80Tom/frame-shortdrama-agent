# 项目工作区读模型与正式主链（#182）

适用分支：`feat/ux-182-project-flow`，基于 `dev 36ede58`（已含 #186 项目入口收敛）。本文只记录本轮实际实现与验证边界，不把桩测试当作真实数据库或浏览器验收。

## 1. 项目区段

正式项目只保留六个区段，顺序固定：

| 区段 | 内容 | 数据来源 |
| --- | --- | --- |
| `overview` | 真实状态摘要 + 唯一主行动 | `GET /api/projects/:id/workspace-overview` |
| `script` | 原文版本、拆解运行、事实校对与采用 | 既有 script-versions / breakdown-runs / plan-revisions / adoptions API |
| `assets` | 资产需求 vs 已绑定资产，只读 | `GET /api/projects/:id/asset-requirements` |
| `storyboard` | 正式分镜候选、采用状态；本切片只读 | 既有 storyboards / adoptions API |
| `canvas` | 生产画布，沿用既有 `CanvasWorkspace` | 既有画布与运行 API |
| `production` | 制作运行、检查点与交付，沿用既有 `ProductionAutomationPage` | 既有 production-runs / video-automation API |

旧 hash 由 `packages/web/src/project-flow.ts` 归一，不出现 404：

- `source` / `screenplay` → `script`
- `review` / `history` → `production`
- `director` → `storyboard`
- 未知区段降级 `overview`，但保留 `projectId`

## 2. 两个只读接口

均挂在既有 `ProjectsController`，只读、无写令牌、无模型/付费调用：

- `GET /api/projects/:projectId/workspace-overview`
- `GET /api/projects/:projectId/asset-requirements`

约束：

- `workspaceId` 只从租户作用域派生，不接受请求体或 query 覆盖；不调用 `runAsSystem`。
- 跨租户与项目不存在返回同形 `404 PROJECT_NOT_FOUND`，不泄漏项目是否存在。
- 资产匹配复用 `packages/main/src/production/executors/assets.ts` 的 `matchEntities` 与 `MATCH_RULE_VERSION='production-asset-match/5'`；前端不复制匹配规则、不打分、不自动选中同优先级候选。

`nextAction` 严格按以下优先级返回唯一主行动：

1. 无剧本 → `add-script`
2. 有剧本无拆解 Run → `start-breakdown`
3. 有候选未采用 / 检查未过 → `review-facts` 或 `adopt-facts`
4. 资产 missing/ambiguous > 0 → `resolve-assets`
5. 有分镜候选未采用 → `adopt-storyboard`
6. 已采用分镜无制作 Run → `create-production`
7. 有 open todo → `handle-todos`
8. 有交付 → `view-delivery`
9. 否则 `null`

概览不再按导航区段计算百分比，改为剧本版本、事实场次/实体、资产绑定、采用分镜、最新运行、待办与交付的真实摘要。

### 事实梗概的人工补写

拆解契约允许 `synopsis` 为 `null`，但完成度校验把 `SYNOPSIS_MISSING` 记为阻断项。为避免“校验失败后无入口可修”的死锁，`script` 区段把梗概升级为一等可编辑字段：

- 候选存在时始终显示「剧情梗概」编辑框；未保存的梗概与实体校对一样计入脏稿与离开保护。
- 保存只走既有人工校对通道 `POST /api/plan-revisions/:planRevisionId/entity-edits`；请求允许 `edits: []` 且只带 `synopsis`，生成 `reason='manualEdit'`、`createdBy='user'` 的新候选。
- 人工梗概的 `origin` 记为 `user`，`sourceRefs` 优先复用原有梗概引用，其次首个场次、首个实体，最后回退到剧本前 20 万字符；不伪造模型来源。
- 有未保存校对（含梗概）时禁用程序校验与采用；先保存新候选，再点「重新运行程序校验」。校验失败时页面给出同样指引，不会把“需要先保存”误读成按钮永久变灰。

### 结构化剧本（分集 / 场次 / 五类元素）

`script` 区段不再把分集、场次和元素只当成一段 `rawText`。正式数据模型对齐融光项目的 `ScriptEpisode → SceneItem → DialogueElement`：

- 分集：`episodeNumber`、`title`、`synopsis`、`scenes[]`
- 场次：`sceneNumber`、`intExt`、`location`、`timeOfDay`、`sceneDescription`、`dialogues[]`
- 元素：`type` 固定 `1=对白 / 2=动作 / 3=旁白 / 4=镜头 / 5=环境`；对白和旁白有 `characterName`、`parenthetical`
- 结构保存在 `script_versions.structure_json`（迁移 `055_script_structure.sql`），`rawText` 由服务端从结构派生，既有拆解和源索引链路继续读取派生文本
- `POST /api/projects/:projectId/script-versions` 同时接受 `{ rawText }` 或 `{ structure }`；`{ structure }` 优先，服务端重新派生 `rawText`，不接受客户端同时提交两份互相矛盾的内容
- 场景卡提供「保存本场」；每次保存仍产生一个新的不可变 `script_versions` 版本，旧版本不被覆盖。这是 Lyra 版本模型与融光按场 `version` 语义的对齐方式
- 切换到「原文」后仍可直接编辑文本；保存原文会生成没有 `structure_json` 的旧式版本，下一次进入结构化编辑器会重新解析

分镜仍然独立于剧本：正式 `StoryboardItem` 不是剧本元素类型 4 的替代；按集生成、`scriptEpisodeId` 绑定和分镜场次/镜头结构属于下一步，不在本切片中冒称完成。

## 3. 边界

- 正式项目不再渲染本地 `StoryboardPage`、`ProductionPage` 或 `DirectorWorkspace`；本地练习页仍保留，并明确标注「练习用，不用于正式制作」。
- 不新增全局个人画布，不重写生产 DAG、RLS 或 Outbox。
- web 不直连数据库或模型；所有正式读写仍走 main HTTP API。
- 人工编辑分镜候选、迁移与幂等属于 #184，本切片不冒称完成。

## 4. 验证与限制

本轮实际运行：

- `npm --prefix packages/shared run build`：通过
- `npm --prefix packages/shared test`：28/28 通过
- `npm --prefix packages/main run build`：通过
- `npm --prefix packages/main test`：1060 项 / 1057 通过 / 0 失败 / 3 跳过（桩模型；其中结构化契约 3/3）
- `npm --prefix packages/web run build`：通过
- `npm --prefix packages/web test`：159/159 通过（含结构化剧本解析、增删与保存适配 5 项）
- 迁移 `055_script_structure.sql`：在隔离演示库实际执行成功
- 真实 PostgreSQL + 真实后端 + 浏览器：在 5203 打开剧本区，解析出 2 集 3 场和动作/对白/旁白/镜头/环境；点「保存本场」生成 version 4（`structure_json` 非空）；新增对白「老周：这块表，你还留着。」再保存生成 version 5，数据库确认结构末元素为 `type=1` 且派生 `raw_text` 含该对白

未运行/未验证：

- 真实 PostgreSQL、RLS 与跨租户数据库回归（两个新接口只有桩仓储与 HTTP 层测试）
- 真实模型、付费任务、部署与迁移

## 5. 回退

本切片无 SQL 迁移、无配置变更；梗概人工保存复用既有人工校对写链路。按 commit 逆序 `git revert` 即可回退；`ProjectWorkspace` 的 6 区段导航、两个只读接口与梗概编辑可独立撤回，不影响 #186 的入口收敛。
