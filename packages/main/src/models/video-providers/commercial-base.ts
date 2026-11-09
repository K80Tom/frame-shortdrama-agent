import {
  assertPaidGenerationReservation,
  PaidGenerationError,
  type PaidGenerationInterceptor,
  type PaidGenerationReservation,
} from '../../budget/paid-generation';
import {
  assertProviderConfig,
  CommercialVideoError,
  parseCommercialVideoRequest,
  providerRequestJson,
  ProviderHttpError,
  type CommercialVideoAcceptance,
  type CommercialVideoPollQuery,
  type CommercialVideoPollResult,
  type CommercialVideoProvider,
  type CommercialVideoProviderConfig,
  type CommercialVideoRequest,
  type ProviderHttpRequest,
} from './types';

export abstract class CommercialVideoAdapter {
  readonly provider: CommercialVideoProvider;
  protected readonly config: CommercialVideoProviderConfig;
  protected readonly budget: PaidGenerationInterceptor;

  constructor(provider: CommercialVideoProvider, config: CommercialVideoProviderConfig, budget: PaidGenerationInterceptor) {
    assertProviderConfig(config, provider);
    this.provider = provider;
    this.config = config;
    this.budget = budget;
  }

  /** Pure request assembly; safe to unit test without network or credentials. */
  protected abstract buildRequest(request: CommercialVideoRequest): ProviderHttpRequest;
  protected abstract parseTaskId(response: unknown): string | null;
  /** 轮询请求组装（GET，只读，无预算动作）。 */
  protected abstract buildPollRequest(query: CommercialVideoPollQuery): ProviderHttpRequest;
  /** 纯解析：把供应商轮询响应映射为 pending/succeeded/failed 与产物地址。 */
  protected abstract parsePollResponse(response: unknown, query: CommercialVideoPollQuery): CommercialVideoPollResult;

  /** Redacted view for tests/operators: never returns auth headers or the API key. */
  inspectRequest(raw: CommercialVideoRequest): { url: string; body: Record<string, unknown> } {
    const request = parseCommercialVideoRequest(raw, this.provider);
    const built = this.buildRequest(request);
    return { url: built.url, body: built.body ?? {} };
  }

  /** 轮询URL预览（脱敏，不含 Authorization）；供测试与运维检查。 */
  inspectPoll(query: CommercialVideoPollQuery): { url: string } {
    return { url: this.buildPollRequest(query).url };
  }

  /** 单次任务轮询。只读，不触发预算动作；网络失败抛 ProviderHttpError，由调用方决定重试节奏。 */
  async poll(query: CommercialVideoPollQuery): Promise<CommercialVideoPollResult> {
    const request = this.buildPollRequest(query);
    const response = await providerRequestJson(this.config, request);
    return this.parsePollResponse(response, query);
  }

  async submit(raw: CommercialVideoRequest): Promise<CommercialVideoAcceptance> {
    const request = parseCommercialVideoRequest(raw, this.provider);
    const built = this.buildRequest(request);
    let reservation: PaidGenerationReservation;
    try {
      reservation = await this.budget.reserve({
        workspaceId: request.workspaceId, operationKey: request.operationKey, provider: this.provider,
        model: request.model, estimateMicros: request.estimateMicros, budgetLimitMicros: request.budgetLimitMicros,
        currency: request.currency, runId: request.runId ?? null, taskId: request.taskId ?? null,
      });
    } catch (error) {
      if (error instanceof PaidGenerationError) throw error;
      throw new CommercialVideoError(503, 'VIDEO_BUDGET_UNAVAILABLE', '视频预算拦截器不可用；未提交供应商请求。');
    }
    try {
      assertPaidGenerationReservation(this.budget, reservation, {
        workspaceId: request.workspaceId, operationKey: request.operationKey, provider: this.provider,
        model: request.model, estimateMicros: request.estimateMicros, currency: request.currency,
      });
    } catch (error) {
      await this.releaseSafely(reservation, '预算凭证与视频请求不一致，未提交供应商请求。');
      throw error;
    }

    let response: unknown;
    try { response = await providerRequestJson(this.config, built); }
    catch (error) {
      if (error instanceof ProviderHttpError) {
        if (error.upstreamStatus >= 400 && error.upstreamStatus < 500
          && error.upstreamStatus !== 408 && error.upstreamStatus !== 429) {
          await this.releaseSafely(reservation, '供应商明确拒绝视频请求，释放预算预留。');
          throw new CommercialVideoError(502, 'VIDEO_PROVIDER_REJECTED', '视频供应商明确拒绝了请求；未重试、未扣费。');
        }
        await this.unknownSafely(reservation, '视频供应商请求结果不明，保留预算预留等待对账。');
        throw new CommercialVideoError(502, 'VIDEO_SUBMISSION_UNCERTAIN', '视频提交结果不明；已保留预算预留，不会自动重发。');
      }
      if (error instanceof CommercialVideoError) {
        await this.unknownSafely(reservation, '视频供应商响应无法确认，保留预算预留等待对账。');
        throw error;
      }
      await this.unknownSafely(reservation, '视频提交发生未知错误，保留预算预留。');
      throw new CommercialVideoError(502, 'VIDEO_SUBMISSION_UNCERTAIN', '视频提交结果不明；未自动重试。');
    }

    let taskId: string | null;
    try { taskId = this.parseTaskId(response); }
    catch {
      await this.unknownSafely(reservation, '供应商返回 2xx 但任务号无法解析，提交结果不明。');
      throw new CommercialVideoError(502, 'VIDEO_TASK_RESPONSE_INVALID', '视频供应商返回了无法验证的任务信息；保留预算预留，不会自动重发。');
    }
    if (!taskId) {
      // A 2xx response without a task ID means the provider may already have
      // accepted work. Keep the hold; an operator must reconcile by account.
      await this.unknownSafely(reservation, '供应商返回 2xx 但没有有效任务号，提交结果不明。');
      throw new CommercialVideoError(502, 'VIDEO_TASK_ID_MISSING', '视频供应商未返回有效任务号；保留预算预留，不会自动重发。');
    }
    try { await this.budget.commit(reservation, request.estimateMicros); }
    catch { throw new CommercialVideoError(503, 'VIDEO_SETTLEMENT_FAILED',
      `视频供应商已接受任务 ${taskId}，但预算结算失败；需要人工对账，不能重提。`); }
    return { provider: this.provider, taskId, model: request.model,
      operationKey: request.operationKey, reservationId: reservation.id, status: 'submitted' };
  }

  private async releaseSafely(reservation: PaidGenerationReservation, reason: string): Promise<void> {
    try { await this.budget.release(reservation, reason); } catch { /* preserve the original provider outcome */ }
  }

  private async unknownSafely(reservation: PaidGenerationReservation, reason: string): Promise<void> {
    try { await this.budget.markUnknown(reservation, reason); } catch { /* operator reconciles; never resubmit */ }
  }
}
