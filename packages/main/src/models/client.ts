import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config';
import { ModelError, parseCall } from '@ohao/shared';
import { configuredModel } from './registry';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safeString = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:()\/-]{1,160}$/.test(value) ? value : null;
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ModelError(502, 'INVALID_UPSTREAM_RESPONSE', '模型返回空响应。');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new ModelError(502, 'UPSTREAM_RESPONSE_TOO_LARGE', '模型响应超过本项目限制。');
      }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ModelError(502, 'INVALID_UPSTREAM_RESPONSE', '模型没有返回有效 JSON；请检查模型服务。'); }
}

// Independent of Nest/HTTP: future task workers can call this same bounded adapter.
export class ModelClient {
  private readonly localBudget = { active: 0 };
  constructor(private readonly config: AppConfig, private readonly transport: typeof fetch = fetch) {}

  assertConfigured(): void {
    if (!(this.config.endpointUrl || this.config.baseUrl) || !this.config.apiKey || !this.config.defaultModel) {
      throw new ModelError(503, 'MODEL_NOT_CONFIGURED', '模型服务尚未配置；请在服务端配置新的 HTTPS 地址与 API key。现有项目仍可人工校对和保存。');
    }
  }

  async call(input: unknown) {
    const request = parseCall(input);
    this.assertConfigured();
    if (this.config.connectionRevision && request.model && request.model !== this.config.defaultModel) {
      throw new ModelError(400, 'UNKNOWN_MODEL', '请求的模型与当前用途配置不一致；请在模型连接页修改。');
    }
    const model = configuredModel(request.model ?? this.config.defaultModel, this.config.defaultModel);
    if (!model) throw new ModelError(400, 'UNKNOWN_MODEL', '未配置此模型，请从 /api/models 选择。');
    const effort = request.reasoningEffort ?? this.config.reasoningEffort;
    if (!model.reasoningEfforts.includes(effort)) throw new ModelError(400, 'EFFORT_UNSUPPORTED', '所选模型不支持此推理档位。');
    const budget = this.config.callBudget ?? this.localBudget;
    if (budget.active >= this.config.maxConcurrentCalls) throw new ModelError(429, 'LOCAL_BUSY', '本机并发额度已满；未发出此次模型请求。');
    const callId = randomUUID();
    const started = performance.now();
    const signal = AbortSignal.timeout(this.config.timeoutMs);
    budget.active++;
    try {
      const response = await this.transport(this.config.endpointUrl ?? `${this.config.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          ...(this.config.authType === 'bearer' ? { Authorization: `Bearer ${this.config.apiKey}` } : { 'api-key': this.config.apiKey }) }, redirect: 'error', signal,
        body: JSON.stringify({ model: model.id, messages: request.messages.map(message =>
          typeof message.content === 'string' ? message : { role: message.role, content: message.content.map(part =>
            part.type === 'text' ? { type: 'text', text: part.text }
              : { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` } }) }), stream: false,
          ...(request.thinking && this.config.provider === 'maas' ? { thinking: { type: request.thinking } } : {}),
          ...(request.jsonOutput ? { response_format: { type: 'json_object' } } : {}),
          max_tokens: Math.min(request.maxOutputTokens ?? this.config.maxOutputTokens, this.config.maxOutputTokens) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const hints: Record<number, string> = {
          400: '上游拒绝参数或输入，请检查模型能力与输出额度。',
          401: '请检查服务端配置的模型 API key。',
          403: '上游权限或资源受限，请联系维护方；不要尝试绕过限制。',
          404: '上游模型或接口不可用。', 429: '上游限流或额度不足。',
        };
        throw new ModelError(502, 'UPSTREAM_ERROR', hints[response.status] ?? '上游服务失败，请检查模型服务。', { upstreamStatus: response.status });
      }
      const payload = record(await readJson(response));
      const choices = payload.choices;
      if (payload.error || !Array.isArray(choices) || choices.length !== 1) {
        throw new ModelError(502, 'INVALID_UPSTREAM_RESPONSE', '模型响应结构异常。');
      }
      const choice = record(choices[0]);
      const message = record(choice.message);
      const finishReason = choice.finish_reason;
      const usage = record(payload.usage);
      const usageSummary = { inputTokens: count(usage.prompt_tokens), outputTokens: count(usage.completion_tokens),
        totalTokens: count(usage.total_tokens), reasoningTokens: count(record(usage.completion_tokens_details).reasoning_tokens) };
      if (finishReason !== 'stop' && finishReason !== 'length') {
        throw new ModelError(502, 'UNEXPECTED_FINISH', '模型未返回普通文本结果；未执行任何工具或重试。', { usage: usageSummary });
      }
      if (typeof message.content !== 'string' || !message.content.trim()) {
        throw new ModelError(502, 'EMPTY_OUTPUT', '模型没有可见文本，可能已耗尽推理预算；未自动重试。', { finishReason, usage: usageSummary });
      }
      return { callId, requestedModel: model.id, reportedModel: safeString(payload.model),
        providerRequestId: safeString(payload.id), text: message.content, reasoningEffort: effort,
        status: finishReason === 'length' ? 'incomplete' : 'completed', finishReason,
        usage: usageSummary, durationMs: Math.round(performance.now() - started),
        warnings: finishReason === 'length' ? ['输出达到额度上限，结果不完整；未自动续写。'] : [] };
    } catch (error) {
      if (error instanceof ModelError) throw new ModelError(error.status, error.code, error.message, { ...error.details, callId });
      if (signal.aborted) throw new ModelError(504, 'UPSTREAM_TIMEOUT', '等待模型超时；上游可能仍执行或已计费，未自动重试。', { callId });
      throw new ModelError(502, 'PROXY_UNAVAILABLE', '无法完成模型请求，请检查服务配置与网络；结果可能未知，未自动重试。', { callId });
    } finally { budget.active--; }
  }
}
