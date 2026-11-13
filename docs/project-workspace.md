# 项目工作区读模型与正式主链（#182）

适用分支：`fix/script-parse-feedback`，基于 `dev 0ec4b4b`（已含 #187 项目主链读模型与 #185 项目记录规则）。本文记录结构化剧本、AI 解析、对白修复与警告后采用的实际实现和验证边界，不把桩测试当作真实供应商验收。

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
- 结构保存在 `script_versions.structure_json`（迁移 `055_script_structure.sql`）；原文与结构同时提交时保留用户原文，结构只是对原文的可编辑解释，拆解和源索引继续读取原文；只提交 `{ structure }` 时才由服务端派生 canonical `rawText`
- `POST /api/projects/:projectId/script-versions` 接受 `{ rawText }`、`{ structure }` 或 `{ rawText, structure }`。只提交 `{ rawText }` 时停在原文模式，不自动用正则假装拆分，等待用户点按钮做 AI 解析
- 页面保存原文后仍停在原文视图，出现「AI 解析分场与实体」入口；解析使用现有 `breakdown` 角色模型，按 1 集自动分场并识别对白/动作/旁白/镜头/环境，以及人物、地点和道具，结果先进入可编辑预览，确认后才生成新剧本版本和事实候选
- `script-parse` 与 `script-structure` 是两个独立 URL；旧 `script` 入口默认进入 AI 解析中心。解析成功或失败不自动跳转；只有用户勾选差异项并点「确认保存并导入剧本场次」后，受控网关才落库并自动进入场次工作台。两个子页仍各自保留 URL，且共享同一工作区实例（`App` 动画 key 同为 `script`），导入跳转不会卸载组件、草稿与勾选状态可延续；结构页刷新后仍停留在结构页
- AI 解析中心负责原文、字数/预估场次、模型计价确认、AI 解析草稿、选择性差异比对、事实候选与解析记录；剧本结构页（场次工作台）只编辑已保存的分集、场次和五类元素。属于旧原文版本的成功记录只读，不覆盖当前版本
- `GET /api/projects/:projectId/script-parse-attempts` 返回项目最近 50 次成功/失败记录，包含原文版本、模型、提示词版本、错误码、usage 和原始输出；成功记录可重新打开，失败记录展示原始错误码
- 当前原文的未确认预览按 `projectId + scriptVersionId` 保存在浏览器 `localStorage` 的 `lyra.script-parse-preview.v1` 命名空间，刷新后恢复；确认或关闭时清理对应草稿。PostgreSQL `output_json` 始终保留不可变模型原始输出，不保存人工编辑中的预览，也不需要新增迁移
- 模型连接版本与提示词版本分别跟踪：连续解析的请求始终发送 `expectedModelConnectionRevision`，不能把上一条结果的 `script-parse/2` 当作模型连接版本
- 剧本解析与对白修复的有界 JSON 调用都显式传入 `thinking: 'disabled'`；`ModelClient` 仍只在 MAAS 或 DeepSeek 官方端点下发该参数，其他 OpenAI 兼容端点不接收未知字段。请求体回归覆盖这两条服务路径，避免推理内容耗尽输出预算后返回空正文
- AI 解析人物、地点、道具均可在预览中改名、改别名、改说明和增删；人物改名同步场次说话人，地点改名或删除同步对应场次的 `location`。确认后通过原 `script-character-candidates` 路由创建完整事实候选；新增 `locations` / `props` 请求字段可选，旧客户端仍按人物请求工作
- `script-parse/2` 的原始模型 schema 允许旧结果省略 `locations` / `props`；规范化结果始终返回数组。地点合并模型显式地点与场次 `location` 并去重，道具按原文明确出现的物件提取；成功审计保存完整结构化结果
- 上方「剧本结构」与下方「事实候选与采用」是两类数据而非两次解析：前者维护分集、场次和元素，后者维护供资产与分镜采用的人物、地点、道具等事实
- AI 解析保留 `ModelError` 的原始错误码、HTTP 状态和脱敏提示，并把同一错误码写入 `script_parse_attempts.error_code`；鉴权、额度与空输出不再被统一吞成 `SCRIPT_PARSE_MODEL_FAILED`，未知异常仍使用通用错误
- 场景卡提供「保存本场」；每次保存仍产生一个新的不可变 `script_versions` 版本，旧版本不被覆盖。这是 Lyra 版本模型与融光按场 `version` 语义的对齐方式

