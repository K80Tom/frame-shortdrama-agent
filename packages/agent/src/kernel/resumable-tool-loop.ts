import {
  AgentContractError, type AgentRunCheckpoint, type ToolCallProposal,
} from '@lyra/shared';
import type { AgentRuntime } from '../agent-runtime/runtime';
import {
  runAgentToolLoop, type AgentToolLoopInput, type AgentToolLoopResult, type ToolLoopObservation,
} from './tool-loop';
import type { ToolExecutionOutcome, ToolKernel } from './tool-kernel';

/**
 * 可恢复的多轮 Tool Loop。
 *
 * 与 runAgentToolLoop 的纯执行语义不同，本入口在每次 Tool 调用之前与结果
 * 确认之后都写 Checkpoint：
 * - before_tool：Invocation 已经持久化，但执行结果尚未确认；
 * - after_tool：结果已确认，重启后只复用结果，绝不再次执行；
 * - run_completed：Run 已收束，恢复直接返回缓存结果。
 *
 * Checkpoint 只保存公开的编排状态与工具提案，禁止写入模型隐藏推理。
 */

const DEFAULT_MAX_ROUNDS = 8;
const MAX_ROUNDS = 16;
const MAX_CALLS_PER_ROUND = 8;
const CHECKPOINT_VERSION = 1;

interface ResumableCheckpointPayload {
  version: 1;
  round: number;
  callIndex: number;
  calls: ToolCallProposal[];
  observations: ToolLoopObservation[];
  /** 调度器已完成本轮工具，等待下一轮 planner。 */
  awaitingPlanner: boolean;
  /** planner 已返回的终态摘要；仅 run_completed 使用。 */
  terminal?: {
    status: 'completed';
    rounds: number;
    summary: string;
    output?: unknown;
    observations: ToolLoopObservation[];
  };
  /** 已确认的失败/未知结果；重启后原样返回，不能继续执行后续调用。 */
  stop?: {
    status: 'failed' | 'inconclusive';
    rounds: number;
    summary: string;
    invocationId: string;
  };
}

export interface ResumableAgentToolLoopInput extends Omit<AgentToolLoopInput, 'planner'> {
  planner: AgentToolLoopInput['planner'];
  runtime: Pick<AgentRuntime, 'getRun' | 'recordCheckpoint' | 'latestCheckpoint'>;
  runId: string;
  stepId: string;
  /** 显式传入恢复点主要用于故障注入测试；默认读取最新 Checkpoint。 */
  checkpoint?: AgentRunCheckpoint | null;
  /** false 时忽略历史 Checkpoint，仅用于全新 Run 的首次执行。 */
  resume?: boolean;
}

export type ResumableAgentToolLoopResult = AgentToolLoopResult & { checkpoints: number };

