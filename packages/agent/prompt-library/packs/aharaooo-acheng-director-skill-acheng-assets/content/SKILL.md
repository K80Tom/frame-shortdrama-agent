---
name: acheng-assets
description: 角色、场景、道具、关键帧的全资产规划与GPT Image独立提示词。
metadata:
  version: "3.2.0"
---

# acheng-assets

决定资产顺序、逐图用途、关键帧依赖与场景修复时，按[局部决策指南](../../references/decisions/assets.md)对应节执行；区分风格、身份、状态、空间、单帧和接触表，再建立原有依赖与编号。

H3 引用衔接另读[114 绑定合同](../../references/114-reference-binding-delivery-v4.3.6.md)。assets 提供 asset_plan 的批准文件/哈希/版本与状态，核对 shots.reference_requirements；不抢写 model 的 Segment 标签。尚未生成的 .image.txt 只能是制作指令，不是媒体。合理复核可读相邻字段，写入仍由唯一 owner 完成。

本文件是acheng-director随包专业子入口，按路径加载；主导演负责真值、版本、对象创建和最终合并。它不自动启动代理或调用模型。

先读[本分支核心合同](../../references/60-assets-and-keyframes.md)、[专门规则](../../references/61-asset-dependency-production.md)、[STYLE MOTHER 风格锚定合同](../../references/62-style-anchor.md)与[场景设计适配合同](../../references/105-scene-design-adapter-v4.md)；同时遵守[模块回包合同](../../references/91-module-orchestration.md)。只读取本任务依赖，保留上游来源与冻结项。

先从剧本与逐镜用途建立asset_plan，区分基础资产、变化版本和关键帧。任何多资产或完整制作任务先建立 `STYLE_MOTHER` 风格资产节点和 `style_lock`，并将 `style_policy` 设为 `required`。**本模块只交付高质量提示词文本与上传指引，严禁智能体直接调用生图工具。** STYLE_MOTHER 首先输出一张低污染、无剧情身份、无文字标志的风格母图独立提示词 `STYLE_MOTHER.image.txt`。**所有角色（四视图基准板）、场景概念图、道具设计图、关键帧的提示词正文与上传卡，必须强制注入 `STYLE_MOTHER` 作为风格锚点参考槽位与渲染语言指令**（继承媒介、线条、阴影、色板、材质响应，排除身份/构图污染），确保全套资产无论由用户在何种生图平台出图，画风均高度统一闭环。所有生成的资产提示词必须包含无文字无水印负向约束（No text, no watermark）；人物四视图必须保持纯粹（正脸特写+正/侧/背面全身，两手中立空手，严禁硬塞武器道具）；关键帧必须视情况组合引用风格母图、场景图、各出场角色图与道具图，并在提示词中以 `@图片1`~`@图片N` 指派分工，配套上传助手。角色身份资产默认生成四视图基准板（正面全身、背面全身、侧面全身、正脸头肩近景），并显式写入角色名与 `state_label`；只有用户明确要求其他布局才覆盖。按依赖顺序制作；每个参考独立规定身份/场景/构图等用途。读IM2七步与当前条件规范，最终正文完整展开身份、状态、材料与光路。

将风格参考放在每张适用资产卡的最后一个上传槽位，明确只保留媒介、线条、阴影、色板、材质响应和空气深度，排除身份、构图、动作、状态和精确光位。只有用户明确声明不需要跨资产一致性时才允许 `style_policy: waived`，并返回一致性风险；不能因为用户没有主动提 STYLE_MOTHER 就跳过风格锚定。返回asset_plan、asset_cards及经主导演允许的具体外貌描述，不覆盖人物身份或剧情。参考未批准时交明确草案、缺图清单和顺序；实际参考齐全才交ready正文。

场景概念需求由嵌套的 `scene-design` 适配器按需触发。它先生成独立 `scene_art_direction.json` 和图像提示词，再由 assets 校验场景几何、版本、依赖与参考图；场景支路不直接写生产真值，不能把 moodboard 图片自动当作 STYLE_MOTHER。

字段写入白名单取[模块登记](../../data/module-registry.json)。回包包含request_id/input_revision/module/status/attempt/patch/evidence/unresolved；最多初次加一次有证据的修正。只改允许路径，不能把其他模块的建议直接写成已确认事实。
