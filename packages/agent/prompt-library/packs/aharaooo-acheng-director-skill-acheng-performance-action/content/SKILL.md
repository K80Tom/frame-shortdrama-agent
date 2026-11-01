---
name: acheng-performance-action
description: 文戏的表演因果、动作的受力因果以及从上游表演交接到镜头的适配。
metadata:
  version: "3.2.0"
---

# acheng-performance-action

情绪尚未外化、动作因果缺失或对白与动作抢节拍时，按[局部决策指南](../../references/decisions/performance.md)对应节执行，先筛可见部位和身体条件，再选适用配方。

本文件是acheng-director随包专业子入口，按路径加载；主导演负责真值、版本、对象创建和最终合并。它不自动启动代理或调用模型。

先读[本分支核心合同](../../references/31-performance-handoff.md)、[灵动表演合同](../../references/32-liveliness-performance-framework.md)与[专门规则](../../references/40-action-choreography.md)；同时遵守[模块回包合同](../../references/91-module-orchestration.md)。只读取本任务依赖，保留上游来源与冻结项。

有锁定expression_handoff时消费来源、十二项表演信息与排除项；镜头只接收可见的相位。无交接时依据已确认剧本设计，不声称外部专家已处理。动作采用攻应果续与适用的受力链，保留受击和尾态。

返回performance/combat及来源绑定；需要灵动、夸张或动作化表演时，额外返回acting_design和可供模型编译的运动逻辑。expression_handoff由主导演接收和锁定，本模块不修改它。不修改镜头景别、故事结果或伤势事实。不可见或超容量的节拍明确返回主导演，不静默删去。

字段写入白名单取[模块登记](../../data/module-registry.json)。回包包含request_id/input_revision/module/status/attempt/patch/evidence/unresolved；最多初次加一次有证据的修正。只改允许路径，不能把其他模块的建议直接写成已确认事实。