export async function runResumableAgentToolLoop(
  kernel: ToolKernel,
  input: ResumableAgentToolLoopInput,
): Promise<ResumableAgentToolLoopResult> {
  const {
    planner, runtime, runId, stepId, checkpoint: explicitCheckpoint, resume = true,
    approvalIdsByProposal, executeOptions, maxRounds: requestedMaxRounds, ...prepareBase
  } = input;
  const maxRounds = Math.min(requestedMaxRounds ?? DEFAULT_MAX_ROUNDS, MAX_ROUNDS);
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new AgentContractError(400, 'AGENT_TOOL_LOOP_INVALID', 'maxRounds 必须是 1–16 的整数。');
  }
  if (!runId || !stepId) throw new AgentContractError(400, 'AGENT_CHECKPOINT_CONTEXT_REQUIRED', '恢复执行必须绑定 Run 与 Step。');

  let checkpoints = 0;
  const checkpoint = explicitCheckpoint !== undefined
    ? explicitCheckpoint
    : (resume ? await runtime.latestCheckpoint(runId) : null);
  if (checkpoint?.phase === 'run_completed') {
    const terminal = terminalFromCheckpoint(checkpoint);
    return {
      ...terminal, checkpoints: 1,
    };
  }

  let state = checkpoint ? parseCheckpoint(checkpoint) : emptyState();
  // 兼容显式传入 null（首次执行）与历史版本缺字段。
  if (!Array.isArray(state.observations)) state.observations = [];

  // 已确认的失败/未知结果属于恢复终态；不得因为“还有剩余 calls”继续执行。
  if (state.stop) {
    const invocation = await kernel.getInvocation(state.stop.invocationId);
    if (!invocation?.result) {
      throw new AgentContractError(409, 'AGENT_CHECKPOINT_INVALID', 'Checkpoint 中的终态 Invocation 已不可回读。');
    }
    return {
      status: state.stop.status, rounds: state.stop.rounds,
      invocation, result: invocation.result,
      observations: state.observations, checkpoints: 0,
    };
  }

  const save = async (phase: 'before_tool' | 'after_tool' | 'run_completed', options: {
    pendingInvocationId?: string | null; summary: string; cursor?: string | null;
  }): Promise<void> => {
    await runtime.recordCheckpoint(runId, {
      phase,
      stepId,
      summary: options.summary,
      payload: state as unknown as Record<string, unknown>,
      pendingInvocationId: options.pendingInvocationId ?? null,
      cursor: options.cursor ?? null,
    });
    checkpoints += 1;
  };

  // 1) 上次在 Tool 执行前/执行中崩溃：回读持久化 Invocation，交给 Kernel 判定
  //    是复用结果、重新排队，还是外部未知进入 reconciling。
  if (checkpoint?.pendingInvocationId) {
    const pending = await kernel.getInvocation(checkpoint.pendingInvocationId);
    if (!pending) {
      throw new AgentContractError(404, 'AGENT_TOOL_INVOCATION_NOT_FOUND',
        `Checkpoint 指向的 Invocation 不存在：${checkpoint.pendingInvocationId}。`);
    }
    let outcome: ToolExecutionOutcome;
    try {
      outcome = await kernel.recover(pending, prepareBase.context, executeOptions);
    } catch (error) {
      const code = error instanceof AgentContractError ? error.code : '';
      // 审批尚未决定时，恢复不应把 Run 当成执行失败；继续保持挂起。
      if (code === 'AGENT_APPROVAL_ALREADY_DECIDED' || code === 'AGENT_APPROVAL_EXPIRED'
        || code === 'AGENT_TOOL_INVOCATION_NOT_EXECUTABLE') {
        const approval = await kernelApprovalOf(kernel, pending);
        if (approval && approval.state === 'pending') {
          return {
            status: 'WAITING_CONFIRMATION', confirmationState: 'WAITING_CONFIRMATION',
            rounds: state.round, invocation: pending, approval,
            observations: state.observations, checkpoints,
          };
        }
      }
      throw error;
    }
    state.observations.push(observationOf(state.round, pending.proposal, outcome, checkpoint.pendingInvocationId));
    state.callIndex = Math.max(state.callIndex + 1, 0);
    if (outcome.result.status === 'inconclusive') {
      state.stop = {
        status: 'inconclusive', rounds: state.round, summary: outcome.result.summary,
        invocationId: outcome.invocation.invocationId,
      };
    } else if (outcome.result.status === 'failed' || outcome.result.status === 'cancelled') {
      state.stop = {
        status: 'failed', rounds: state.round, summary: outcome.result.summary,
        invocationId: outcome.invocation.invocationId,
      };
    }
    await save('after_tool', { summary: `工具 ${pending.invocationId} 结果已确认。`, cursor: `round:${state.round}:call:${state.callIndex}` });
    if (state.stop) {
      return {
        status: state.stop.status, rounds: state.round, invocation: outcome.invocation,
        result: outcome.result, observations: state.observations, checkpoints,
      };
    }
    if (state.callIndex >= state.calls.length) {
      // 当前轮已全部确认，恢复后的下一轮必须请求 planner，而不是重新回到第 1 轮。
      state.round += 1;
      state.awaitingPlanner = true;
    }
  }

  // 2) 继续执行 Checkpoint 中已规划但未完成的调用；没有剩余调用时才请求 planner。
  // 若恢复点已确认完本轮最后一个调用，必须先推进到下一轮，不能把
  // “本轮已结束”误判成“本轮还没规划”。
  if (checkpoint && !checkpoint.pendingInvocationId
    && state.calls.length > 0 && state.callIndex >= state.calls.length) {
    state.round += 1;
    state.awaitingPlanner = true;
  }
  for (let round = state.round; round <= maxRounds; round += 1) {
    if (round > state.round) {
      state.round = round;
      state.calls = [];
      state.callIndex = 0;
      state.awaitingPlanner = false;
    }
    if (state.calls.length === 0 || state.callIndex >= state.calls.length) {
      if (state.awaitingPlanner || state.calls.length > 0) {
        state.awaitingPlanner = false;
        state.calls = [];
        state.callIndex = 0;
      }
      const decision = await planner({ round, observations: [...state.observations] });
      const calls = decision.calls ?? [];
      if (decision.done || calls.length === 0) {
        const terminal: ResumableCheckpointPayload['terminal'] = {
          status: 'completed', rounds: round, summary: decision.summary ?? '模型已完成本轮工具循环。',
          ...(decision.output === undefined ? {} : { output: decision.output }),
          observations: state.observations,
        };
        state.terminal = terminal;
        await save('run_completed', { summary: terminal.summary, cursor: `done:${round}` });
        return { ...terminal, checkpoints };
      }
      if (calls.length > MAX_CALLS_PER_ROUND) {
        throw new AgentContractError(400, 'AGENT_TOOL_CALLS_EXCEEDED', `单轮工具调用不能超过 ${MAX_CALLS_PER_ROUND} 个。`);
      }
      state.calls = calls.map(call => structuredClone(call));
      state.callIndex = 0;
      state.round = round;
    }

    for (let index = state.callIndex; index < state.calls.length; index += 1) {
      state.callIndex = index;
      const proposal = state.calls[index]!;
      const approvalId = approvalIdsByProposal instanceof Map
        ? approvalIdsByProposal.get(proposal.proposalId)
        : approvalIdsByProposal
          ? (approvalIdsByProposal as Readonly<Record<string, string>>)[proposal.proposalId]
          : undefined;
      const prepared = await kernel.prepare({
        ...prepareBase,
        stepId,
        proposal,
        ...(approvalId ? { approvalId } : {}),
      });

      if (prepared.kind === 'denied') {
        state.observations.push({
          round, proposalId: proposal.proposalId, toolId: prepared.definition.toolId,
          version: prepared.definition.version, status: 'denied', summary: prepared.summary,
        });
        await save('after_tool', { summary: prepared.summary, cursor: `round:${round}:denied` });
        return {
          status: 'denied', rounds: round, reasonCode: prepared.reasonCode, summary: prepared.summary,
          definition: prepared.definition, observations: state.observations, checkpoints,
        };
      }
      if (prepared.kind === 'awaiting_confirmation') {
        state.observations.push({
          round, proposalId: proposal.proposalId, toolId: proposal.toolId, version: proposal.version,
          status: 'awaiting_confirmation', summary: prepared.approval.summary,
          invocationId: prepared.invocation.invocationId,
        });
        await save('before_tool', {
          pendingInvocationId: prepared.invocation.invocationId,
          summary: `等待人工确认：${prepared.approval.summary}`,
          cursor: `round:${round}:call:${index}`,
        });
        return {
          status: 'WAITING_CONFIRMATION', confirmationState: 'WAITING_CONFIRMATION', rounds: round,
          invocation: prepared.invocation, approval: prepared.approval,
          observations: state.observations, checkpoints,
        };
      }

      let outcome: ToolExecutionOutcome;
      if (prepared.kind === 'reused') {
        if (prepared.result.reconciliation === 'pending') {
          // 崩溃可能发生在 Invocation 已持久化、但 before_tool 尚未落盘之间；
          // 不能把 pendingResult 当成终态，必须交给 Kernel 重新确认。
          await save('before_tool', {
            pendingInvocationId: prepared.invocation.invocationId,
            summary: `恢复未确认调用：${proposal.toolId}@${proposal.version}`,
            cursor: `round:${round}:call:${index}`,
          });
          outcome = await kernel.recover(prepared.invocation, prepareBase.context, executeOptions);
          state.observations.push(observationOf(round, proposal, outcome, prepared.invocation.invocationId));
          state.callIndex = index + 1;
          if (outcome.result.status === 'inconclusive') {
            state.stop = {
              status: 'inconclusive', rounds: round, summary: outcome.result.summary,
              invocationId: outcome.invocation.invocationId,
            };
          } else if (outcome.result.status === 'failed' || outcome.result.status === 'cancelled') {
            state.stop = {
              status: 'failed', rounds: round, summary: outcome.result.summary,
              invocationId: outcome.invocation.invocationId,
            };
          }
          await save('after_tool', {
            summary: outcome.result.summary,
            cursor: `round:${round}:call:${index + 1}`,
          });
        } else {
          outcome = { invocation: prepared.invocation, result: prepared.result };
          // reused 已有确认结果，但仍写 after_tool，避免复活时重复规划。
          state.observations.push(observationOf(round, proposal, outcome, prepared.invocation.invocationId, 'reused'));
          state.callIndex = index + 1;
          await save('after_tool', {
            summary: `复用已确认结果：${prepared.invocation.invocationId}`,
            cursor: `round:${round}:call:${index + 1}`,
          });
        }
      } else {
        await save('before_tool', {
          pendingInvocationId: prepared.invocation.invocationId,
          summary: `准备执行工具：${proposal.toolId}@${proposal.version}`,
          cursor: `round:${round}:call:${index}`,
        });
        outcome = await kernel.execute(prepared.invocation, prepareBase.context, executeOptions);
        state.observations.push(observationOf(round, proposal, outcome, prepared.invocation.invocationId));
        state.callIndex = index + 1;
        if (outcome.result.status === 'inconclusive') {
          state.stop = {
            status: 'inconclusive', rounds: round, summary: outcome.result.summary,
            invocationId: outcome.invocation.invocationId,
          };
        } else if (outcome.result.status === 'failed' || outcome.result.status === 'cancelled') {
          state.stop = {
            status: 'failed', rounds: round, summary: outcome.result.summary,
            invocationId: outcome.invocation.invocationId,
          };
        }
        await save('after_tool', {
          summary: outcome.result.summary,
          cursor: `round:${round}:call:${index + 1}`,
        });
      }

      if (state.stop) {
        return {
          status: state.stop.status, rounds: round, invocation: outcome.invocation,
          result: outcome.result, observations: state.observations, checkpoints,
        };
      }
      if (outcome.result.status === 'inconclusive') {
        return { status: 'inconclusive', rounds: round, invocation: outcome.invocation, result: outcome.result, observations: state.observations, checkpoints };
      }
      if (outcome.result.status === 'failed' || outcome.result.status === 'cancelled') {
        return { status: 'failed', rounds: round, invocation: outcome.invocation, result: outcome.result, observations: state.observations, checkpoints };
      }
    }
    state.awaitingPlanner = true;
  }

  return { status: 'max_rounds', rounds: maxRounds, observations: state.observations, checkpoints };
}

