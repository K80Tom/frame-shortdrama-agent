# AI 工作区模型调用契约修复（#175）

日期：2026-11-11。Owner：@K80Tom / @255308153。适用：`fix/assistant-model-call-contract`，基于 `dev df976eb`。

## 已实现范围

- `AssistantBrain.call` 使用现有 shared `ModelCall` 类型；决策与工具观察后的收尾请求都显式传入 `allowPaid: true`。
- main 适配层保持透传，不为未知调用隐式补齐授权；`parseCall` 仍拒绝缺失/false 授权字段。
- 助手普通回答和只读查询不创建制作任务；制作报价仍必须经独立人工确认才提交。该修复不等于新增预算化 Agent Runtime。

## 实际离线验证

- `npm run build`：全包成功。
- `cd packages/main; node --test tests/assistant.test.cjs tests/models.test.cjs`：38/38。
- `npm --prefix packages/agent test`：44/44；`npm --prefix packages/web test`：140/140（Vite 测试服务关闭时有 dep-scan 警告，退出码 0）。
- `npm --prefix packages/main test`：1017 项，1010 pass / 2 fail / 5 skipped。两个失败为既有 Windows 路径问题：`governance-workflows.test.cjs:171` 的路径分隔符、`storage-driver.test.cjs:60` 的本地对象路径判断；本 PR 未修改相关源码和断言，不宣称本地全套全绿。
- 新测试使用真实 `AssistantService → AssistantOrchestrator → ModelClient → parseCall`，仅模拟 transport 的供应商响应；验证决策及收尾都到达传输、JSON/输出额度、只读查询结果，以及没有制作任务提交。
- 对构建产物分别把两个调用点的 `allowPaid` 改成 false，新回归均失败；恢复产物后助手 13/13 通过。所有已有助手桩也执行真实 `parseCall`，不再静默接受契约不合规请求。

未调用真实模型/付费媒体，未进行浏览器人工验收、数据库或生产环境验收。#125 整体能力仍为 partial。本修复涉及模型调用边界，需非作者真人审批当前 head，不自动合并。
