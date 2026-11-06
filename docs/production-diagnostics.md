# 生产输出拒绝日志的最小安全闭环

日期：2026-11-06；适用分支 dev，基线 890cc36 / 0.1.0。
Owner：@K80Tom（仓库默认维护责任）。跟踪 [#77](https://github.com/K80Tom/frame-shortdrama-agent/issues/77)。
本增量 implemented，#77 整体仍为 partial；不依赖未合并 PR。

## 实际接入

[生产服务](../packages/main/src/production/service.ts)的 failInvalidOutcome 原先直接 console.error 原始错误堆栈或 JSON.stringify(error)。
这可能输出凭据、带凭据 URL、供应商响应和本地路径；循环对象/BigInt 或日志输出失败还可能阻止保存失败状态。
现在调用[安全诊断入口](../packages/main/src/production/diagnostics.ts)，输出单行 JSON：

- schemaVersion、固定 level/event、UTC 时间。
- 严格验证的 project/run/task/attempt/operation ID，格式沿用本地生产标识，不记录自由文本 request ID。
- 原始错误、code/message/stack/cause、原文、URL、模型/供应商响应和未知字段默认不收集，而不是靠模式猜测脱敏。
- 只读自有数据属性，不执行输入 getter/toJSON，不遍历循环对象。非法 ID 省略，无法安全读取则丢弃该条诊断。
- 同步 sink 抛错、异步 reject 或返回永不完成的 Promise 不影响业务；不等待日志完成、不递归记录日志错误。

日志内容仅来自本机服务生成的关联 ID。此入口不是接受任意供应商数据的通用字符串清洗器，也不是持久化审计日志。
自定义 sink 必须保持非阻塞；无法隔离同步死循环或进程级故障。缓冲、采样与持久化由未来日志基础设施负责。

## 业务安全与数据中台边界

失败状态、预算与 unknown 外部操作的处理规则不变。日志不触发重试、释放预算或重新提交付费调用。
业务 outbox 仍是事务内状态事实来源；日志是可丢失的运维辅助信息，不替代 [数据中台 #47](https://github.com/K80Tom/frame-shortdrama-agent/issues/47) 的事件、投影、checkpoint 或成本对账。
本 PR 不改变已有 UI 错误文案策略，也不宣称整个仓库的错误出口已统一清洗。

## 验证入口

[回归测试](../packages/main/tests/production-orchestration.test.cjs)覆盖：
白名单与格式、200 组敏感输入性质检查、getter/toJSON/Proxy/循环对象/BigInt，及同步/异步/悬挂 sink。
集成测试实际让执行器产出无效成果，确认失败状态落库；付费桩保持 unknown、预算预留和重提阻断。
测试不调用真实模型或付费服务。

```sh
npm run build
node --test packages/main/tests/production-orchestration.test.cjs
npm --prefix packages/main test
npm --prefix packages/web test
```

完整 correlation 传播、其他日志入口清洗、单运行诊断包和导出 API/UI 仍待后续 PR。本分支尚无 #109 的状态真源，合并后应将本记录并入统一台账。

## 本地执行记录

2026-11-06，Windows / Node 24.15.0：全项目 `npm run build` 通过；生产编排 56/56，前端 105/105 通过。
后端全量 583 项：579 通过、3 项平台相关跳过、1 项失败；唯一失败为 dev 既有 production-media 字体断言。
该问题由独立 PR #111 修复但尚未合并，本分支未改动 composer 或媒体测试，不将本地全量宣称为通过。
没有真实供应商验证；所有付费路径测试均使用本地桩，预算和 unknown 保护集成测试通过。
