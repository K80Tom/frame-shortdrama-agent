# 媒体 DNS 有界等待（#78 增量）

日期 2026-11-08；dev 基线 0622a35；owner 沿用 @K80Tom 默认维护责任。
状态：本增量 implemented，完整 #78 partial。不依赖未合并的地址范围 PR #121。

原下载超时只约束 HTTPS，请求之前的 resolver.resolve 可能一直不完成。
现在服务端构造选项 dnsTimeoutMs 默认 min(timeoutMs, 5000)，允许 1..30000 的安全整数；到期返回固定 504 / REMOTE_MEDIA_DNS_TIMEOUT，不开始下载、不自动重试，也不重新提交供应商生成任务。
DNS 和下载分别计时，不将二者称为整个任务的统一 deadline；无效/溢出 timer 值拒绝。
成功、失败、超时均清理定时器；超时后迟到的结果或错误被安全消费，不再触发 fetch，也不产生 unhandled rejection。

该期限仅停止等待，不能取消底层系统 getaddrinfo 工作；不宣称提供 DNS 线程池隔离、并发限流或整个任务取消。
IP 字面地址继续跳过 DNS。原地址校验、DNS pinning、HTTPS 及重定向策略不变。
不改 ObjectStorage、workspace、Outbox、预算与付费确认链路，不新增 HTTP 配置字段。

测试使用注入 resolver/fetch，不访问公网或真实内网：永不完成/迟到成功/迟到失败、立即失败脱敏、快速成功、IP 字面地址及 timer 边界。
命令：npm run build；node --test --test-name-pattern="DNS|provider ingest|socket lookup|address|URL" packages/main/tests/production-media.test.cjs；npm test。
现有后端 CI 会执行整个媒体测试文件，不以定向运行取代全套。无真实供应商验证。

2026-11-08 本地 Node 24.15：全项目构建通过，DNS/地址定向 12/12，前端 117/117；后端全量 649 项，645 通过、3 跳过、1 dev 既有 Windows 字体失败（#111 尚待合并），不宣称本地全量全绿。
