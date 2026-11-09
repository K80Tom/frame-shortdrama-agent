import {
  assertPaidGenerationReservation,
  PaidGenerationError,
  type PaidGenerationInterceptor,
  type PaidGenerationReservation,
} from '../../budget/paid-generation';
import { ComfyUiError, type ComfyUiNativeClient } from './native-client';
import type { ComfyUiWorkflowValidator } from './workflow-validation';

export interface ComfyUiGenerationRequest {
  workspaceId: string;
  operationKey: string;
  clientRequestId: string;
  runId?: string | null;
  taskId?: string | null;
  model: string;
  prompt: string;
  workflow: unknown;
  estimateMicros: number;
  budgetLimitMicros: number;
  currency: string;
}

export interface ComfyUiGenerationAcceptance {
  provider: 'comfyui';
  promptId: string;
  model: string;
  operationKey: string;
  reservationId: string;
  status: 'submitted';
}

function invalid(message: string): never {
  throw new ComfyUiError(400, 'COMFYUI_GENERATION_REQUEST_INVALID', message);
}

function parseRequest(value: ComfyUiGenerationRequest): ComfyUiGenerationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('ComfyUI 生成请求格式无效。');
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 8000
    || /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value.prompt)) invalid('ComfyUI 提示词无效。');
  if (typeof value.clientRequestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/u.test(value.clientRequestId)) {
    invalid('ComfyUI clientRequestId 无效。');
  }
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200) invalid('ComfyUI 模型标识无效。');
  if (!Number.isSafeInteger(value.estimateMicros) || value.estimateMicros < 0
    || !Number.isSafeInteger(value.budgetLimitMicros) || value.budgetLimitMicros < value.estimateMicros) {
    invalid('ComfyUI 预算估价无效。');
  }
  return value;
}

/**
 * ComfyUI generation gate. Validation happens before any reservation; the paid
 * reservation is opened before /prompt and settled according to the definite or
 * uncertain outcome of the submission.
 */
export class ComfyUiGenerationAdapter {
  constructor(private readonly client: ComfyUiNativeClient,
    private readonly validator: ComfyUiWorkflowValidator,
    private readonly budget: PaidGenerationInterceptor) {}

  async submit(raw: ComfyUiGenerationRequest): Promise<ComfyUiGenerationAcceptance> {
    const request = parseRequest(raw);
    const validation = await this.validator.validate(request.workflow);
    if (!validation.valid) {
      throw new ComfyUiError(400, 'COMFYUI_WORKFLOW_INVALID', validation.message);
    }
    let reservation: PaidGenerationReservation;
    try {
      reservation = await this.budget.reserve({
        workspaceId: request.workspaceId, operationKey: request.operationKey, provider: 'comfyui',
        model: request.model, estimateMicros: request.estimateMicros,
        budgetLimitMicros: request.budgetLimitMicros, currency: request.currency,
        runId: request.runId ?? null, taskId: request.taskId ?? null,
      });
    } catch (error) {
      if (error instanceof PaidGenerationError) throw error;
      throw new ComfyUiError(503, 'COMFYUI_BUDGET_UNAVAILABLE', 'ComfyUI 预算拦截器不可用；未提交工作流。');
    }
    try {
      assertPaidGenerationReservation(this.budget, reservation, {
        workspaceId: request.workspaceId, operationKey: request.operationKey, provider: 'comfyui',
        model: request.model, estimateMicros: request.estimateMicros, currency: request.currency,
      });
    } catch (error) {
      await this.releaseSafely(reservation, '预算凭证与请求不一致，未提交工作流。');
      throw error;
    }
    let accepted: { promptId: string; nodeErrors: string[] };
    try {
      accepted = await this.client.submitPrompt(request.workflow, request.clientRequestId);
    } catch (error) {
      if (error instanceof ComfyUiError && error.status >= 400 && error.status < 500
        && error.status !== 408 && error.status !== 429) {
        await this.releaseSafely(reservation, error.message);
        throw error;
      }
      await this.unknownSafely(reservation, 'ComfyUI 提交结果不明，保留预算预留等待对账。');
      throw new ComfyUiError(502, 'COMFYUI_SUBMIT_UNCERTAIN', 'ComfyUI 提交结果不明；未自动重试。');
    }
    if (accepted.nodeErrors.length) {
      await this.releaseSafely(reservation, 'ComfyUI prompt 返回 node_errors，工作流未执行。');
      throw new ComfyUiError(400, 'COMFYUI_NODE_ERRORS', 'ComfyUI 工作流节点校验失败，未执行生成。');
    }
    try {
      await this.budget.commit(reservation, request.estimateMicros);
    } catch (error) {
      // The provider has already accepted the prompt. Never hide the acceptance;
      // surface a settlement blocker so an operator can reconcile the ledger.
      throw new ComfyUiError(503, 'COMFYUI_SETTLEMENT_FAILED',
        `ComfyUI 已接受任务（${accepted.promptId}），但预算结算失败，需要人工对账。`);
    }
    return { provider: 'comfyui', promptId: accepted.promptId, model: request.model,
      operationKey: request.operationKey, reservationId: reservation.id, status: 'submitted' };
  }

  private async releaseSafely(reservation: PaidGenerationReservation, reason: string): Promise<void> {
    try { await this.budget.release(reservation, reason); } catch { /* keep the original provider error */ }
  }

  private async unknownSafely(reservation: PaidGenerationReservation, reason: string): Promise<void> {
    try { await this.budget.markUnknown(reservation, reason); } catch { /* never resubmit; operator reconciles */ }
  }
}