### 受控导入与场次工作台（#191）

- 差异与合并是 `shared` 的纯函数：`diffScriptStructures(base, draft)` 只输出真正变动的分集/场次/元素项，`applySelectedDiffs(base, draft, selectedIds)` 只合并勾选项，未勾选项严格取原版。差异 ID 稳定（`kind|episode:N|scene:anchor|element:anchor`），草稿重新编辑后勾选不会错位。
- 对齐按内容相似度而非 `sceneNumber`：`script-parse` 固定返回单集且场次号由服务端生成，场次用「对白内容集合 Jaccard + 地点/时间/内外景/场次号加权」，元素用「内容相等或长内容包含」；`n*m > 250000` 时退化为按序对齐，避免大剧本的 DP 开销。
- 合并结果强制走 `validateScriptStructure`，空结果抛 `ScriptStructureError('EMPTY_MERGE')`；存在场次增删时按 `${episodeNumber}-${index+1}` 重排场次号，插入对象生成新的 `${idPrefix}_merged_N` ID。
- 面板只展示变动项并给出新增/修改/删除统计、逐项复选和「全部采纳修改 / 全部保留原版」，默认全选；相同内容隐藏。未确认前草稿仍只存在浏览器 `localStorage`，不写正式版本。
- 「资产需求」不再逐项跳手动表单：`autoRegisterCandidates` 只选中未匹配且无歧义的需求，支持逐行勾选、全选/全消与「勾选进入资产库」；前端用画布生成真实 PNG 占位图（`placeholderPngBase64`，标注“待替换为正式素材”），经既有 `POST /api/assets/import` 写入资产库，服务端按名称自动匹配绑定。歧义项仍需人工在候选中选择，不自动猜选。
- 差异选择状态修复：`diffSelectionForMode` 保证「全部保留原版」始终返回空集合，点击时同步清空已存选择，避免逐项调整后误采纳；「全部采纳修改」恢复全选。
- 「资产库」支持编辑已登记资产：`POST /api/assets/:id/update` 更新名称/类型/说明，`POST /api/assets/:id/media` 重新上传图片（复用同一套格式/大小校验，外部链接资产同时转为本地图片）。资产 ID、创建时间与既有需求绑定保持不变，媒体替换与目录更新在同一事务内完成。
- 解析按钮被门禁禁用时必须显示具体原因（`parseStartBlockReason`：未保存原文 / 未配置模型 / 原文已改未存 / 未勾选模型确认），勾选确认后提示消失、按钮立即可点，避免“点击没有反应”。
- 角色导入总控：`planCharacterImport` 统计每个角色在草稿里的出场场数（名称或别名命中说话人）并标记「已匹配已有角色」（对照当前正式版本的说话人）；`filterImportEntities` 在总开关关闭时返回空数组，开启时只保留勾选项。默认勾选已有角色或出场 ≥2 场的角色，单场角色标「建议不导入」；改名会同步迁移勾选状态。采纳时只把勾选角色写入 `script-character-candidates`，未勾选角色不会进入角色库。
- 角色真正入库复用既有 `POST /plan-revisions/:id/checks` + `POST /projects/:id/adoptions`：阶段一导入创建候选后立即校验并采用，通过才自动入库；有警告必须用户显式确认（`allowCheckWarnings`），取消则只保留候选不入库。`project.activePlanRevisionId` 同步更新，「资产需求」与分镜立即看到角色。
- 「确认场次，推进至分镜设计」前做入库兜底：当前版本没有候选时，用 `buildStructureFactCandidate` 从正式结构提取说话人（排除旁白）与场次地点创建候选再采用；入库失败会停留在工作台并提示，不会假装跳转成功。
- 受控网关一次只提交已勾选合并结果，创建一个新的不可变 `script_versions` 版本并保留 attempt 与版本历史。请求里的 `rawText` 保持原版本不变：解析记录与 `dialogueExclusions.sourceRef` 的偏移绑定原文，重新序列化会让既有证据错位。
- 场次工作台按顺序垂直展开场次卡片，展示「第 N 场 · 内/外景 · 地点 · 日/夜」、出场角色标签和对白气泡；支持就地修改场次编号、内外景、地点、时间和场景描述，支持相邻场次一键合并（保留当前场时空、拼接元素与场景描述、重排后续编号）与长场次一键拆分（默认按元素中段切分、第二场继承时空、元素 ID 不变、重排编号），对白说话人可从已有角色下拉纠正。
- 步骤二顶部概览栏展示「共 N 场 ｜ 核心角色 X 位（排除旁白）｜ 对白 Y 句」与当前正式版本号，随编辑实时更新。
- 唯一流转主行动是「确认场次，推进至分镜设计」：结构有未保存修改时先保存新版本再跳转；已有已采用事实或分镜时明确提示保存会重置下游，需要用户确认后才继续。
- 按更新后的 #191，剧本工作区不再渲染旧「事实候选与采用」面板：独立事实版本下拉、历史只读提示与手工校验/修复入口一并移除，`ProjectFactsPanel` 组件删除；历史解析与修复记录仍保留在「解析记录」中可重开，生产工作区的 `FactsEditor` 不受影响。

