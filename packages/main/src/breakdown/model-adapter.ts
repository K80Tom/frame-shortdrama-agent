import type { AppConfig } from "../config";
import { ModelClient } from "../models/client";
import { configForRole } from "../models/connections";
import type { ResolvedModelConfig } from "./repository";
import { BreakdownError } from "./errors";
import type { StageModelAdapter } from "./execution";

export class MaasStageModelAdapter implements StageModelAdapter {
  private readonly client: ModelClient;

  constructor(private readonly config: AppConfig, private readonly transport: typeof fetch = fetch) {
    this.client = new ModelClient(config, transport);
  }

  forRun(input: ResolvedModelConfig): StageModelAdapter {
    const config = configForRole(this.config, 'breakdown');
    if (input.model !== config.defaultModel || input.provider !== config.provider || input.reasoningEffort !== config.reasoningEffort
      || (input.connectionRevision ? input.connectionRevision !== config.connectionRevision
        : config.connectionRevision && config.connectionRevision !== 'environment-v1')) {
      throw new BreakdownError(409, 'MODEL_CONFIGURATION_CHANGED', '拆解模型连接已修改，请新建 Run；历史结果仍可校对。');
    }
    return new MaasStageModelAdapter(config, this.transport);
  }

  assertConfigured(): void { this.client.assertConfigured(); }

  async call(input: Parameters<StageModelAdapter["call"]>[0]) {
    const payload = input.payload as Record<string, unknown>;
    if (payload.operation !== "extractFacts" || typeof payload.systemPrompt !== "string") {
      throw new BreakdownError(400, "STAGE_PAYLOAD_INVALID", "事实拆解请求无效。");
    }
    const messages = payload.messages;
    if (!Array.isArray(messages) || messages.length !== 1 || messages[0]?.role !== "user"
      || typeof messages[0]?.content !== "string") {
      throw new BreakdownError(400, "STAGE_PAYLOAD_INVALID", "事实拆解上下文无效。");
    }
    const result = await this.client.call({
      model: input.model,
      messages: [{ role: "system", content: payload.systemPrompt }, messages[0]],
      ...(input.reasoningEffort !== "model-default" ? { reasoningEffort: input.reasoningEffort } : {}),
      // Mirrors the novel chain: upstream reasoning once drained the whole
      // output budget, so MAAS thinking is disabled for the bounded call.
      thinking: "disabled",
      maxOutputTokens: input.maxOutputTokens,
      allowPaid: true,
    });
    if (result.status !== "completed") {
      throw new BreakdownError(422, "MODEL_OUTPUT_INCOMPLETE", "模型输出达到额度上限，请调整剧本长度或输出额度后重试。");
    }
    let output: unknown;
    try { output = JSON.parse(result.text.trim()); }
    catch { throw new BreakdownError(422, "MODEL_OUTPUT_NOT_JSON", "模型没有返回 JSON 事实拆解结果。"); }
    return {
      output,
      providerRequestId: result.providerRequestId,
      usage: {
        ...(result.usage.inputTokens !== null ? { inputTokens: result.usage.inputTokens } : {}),
        ...(result.usage.outputTokens !== null ? { outputTokens: result.usage.outputTokens } : {}),
        ...(result.usage.totalTokens !== null ? { totalTokens: result.usage.totalTokens } : {}),
      },
    };
  }
}
