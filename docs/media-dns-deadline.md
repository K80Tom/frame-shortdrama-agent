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

## 2026-11-09 当前 dev 同步与恢复回归

本 PR 同步到 dev b264844，保留冻结输入/Run、Canvas/Assistant与租户媒体投影。没有把 #121 的地址策略或 #111 的字体补丁夹带进来；这些待审PR未合并前，其独立行为/失败不会因本PR验证通过自动变化。原 #78 已关闭，不等于本PR已合并或全链路安全验收。

新增并发快/慢请求用例：同一ingestor中快DNS完成不清除或消费慢请求deadline；慢请求超时后，迟到resolve/reject不触发fetch；显式新调用能正常执行，没有共享失效状态或自动重试。

新增实际 ProductionMediaIngestor + VideoProductionExecutor 链路用例：已完成的视频生成在DNS超时时返回waitingHuman，保留videoRunId和REMOTE_MEDIA_DNS_TIMEOUT，fetch/store均为0；迟到resolve/reject仍不写入。把待入库引用按既有机制交回执行器后，显式重试只读取同一完成Run，requiresPaid=false、actualCostMicros=0，create计数仍1。首次已知完成生成的outcome仍计入原估价500，不把DNS失败伪装成免费或再次提交。

上述是实际ingestor/执行器逻辑、真实JS timer及注入的DNS/fetch/store/provider桩；不是实际DNS、真实MP4/对象存储/PG、账单或生产恢复E2E。该测试不证明底层getaddrinfo可取消，也不证明线程池、并发请求数、排队工作量或内存已整体有界。

- 全包build通过；DNS/媒体/运行时恢复相关定向17/17，无跳过。
- 后端全量723项：719pass /1项既有Windows drawtext字体fail（#111尚未合并）/3平台skipped；未改或跳过原断言。Web135/135。
- 本轮无SQL/DB改动，本地未额外跑PG；当前head Linux/Database CI须独立验收，不能沿用旧绿灯。
- 没有真实下载/模型/付费/目标部署验证。不新增HTTP配置字段，不修改预算、外部操作或DNS pinning逻辑；只在服务端提供单独DNS等待上限，不冒充统一下载总deadline或网络层安全保证。
