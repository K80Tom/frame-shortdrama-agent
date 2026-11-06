# 离线指标统计（#42 首个独立增量）

日期：2026-11-06；分支：`dev`；适用基线：`890cc36` / 0.1.0。
Owner：@K80Tom（沿用仓库默认评审责任）。
状态：`partial`。跟踪 [#42](https://github.com/K80Tom/frame-shortdrama-agent/issues/42)，父 Epic [#17](https://github.com/K80Tom/frame-shortdrama-agent/issues/17)。

## 实现与边界

[aggregateMetricSamples](../packages/shared/src/evaluation-statistics.ts) 是无 IO 的纯函数，由 `@lyra/shared` 导出。
调用方先按冻结版本、run/case/sample/metric 层级分组；`sampleId` 在组内唯一。
`expectedCount` 来自冻结计划，`minimumSamples` 必须显式给出，不根据返回数量猜测。

- 分别统计 pass/fail/uncertain/skipped/evaluator_error，另外保留未返回的 missingCount。
- 通过率分子仅为 pass，分母为计划样本量，包含未知、错误、跳过与缺失；不是质量置信区间。
- 只有 pass/fail 数值参与均值、线性插值 p50/p95 和无偏样本方差。空集统计为 null，单样本方差为 null。
- 已知 fail 优先，其次 evaluator_error；所有计划项均 skipped 则为 skipped。缺失、混合跳过、不确定或有效样本不足均不产生 pass。错误计数不会被 fail 的优先级隐藏。
- 样本数最多 100,000；数值范围为 [-1e12, 1e12]，拒绝 NaN、Infinity、重复 ID 和不确定状态的伪造数值。
- 不改变输入，不读写数据库，不调用真实模型或媒体服务。

## 尚未完成

本增量不是完整评估器协议：EvaluatorDefinition、EvidenceRef、SourceRef、版本持久化、现有三类兼容适配器与运行/UI 集成仍待后续 PR。
均值和分位数不代表视觉或剧情质量通过；minimumSamples 不是统计置信度，不能替代实验设计。
本分支基于 dev，不依赖尚未合并的 #109；其功能状态真源合并后应将本条并入台账。

## 验证入口

[回归测试](../packages/shared/tests/evaluation-statistics.test.cjs)：`npm --prefix packages/shared test`。
后端 `npm --prefix packages/main test` 同样包含此文件，确保现有只读 CI 执行新回归，无需修改 workflow。
真实供应商：不适用，未调用。完整构建及相关评测套件的实际执行结果记录在 PR 中，未执行不视为通过。

本地执行（2026-11-06，Node 24.15）：新增统计测试 20/20、相关评测回归 47/47、前端 105/105、完整 npm run build 均通过。
后端全套 591 项：587 通过、3 跳过、1 既有 Windows 字体路径失败；本增量未修改 composer 或该媒体测试，不声称本地全套全绿。
