# 功能状态与证据（单一真源）

盘点日期：2026-11-06。适用分支：`dev`；代码盘点基线：`890cc3692203040413bfec01490df50c7a18a543`（0.1.0）。
总入口：[产品 Epic #5](https://github.com/K80Tom/frame-shortdrama-agent/issues/5)；治理需求：[#80](https://github.com/K80Tom/frame-shortdrama-agent/issues/80)。

## 判定规则

- `not-started`：目标能力未发现实现证据；不以目录存在推断能力。
- `partial`：存在相关实现，但 Issue 验收尚不完整或未核验。下面的代码/测试是排查入口，不代表全部范围已实现。
- `implemented`：目标范围代码和离线验收齐备，必须附准确命令、提交、结果与限制。
- `verified`：在 implemented 基础上，另附真实环境/供应商验证记录（日期、提交、模型版本、输入、脱敏产物、预算与真人结论）。不外推到其他版本或供应商。

实现状态、离线执行结果、真实供应商验证是三个独立字段。测试文件存在≠已通过；离线桩通过≠真实生成成功。
本次只做源码/测试入口盘点，不执行模型、数据库或产品测试；没有任何条目因此升级为 verified。
所有行 owner 为 `@K80Tom`（按 CODEOWNERS 默认维护责任，非个人实现或验收背书；可在后续 PR 委派）。

## 能力台账

各行均适用上述基线；“未运行/未核验”不是失败，也不是通过。

| ID / 能力 | 跟踪 Issue | owner | 状态 | 代码入口 | 测试入口 | 离线执行 | 真实供应商记录 | 限制 / 下一步 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| <a id="novel"></a>小说分片、实体合并与改编 | [#7](https://github.com/K80Tom/frame-shortdrama-agent/issues/7) [#8](https://github.com/K80Tom/frame-shortdrama-agent/issues/8) [#6](https://github.com/K80Tom/frame-shortdrama-agent/issues/6) | @K80Tom | partial | [源码](../packages/main/src/novel/) | [测试](../packages/main/tests/novel-workflow.test.cjs) | 未运行 | 未核验 | 检查点、合并传播与歧义采用仍需逐项验收 |
| <a id="script"></a>版本化剧本工作区 | [#9](https://github.com/K80Tom/frame-shortdrama-agent/issues/9) | @K80Tom | partial | [源码](../packages/main/src/breakdown/) | [测试](../packages/main/tests/breakdown-persistence.test.cjs) | 未运行 | 未核验 | 完整编辑、比较、按场重做尚未闭环 |
| <a id="repair"></a>字段级修复 | [#10](https://github.com/K80Tom/frame-shortdrama-agent/issues/10) | @K80Tom | partial | [源码](../packages/main/src/breakdown/) | [测试](../packages/main/tests/extract-facts-execution.test.cjs) | 未运行 | 未核验 | 最小修复计划与局部重验仍需验收 |
| <a id="assets"></a>资产适配与授权 | [#11](https://github.com/K80Tom/frame-shortdrama-agent/issues/11) | @K80Tom | partial | [源码](../packages/main/src/assets/) | [测试](../packages/main/tests/assets.test.cjs) | 未运行 | 未核验 | 授权门禁与缺失资产决策未完整闭环 |
| <a id="previs"></a>3D 预演 | [#12](https://github.com/K80Tom/frame-shortdrama-agent/issues/12) | @K80Tom | partial | [源码](../packages/main/src/production/) | [测试](../packages/main/tests/storyboard.test.cjs) | 未运行 | 未核验 | prompt-only，不证明渲染参考或几何检查完成 |
| <a id="review"></a>视觉与连续性审核 | [#13](https://github.com/K80Tom/frame-shortdrama-agent/issues/13) | @K80Tom | partial | [源码](../packages/main/src/review/) | [测试](../packages/main/tests/production-media.test.cjs) | 未运行 | 未核验 | 技术检查不等于语义、表演或跨镜头连续性审核 |
| <a id="audio"></a>声音与字幕 | [#14](https://github.com/K80Tom/frame-shortdrama-agent/issues/14) | @K80Tom | partial | [源码](../packages/main/src/production-media/) | [测试](../packages/main/tests/production-finalization.test.cjs) | 未运行 | 未核验 | 依赖供应商原生音轨；独立配音、口型、混音、字幕未形成子图 |
| <a id="reconcile"></a>未知付费调用对账 | [#15](https://github.com/K80Tom/frame-shortdrama-agent/issues/15) | @K80Tom | partial | [源码](../packages/main/src/production/) | [测试](../packages/main/tests/production-orchestration.test.cjs) | 未运行 | 未核验 | unknown 不代表可安全重提；供应商对账证据仍缺 |
| <a id="editing"></a>时间线与交付 | [#16](https://github.com/K80Tom/frame-shortdrama-agent/issues/16) | @K80Tom | partial | [源码](../packages/main/src/production-media/) | [测试](../packages/main/tests/production-finalization.test.cjs) | 未运行 | 未核验 | 尚缺版本化整集编辑与可复现交付完整闭环 |
| <a id="evaluation"></a>评测中台 | [#17](https://github.com/K80Tom/frame-shortdrama-agent/issues/17) | @K80Tom | partial | [源码](../packages/main/src/evaluation-run/) | [测试](../packages/main/tests/evaluation-run.test.cjs) | 未运行 | 未核验 | 已有运行契约；人工裁决、质量回归、账单和首批套件仍待完成 |
| <a id="data"></a>数据中台 | [#47](https://github.com/K80Tom/frame-shortdrama-agent/issues/47) | @K80Tom | partial | [源码](../packages/main/src/data/) | [测试](../packages/main/tests/data-pipeline.test.cjs) | 未运行 | 未核验 | 已有事件/投影底座；血缘、指标、成本与只读 API 仍待完成 |
| <a id="runtime"></a>调度恢复 | [#73](https://github.com/K80Tom/frame-shortdrama-agent/issues/73) | @K80Tom | partial | [源码](../packages/main/src/production/) | [测试](../packages/main/tests/production-runtime.test.cjs) | 未运行 | 未核验 | 单机运行不等于租约、心跳与崩溃恢复完成 |
| <a id="preflight"></a>运行前预检 | [#74](https://github.com/K80Tom/frame-shortdrama-agent/issues/74) | @K80Tom | partial | [源码](../packages/main/src/production/) | [测试](../packages/main/tests/production-runtime.test.cjs) | 未运行 | 未核验 | 现有节点检查不等于完整能力预检与可行动诊断 |
| <a id="contract"></a>公共 HTTP 契约 | [#75](https://github.com/K80Tom/frame-shortdrama-agent/issues/75) | @K80Tom | partial | [源码](../packages/main/src/assistant/) | [测试](../packages/main/tests/assistant.test.cjs) | 未运行 | 未核验 | shared 类型存在不代表所有 HTTP 边界已有运行时校验 |
| <a id="e2e"></a>离线失败恢复端到端 | [#76](https://github.com/K80Tom/frame-shortdrama-agent/issues/76) | @K80Tom | partial | [源码](../packages/main/src/production/) | [测试](../packages/main/tests/production-orchestration.test.cjs) | 未运行 | 未核验 | 另有 production-e2e.db.test.cjs；此处未运行 PostgreSQL 用例 |
| <a id="observability"></a>关联日志与诊断 | [#77](https://github.com/K80Tom/frame-shortdrama-agent/issues/77) | @K80Tom | partial | [源码](../packages/main/src/production/) | [测试](../packages/main/tests/production-http.test.cjs) | 未运行 | 未核验 | 运行状态不等于结构化日志、诊断包与完整脱敏 |
| <a id="security"></a>媒体/模型安全 | [#78](https://github.com/K80Tom/frame-shortdrama-agent/issues/78) | @K80Tom | partial | [源码](../packages/main/src/production-media/) | [测试](../packages/main/tests/media-client.test.cjs) | 未运行 | 未核验 | 既有媒体测试不证明统一 SSRF、DNS rebinding 与资源上限门禁 |
| <a id="backup"></a>项目备份与恢复 | [#79](https://github.com/K80Tom/frame-shortdrama-agent/issues/79) | @K80Tom | not-started | [源码](../packages/main/src/db/) | [测试](../packages/main/tests/migration-checksums.test.cjs) | 未运行 | 未核验 | 仅数据库底座；未建立版本化备份、可验证导出和原子导入 |

## 横向能力

| 能力 | owner / 状态 | 代码与测试 | 离线 / 真实验证 | 限制 |
| --- | --- | --- | --- | --- |
| AI 工作区 | @K80Tom / partial | [agent](../packages/agent/) / [assistant 测试](../packages/main/tests/assistant.test.cjs) | 未运行 / 未核验 | SSE、估价和只读工具不证明真实供应商质量 |
| 资产自进化 | @K80Tom / partial | [evolution](../packages/main/src/evolution/) / [测试](../packages/main/tests/asset-evolution.test.cjs) | 未运行 / 未核验 | 仅资产 RAG 策略；不自动改写资产或证明画质提升 |
| 方法包 | @K80Tom / partial | [prompt-packs](../packages/main/src/prompt-packs/) / [测试](../packages/main/tests/prompt-packs.test.cjs) | 未运行 / 未核验 | 冻结提示参考不代表模型质量提升 |
| 功能证据治理 #80 | @K80Tom / implemented | [文档目录](documentation-index.md) / [PR 模板](../.github/PULL_REQUEST_TEMPLATE.md) | 本次仅文档链接与 diff 校验 / 不适用 | 模板提醒不是强制 CI；后续实现必须持续更新 |

## 更新与验证记录约定

功能 PR 必须更新对应行：owner、状态、适用提交/版本、代码、测试、执行结果与限制。无变化时在 PR 解释原因。
验证记录必须分列离线和真实供应商，记录命令、环境、日期、commit、结果；缺失项写“未运行/未核验”，不得填推测结果。
真实验证只收脱敏摘要及可审计产物，不提交密钥、个人路径、原始供应商响应或敏感业务数据。
历史材料的有效性见[文档目录](documentation-index.md)，不得用旧演示或历史单次成功升级状态。

## Epic 反向导航维护

上表链接 #5 下的全部生产与平台 Epic；本 PR 正文引用本文件及 #5、#9、#12、#13、#14、#16、#17、#47，合并前在这些 Issue 中建立反向入口。
新增 Epic 时同时更新本表和 #5 的依赖列表；关闭子任务不自动升级整个 Epic。
