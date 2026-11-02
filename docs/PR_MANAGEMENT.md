# Pull Request 管理规则

## 分支与审核人

- 普通功能和修复 PR 以 `dev` 为目标；`dev` 到 `main` 的发布 PR 必须人工处理。
- 默认审核人为 `K80Tom`、`255308153`（QCode）和 `VerCurL`。其他已邀请成员在接受邀请并获得写权限后加入 `CODEOWNERS`。
- PR 作者不能批准自己的 PR。每个合并必须至少有一名默认审核人中的非作者对当前 head 提交 `APPROVED` review。

## 唯一处理结论

1. `WAITING`：Draft、CI 运行中或 GitHub 尚未算出合并状态；不评论、不合并。
2. `NEEDS_REBASE`：仅存在基线落后或机械冲突；先更新到正确 base。
3. `REQUEST_CHANGES`：存在可复现的正确性、安全、数据契约、付费、预算、幂等或回归测试缺陷。
4. `SUBSTANTIVE_CONFLICT`：新旧实现涉及产品行为、公共契约、数据语义或付费状态机取舍；写明冲突与保留项，不自动选边。
5. `READY_TO_MERGE`：所有门禁满足后 squash 合并。

## Rebase 与冲突处理

- 无冲突的过期分支可以更新到最新 base 后重新跑 CI。
- 只含机械冲突时，从最新 `dev` 建隔离分支，仅移植原 PR 的有效意图，保留当前架构和安全门禁；运行完整测试后开 replacement PR，并保留原作者 attribution。
- 不 force-push 外部贡献者的 fork，不改写贡献者历史。
- 实质冲突只留具体 comment，说明冲突文件、行为差异、必须保留的能力和下一步；不得用 `ours`/`theirs` 粗暴覆盖。
- 已被 `dev` 上更完整实现取代的 PR 标记为 superseded，不恢复旧架构。

## 合并门禁

只有同时满足以下条件才允许 squash 合并：

- Backend tests 与 Frontend tests and build 在当前 head 全绿；
- 与当前 base 同步、无冲突；
- 没有未解决 review thread 或 `CHANGES_REQUESTED`；
- 没有 P0/P1 blocker，也未触及尚未人工确认的高风险变更；
- 至少一名默认审核人中的非作者批准当前 head。

GitHub Actions 只做 CI 和只读安全门禁，不批准、不自动合并。最终合并由仓库 PR 管家在上述条件全部满足后执行，不使用管理员绕过。
