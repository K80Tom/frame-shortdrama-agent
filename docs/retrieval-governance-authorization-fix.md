# 检索治理授权修复（#165）

- 五条 Facade 路由读取标量 expectedVersion；身份不从版本参数或客户端 actorId 推导。
- 缺失 authorization/quality 默认为 unverified，不能用于正样本；客户端 clean 必须由 Main 权威验证器证明。验证器缺失、版本/摘要/租户/项目不符、未实际采用、未审核、许可不明、过期、无 evaluation 用途或后续撤销版本均失败关闭。
- evaluation 是有意收紧的显式用途：production 授权不自动等于评测数据许可。当前最新采用版本之外的历史版本也不自动成为新的训练/评测正样本；历史决策行不改写。
- 决策、冻结与评测注册用同一租户事务连接访问资产、治理及正规 EvaluationService。短时 SHARE 表锁把版本/采用写入与授权快照串行化；不能在该作用域加入网络调用。表锁跨租户竞争，尚未声称吞吐验收，可后续换为资产级 revision 协议。
- 实际PG测试观察撤销 INSERT 的锁等待；typed refs 写入失败时，新增评测 dataset/revision/case/lifecycle 记录全部回滚。
- 元数据生成键修正为 final_score/authorization_quality，符合现有评测契约，不放宽契约校验。

## 验证范围

当前构建通过；相关16项（含真实PostgreSQL054测试）通过。完整数据库38项37通过、1个因管理员连接不执行RLS场景的显式跳过；本修复的054集成实际使用非owner/非superuser/非BYPASSRLS应用连接，无跳过。Web138/138，agent35/35。后端全量1000项993通过、5跳过、2个Windows既有路径失败；干净dev cc837c7独立工作树复现了这两项，不改安全断言来隐藏失败。

数据库测试有清库 fixture 和全局 Outbox 数量断言，原并行执行会互删数据/误报。test-db 现串行执行文件，保留文件内并发CAS/锁竞态测试；不是生产业务串行化设置，也不跳过失败断言。首次并行完整套件已暴露该污染，串行重跑 exit0。没有模型/付费调用，没有迁移或Actions权限修改。此修复不表示整个#128/#134/#135平台完成，须非作者真人审批。
