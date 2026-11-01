import { BreakdownError } from './errors';

// The HTTP app is CommonJS while Pi Agent Core is ESM. Import targets are
// constants, never user or model supplied values.
const importEsm = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<unknown>;

/** Run one bounded JSON-producing Pi turn, with the caller owning transport and accounting. */
export async function runPiJsonAgent(input: {
  systemPrompt: string;
  prompt: unknown;
  invoke: (systemPrompt: string, userText: string) => Promise<unknown>;
}): Promise<unknown> {
  const [{ Agent }, { createAssistantMessageEventStream }] = await Promise.all([
    importEsm('@earendil-works/pi-agent-core') as Promise<typeof import('@earendil-works/pi-agent-core')>,
    importEsm('@earendil-works/pi-ai') as Promise<typeof import('@earendil-works/pi-ai')>,
  ]);
  let modelFailure: unknown;
  const agent = new Agent({
    initialState: { systemPrompt: input.systemPrompt, tools: [] },
    streamFn: (piModel, piContext) => {
      const stream = createAssistantMessageEventStream();
      const blank = () => ({ role: 'assistant' as const, content: [], api: piModel.api,
        provider: piModel.provider, model: piModel.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
          totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop' as const, timestamp: Date.now() });
      stream.push({ type: 'start', partial: blank() });
      void (async () => {
        try {
          const userText = piContext.messages.filter(message => message.role === 'user')
            .map(message => typeof message.content === 'string' ? message.content
              : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'))
            .join('\n');
          const output = await input.invoke(piContext.systemPrompt ?? input.systemPrompt, userText);
          const message = { ...blank(), content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
          stream.push({ type: 'done', reason: 'stop', message });
        } catch (error) {
          modelFailure = error;
          const message = { ...blank(), stopReason: 'error' as const, errorMessage: '模型调用失败。' };
          stream.push({ type: 'error', reason: 'error', error: message });
        }
      })();
      return stream;
    },
  });
  await agent.prompt(JSON.stringify(input.prompt));
  if (modelFailure) throw modelFailure;
  const last = agent.state.messages.at(-1);
  if (last?.role !== 'assistant' || last.stopReason !== 'stop') {
    throw new BreakdownError(502, 'PI_AGENT_FAILED', 'Agent 未返回完整结果。');
  }
  const text = last.content.filter(block => block.type === 'text').map(block => block.text).join('');
  try { return JSON.parse(text); }
  catch { throw new BreakdownError(422, 'PI_AGENT_OUTPUT_INVALID', 'Agent 输出不是有效 JSON。'); }
}