### 校验警告、定向修复与人工放行

- （#191 更新）本节问题卡所在的旧「事实候选与采用」面板已从剧本工作区移除，AI/手动修复与人工放行入口随之不在该工作区出现；以下为 #188 时期的交互与后端规则记录，后端校验、修复与放行规则本身未改。
- `DIALOGUE_MISSING`、`SCENE_DIALOGUE_MISSING` 问题卡统一提供「AI 修复 / 手动修复 / 忽略」；其他类型问题只提供「忽略」，不伪造通用修复能力。页面明确说明校验结果是可继续的警告，不再只显示“阻断”。
- 手动入口进入独立 `script-structure` 并定位目标场次，同时显示对应原文。手动修复模式在每个元素上提供「上方补对白」，允许按原文顺序定点插入；保存时再次确认，创建新剧本版本和沿用原实体的新事实候选，自动重跑同一规则校验；普通结构保存不改变既有行为。两个子页保留独立 URL，但共享同一工作区实例，切换不会丢失修复上下文。
- 「忽略」只在当前页面关闭所选警告，可恢复显示；不修改原文、剧本、候选或服务端 issue，重新校验会再次出现。它不同于会生成 `dialogueExclusions` 预览并保存新版本的“非对白排除”。
- 当前规则且 content digest 匹配的失败 check 可由用户二次确认「已知问题仍继续」后采用。请求显式携带 `allowCheckWarnings: true`，service、InMemory 与 PostgreSQL 仓储同时校验该授权；`actor='agent'` 的自动生产路径不能使用人工放行。采用记录继续关联原失败 check，issue 保持 `open`，不新增迁移，也不把失败审计改写成通过。
- `POST /api/projects/:projectId/script-dialogue-repair` 使用 `script-dialogue-repair/1`，请求必须包含 `allowPaid: true`、当前候选、失败 check、开放 issue、剧本版本和可选模型连接 revision。它复用模型连接 CAS 与 `script_parse_attempts` 审计，不创建第二条模型密钥或付费通道。
- AI 只能返回已有原文候选 ID、已知人物和语气提示。服务端根据 `dialogueBodySpans` 的精确码点范围回填正文，按原文顺序插入结构；禁止新增人物，也不允许模型改写原文。
- 对叙事误报，AI 只能形成精确原文范围的排除建议。`dialogueExclusions` 是 plan content 的可选 JSON 字段，旧 plan 不需要迁移；质量校验只排除 start/end 完全匹配的 dialogue span，不关闭旧 issue、不放宽其他规则。
- AI 保留“费用确认 → 未确认预览 → 再次确认保存并重跑”；成功后自动滚动到预览，按钮显示调用中状态，取消确认也有明确反馈。保存创建新剧本和候选后不会自动采用或覆盖旧版本。历史 AI 修复记录可重开，旧剧本版本上的结果只读。

分镜仍然独立于剧本：正式 `StoryboardItem` 不是剧本元素类型 4 的替代；按集生成、`scriptEpisodeId` 绑定和分镜场次/镜头结构属于下一步，不在本切片中冒称完成。

## 3. 边界

