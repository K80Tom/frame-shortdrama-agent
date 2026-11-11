# DECISIONS — 现行设计决定

> 初版：2026-11-11。发生设计冲突、跨包边界调整或架构迁移时先读本文件。这里记录“为什么这样做”；进度放 NOW，操作放 RUNBOOK，过程放 history。

## 决定登记

| ID | 决定 | 解决的冲突与影响 | 状态 / 依据 |
| --- | --- | --- | --- |
| D-001 | 保持单 monorepo：`shared / agent / main / web / cli` | 避免包间互相引用内部实现；公共契约优先进 shared，reference 不参与运行 | 现行；[AGENTS.md](AGENTS.md) |
| D-002 | `main` 独占数据库、模型密钥、付费提交和最终媒体确认 | 防止纯逻辑包或客户端越权；agent 通过接口注入取数，web/cli 只走 main API | 现行；[README 架构](README.md) |
| D-003 | PostgreSQL 是结构化业务事实源；Redis/Milvus 是可重建或安全失效的派生层 | 避免缓存、向量索引或临时流成为唯一事实；检索命中后回 PG 验权与版本 | 现行；[路线 §2–3](docs/production-architecture-roadmap.md) |
| D-004 | 媒体目标事实字节进统一 ObjectStorage，数据库只存元数据 | 避免大型字节进入 PG/Redis/Kafka；当前 `asset_media.content BYTEA` 是已披露迁移例外，不能宣称迁移完成 | 目标已定、迁移中；[路线 §4.6](docs/production-architecture-roadmap.md) |
| D-005 | 所有付费遵循“估价/计划 → 人工确认 → 提交”，unknown 先对账原任务 | 防止建卡扣费、重试双花和不确定状态下重复提交；CLI create/submit 分离 | 现行；[README 付费边界](README.md) |
| D-006 | 跨存储投影只复用 PostgreSQL 事务 Outbox，不新建第二套事件体系 | 避免 PG 与 Redis/Milvus/Kafka 不可恢复双写；消费者至少一次投递必须幂等 | 现行；[DataEvent 契约](docs/data-event-contract.md) |
| D-007 | Stage 1 API/Worker 分进程但保持同仓库和 `@lyra/main` 主权 | 获得故障隔离和独立扩缩容，不提前拆微服务；旧调度切换必须有 fencing | 现行、迁移中；[路线 §4.3](docs/production-architecture-roadmap.md) |
| D-008 | 生产输入采用不可变版本、摘要和 Run 绑定，执行前仍复查授权 | 防止运行中读取 current/active 导致输入漂移；冻结不等于永久付费授权 | 分阶段实施；[#123 进度](docs/frozen-production-run-progress.md) |
| D-009 | `dev` 集成、`main` 发布；所有主题在独立 worktree 通过 PR 交付 | 避免共享工作区交叉污染和直接发布；高风险改动需非作者真人批准 | 现行；[AGENTS.md](AGENTS.md) |
| D-010 | Stage 1 不引入 Kubernetes、Kafka、分片或跨地域双活 | 避免超出实测需求的复杂度；只有路线定义的吞吐、SLO、多消费者或灾备条件触发后才评估 | 现行；[路线 §8](docs/production-architecture-roadmap.md) |
| D-011 | 文档按索引、当前状态、路径、操作、决策、风险、历史分责，并采用“团队共享主文件＋个人本地补充” | 避免目标、当前事实和验收证据混写；共享文件保存项目事实，被忽略的 `*.local.md` 保存个人高频状态，减少合并冲突 | 现行；[PROJECT_INDEX.md](PROJECT_INDEX.md) |
| D-012 | 上下文按需读取，修改前定位目标章节并定点编辑 | 避免全项目遍历、断章取义与局部阅读后覆盖整份文件；只有证据不足、冲突或依赖核对时才扩大范围 | 现行；[AGENTS §8](AGENTS.md#8-ai-上下文读取与文档写入规则) |
| D-013 | 每类事实只设一个权威来源，当前状态原位修订；无独立用途时不建平行文档 | 避免多份状态冲突和无效 `PROJECT_NOTES.md` / `docs/context/`；有价值旧过程才归档，只读任务不改记录 | 现行；[PROJECT_INDEX.md](PROJECT_INDEX.md)、[AGENTS §8](AGENTS.md#8-ai-上下文读取与文档写入规则) |

## 变更规则

1. 新决定使用下一编号，写明背景、备选方案、影响范围、兼容/回滚和证据链接。
2. 旧决定被替代时标为 `superseded` 并指向新 ID，不删除历史推理；正在试验的方案标为 `proposed`，不得写成现行。
3. 涉及公共契约、数据库迁移、认证授权、付费/媒体/预算或跨包边界时，同步检查代码、测试、部署文档和审批要求。
4. 本表只保留有长期约束力的摘要；详细设计通过链接定位，避免复制后产生多个真相源。
