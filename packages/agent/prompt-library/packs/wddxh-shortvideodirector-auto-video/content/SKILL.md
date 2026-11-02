---
name: auto-video
description: 在用户要求持续监控已登记视频任务、下载结果或停止已有监控时使用。
user-invocable: false
allowed-tools: Read, Write, Glob, Bash, CronCreate, CronDelete, CronList, Task, Skill
argument-hint: "自然语言监控目标与间隔"
model: opus
---

## 范围与许可

本 skill 是 AI 可按用户自然语言监控、下载或停止监控请求在当前上下文本地加载的内部知识。

付费续交/重试使用 typed references，每任务至少一个全组本地 MP4，最终 `task-inputs/taskNN.json` 为 `{shots,references,prompt}`，条目仅 local PNG/MP4。Creator 的非空白 prompt 已经独立 shot-input 审核且 target 指纹绑定；草稿仅供 materials、不就绪。tasks.json 原样存 prompt，gate/reserve 比较最终 manifest 的 prompt/duration/references，提交不重写。记录/授权以 task_id 和完整 shots 绑定，输出 `videos/taskNN.mp4`。成员匹配 manifest/record/grant，漂移或部分选组零调用、不改次数。按 recorded ID/provider 取回 submitted，缺 ID 则 human_needed，保留状态。首次与周期 checker 均携带该契约、真实 grants 和 inflight 边界。

监控请求表示监控/取回，不表示新生成。只延续 tasks 中已登记的实际 initial/retry grants，不重问有效范围的生成许可、不补造通用 consent 或无限重试。用户后续明确要求新生成时，由 AI 本地加载 generate-video 登记实际请求；short/series 即使就绪也不自动进入视频提交。首次提交不以预先询问重试许可为条件。

按共享 intake 规则复用监控目标与持久授权，不重新问创作偏好；无人值守缺决定仅报 human_needed，不先编候选、场景、设计或提示。意外问题仅暂停受影响工作，其他已授权任务可继续。新创作留给后续交互取得相关需求或明确角色/范围/约束委托。

按已选模型/参数处理获准提交，不设预算、费用、积分/余额或最低价前置，不为省钱降级。用户实际费用限制仍绑定，真实账号/provider 失败仍报告；grant constraints 无需费用，首次/重试、inflight 与监控许可保持独立。

必读 `${CLAUDE_PLUGIN_ROOT}/skills/_meta/rules/user-decision-relay.md`。发起角色一次给齐相关问题/表及题界/分支；主 AI 读全并内部保留，沿作者题界完整展示当前题全部选项/解释后原生单题询问，仅应用所给条件，不摘要或倾倒全表。相关原始答复及全部条件批量完整回原角色原任务，不逐题往返，提前回询仅限共享规则例外。无人值守仅报告需决策，不擅自提问或代选，完整计划保留供后续交互，不被状态摘要替代。

纯监控按 recorded tasks 查询，不先验证生成配置。若请求查看/修改配置或后续获准提交，在相关读取/写入/evidence 前从项目根运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/review-evidence.mjs" config-path`，取得 SVD_CONFIG（未设才 config.md）的 canonical 项目相对 config_path；支持项目内绝对路径/./，外部配置（含 symlink 越界）不支持，在相关副作用前报告，不阻断纯取回。配置读写、fingerprint 与 helper 用此路径；相关 Bash 显式设置 SVD_CONFIG，位置参数也传同一路径。

首次 checker、周期 prompt 和 Creator relay 均显式携带 canonical config_path 或 `UNRESOLVED`。未解析只允许取回并报告 human_needed，不选择默认配置或提交；空值是传输错误。绑定路径的配置操作显式用该路径运行 config-path 核验，所有相关命令共用 SVD_CONFIG，纯取回不初始化配置。

整体理解原始请求 `$ARGUMENTS` 和会话，解析 canonical epNN 或明确全部任务的 all、监控/取消意图与间隔。缺目标或歧义先问，不默认 latest/all；写文件/安装监控前确认目标。未指定间隔可建议 1200 秒，只有用户要求监控或已同意默认才启动。查看配置只读，不强制初始化。短写 ep01 可以理解，不要求位置语法或用户 flags。

监控与重试授权分开。checker 读取 tasks.json 的真实 initial_authorization/retry_authorization，遵守 scope/constraints 和用户指定的次数；不补 grant。inflight 保留待人工核实，不清理重提。submitted 查询不要求新能力/创作 gate；下载错误保留 id 继续取回，不付费重生。all_complete 表示无需继续监控，可含 human_needed，不表示全部成功或视频质量通过。

## 首次检查

当前 monitor target 只支持 epNN/all。若请求仅监控部分镜头，先说明边界并确认可接受范围，不能静默扩大到整集；未确认不安装。

确认目标 tasks.json 存在且可读。CronList 仅按明确绑定的目标找现有任务，不能用 ep01 子串匹配 ep010；存在则不重复创建，取消仅删除所选任务。

用 Task 新建 general-purpose checker 并保存 task_id，委托：