- 正式项目不再渲染本地 `StoryboardPage`、`ProductionPage` 或 `DirectorWorkspace`；本地练习页仍保留，并明确标注「练习用，不用于正式制作」。
- 不新增全局个人画布，不重写生产 DAG、RLS 或 Outbox。
- web 不直连数据库或模型；所有正式读写仍走 main HTTP API。
- 人工编辑分镜候选、迁移与幂等属于 #184，本切片不冒称完成。

## 4. 验证与限制

本轮实际运行：

- `npm --prefix packages/shared run build`：通过
- `npm --prefix packages/shared test`：29/29 通过
- `npm --prefix packages/main run build`：通过
- `npm --prefix packages/main test`：1068 项 / 1065 通过 / 0 失败 / 3 跳过（桩模型；含结构化契约、AI 解析地点/道具、解析历史成功/失败记录、上游错误透传、对白修复与警告后采用回归）
- `npm --prefix packages/web run build`：通过
- `npm --prefix packages/web test`：168/168 通过（含独立路由、共享工作区、离开保护、预览持久化、三类实体字段、问题操作与「上方补对白」顺序回归）
- 迁移 `055_script_structure.sql`：在隔离演示库实际执行成功
- 真实 PostgreSQL + 真实后端 + 浏览器：在 5203 打开剧本区，解析出 2 集 3 场和动作/对白/旁白/镜头/环境；点「保存本场」生成 version 4（`structure_json` 非空）；新增对白「老周：这块表，你还留着。」再保存生成 version 5，数据库确认结构末元素为 `type=1` 且派生 `raw_text` 含该对白
- AI 解析：把一段没有分集/场次标题的文字保存为原文 version 7；点「AI 解析分场与人物」后预览出 1 集 2 场、五类元素和 2 个人物，确认生成 version 8 与人物候选
- 点击故障回归：在独立 5204 页面实际勾选费用确认并点击「AI 解析分场与人物」，HTTPS 桩返回 1 集 2 场及林澈、老周 2 个人物；`script_parse_attempts` 持久化 `succeeded`，401 上游回归验证原始错误码与脱敏提示透传且模型只调用一次
- 双展示与三类实体回归：同一 5204 页面重新解析后，预览直接展示并可编辑 2 个人物、1 个地点、2 个道具；修改道具说明后确认保存，页面事实候选与 PostgreSQL 均为 2 人物 / 1 地点 / 2 道具 / 2 场，编辑值保留，最新审计为 `script-parse/2`、`succeeded`。上方剧本结构与下方事实候选的标题和说明已区分，未合并两类数据
- 双页面与历史记录验收：在 5204 生产构建页面连续两次使用本地桩解析，均生成独立成功记录且保持 `script-parse` URL；预览为 2 人物 / 1 地点 / 2 道具。编辑道具说明后刷新，草稿与编辑值恢复。受控停止本地桩产生的 `PROXY_UNAVAILABLE` 失败记录与成功记录同屏可见。确认保存生成 V3 和三类事实候选后不自动跳转；手动进入 `script-structure` 可看到 2 个已保存场次，刷新仍停留在结构页，历史结果重开为只读
- 对白修复真实浏览器验收：本地桩补入原文已有的林澈对白后生成 V2 与新候选，自动校验通过且未采用；AI 与手动分别排除同一叙事 span 后，两个关联问题均消失且原文未改；手动「上方补对白」把林澈对白置于老周对白之前，保存后自动校验通过。手动排除预览整页刷新后恢复，历史 AI 修复结果的输入和删除被禁用且不提供保存入口。真实 PostgreSQL 验收同时覆盖修复审计成功、失败和版本保护 SQL
- 警告放行与三按钮验收：与原问题相同的叙事句在隔离项目产生 `DIALOGUE_MISSING` 和 `SCENE_DIALOGUE_MISSING`。页面显示三按钮；AI 费用确认后由本地桩生成排除预览并自动滚动到预览，未保存前剧本不变；失败时滚动到可见错误并清除“调用中”状态。手动定位到唯一目标场次并显示原文；忽略只移除当前一条，重跑后恢复。用户确认警告后 PostgreSQL 采用成功，剧本仍只有 V1、两条 issue 仍为 `open`，正式分镜页显示「已采用事实」。另以真实 PostgreSQL 定向测试验证无确认和 agent 确认均拒绝，只有用户确认可采用且不改写审计。
- 浏览器启动回归：Shared 默认资产策略使用等值的冻结摘要常量，避免模块加载时在浏览器执行 Node `createHash`；Node 回归断言该常量与 canonical digest 完全一致，生产页面已实际渲染
- 原文保真：把 version 8 的结构与 version 7 的原文一起保存为 version 9，数据库确认 `raw_text` 仍是原段落、`structure_json` 仍是 2 场；基于 version 9 创建完整事实候选后程序校验通过（0 issues），采用后进入分镜
- 本轮隔离验收使用独立 HTTPS 桩模型和隔离数据库，未调用真实付费模型；本机 8790/5203 保留原数据库与模型配置，仅切换到修复 worktree 的生产构建，原候选和原问题未被自动修复或采用

