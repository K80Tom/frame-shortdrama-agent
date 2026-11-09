import { parseCreateProductionRun } from '@lyra/shared';
import {
  AssistantError, newAssistantId, type AssistantContextSnapshot, type AssistantEvent, type AssistantMessage,
  type AssistantQuote, type AssistantSession,
} from './contracts';
import { ASSISTANT_TOOLS, executeAssistantTool, type AssistantToolPorts } from './tools';

export interface AssistantBrain {
  call(input: unknown): Promise<{ text: string; status?: string }>;
}

export interface AssistantQuoteDraft {
  summary: string;
  request: Record<string, unknown>;
}

interface Decision {
  reply: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  quote: AssistantQuoteDraft | null;
}

export interface AssistantOrchestratorOptions {
  /** 单张估价卡允许的最高预算（CNY micros）。超出的一律拒绝建卡，引导去页面人工创建。 */
  maxQuoteBudgetMicros?: number;
  quoteTtlMs?: number;
  maxToolCalls?: number;
  now?: () => Date;
}

const DEFAULT_MAX_QUOTE_BUDGET = 50_000_000; // 50 元
const DEFAULT_QUOTE_TTL_MS = 15 * 60 * 1000;
const MAX_TOOL_CALLS = 2;
const MAX_HISTORY_MESSAGES = 12;

/**
 * 冻结的助手估价价格表。估价不是预算：预算由用户给定，估价由服务端按
 * 时长与候选数推算，二者在确认卡上分开显示。供应商接入后替换此 revision。
 */
const ASSISTANT_PRICE_REVISION = 'assistant-price/2026-11';
const ESTIMATE_BASE_MICROS = 2_000_000;
const ESTIMATE_SECOND_MICROS = 150_000;
const ESTIMATE_CANDIDATE_MICROS = 4_000_000;

export function estimateProductionMicros(targetDurationSec: number, candidateLimit: number): {
  estimateMicros: number; range: { lowMicros: number; highMicros: number };
  durationSec: number; breakdown: Array<{ label: string; amountMicros: number; note?: string }>;
} {
  const seconds = Math.max(15, Math.min(900, targetDurationSec));
  const baseMicros = ESTIMATE_BASE_MICROS;
  const durationMicros = Math.round(ESTIMATE_SECOND_MICROS * seconds);
  const candidateMicros = Math.max(0, candidateLimit - 1) * ESTIMATE_CANDIDATE_MICROS;
  const estimateMicros = Math.round(baseMicros + durationMicros + candidateMicros);
  // 仅供确认卡展示的离线耗时推算：编排 + 每 1.5 秒成片 1 秒渲染 + 每个候选 20 秒。
  const durationSec = Math.round(30 + seconds * 1.5 + Math.max(0, candidateLimit - 1) * 20);
  return {
    estimateMicros,
    range: { lowMicros: Math.round(estimateMicros * 0.82), highMicros: Math.round(estimateMicros * 1.28) },
    durationSec,
    breakdown: [
      { label: '编排与质检', amountMicros: baseMicros, note: '拆解、分镜与流程编排' },
      { label: `成片渲染 ${seconds}s`, amountMicros: durationMicros, note: '按冻结价格表每秒单价' },
      ...(candidateMicros > 0
        ? [{ label: `额外候选 ${candidateLimit - 1} 个`, amountMicros: candidateMicros, note: '每个候选的抽卡成本' }]
        : []),
    ],
  };
}

const CREATE_RUN_SHAPE = `{
  "projectId": "项目ID", "scriptVersionId": "剧本版本ID", "ratio": "9:16",
  "targetDurationSec": 60, "visualStyle": "画面风格", "qualityPreset": "balanced",
  "automationMode": "auto", "candidatePolicy": "direct", "candidateLimit": 1,
  "directorPolicy": "auto", "budgetMicros": 30000000, "currency": "CNY",
  "allowPaid": true, "clientRequestId": "assistant"
}
枚举约束：ratio=9:16|16:9；qualityPreset=fast|balanced|quality；automationMode=auto|checkpoints|coDirector；
candidatePolicy=direct|gacha（direct 时 candidateLimit 必须为 1，gacha 时为 2-4）；directorPolicy=auto|always|never；
targetDurationSec 为 15-900 的整数；budgetMicros 为整数（元×1000000）。
只允许上述 14 个字段，不要添加任何额外字段。`;

