---
name: acheng-effects-scale
description: 按效果家族创建或优化视效，并设计可信巨构尺度。
metadata:
  version: "3.2.0"
---

# acheng-effects-scale

效果遮挡、尺度或风格化表现未定时，按[局部决策指南](../../references/decisions/effects.md)对应节执行；只调整当前 owner 可写项，保留既定起因和结果。

本文件是acheng-director随包专业子入口，按路径加载；主导演负责真值、版本、对象创建和最终合并。它不自动启动代理或调用模型。

先读[本分支核心合同](../../references/46-effect-families.md)与[专门规则](../../references/00-visual-constitution.md)；同时遵守[模块回包合同](../../references/91-module-orchestration.md)。只读取本任务依赖，保留上游来源与冻结项。

先判定family，再选择字段；能量流体、天气、破坏、变形、空间、光学各按适用逻辑。巨构先主形/机制/决定性事件与两类独立尺度证据。OPTIMIZE冻结动作、时序、结果及效果过程，不以更好看为由更改事件。

返回vfx和scale_proofs；需改变动作或损伤时提出冲突。与动作模块只互检接触可读性与结果，不循环互相调用。

字段写入白名单取[模块登记](../../data/module-registry.json)。回包包含request_id/input_revision/module/status/attempt/patch/evidence/unresolved；最多初次加一次有证据的修正。只改允许路径，不能把其他模块的建议直接写成已确认事实。