未运行/未验证：

- 全量 RLS 与跨租户数据库回归未在本轮重跑；本轮警告放行已在隔离真实 PostgreSQL 做定向验证
- 真实付费模型、付费任务、部署未执行；DeepSeek 空输出缺陷只有请求体与全量回归证据，未再次调用真实上游复验

### #191 增量验证（2026-11-12）

上节浏览器证据属于 #182 剧本解析切片，本增量没有重跑真实浏览器、真实后端或真实模型。本轮实际运行：

- 根目录 `npm run build`：通过（shared → agent → main → cli → web）
- 根目录 `npm test`：通过；Agent 44/44；Main 1075 项 / 1073 通过 / 0 失败 / 2 跳过；Web 175/175
- `npm run docs:check`：通过（13 份文档、173 个本地链接）
- `node --test packages/shared/tests/script-diff.test.cjs`：9/9 通过（只输出变动项、ID 稳定、全选=草稿、全不选=原版、只采纳说话人、场次切分重排、空合并拒绝、整集删除默认保留）
- `node --test packages/web/tests/script-structure.test.mjs`：15/15 通过（含字数/预估场次、相邻场次合并、差异统计与选择性合并、差异面板渲染、付费门禁、两步门禁、场次卡片徽标/角色标签/说话人下拉/合并入口）

真实浏览器与隔离 PostgreSQL 验收（未调用付费模型）：

- 用独立 PostgreSQL 15 库应用 001–056 迁移，main 以 `PORT=8791`、`LYRA_AUTH_MODE=disabled` 启动；另起 Vite `5211` 代理 `/api` 到 8791，并把写请求的 `Origin` 重写为 8791 以通过本机写守卫
- 通过 `/api/projects`、`/api/projects/:id/script-versions` 造 1 个项目与 V1（1 集 2 场），再用一条手工构造的 `script_parse_attempts` 成功记录 + `localStorage` 草稿（未调用模型、无费用）恢复未确认预览；页面显示「已恢复上次未确认的解析预览」
- 差异面板实际渲染 5 项（修改 4、新增 1）：第 2 场的场次标题、内/外景、地点、时间，以及第 3 场新增；取消「场次标题」后计数变为 4/5；点「确认保存并导入剧本场次」生成 V2 并跳到 `script-structure`
- 数据库核对 V2：1 集 3 场，第 2 场 `intExt=内`、`location=咖啡馆`、`timeOfDay=日`，而 `sceneHeading` 仍是原版「外景 街道 夜」——未勾选项确实完全保留
- 场次工作台实际渲染 3 张卡片、出场角色标签、4 个对白气泡和 3 个说话人候选；点「与下一场合并」后目录变 2 场且元素合并；点「确认场次，推进至分镜」接受重置提示后保存 V3 并跳转 `storyboard`，数据库 V3 为 1 集 2 场

未验证：真实付费模型的解析草稿质量与真实供应商错误路径；本次单租户演示库未覆盖全量 RLS。

### #191 需求更新增量验证（2026-11-12 第二轮）

Issue #191 于同日更新，追加角色导入总控、彻底移除旧「事实候选与采用」面板、步骤二概览栏与场次拆分。本轮实际运行：

