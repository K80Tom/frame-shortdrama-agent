# 运行前本地能力检查（#74）

日期：2026-11-06；适用 dev / 890cc36 / 0.1.0。Owner：@K80Tom（默认维护责任）。
跟踪 [#74](https://github.com/K80Tom/frame-shortdrama-agent/issues/74)。API/CLI 增量 implemented，完整 #74 partial。

## 实际入口

`GET /api/platform/preflight` 返回版本化 shared DTO；CLI `doctor --json` 在原 health/models 输出外增加 preflight，普通输出显示阻断/降级阶段及固定修复建议。
healthz 仍只表示存活，不能代表生产就绪。API 使用既有本机访问守卫与 Cache-Control: no-store，不新增写操作或授权。

检查包括 PostgreSQL 只读 SELECT/迁移清单、受控媒体目录及 objects/tmp/manifests 目录权限、媒体和生产服务初始化状态、ffmpeg/ffprobe -version，以及四种用途的本地模型配置。
必需项失败为 blocked，可选生图/向量项缺失为 degraded，仅列出受影响阶段；禁用抽帧时通用模型不作为必需项。
实际向量服务不发送探测请求：即使已配置也标记 UNVERIFIED/degraded，不把配置存在冒充可用性。

模型检查仅确认已校验的本地用途配置存在，不调用供应商，不验证质量/余额/连通性。
`providerAvailabilityChecked:false`、`paidCallsMade:0` 是本次检查范围声明，不代表后台原有已授权任务没有运行。
检查不是付费授权或 Run 创建门禁，实际预算/模型选择/确认/提交保护不变。

## 超时、缓存与隐私

每项默认 2 秒超时；二进制探测另有限时 1.5 秒和 64 KiB 输出上限。默认缓存 10 秒，最大 60 秒，合并并发请求并对返回值做深拷贝。
模型连接更新后结果最多滞后缓存窗口；报告携带 checkedAt/expiresAt/schemaVersion。
探测异常只转为固定 code/action，不返回 URL、数据库凭据、路径、二进制输出或供应商原始异常。
数据库池已有 5 秒连接超时；服务层超时只停止等待，不能取消底层数据库操作。注入 probe 必须只读且自行有界。
目录权限使用 lstat/access，不创建测试文件，不证明文件系统实际写入一定成功。

## 验证

```sh
npm run setup
npm run build
node --test packages/main/tests/platform-preflight.test.cjs
npm test
```

回归覆盖必需阻断/可选降级、缺迁移/缺二进制/连接失败、超时、单飞缓存、克隆隔离、DTO 破坏及真实 HTTP/CLI。
完整构建后本地真实 CLI 子测试执行；只构建后端的 CI 显式跳过未构建 CLI 子测试，其余 HTTP 与所有探测回归始终执行。
没有真实模型调用；测试的完全 ready 使用本地桩，不作为真实供应商验证。

## 剩余范围

尚未接入 Web 创建 Run 界面，未将报告写入冻结运行，也不声称完整 #74 完成。后续 UI 应复用 shared DTO/API，不另造检查结论。
启动期间遇到致命数据库连接或媒体初始化错误仍沿用启动失败策略，尚不提供“失败后仍在线”的诊断服务器。
当前 dev 尚无 #109 状态台账，合并后应链接本记录。向量远端健康和真实供应商验证需要单独设计，不能触发付费调用。

本地执行（2026-11-06，Windows / Node 24.15）：全项目构建通过；定向测试含真实 CLI 为 9/9，前端 105/105 通过。后端全量 580 项：576 通过、3 平台相关跳过、1 dev 既有 Windows 字体失败（#111 尚未合并），不宣称本地全量全绿。paid 字段表示该能力将来可能收费（含可选 embedding），不是本次检查发生了费用。
