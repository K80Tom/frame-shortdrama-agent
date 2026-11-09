import {
  AgentContractError, type AgentApprovalRequest, type ToolCallProposal, type ToolDefinition,
  type ToolInvocationRecord, type ToolResult,
} from '@lyra/shared';
import type {
  ToolExecutionOutcome, ToolExecuteOptions, ToolKernel, ToolPrepareInput,
} from './tool-kernel';

/**
 * 多轮 tool_calls 受控循环。
 *
 * 模型/规划器只产生 Proposal；每一轮都必须重新经过 ToolKernel 的第三层校验
 * （Agent allowlist、Schema、RBAC、租户、预算、副作用）。任何需要人工确认的
 * 调用都会立即以 WAITING_CONFIRMATION 挂起，不继续执行后续轮次。
 */

const DEFAULT_MAX_ROUNDS = 8;
const MAX_ROUNDS = 16;
const MAX_CALLS_PER_ROUND = 8;

export interface ToolLoopObservation {
  round: number;
  proposalId: string;
  toolId: string;
  version: string;
  status: 'succeeded' | 'reused' | 'failed' | 'inconclusive' | 'denied' | 'awaiting_confirmation';
  summary: string;
  invocationId?: string;
}

export interface ToolLoopPlannerState {
  round: number;
  observations: readonly ToolLoopObservation[];
}

export interface ToolLoopDecision {
  /** 本轮模型返回的 tool_calls；为空或 done=true 表示可以收束。 */
  calls?: readonly ToolCallProposal[];
  done?: boolean;
  summary?: string;
  output?: unknown;
}

export type ToolLoopPlanner = (state: ToolLoopPlannerState) => Promise<ToolLoopDecision>;

export type AgentToolLoopInput = Omit<ToolPrepareInput, 'proposal' | 'approvedInvocation' | 'now'> & {
  planner: ToolLoopPlanner;
  maxRounds?: number;
  /** 已由人工批准的提案 ID；只对同一 proposalId 生效，不能跨调用复用审批。 */
  approvedProposalIds?: ReadonlySet<string>;
  executeOptions?: ToolExecuteOptions;
};

export type AgentToolLoopResult =
  | {
    status: 'completed';
    rounds: number;
    summary: string;
    output?: unknown;
    observations: readonly ToolLoopObservation[];
  }
  | {
    status: 'WAITING_CONFIRMATION';
    confirmationState: 'WAITING_CONFIRMATION';
    rounds: number;
    invocation: ToolInvocationRecord;
    approval: AgentApprovalRequest;
    observations: readonly ToolLoopObservation[];
  }
  | {
    status: 'denied';
    rounds: number;
    reasonCode: string;
    summary: string;
    definition: ToolDefinition;
    observations: readonly ToolLoopObservation[];
  }
  | {
    status: 'failed' | 'inconclusive';
    rounds: number;
    invocation: ToolInvocationRecord;
    result: ToolResult;
    observations: readonly ToolLoopObservation[];
  }
  | {
    status: 'max_rounds';
    rounds: number;
    observations: readonly ToolLoopObservation[];
  };

export async function runAgentToolLoop(
  kernel: ToolKernel,
  input: AgentToolLoopInput,
): Promise<AgentToolLoopResult> {
  const { planner, maxRounds: requestedMaxRounds, approvedProposalIds, executeOptions, ...prepareBase } = input;
  const maxRounds = Math.min(requestedMaxRounds ?? DEFAULT_MAX_ROUNDS, MAX_ROUNDS);
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new AgentContractError(400, 'AGENT_TOOL_LOOP_INVALID', 'maxRounds 必须是 1–16 的整数。');
  }
  const observations: ToolLoopObservation[] = [];
  for (let round = 1; round <= maxRounds; round += 1) {
    const decision = await planner({ round, observations: [...observations] });
    const calls = decision.calls ?? [];
    if (decision.done || calls.length === 0) {
      return {
        status: 'completed', rounds: round, summary: decision.summary ?? '模型已完成本轮工具循环。',
        ...(decision.output === undefined ? {} : { output: decision.output }), observations,
      };
    }
    if (calls.length > MAX_CALLS_PER_ROUND) {
      throw new AgentContractError(400, 'AGENT_TOOL_CALLS_EXCEEDED', `单轮工具调用不能超过 ${MAX_CALLS_PER_ROUND} 个。`);
    }
    for (const proposal of calls) {
      const prepared = await kernel.prepare({
        ...prepareBase,
        proposal,
        ...(approvedProposalIds?.has(proposal.proposalId) ? { approvedInvocation: true } : {}),
      });
      if (prepared.kind === 'denied') {
        observations.push({
          round, proposalId: proposal.proposalId, toolId: prepared.definition.toolId,
          version: prepared.definition.version, status: 'denied', summary: prepared.summary,
        });
        return {
          status: 'denied', rounds: round, reasonCode: prepared.reasonCode, summary: prepared.summary,
          definition: prepared.definition, observations,
        };
      }
      if (prepared.kind === 'awaiting_confirmation') {
        observations.push({
          round, proposalId: proposal.proposalId, toolId: proposal.toolId, version: proposal.version,
          status: 'awaiting_confirmation', summary: prepared.approval.summary, invocationId: prepared.invocation.invocationId,
        });
        return {
          status: 'WAITING_CONFIRMATION', confirmationState: 'WAITING_CONFIRMATION', rounds: round,
          invocation: prepared.invocation, approval: prepared.approval, observations,
        };
      }
      const outcome: ToolExecutionOutcome = prepared.kind === 'reused'
        ? { invocation: prepared.invocation, result: prepared.result }
        : await kernel.execute(prepared.invocation, prepareBase.context, executeOptions);
      observations.push({
        round, proposalId: proposal.proposalId, toolId: proposal.toolId, version: proposal.version,
        status: outcome.result.status === 'succeeded'
          ? (prepared.kind === 'reused' ? 'reused' : 'succeeded')
          : (outcome.result.status === 'inconclusive' ? 'inconclusive' : 'failed'),
        summary: outcome.result.summary, invocationId: outcome.invocation.invocationId,
      });
      if (outcome.result.status === 'inconclusive') {
        return { status: 'inconclusive', rounds: round, invocation: outcome.invocation, result: outcome.result, observations };
      }
      if (outcome.result.status === 'failed' || outcome.result.status === 'cancelled') {
        return { status: 'failed', rounds: round, invocation: outcome.invocation, result: outcome.result, observations };
      }
    }
  }
  return { status: 'max_rounds', rounds: maxRounds, observations };
}