- 根目录 `npm test`：通过；Agent 44/44；Main 1075 项 / 1073 通过 / 0 失败 / 2 跳过；Web 178/178
- `node --test packages/shared/tests/script-character-import.test.cjs`：5/5 通过（出场统计与别名命中、空草稿、总开关返回空、逐项过滤、名称归一化）
- `node --test packages/web/tests/script-structure.test.mjs`：18/18 通过（含拆分重排与元素 ID 保持、概览统计、角色总控渲染与默认勾选）

真实浏览器 + 演示 PostgreSQL（5433，未调用付费模型）：

- 为当前正式版本 V17 手工写入一条 `script-parse/2` 成功记录并打开草稿：人物组显示总开关、全选/全消、逐角色勾选、「出场 N 场」「已匹配已有角色」「建议不导入」；默认已选 2/3（老林 3 场、年轻人 2 场，摊贩 0 场不选）
- 取消「年轻人」后计数变为 1/3，主行动提示「本次导入 1 位角色」；关闭总开关后计数与全选/全消隐藏，提示不导入任何角色
- 点击「确认采纳所选项，导入场次工作台」生成 V18；数据库核对新 `plan_revisions` 的 characters 只有「老林」1 位，未勾选角色未写入角色库
- 步骤二概览栏显示「共 6 场 ｜ 核心角色 2 位 ｜ 对白 10 句 ｜ 当前版本 V18」；点「拆分」变 7 场、「与下一场合并」回到 6 场；点「确认场次，推进至分镜设计」保存 V19 并跳转 storyboard
- 返回剧本页确认「事实候选与采用 / FACTS CANDIDATES / 事实版本」均已不再出现

角色入库补充验收（同一演示库，真实浏览器）：

- 打开为 V21 构造的解析草稿，取消「年轻人」后导入：页面提示「已采纳 42 项修改，导入 1 位角色，保存为剧本 V22，角色已自动匹配并进入项目角色库」
- 数据库确认 `projects.active_plan_revision_id` 已指向新候选，且该候选 characters 只有「老林」1 位；此前该字段为 NULL，即用户反馈“人物不见了”的根因
- 点击「确认场次，推进至分镜设计」直接跳转（无重复采用），项目状态变为「已采用事实」；「资产需求」页实际列出「人物 老林 · 3 场」及地点、道具需求，未匹配媒体资产时需另行新建/绑定

资产一键入库验收（真实浏览器，2026-11-13）：

- 「资产需求」默认勾选全部 10 项未匹配需求，取消「老林」后按钮变为 9 项；全消后只勾选「老林」，点「勾选进入资产库（1）」
- 页面提示「已把 1 项需求写入资产库并自动匹配」，该行变为「已绑定 · name」；「个人资产库」实际出现「人物 老林」占位资产，无需填写任何表单

「全部保留原版」回归验收（真实浏览器 + PostgreSQL，2026-11-13）：

- 打开解析记录 `scriptparse_191keeporig`（2 项场次差异），取消「场次地点」后显示 1/2；点「全部保留原版」变为 0/2；点「全部采纳修改」恢复 2/2；再点「全部保留原版」回到 0/2
- 以 0 项采纳导入，提示「已采纳 0 项修改」并保存为 V23；数据库确认 V23 `structure_json` 与 V22 完全相等，不含 AI 修改的「雨夜码头」

资产编辑验收（真实浏览器 + PostgreSQL，2026-11-13）：

- 资产详情点「编辑说明 / 重新上传图片」，修改说明并选择新 PNG 后保存，提示「已更新资产信息并替换图片，资产 ID 与既有绑定保持不变」；详情显示新说明，资产 ID 不变
- 直接读取 `/api/assets/:id/content`，返回字节的 sha256 与上传文件完全一致，确认 PostgreSQL 媒体已就地替换

## 5. 回退

本切片新增迁移 `055_script_structure.sql` 与 `056_script_parse_attempts.sql`；解析审计表只追加、不改既有业务表。梗概人工保存复用既有人工校对写链路。按 commit 逆序 `git revert` 即可回退；`ProjectWorkspace` 的 6 区段导航、两个只读接口与梗概编辑可独立撤回，不影响 #186 的入口收敛。

#191 增量不新增迁移、不改后端契约：回退 `shared` 的差异纯函数、`ProjectScriptWorkspace` 的两阶段向导、`StructuredScriptEditor` 的场次卡片增强与对应 CSS 即可；已导入的剧本版本仍按既有不可变版本链保留。