function systemPrompt(): string {
  return `你是 Lyra 短剧工作台的 AI 助手，运行在本机，帮助用户了解项目、自动制片运行与资产状态，并在用户明确要求时发起付费生产的估价确认。

铁律：
1. 你只能使用下列白名单工具查询真实数据，不得编造项目、运行、资产或费用信息；查不到就如实说不知道。
2. 任何付费、生成、提交类操作都不能由你执行。你只能按 quote 形式给出「估价确认卡」提议，由用户在界面上确认后才真正提交。不得声称已经创建、提交或生成成功。
3. 用户只是闲聊或询问概念时，直接回答，不要调用工具。
4. 只输出严格 JSON，不要 Markdown、不要解释。

可用工具：
${ASSISTANT_TOOLS.map(tool => `- ${tool.name}：${tool.description}${tool.argument ? `（参数 ${tool.argument.name}${tool.argument.required ? '，必填' : '，可选'}）` : ''}`).join('\n')}

输出结构：
{
  "reply": "给用户看的中文回答；若需要工具结果才能回答，这里写一句简短的过渡语",
  "toolCalls": [{"name": "工具名", "arguments": {}}],
  "quote": null
}

当且仅当用户明确要求创建自动制片运行/开始生成成片时，quote 改为：
{ "summary": "这次生产要做什么、预计花费多少（元）", "request": ${CREATE_RUN_SHAPE} }
estimateCostMicros 不需要你填写，服务端会以 request.budgetMicros 为准。
信息不足（例如不知道 projectId 或 scriptVersionId）时，不要猜：先用工具查询，或在 reply 里向用户追问，quote 保持 null。`;
}

function extractJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith('```') ? trimmed.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim() : trimmed;
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new AssistantError(502, 'ASSISTANT_DECISION_INVALID', '助手没有返回有效的决策结构，请重试。');
  }
  try {
    const value: unknown = JSON.parse(unfenced.slice(start, end + 1));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value as Record<string, unknown>;
  } catch {
    throw new AssistantError(502, 'ASSISTANT_DECISION_INVALID', '助手决策不是有效 JSON，请重试。');
  }
}

function parseDecision(text: string): Decision {
  const raw = extractJson(text);
  const reply = typeof raw.reply === 'string' ? raw.reply : '';
  const toolCalls: Decision['toolCalls'] = [];
  if (Array.isArray(raw.toolCalls)) {
    for (const item of raw.toolCalls) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const call = item as Record<string, unknown>;
      if (typeof call.name !== 'string' || !call.name) continue;
      const args = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
        ? call.arguments as Record<string, unknown> : {};
      toolCalls.push({ name: call.name, arguments: args });
    }
  }
  let quote: AssistantQuoteDraft | null = null;
  if (raw.quote && typeof raw.quote === 'object' && !Array.isArray(raw.quote)) {
    const value = raw.quote as Record<string, unknown>;
    if (value.request && typeof value.request === 'object' && !Array.isArray(value.request)) {
      quote = {
        summary: typeof value.summary === 'string' && value.summary.trim() ? value.summary.trim().slice(0, 300) : '自动制片运行',
        request: value.request as Record<string, unknown>,
      };
    }
  }
  return { reply, toolCalls, quote };
}

