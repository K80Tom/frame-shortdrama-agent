---
name: check-video
description: 查询已登记视频任务、下载完成视频，或处理需要授权重试与创作修正的失败。
user-invocable: false
allowed-tools: Read, Write, Edit, Glob, Bash, Skill, Task
argument-hint: "自然语言查询目标、镜头范围或无人值守检查委托"
model: opus
---

## 范围与持久记录

本 skill 是 AI 可按用户自然语言查询、下载或失败处理请求在当前上下文本地加载的内部知识，也供受托 checker 使用。

check/auto 本身不是新视频生成请求，只取回已登记任务或延续有效 initial/retry grants。generate-video 已将用户实际生成请求登记为 initial grant 时，首次续交不再询问生成许可；缺 grant 不从“使用本系统”或监控意图补造。交互中用户另行要求新生成则由 AI 本地加载 generate-video，按该实际请求登记，不另设批准握手；重试仍按真实 retry grant，不推断无限次数。

付费续交/重试使用当前 typed references，每任务至少一个全组本地 MP4，最终 `task-inputs/taskNN.json` 顶层恰为 shots/references/prompt，prompt 为 Creator 编写并审核的非空白字符串，条目仅 local PNG/MP4。草稿 shots/references 仅供 materials，不就绪；tasks.json 中 prompt 与最终 manifest 原文一致，gate/reserve 核对该原文及 duration/references，不在提交时重写。按已登记 ID/provider 查询下载 submitted 任务；缺可核实 ID 则 human_needed，保留记录和媒体等待核实。

先复用当前配置、材料和真实 grants，许可内的首次续交、原输入重试和取回不逐次求批准，不重问已定 provider、限制或重试范围。新阻塞先交责任角色在原权限内诊断，内部 review/fix 不自动触发用户确认；仅缺必要权限、关键冲突或用户指定检查点才问，进度只陈述。无人值守仍不得新授权或发起创作修复，不能用减少打断绕过 human_needed/inflight 边界。

查询/下载可直接按记录进行，不补创作问卷。需要新创作时按共享 intake 规则，先复用已知需求或取得明确角色/范围/约束委托，不先编修正候选、设计、提示或聊天预览；意外问题仅暂停受影响工作。无人值守缺决定仅报 human_needed。

按已选模型/参数执行，不要求预算、费用、积分/余额或最低价检查，不为省钱降级；用户实际费用限制仍绑定，真实账号/provider 失败如实报告。constraints 无需费用字段，首次/重试与监控授权及 inflight 保护不变。

必读 `${CLAUDE_PLUGIN_ROOT}/skills/_meta/rules/user-decision-relay.md`。发起角色一次给齐相关问题/表及题界/分支；主 AI 读全并内部保留，沿作者题界完整展示当前题全部选项/解释后原生单题询问，仅应用所给条件，不摘要或倾倒全表。相关原始答复及全部条件批量完整回原角色原任务，不逐题往返，提前回询仅限共享规则例外，创作事项保留 Director 协调。无人值守仅报告需决策，不擅自提问或代选，完整计划保留供后续交互，不被状态摘要替代。

纯查询/下载首先按持久任务处理，不运行 generation config、videoProfile 或审核门禁。只有查看/修改配置、准备或获准提交需要配置时，从项目根运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/review-evidence.mjs" config-path`，把 SVD_CONFIG（未设才 config.md）规范为项目相对 config_path，再读取/写入/取证。项目内绝对路径及 ./ 支持；外部配置（含 symlink 越界）不支持，任何相关副作用前报告，不能因此阻断其他已提交任务取回。

配置/approval 只写 config_path；Task/relay 传同一路径，相关 Bash 显式用 `SVD_CONFIG="{config_path}"`，配置位置参数也传该路径。fingerprint/videoProfile/evidence 共用配置。监控首次及周期 payload 的 `UNRESOLVED` 仅允许取回并报告 human_needed，空值是传输错误；绑定路径用 `config-path "{config_path}"` 显式验证，不取环境默认或刷新持久 tuple。

