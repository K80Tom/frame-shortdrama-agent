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

## 3. 边界

- 正式项目不再渲染本地 `StoryboardPage`、`ProductionPage` 或 `DirectorWorkspace`；本地练习页仍保留，并明确标注「练习用，不用于正式制作」。
- 不新增全局个人画布，不重写生产 DAG、RLS 或 Outbox。
- web 不直连数据库或模型；所有正式读写仍走 main HTTP API。
- 人工编辑分镜候选、迁移与幂等属于 #184，本切片不冒称完成。

## 4. 验证与限制

本轮实际运行：

- `npm --prefix packages/shared run build`：通过
- `npm --prefix packages/main run build`：通过
- `npm --prefix packages/main test`：1057 项 / 1055 通过 / 0 失败 / 2 跳过（桩模型）
- `npm --prefix packages/web run build`：通过
- `npm --prefix packages/web test`：154/154 通过
- 真实 PostgreSQL + 真实后端 + 浏览器：在隔离演示库中把缺失梗概补成人工候选，校验由 `SYNOPSIS_MISSING` 失败转为通过，随后采用并出现「进入分镜」

未运行/未验证：

- 真实 PostgreSQL、RLS 与跨租户数据库回归（两个新接口只有桩仓储与 HTTP 层测试）
- 真实模型、付费任务、部署与迁移

## 5. 回退

本切片无 SQL 迁移、无配置变更；梗概人工保存复用既有人工校对写链路。按 commit 逆序 `git revert` 即可回退；`ProjectWorkspace` 的 6 区段导航、两个只读接口与梗概编辑可独立撤回，不影响 #186 的入口收敛。
