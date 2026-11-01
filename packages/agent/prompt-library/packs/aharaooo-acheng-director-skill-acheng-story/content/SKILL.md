---
name: acheng-story
description: 多线剧本、角色弧光、信息权限、伏笔与局部润色。
metadata:
  version: "3.2.0"
---

# acheng-story

遇到当前一拍因果、台词目的或人物选择未定时，按[局部决策指南](../../references/decisions/story.md)对应节执行，结果仍回到原字段，不重复回答已解决问题。

本文件是acheng-director随包专业子入口，按路径加载；主导演负责真值、版本、对象创建和最终合并。它不自动启动代理或调用模型。

先读[本分支核心合同](../../references/11-story-architecture.md)与[专门规则](../../references/12-character-dialogue-revision.md)；同时遵守[模块回包合同](../../references/91-module-orchestration.md)。只读取本任务依赖，保留上游来源与冻结项。

确认稿和终局先锁；仅从缺失的创作阶段进入。先建立任意数量剧情线、知情事件与伏笔，再写完整分场正文。每拍的选择与代价必须落在场上行动，禁改对白逐字保留。

返回story与script_scenes；引用已登记角色和场景，新增对象交主导演登记。运行post_hooks.py script；内容复核因果、人物声音、误导公平及未兑现项目。

字段写入白名单取[模块登记](../../data/module-registry.json)。回包包含request_id/input_revision/module/status/attempt/patch/evidence/unresolved；最多初次加一次有证据的修正。只改允许路径，不能把其他模块的建议直接写成已确认事实。