整体理解原始请求 `$ARGUMENTS` 与当前委托，先确定 canonical ep/all 和具体镜头范围。all 只来自明确全项目请求，缺目标或冲突先澄清，不默认最新/全部。监控模式来自明确 unattended 委托，不要求用户 flags；普通查询不自动安装监控或授权重试。查看配置只读实际配置，缺失不初始化。仅用现有 scripts，不临时编写执行脚本。

任务在 `story/episodes/{ep}/videos/tasks.json`，JSON 数组，task_id 唯一。按 [shot-inputs](../_meta/rules/shot-inputs.md) 保留 `task_id,shots,submit_id,status,prompt,references,duration,fail_reason`，references 为有序 `{media,path}`；submission 为 `{provider,model,ratio,resolution,references:[{media,path,sha256}]}`。输出 `videos/taskNN.mp4`。reserve/settle 由 wrapper 写；checker 仅维护真实授权/查询结果，写前重读，保留其他变更/grants/inflight。

具体选镜须覆盖记录的完整组；部分选择报告 task_id、完整 shots 及额外成员，不静默扩范围。付费前当前 manifest membership 必须等于 record 和 grant；错误任务、成员漂移、部分组或输入漂移零调用、不改次数。纯已登记 ID/provider 取回独立于当前项目材料，不重新组装或核对新素材。

status 为 pending/submitted/done/failed。done 仅表示当前任务已下载，不表示视频质量通过。submitted/done 不允许刷新输入或自动重提。缺 submission 的 submitted 仍可按已登记 ID 取回；failed 的输入未就绪须在实际授权内准备，不猜配置或补造哈希。

## 查询与下载