function historyMessages(session: AssistantSession, history: AssistantMessage[], content: string,
  snapshot?: AssistantContextSnapshot) {
  const past = history
    .filter(message => message.role === 'user' || (message.role === 'assistant' && message.status === 'complete'))
    .slice(-MAX_HISTORY_MESSAGES)
    .map(message => ({ role: message.role, content: message.content.slice(0, 2000) }));
  const facts = snapshot
    ? `后端上下文快照（只读，以此为准）：${JSON.stringify({
      projectId: snapshot.projectId ?? null, projectTitle: snapshot.projectTitle ?? null,
      scriptVersionId: snapshot.scriptVersionId ?? null,
      storyboardRevisionId: snapshot.storyboardRevisionId ?? null,
      productionRunIds: snapshot.productionRunIds.slice(0, 5), canvasId: snapshot.canvasId ?? null,
    })}。不要编造快照里没有的 ID。`
    : '本次没有可用的后端上下文快照；涉及具体 ID 时必须先查询，不要猜测。';
  return [
    { role: 'system', content: systemPrompt() },
    { role: 'system', content: `当前界面上下文：${session.context.label}。projectId=${session.context.projectId ?? '无'}，runId=${session.context.runId ?? '无'}。${facts}` },
    ...past,
    { role: 'user', content },
  ];
}

/** 把完整回答分段下发。上游模型当前为非流式调用；这里只切分已完成的文本，不伪造思考过程。 */
function* deltas(text: string, size = 48): Generator<string> {
  for (let index = 0; index < text.length; index += size) yield text.slice(index, index + size);
}

export class AssistantOrchestrator {
  private readonly maxQuoteBudgetMicros: number;
  private readonly quoteTtlMs: number;
  private readonly maxToolCalls: number;
  private readonly now: () => Date;

  constructor(
    private readonly brain: AssistantBrain,
    private readonly ports: AssistantToolPorts,
    private readonly hooks: { createQuote(sessionId: string, quote: Omit<AssistantQuote, 'createdAt'>): Promise<AssistantQuote> },
    options: AssistantOrchestratorOptions = {},
  ) {
    this.maxQuoteBudgetMicros = options.maxQuoteBudgetMicros ?? DEFAULT_MAX_QUOTE_BUDGET;
    this.quoteTtlMs = options.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
    this.maxToolCalls = options.maxToolCalls ?? MAX_TOOL_CALLS;
    this.now = options.now ?? (() => new Date());
  }

  async decide(session: AssistantSession, history: AssistantMessage[], content: string,
    snapshot?: AssistantContextSnapshot): Promise<Decision> {
    const response = await this.brain.call({
      messages: historyMessages(session, history, content, snapshot), jsonOutput: true, maxOutputTokens: 2200,
    });
    return parseDecision(response.text);
  }

  private async finalize(session: AssistantSession, history: AssistantMessage[], content: string,
    decision: Decision, observations: Array<{ name: string; observation: string }>,
    snapshot?: AssistantContextSnapshot): Promise<string> {
    if (!observations.length) return decision.reply.trim();
    const response = await this.brain.call({
      messages: [
        ...historyMessages(session, history, content, snapshot),
        { role: 'assistant', content: JSON.stringify({ reply: decision.reply, toolCalls: decision.toolCalls, quote: null }) },
        { role: 'user', content: `以下是工具真实返回的观察结果（JSON），请据此用中文回答用户最初的问题；不要编造观察里没有的信息，不要再次调用工具。\n${observations.map(item => `【${item.name}】${item.observation}`).join('\n')}` },
      ],
      jsonOutput: true, maxOutputTokens: 2200,
    });
    const final = parseDecision(response.text);
    return (final.reply || decision.reply).trim();
  }

