# #163 未知结果预算与原子领取

未知结果不是免费结果。running中断后的external_write/paid_external/非幂等调用进入reconciling，waiting_external、inconclusive及pending重放保留reservation；不得通过cancel提前退款。排队/批准但未执行的取消、明确未执行失败仍可release；明确成功时settle。供应商已返回后，输出验证/结果CAS/结算失败均不得退回可消费额度。

AgentRuntimeStore新增必须实现的claimRun(expectedVersion,next,attempt)。这是agent库端口的兼容性变更，两个仓库内实现均已更新，不提供不安全的顺序fallback。它把Run CAS、Attempt、run_state事件（PG含唯一Outbox）原子提交；内存先验证/clone再一次更新maps，PG共用同一租户client与事务，无新队列、迁移或服务。

实际证据：Agent44/44，包含直接unknown、对账CAS失败、结果CAS失败、settle失败、已知未执行release控制，以及成功后的恢复补结算。真实PG测试验证unknown仅执行一次、recover/cancel后保留全部5000预留、两个并发新reservation均拒绝；成功费用4200正常settle。真实PG另外注入Attempt和事件插入失败，Run/Attempt/event全部回滚，两个并发claim仅一个赢家。均为合成工具/适配器，不是供应商账单或真实付费调用。

限制：此修复不增加人工“强制退款”或对账API；未知调用必须由后续权威结果推进，不能靠超时猜测未执行。当前变化不宣称完整#136 Runtime或#137工具平台验收完成。付费/预算及跨包端口变更须非作者真人审批，不自动合并。

数据库test-db按文件串行，避免会删除共享预算账户/预留的fixture污染其他测试；文件内并发竞争测试仍实际执行。无真实付费调用。已有历史误释放记录不会被本修复擅自补账，需独立权威对账。