1. 解析目标；all 用 Glob 找所有 tasks.json。缺文件、无匹配或损坏时报告错误；auto 仍输出末行 JSON。
2. pending 有 inflight 则核实，不提交。无则用 `node ${CLAUDE_PLUGIN_ROOT}/scripts/video-task-inputs.mjs initial "{tasks}" "{task_id}" "{ep}"` 读取授权并判断 constraints。获准 untouched pending 委托真实 Creator 首次提交，不需 retry grant、不增 retry attempts。无授权则 human_needed；后续新生成请求交 generate-video 登记，无人值守不补授权。
3. submitted 且 id 非空时按 recorded submission.provider 路由取回，不看当前 config。Dreamina 使用下列查询；缺失或未知 provider 保留记录、报告 human_needed，不猜提供方。仅查询无需 Creator 或新生成 help：

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/video-check-dreamina.sh "{submit_id}" "story/episodes/{ep}/videos/{task_id}.mp4"
```

查询下载不经过创作 review gate，也不因旧材料/配置/身份 metadata 缺失而被阻塞。submitted 缺 id 时保留状态，报告人工核实，不新建付费任务。

无法路由的显式 provider 或 submitted 缺 id 需要人工解决：保留状态和已收集结果，摘要附 error、recoverable=false 与 human_needed，不能伪装 querying 或让监控无限等待。临时 CLI/下载错误仍 recoverable=true。

| 输出 / exit | 更新 |
| --- | --- |
| success / 0 | 同一 submit_id 的下载成功，改 done，清空 fail_reason |
| querying / 1 | 正常等待；保留 submitted 和 submit_id，不记异常 |
| fail:reason / 0 | 实际生成失败，改 failed 并记录原因 |
| error:reason / 2 | 查询、CLI、下载或本地移动错误；保留 submitted 和 submit_id，之后对同一 id 重试取回 |

非预期输出按查询错误处理。写回时核实当前 id 未变化。已有 taskNN.mp4 不能证明本任务成功，无登记文件不添加 done；下载失败保留 ID 取回，不付费重生。auto 遇单项错误继续其他项并记录 recoverable error。

## 重试授权记录

每条 task 可有 `retry_authorization`；缺失/null 表示无自动重试授权。由实际与用户交互的 generate-video 或交互 checker 记录用户的明确决定，不从 failed、入口名称或默认监控推断。示例仅为格式，不是授权：

```json
{"decision":"允许 ep01 task01（镜头1、2）遇临时生成失败时原输入自动重试","episode":"ep01","task_id":"task01","shots":[1,2],"constraints":["仅临时生成失败；不修改输入、模型或比例"]}
```

decision 保留实际授权原文；episode/task_id/shots 绑定该完整任务，constraints 保留真实失败类型、截止等条件，无额外条件可为 []，不要求费用字段。仅用户明确给次数限制时增加 `max_attempts:N, attempts:0`。attempts 为调用 provider 前预留的重试次数，不含首次提交、查询、下载或 gate 拒绝；未知结果不退还次数。

首次提交不例行询问重试许可。仅用户要求自动重试，或实际失败阻塞且不能按现有权限解决时，才处理重试决定；实际重试请求本身是其范围依据，无须再问同一授权。无 grant 不重试，不重复追问已拒绝/未答的问题，也不从初始生成意图推断无限重试。有效持续 grant 内无需再次同意。撤销时清除对应 grant；修改输入/范围不自动继承旧 grant，原输入重试许可不涵盖修改。仅真实授权明确覆盖变化及重准备/重提时可据其记录当前目标授权，否则取得必要决定；保留剩余次数等限制。不能把示例填入用户记录。

## 初始授权与 Inflight

`initial_authorization` 与 retry grant 分开，结构为 `{decision,episode,task_id,shots,constraints}`，由 generate-video 登记实际请求原文及条件，不另索同意。checker 读取记录；查询/监控不创建它，不含重试次数。未调用 pending 因前面任务限流暂停仍保留 pending 和授权。重新准备先核对授权覆盖，不自动继承或重复索许可，不将实际失败伪装成未调用。

wrapper 在 provider 前调用 `reserve`，原子写入 `inflight:{token,kind,reserved_at}`（token 为随机 UUID，kind 为 initial/retry，reserved_at 为 ISO 时间），并在 retry 有上限时增加 attempts。原 status 保持 pending/failed；文件 fsync+rename 后才调用 provider。明确结果由 `settle` 更新 submitted/id 或 failed/reason 并移除 inflight，LLM 不重复扣次数或写状态。

任何遗留 inflight 或 `.submit-lock` 禁止自动提交、capture 或重置，加入 human_needed。只知道超时/断线/旧 submit_id/旧 MP4 不能清理意图。人工核实 provider 的该次调用：找到新 id 后用 `node ${CLAUDE_PLUGIN_ROOT}/scripts/video-task-inputs.mjs settle "{output}" "{token}" submitted "{verified_id}"` 登记并正常查询下载；确认该次明确失败或确实未被接受后可用同命令 `failed "{verified_reason}"`，之后重提仍需 retry grant 且不退还预留次数。证据不明则保留 intent。锁仅在确认无活跃写入者、检查 tasks 完整性后人工清理，不按时间自动过期。已有 submitted 的查询下载不受这些创作/授权检查阻塞。

## 原输入重试

对 failed 按 `${CLAUDE_PLUGIN_ROOT}/skills/check-video/failure-classification.md` 语义分类。每次从 tasks.json 读取 retry_authorization，执行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/video-task-inputs.mjs retry "{tasks}" "{task_id}" "{ep}"`。非零归 human_needed；通过后仍按 decision/constraints 判断失败是否获准、实际限制是否满足，无法确认则 human_needed。脚本校验结构、scope 和次数，不替用户授权或解释语义。

