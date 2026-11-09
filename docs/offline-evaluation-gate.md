# 离线基线/候选比较与 CI 门禁

日期：2026-11-09；适用 dev，基线 b264844。Owner：@K80Tom（默认维护责任）。
当前跟踪 [#134](https://github.com/K80Tom/frame-shortdrama-agent/issues/134) / [#135](https://github.com/K80Tom/frame-shortdrama-agent/issues/135)；原跟踪 #44 / #17。
本增量 implemented；完整评测平台集成仍为 partial，不依赖未合并 PR。

## 执行

先 `npm run setup && npm run build`，然后在仓库根执行：

```sh
node packages/main/scripts/evaluation-gate.mjs packages/main/examples/evaluation-comparison.json json
node packages/main/scripts/evaluation-gate.mjs packages/main/examples/evaluation-comparison.json markdown
```

命令纯离线，只读输入并向 stdout 输出报告；不调用模型、不读数据库、不改变生产状态，也不自动部署。
退出码：0 通过，1 存在确定失败/回归，2 文件/契约/构建错误，3 证据不完整或样本不足。CI 必须保留非零退出码，不用 `|| true` 掩盖。
JSON 用于机器，Markdown 用于审查；报告包含完整策略及其摘要、冻结 run/snapshot/dataset 引用、case/sample/metric/evidence 下钻、case/slice/aggregate 三层结果。

## 输入与安全边界

参考[完整示例](../packages/main/examples/evaluation-comparison.json)与[严格校验实现](../packages/main/src/evaluation/compare.ts)。
输入必须来自已冻结、已授权的离线导出；baseline/candidate run 不同且 datasetDigest 相同。
显式 cases 与 samplesPerCase 构成预期样本计划，即使两边均未返回也会保留缺失记录。未知字段、重复或计划外样本、错误 schema、无证据的确定结果直接拒绝。

所有标识为有界安全 token，evidenceRefs 只接受 ID 或 namespace:ID（字母数字、点、下划线、连字符），不接受斜杠、额外冒号、外部 URL、文件路径或自由文本；脚本不访问证据位置。这是对旧草稿允许斜杠格式的有意收紧，导出器须先映射成不透明 ID。格式校验不是秘密扫描器，导出器仍须授权与脱敏，不能把敏感内容编码进合法 ID。
文件流读取限制 8 MiB；最多 500 case、20 metric、每 case 100 sample，且总计划不超过 10,000。分数范围 ±1e9，成本为 0..1e9 整数 micros，耗时为 0..1e9 ms。
所有输入错误只返回固定提示，不输出原始输入、凭据或个人文件路径。

## 判定规则

- 逐样本配对并区分新增、修复、回归、未变化、不确定、评估器错误、缺失候选；缺失/unknown 不当作 0 或通过。
- 支持 higher/lower 指标、绝对阈值、最大回退与关键 case 零容忍。精确最大回退边界允许，关键 case 任一下降阻断，不以整体均值掩盖。
- 候选明确 fail、绝对阈值失败或超限回归使 gate fail；无确定失败但存在缺失、错误、跳过、低样本则 inconclusive。
- 最小样本量在每个 case/metric 层级检查，不只检查全局总量；确定性规则可显式设置为 1。
- 仅有效 pass/fail 参与分数分布；未知/跳过/错误和 missing 单独计数并保留计划分母。成本/耗时包含所有已返回项。
- JSON 提供均值、p50/p95、无偏样本方差、样本量。低于 5 的 LOW_SAMPLE_CONFIDENCE 是提醒，不是置信区间或显著性证明；报告始终明确这是描述性统计。
- 每条 metric 记录的成本应由导出器准确归因；不会替导出器去除跨指标重复成本，也不代表供应商真实账单对账。

## 证据与剩余范围

[回归测试](../packages/main/tests/evaluation-compare.test.cjs)含真实 CLI 的 0/1/2/3 退出码、JSON/Markdown、8 MiB 上限、隐私错误提示、计划缺失、关键切片、方向、分布、摘要稳定和契约破坏测试，接入现有后端 CI。
输入摘要是引用，不是对外部文件真实性的证明；完整平台的权威冻结导出/导入、人工裁决、签名与持久化可审计报告仍属 #134/#135 的后续范围。
示例是合成桩数据，不是模型质量验证。付费结果只可经授权脱敏后离线导入；没有真实供应商调用。
当前 dev 尚无 #109 台账，其合并后应将本记录链接到状态真源。

本地执行（2026-11-09，Windows / Node 24.15.0）：全项目构建通过；比较测试 16/16，相关评测单元测试 60/60；前端 135/135。后端全量 731 项：727 通过、3 跳过、1 项 dev 既有字体失败（独立 #111 尚待合并）；未把本地全量表述为通过。本轮无本地 PostgreSQL、真实模型或付费调用。

CI 集成沿用现有 backend test：`scripts/test-unit.mjs` 自动发现该 `.test.cjs` 文件，由它启动真实 CLI 子进程检查退出码及报告；没有新增或修改 workflow，也不代表用真实生产质量样本做过质量门禁。首次评测通配命令误包含 `.db.test.cjs`，因未配置 DATABASE_URL 失败；改用明确排除 DB 的单元集合后 60/60，不将数据库测试记为通过。
