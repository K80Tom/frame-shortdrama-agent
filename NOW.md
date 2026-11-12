# NOW — 项目当前状态

> 初版：2026-11-11。本文件由团队共享，只记录当前里程碑、项目级阻塞和待验收事项。个人分支、HEAD、本地下一步与验证状态放入被 Git 忽略的 `NOW.local.md`，模板见 [NOW.local.example.md](NOW.local.example.md)。

## 当前里程碑

当前产品基线为 `v0.2.0 / Stage 1 单受信 workspace 试运行`。主链、工作台和 PostgreSQL 事实源已落地，API/Worker、会话与 workspace、RLS、Redis、Milvus 和对象存储等 Stage 1 基线已有实现；这不代表公网多租户或目标环境生产验收已完成。

能力范围、源码与测试证据统一读 [功能状态与证据](docs/feature-status.md)，目标架构与阶段差距读 [生产架构路线](docs/production-architecture-roadmap.md)。本页不复制各 Issue 的详细进度。

## 项目级待验收事项

以下是现有文档已明确的缺口，不代表个人排期。任务归属、评审和合并状态以 Issue/PR 为准；认领后链接对应 Issue，不在本页另建任务流水账。

| 方向 | 待完成 / 待验收 | 完成证据要求 | 依据 |
| --- | --- | --- | --- |
| 调度主权 | Production/Asset/Video 旧调度尚未全部迁入通用 jobs | 单领取者、fencing、租约接管、幂等与重复付费验证 | [路线 §7](docs/production-architecture-roadmap.md) |
| 冻结生产输入 | 默认路径、资产包/控制/视频及完整执行链尚未全部切到冻结版本 | 编辑→冻结→执行→交付 E2E，证明不以 current/active 替代历史 | [#123 进度](docs/frozen-production-run-progress.md) |
| 媒体对象化 | 导入资产图片仍在 `asset_media.content BYTEA`；公网签名 endpoint、授权与孤儿 GC 未闭环 | 迁移/checksum 对账、浏览器可达性、跨租户拒绝、生命周期与恢复演练 | [对象版本输入](docs/object-version-inputs.md) |
| 向量检索 | 真实 Milvus 全量回填、召回质量与 Alias 切换未验收 | 显式付费授权、基线对比、回表验真、降级与回切记录 | [路线 §4.5](docs/production-architecture-roadmap.md) |
| 密钥与运行时 | 模型连接仍有共享明文 JSON，API/Worker 版本刷新不一致 | Secret Manager/KMS、BYOK 加密、刷新与回滚演练 | [README 当前边界](README.md) |
| 运维与租户 | 目标环境跨租户、监控告警、备份/PITR 和组合恢复未闭环 | 非特权角色、真实目标环境、脱敏结果与真人验收 | [路线 §4.9](docs/production-architecture-roadmap.md) |

## 事实源与更新规则

- **Git** 是分支、HEAD 和合入状态的事实源；**Issue/PR** 是任务归属、评审与合并状态的事实源。
- **功能台账** 是能力与验证证据的事实源；本页只在里程碑、项目阻塞或待验收状态变化时更新，不逐提交刷新日期。
- 新任务先确认 Issue 和独立 worktree；公共契约、迁移、付费/媒体/预算及跨包改动先读 [DECISIONS.md](DECISIONS.md) 与 [RISKS.md](RISKS.md)。
- 已合入、待审和本地未推送必须分开；Issue 关闭、PR 绿灯或文档更新不能替代产品验收。
- 有复用价值的过程归档到 [history/](history/)；个人高频接续状态只更新 `NOW.local.md`。
