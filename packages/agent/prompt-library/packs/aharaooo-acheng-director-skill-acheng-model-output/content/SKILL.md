---
name: acheng-model-output
description: 将已批准制作数据编译成GPT Image与H3的独立请求及上传清单。
metadata:
  version: "3.2.0"
---

# acheng-model-output

资产到 H3 的对象／帧锚点、状态范围与交付映射未定时，按[局部决策指南](../../references/decisions/model.md)对应节执行；随 H3 附带的资产提示词也须携带各自真实参考副本与上传卡。

H3 必须读[114 绑定与交付](../../references/114-reference-binding-delivery-v4.3.6.md)：从同一绑定快照消费真实素材、Subject、Shot/帧窗，生成正文、manifest、逐段上传卡并联合回读。缺素材保留完整草案，不伪造正式来源或改模式。与 assets 核对版本、与 continuity 核对状态和范围，不替他方写字段。

本文件是acheng-director随包专业子入口，按路径加载；主导演负责真值、版本、对象创建和最终合并。它不自动启动代理或调用模型。

先读[本分支核心合同](../../references/70-minimax-h3-compiler.md)、[灵动表演合同](../../references/32-liveliness-performance-framework.md)、[动作编排合同](../../references/40-action-choreography.md)、[动画与原画术语库](../../references/113-animation-art-terminology-library-v4.3.md)与[专门规则](../../references/72-standalone-prompt-delivery.md)；同时遵守[模块回包合同](../../references/91-module-orchestration.md)。只读取本任务依赖，保留上游来源与冻结项。

图片使用72号独立交付合同；H3必须读安装的h3-prompt-writing和对应指南，并在写出前执行[H3 最终格式编译门](../../references/111-h3-final-format-pass-v4.md)。其字段顺序、标签、说话人和时间格式继续作为基础规则，但安装指南中面向普通生成任务的 350–500 词建议不适用于 Acheng Director 的新生产任务。Ref2VA 是有真实参考图、角色、场景或动作资产时的首选模式；必须保留六字段顺序，并按 `h3_contract.detail_policy()` 的时长/复杂度策略计算 `detailed_description` 门槛：默认 10 秒段最低 2,000、目标约 2,400 个英文词，时长或复杂度增加时同步增加，极限值 2900 词硬性封顶（处于 2200-2900 词区间，剔除无上限输出）。该长度合同优先于通用短模板；长度不足只能提交 partial 和游标，不能作为完整 H3 交付。确定真实输入模式，逐段重建角色/场景/状态，按首次发声分配本段speaker。来源标签与内容Subject分离，台词原文保留。格式编译只能整理载体，不能删除工程参数或动作细节。

返回模型模式、引用、正文与上传映射。启用acting_design时，保留目标、策略、动作因果、运动弧、语气节拍和切点承接；打戏还必须保留每镜 `combat.timing` 的轴线、方向、速度曲线、慢动作触发和摄影同步，并展开到独立 H3 正文；不能为了字数改故事、增加参考占位或宣称模型已调用。编译完成后执行一次只整理格式的最终 pass，再把每个最终文件作为新会话独立阅读。说话清晰度以结构化 speaker、语言标签、逐字台词、口型、停顿和收音方向共同保证；不能用空泛的“清晰发音”代替。

每个 Segment 必须显式写 `mode`、`mode_lock` 和 `mode_selection_reason`；续写时未经用户授权不得切换模式。每个镜头都要独立展开空间位置、朝向、视线、微动作、微表情、受力、声音时序和连续尾态，不能用摘要或“同上”压缩。H3-only 请求不自动启动 STYLE_MOTHER 或资产节点；输出达到宿主上限时按完整字段边界提交 partial、保存游标并继续，不降低详细度。

交付前必须先完成一次非删减校准，再原子写入 `.h3.txt`，最后回读磁盘文件和真实参考素材执行 `scripts/h3_final_format.py validate_h3_file`。最终回执必须绑定正文 SHA-256、参考素材 SHA-256、模式、时长、字段、镜头和对白清单；模型、外部脚本或人工报告不能自行填写 `format_pass=PASSED`。校准可以整理字段和载体，但不能删除工程参数、动作因果、受力链、镜头路径、声音时序或详细正文。

字段写入白名单取[模块登记](../../data/module-registry.json)。回包包含request_id/input_revision/module/status/attempt/patch/evidence/unresolved；最多初次加一次有证据的修正。只改允许路径，不能把其他模块的建议直接写成已确认事实。