> 检查已解析目标 {目标} 的登记视频任务，取回输出并报告进度、阻塞和是否仍需监控；无人值守，按持久 grant 处理，保留原输入和 intent。按 descriptions 选择知识。末行 JSON 为 target、pending、done、submitted、failed、all_complete、human_needed；按生成任务计数，不明用 unknown，human_needed 每 ep/task_id 一条 `{ep,task_id,shots,reason}`，保留完整成员；异常附 error/recoverable。纯取回由 checker 执行；新提交/重试委托真实 Creator。嵌套不可用返回 role/outcome/references/scope/constraints 给主 AI 转交。
>
> 配置上下文：{canonical config_path 或 UNRESOLVED}。继续传给 Creator；UNRESOLVED 只取回并报 human_needed，空值是传输错误，不选默认。配置操作显式验证绑定路径，相关命令共用 SVD_CONFIG；纯取回不验证生成配置。任务保留 task_id/shots/prompt/duration/references，输出 videos/taskNN.mp4；submission 保留四元组和有序媒体指纹，grant 为 {decision,episode,task_id,shots,constraints} 加真实可选次数。最终 manifest 恰为 {shots,references,prompt}，Creator 的非空白 prompt 经独立 shot-input 审核并由 target 指纹绑定；草稿仅供 materials、不就绪。tasks.json 原样保存 prompt，gate/reserve 比较最终 manifest 的 prompt/duration/references，提交不重写。每任务须全组 MP4，manifest/record/grant 成员一致才 reserve，漂移或部分选组零调用、不改次数。遵守 inflight，submitted 缺 ID 人工核实。

收到 relay 时，主 AI 派发 sibling Creator，传原请求与实际 grants，等待后恢复同一 checker task_id 并传回结果。不能用新 checker 替代；无角色上下文则让 checker 报 human_needed。普通任务失败不等于深度拒绝；记住确认过的能力，不自动调高深度。

仅解析 checker 最后一非空行 JSON；必须符合 check-video 摘要结构，且 target 严格等于本监控目标。缺失/无效/目标不符视为可恢复协议错误，保持未完成，不从 prose 推断 all_complete/recoverable。有效同目标摘要的 all_complete=true 或 error 且 recoverable=false 才不建 cron；展示 human_needed 与原始错误，不称全部成功。

## 定时委托

仍需监控时把间隔换成宿主可表达的分钟 cron，向用户说明实际频率；无法表达的频率先确认替代，不静默改变。CronCreate recurring=true，记录 job ID。周期 prompt 必须包含：

```text
监控已解析目标 {目标}，无人值守。本任务以该明确目标绑定，由宿主 job ID 标识。
监控不是新生成请求；仅延续已登记 initial/retry grants，不补 consent 或无限重试，不向 short/series 自动接入视频提交。
付费动作使用 typed references，每任务至少一个全组本地 MP4；按 recorded ID/provider 取回 submitted，缺 ID 报 human_needed，保留记录与 inflight。
任务保留 task_id/shots/prompt/duration/references，输出 videos/taskNN.mp4；submission 为 provider/model/ratio/resolution 加 references:[{media,path,sha256}]。grant 为 {decision,episode,task_id,shots,constraints} 加实际可选次数；manifest/record/grant 成员一致才 reserve，漂移或部分选组零调用、不改次数。查询不重建输入快照。
有效持续 grants 内的动作不逐轮求批准；新阻塞先查配置、材料与 grants 并由责任角色在权限内判断，无法解决再报 human_needed。进度不自动生成用户决策包，不授权新创作修复。
按已选模型/参数执行真实授权，不加费用/余额预检、不为省钱降级；仅用户明确费用限制仍有效。缺需求仅报 human_needed，不先编创作候选/提示；仅暂停受影响工作。
配置上下文：{canonical config_path 或 UNRESOLVED}。显式传入 checker/Creator relay；UNRESOLVED 只允许取回并报告 human_needed，空值是传输错误，不选择默认。配置操作用绑定路径显式运行 config-path 核验，videoProfile/evidence 共用 SVD_CONFIG；纯取回不验证生成配置。
用 Task 新建 general-purpose checker，委托检查此目标登记任务、取回已完成输出并报告进度和阻塞；按持久授权处理，自行从 descriptions 选择适用知识。
返回末行 JSON：target、pending、done、submitted、failed、all_complete、human_needed；按生成任务计数，不明用 unknown，human_needed 为 {ep,task_id,shots,reason}，每 ep/task_id 一条完整成员。异常附 error/recoverable；监控范围仍 epNN/all，部分选镜报告完整组和额外成员，不静默扩范围。
查询按 recorded provider；新提交/重试委托真实 Creator，不由 checker 加载 skill 冒充。
若 checker 因深度限制返回 Creator 请求，主 AI 派 sibling Creator，等待结果后恢复同一个 checker task_id。
relay 不可用让 checker 报 human_needed，不自行提交、补 grant、清理 inflight 或修创作材料。
无人值守仅报告需决策，不发起未经授权的提问或自动选择；完整用户问题计划另行保留，不压缩进状态摘要。后续交互按 user-decision-relay.md 读全计划，沿作者题界完整展示当前题再原生单题询问，相关原始答复/条件批量回原角色，不倾倒全表。
只解析最后一非空行 JSON，验证完整摘要且 target 严格等于 {目标}。
缺失、无效或目标不符保持监控并报告协议错误，绝不从 prose 推断停止。
有效同目标 all_complete=true 或 error 且 recoverable=false 时，用 CronList 核对本任务绑定目标并删除其 job ID；若无法唯一定位则不删除，报告 human_needed。
其他情况保留监控，报告 done/pending/submitted/failed 和错误。all_complete 不保证全部下载成功。
```

仅调用已有插件 scripts 和宿主定时工具，不临时编写生成/调度脚本。主会话不接管专业任务。报告 job ID、目标、实际间隔和停止方式；Claude 会话关闭会停止定时任务，最长运行 7 天。