  private async buildQuote(session: AssistantSession, draft: AssistantQuoteDraft): Promise<AssistantQuote> {
    // 服务端重新校验冻结请求；模型给的字段不合法就拒绝建卡，不静默修补。
    let parsed: ReturnType<typeof parseCreateProductionRun>;
    try {
      parsed = parseCreateProductionRun(draft.request);
    } catch {
      throw new AssistantError(400, 'ASSISTANT_QUOTE_INVALID',
        '生成估价卡所需的信息不完整或不合法。请补充项目、剧本版本、目标时长与预算后再试。');
    }
    if (parsed.budgetMicros > this.maxQuoteBudgetMicros) {
      throw new AssistantError(400, 'ASSISTANT_QUOTE_BUDGET_EXCEEDED',
        `对话内估价卡最高支持 ${this.maxQuoteBudgetMicros / 1_000_000} 元预算；更高预算请在自动制片页面人工创建。`);
    }
    const id = newAssistantId('quote');
    // 幂等键由服务端生成；费用以预算为上限，不信任模型自报金额。
    const request = { ...parsed, clientRequestId: `assistant_${id}` } as unknown as Record<string, unknown>;
    const estimate = estimateProductionMicros(parsed.targetDurationSec, parsed.candidateLimit);
    if (parsed.budgetMicros < estimate.estimateMicros) {
      throw new AssistantError(400, 'ASSISTANT_QUOTE_BUDGET_TOO_LOW',
        `预算 ${parsed.budgetMicros / 1_000_000} 元低于系统估价 ${estimate.estimateMicros / 1_000_000} 元。`
        + '请提高预算，或缩短成片时长后重试。');
    }
    return this.hooks.createQuote(session.id, {
      id, sessionId: session.id, kind: 'production_run', request,
      summary: draft.summary,
      estimateCostMicros: estimate.estimateMicros,
      estimateRangeMicros: estimate.range,
      estimatedDurationSec: estimate.durationSec,
      costBreakdown: estimate.breakdown,
      budgetMicros: parsed.budgetMicros,
      priceRevision: ASSISTANT_PRICE_REVISION,
      assumptions: [
        `按 ${parsed.targetDurationSec} 秒成片、${parsed.candidateLimit} 个候选估算`,
        `质量档位 ${parsed.qualityPreset}，自动化模式 ${parsed.automationMode}`,
        '估价为离线价格表推算，不含人工复剪；提交后以生产运行冻结预算为准',
      ],
      currency: parsed.currency,
      status: 'pending', expiresAt: new Date(this.now().getTime() + this.quoteTtlMs).toISOString(),
    });
  }

  async *respond(session: AssistantSession, history: AssistantMessage[], content: string,
    turn: { turnId: string; context?: AssistantContextSnapshot }): AsyncGenerator<AssistantEvent> {
    const turnId = turn.turnId;
    const snapshot = turn.context;
    const decision = await this.decide(session, history, content, snapshot);
    const observations: Array<{ name: string; observation: string }> = [];
    for (const call of decision.toolCalls.slice(0, this.maxToolCalls)) {
      const callId = newAssistantId('call');
      // 先“提议”再执行：前端可先展示待执行工具，而不是执行后才出现。
      yield { type: 'tool.proposed', turnId, callId, toolName: call.name, arguments: call.arguments };
      yield { type: 'tool_start', toolName: call.name, turnId, callId };
      try {
        const result = await executeAssistantTool(this.ports, call.name, call.arguments);
        observations.push({ name: call.name, observation: result.observation });
        yield { type: 'tool_end', toolName: call.name, isError: false, summary: '查询完成', turnId, callId };
      } catch (error) {
        const message = error instanceof AssistantError ? error.message : '工具查询失败，请稍后重试。';
        observations.push({ name: call.name, observation: `查询失败：${message}` });
        yield { type: 'tool_end', toolName: call.name, isError: true, summary: message, turnId, callId };
      }
    }
    if (decision.quote) {
      const quote = await this.buildQuote(session, decision.quote);
      yield { type: 'generation_quote', quote, turnId };
      // 需要人工确认：建卡不扣费，只有确认后才调用付费提交。
      yield { type: 'confirmation.required', quote, turnId };
    }
    const reply = await this.finalize(session, history, content, decision, observations, snapshot);
    for (const delta of deltas(reply || '好的。')) {
      yield { type: 'model.delta', turnId, delta };
      // 兼容旧事件名；前端只消费其中一种，避免重复拼接。
      yield { type: 'text_delta', delta, turnId };
    }
  }
}