1. 读取原 prompt/references/duration 和 submission 四元组与媒体指纹。付费续交/重试必须具备当前 typed references 和至少一个本地 MP4，并满足实际 grant；submitted 只按已登记 ID/provider 取回。
2. 执行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/video-task-inputs.mjs verify "{tasks}" "{task_id}"`，并用同一 SVD_CONFIG 运行 `check-shot-inputs.mjs "{ep}" {完整 shots 编号}` 与 scoped evidence 检查。缺身份、成员/媒体漂移或审核未决归 human_needed；不重新 capture。源码/记账变化且媒体未变可交独立 reviewer 做 scoped 兼容性评估，不自动全量重审或盲刷哈希。
3. 新提交/重试必须用 Task 委托真实 Creator：按持久 tuple 和 grant 执行当前目标，给出 tasks/材料路径、canonical ep、生成 task_id/完整 shots、config_path、失败原文及约束。Creator 自选 provider 知识，验证当前能力但不重选参数，用现有 wrapper 执行。checker 加载 skill 不能冒充 Creator，不直接调用生成 wrapper。

嵌套不可用或明确深度拒绝时，checker 返回 `role:creator`、outcome、references、scope、constraints 与原 checker task_id。主 AI 忠实派发 sibling Creator，再恢复同一个 checker task_id 传回实际结果；不可用的 relay 归 human_needed，不伪造执行或新建 checker 丢失状态。记住已确认深度结论，普通失败不是深度拒绝。此协议同时适用于首次检查和周期检查。

wrapper gate 必须匹配登记字段及当前 scoped material review。gate 失败保持记录、归 human_needed，不冒充 provider 生成失败；过期 evidence 需评估，不等于必须重生材料。

4. wrapper 返回后只重读持久结果，不再手写提交状态或计数。`FAIL submission_unknown` / `FAIL settlement_unknown` 保留 inflight 并报告人工核实。并发限制停止本轮剩余提交，未调用 pending 仍 pending，不改 failed、不扣 retry 次数；下轮分别按 initial/retry grant 继续。不得重置或丢弃授权和 intent。

## 创作修正委托

auto 用 `{"ep":"ep01","task_id":"task01","shots":[1,2],"reason":"原因"}` 报告 human_needed，不询问或发起创作修复。完整问题计划在 JSON 外保留或给出明确文件/章节，供后续读全并逐题完整展示；摘要不替代计划。

交互模式展示原始失败和用户请求，仅补必要修正范围、实际约束和重提决定，不要求费用确认。将期望成果、失败详情、tasks/材料路径、shot 范围、用户意见及授权交 Director 诊断协调，不指定固定技能链。用户说“自动修复”也不能扩大授权范围或违反明确限制。

创作修正交顶层主 AI，由其在当前上下文加载 `director-orchestrate` 并按实际授权直接协调专家与全新 Reviewer，完成后将实际结果回原 checker 任务。专家/审核协调者在嵌套支持时直接委派；工具不可用或明确深度拒绝后沿用能力结论，请主 AI relay 并恢复原请求任务，不替换 checker 或调整宿主深度。普通失败不视为深度拒绝，后续视觉操作仍全新 task；缺角色或隔离则阻塞。

Director 返回实际变更范围、独立材料审核证据和未决事项。仅在当前材料通过且用户授权准备/重提后，将当前委托交 generate-video 入口处理获准 shots 的重新转换/capture，仍保护 submitted/done，不刷新其他 failed。未授权或审核未决则阻塞。视频质量由用户判断，不自动审片或合成。

## JSON 摘要契约

交互模式返回进度和处理结果。auto 最后一行输出单行 JSON，按生成任务统计各状态（不是摄影 shot 数）；all 跨集合计。示例表示监控停止，但不是全部成功：

```json
{"target":"ep01","pending":0,"done":2,"submitted":0,"failed":1,"all_complete":true,"human_needed":[{"ep":"ep01","task_id":"task03","shots":[5,6],"reason":"需用户决定"}]}
```

- `target` 原样回传 epNN/all；pending/done/submitted/failed 为数值，无法统计填 `"unknown"` 而非 0。
- `human_needed` 为 `{ep,task_id,shots,reason}`，包含授权、身份、成员、审核或 inflight 阻塞；同一 ep/task_id 仅一条，保留完整成员，不将未调用任务改 failed。监控 target 仍为 epNN/all。
- 无异常且数字齐备时，all_complete 仅当 submitted 为 0 且所有 pending/failed 都已列入 human_needed 才为 true。仍有可自动继续的 pending/failed 时为 false。它表示无需继续监控，不表示每条视频下载成功或质量通过。
- 异常附 `error`（简短描述）与 `recoverable`，all_complete 强制 false；保留已经收集的 human_needed。临时查询/下载失败为 true，任务文件缺失/损坏等需人工解决为 false，不确定偏 true。
- querying/1 不是异常；error/2 不是 failed 生成任务。不得因为单项异常省略最终 JSON。

监控只能报告并等待人工决定，不自动授权 creative changes。交付下载结果及未决执行失败给用户。