function emptyState(): ResumableCheckpointPayload {
  return {
    version: CHECKPOINT_VERSION, round: 1, callIndex: 0, calls: [],
    observations: [], awaitingPlanner: false,
  };
}

function parseCheckpoint(checkpoint: AgentRunCheckpoint): ResumableCheckpointPayload {
  const payload = checkpoint.payload as Partial<ResumableCheckpointPayload>;
  if (payload.version !== CHECKPOINT_VERSION || !Number.isInteger(payload.round)
    || !Number.isInteger(payload.callIndex) || !Array.isArray(payload.calls)
    || !Array.isArray(payload.observations)) {
    throw new AgentContractError(409, 'AGENT_CHECKPOINT_INVALID', 'Checkpoint payload 与当前恢复版本不兼容。');
  }
  return {
    version: CHECKPOINT_VERSION,
    round: Number(payload.round),
    callIndex: Number(payload.callIndex),
    calls: payload.calls.map(call => structuredClone(call)),
    observations: payload.observations.map(item => structuredClone(item)),
    awaitingPlanner: Boolean(payload.awaitingPlanner),
    ...(payload.terminal ? { terminal: structuredClone(payload.terminal) } : {}),
    ...(payload.stop ? { stop: structuredClone(payload.stop) } : {}),
  };
}

