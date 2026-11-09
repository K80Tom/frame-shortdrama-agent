import { AgentRuntime, ToolKernel, type ToolRegistry } from '@lyra/agent';
import type { PostgresDatabase } from '../db/client';
import { PostgresAgentRuntimeStore } from './postgres-store';
import { PostgresBudgetLedger, PostgresToolInvocationStore } from './postgres-tool-store';

/**
 * Main 侧装配：把 039 迁移提供的持久化适配器注入 agent 的纯逻辑 Runtime/Kernel。
 *
 * agent 包只知道端口接口；连接、RLS 租户上下文和 SQL 全部留在 main。
 */
export interface AgentTooling {
  readonly runtime: AgentRuntime;
  readonly runtimeStore: PostgresAgentRuntimeStore;
  readonly toolKernel: ToolKernel;
  readonly invocationStore: PostgresToolInvocationStore;
  readonly budgetLedger: PostgresBudgetLedger;
}

export function createAgentTooling(database: PostgresDatabase, registry: ToolRegistry): AgentTooling {
  const invocationStore = new PostgresToolInvocationStore(database);
  const budgetLedger = new PostgresBudgetLedger(database);
  const runtimeStore = new PostgresAgentRuntimeStore(database);
  return {
    runtime: new AgentRuntime(runtimeStore),
    runtimeStore,
    // 审批事实与 Run 共用同一 Postgres store；Kernel 恢复执行时按 approvalId 回读。
    toolKernel: new ToolKernel(registry, invocationStore, budgetLedger, { approvals: runtimeStore }),
    invocationStore,
    budgetLedger,
  };
}
