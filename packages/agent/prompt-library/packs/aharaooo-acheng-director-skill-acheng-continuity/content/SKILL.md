---
name: acheng-continuity
description: 跨镜跨集事实重放、冷档恢复与分层交付验收。
metadata:
  version: "3.2.0"
---

# acheng-continuity

跨镜状态、参考版本或恢复游标有冲突时，按[局部决策指南](../../references/decisions/continuity.md)对应节定位来源；只返回具体缺口，不新增事件来强行对齐。

读[114 绑定合同](../../references/114-reference-binding-delivery-v4.3.6.md)。相邻复核 model 的稳定对象身份、素材状态版本、Shot/帧窗和尾态；发现错误退给字段 owner，不自行改 H3 或素材。联合回执必须与当前 revision 一致，机器 PASS 不等于语义识图、平台上传或实际成片验收。

本文件是acheng-director随包专业子入口，按路径加载；主导演负责真值、版本、对象创建和最终合并。它不自动启动代理或调用模型。

先读[本分支核心合同](../../references/80-continuity-ledger.md)与[专门规则](../../references/95-quality-gates.md)；同时遵守[模块回包合同](../../references/91-module-orchestration.md)。只读取本任务依赖，保留上游来源与冻结项。

从真实初态重放伤势、弹药、道具与场景变化；并保存叙事知识、伏笔、表演来源和资产版本。索引指向完整原文，不能删除原文仅留摘要。归档和恢复核验哈希与素材，失败保持原件。

返回账本差量、未决项目与分层报告。结构通过、提示词就绪、实际影像通过分别记录；不得把未生成片段写为视觉通过。

字段写入白名单取[模块登记](../../data/module-registry.json)。回包包含request_id/input_revision/module/status/attempt/patch/evidence/unresolved；最多初次加一次有证据的修正。只改允许路径，不能把其他模块的建议直接写成已确认事实。