function terminalFromCheckpoint(checkpoint: AgentRunCheckpoint): AgentToolLoopResult {
  const payload = checkpoint.payload as Partial<ResumableCheckpointPayload>;
  const terminal = payload.terminal;
  if (!terminal || terminal.status !== 'completed' || !Number.isInteger(terminal.rounds)) {
    throw new AgentContractError(409, 'AGENT_CHECKPOINT_INVALID', '完成 Checkpoint 缺少可重放结果。');
  }
  return {
    status: 'completed', rounds: terminal.rounds, summary: terminal.summary,
    ...(terminal.output === undefined ? {} : { output: terminal.output }),
    observations: terminal.observations ?? [],
  };
}

function observationOf(
  round: number, proposal: ToolCallProposal, outcome: ToolExecutionOutcome,
  invocationId: string, forced?: ToolLoopObservation['status'],
): ToolLoopObservation {
  return {
    round,
    proposalId: proposal.proposalId,
    toolId: proposal.toolId,
    version: proposal.version,
    status: forced ?? (outcome.result.status === 'succeeded'
      ? 'succeeded'
      : outcome.result.status === 'inconclusive' ? 'inconclusive' : 'failed'),
    summary: outcome.result.summary,
    invocationId,
  };
}

 /** 审批回读只用于恢复时判断是否仍应挂起；不存在审批视为非审批调用。 */
async function kernelApprovalOf(kernel: ToolKernel, invocation: {
  approvalRequestId?: string;
}): Promise<import('@lyra/shared').AgentApprovalRequest | null> {
  if (!invocation.approvalRequestId) return null;
  return kernel.getApproval(invocation.approvalRequestId);
}

// 重新导出，方便调用方无需同时 import 两个模块。
export { runAgentToolLoop };
