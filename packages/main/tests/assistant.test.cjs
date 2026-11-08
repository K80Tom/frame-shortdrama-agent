const { test } = require('node:test');
const assert = require('node:assert/strict');
const { InMemoryAssistantRepository } = require('@lyra/agent');
const { AssistantOrchestrator } = require('@lyra/agent');
const { AssistantService } = require('@lyra/agent');
const { executeAssistantTool } = require('@lyra/agent');
const { ModelError } = require('@lyra/shared');
const {
  CONVERSATION_CONTEXT_SCHEMA,
  ConversationContextCache,
  RedisConversationContextStore,
  createConversationContextRuntime,
} = require('../dist/infrastructure/conversation-context');

const validRequest = () => ({
  projectId: 'proj_1', scriptVersionId: 'script_1', ratio: '9:16', targetDurationSec: 60,
  visualStyle: '写实电影感', qualityPreset: 'balanced', automationMode: 'auto', candidatePolicy: 'direct',
  candidateLimit: 1, directorPolicy: 'auto', budgetMicros: 30_000_000, currency: 'CNY',
  allowPaid: true, clientRequestId: 'assistant',
});

function brainWith(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    call: async input => {
      calls.push(input);
      const response = responses[Math.min(index++, responses.length - 1)];
      if (response instanceof Error) throw response;
      return { text: typeof response === 'string' ? response : JSON.stringify(response) };
    },
  };
}

function makeService({ responses, ports = {}, production, now, options } = {}) {
  const repository = new InMemoryAssistantRepository(now);
  const brain = brainWith(responses ?? [{ reply: '你好', toolCalls: [], quote: null }]);
  const orchestrator = new AssistantOrchestrator(brain, ports, { createQuote: (_sid, quote) => repository.createQuote(quote) },
    { ...options, ...(now ? { now } : {}) });
  const service = new AssistantService(repository, orchestrator, production, now);
  return { repository, brain, service };
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test('纯问答：事件序列完整，用户与助手消息都落库', async () => {
  const { service, repository } = makeService({ responses: [{ reply: '你好，我是工作台助手。', toolCalls: [], quote: null }] });
  const session = await service.createSession({ label: '全局工作区' });
  assert.equal(session.contextKey, 'global');
  const events = await collect(service.send(session.id, { content: '你好' }));
  assert.equal(events[0].type, 'session');
  assert.equal(events.at(-1).type, 'done');
  const text = events.filter(event => event.type === 'text_delta').map(event => event.delta).join('');
  assert.equal(text, '你好，我是工作台助手。');
  const history = await service.history(session.id);
  assert.deepEqual(history.items.map(item => item.role), ['user', 'assistant']);
  assert.equal(history.items[1].status, 'complete');
});

test('工具调用：先发工具事件，再用真实观察生成最终回答', async () => {
  const { service, brain } = makeService({
    responses: [
      { reply: '我先查一下。', toolCalls: [{ name: 'list_projects', arguments: {} }], quote: null },
      { reply: '你有 2 个项目。', toolCalls: [], quote: null },
    ],
    ports: { listProjects: async () => [{ id: 'proj_1', title: '吞噬星空' }, { id: 'proj_2', title: '赴约' }] },
  });
  const session = await service.createSession({ label: '全局工作区' });
  const events = await collect(service.send(session.id, { content: '我有哪些项目' }));
  assert.equal(events.filter(event => event.type === 'tool_start').length, 1);
  const toolEnd = events.find(event => event.type === 'tool_end');
  assert.equal(toolEnd.isError, false);
  assert.equal(events.at(-1).message.content, '你有 2 个项目。');
  assert.equal(brain.calls.length, 2, '有工具观察时必须进行第二次模型调用');
  const history = await service.history(session.id);
  assert.deepEqual(history.items.map(item => item.role), ['user', 'tool', 'assistant']);
});

test('工具白名单：模型发明的工具名绝不执行', async () => {
  await assert.rejects(() => executeAssistantTool({}, 'drop_all_tables', {}), error => error.code === 'ASSISTANT_TOOL_UNKNOWN');
  const { service } = makeService({
    responses: [
      { reply: '试试。', toolCalls: [{ name: 'delete_everything', arguments: {} }], quote: null },
      { reply: '这个操作不支持。', toolCalls: [], quote: null },
    ],
  });
  const session = await service.createSession({ label: '全局工作区' });
  const events = await collect(service.send(session.id, { content: '删库' }));
  assert.equal(events.find(event => event.type === 'tool_end').isError, true);
  assert.equal(events.at(-1).type, 'done');
});

test('工具观察裁剪：最多返回 20 条，保留总数', async () => {
  const ports = { listProjects: async () => Array.from({ length: 30 }, (_, i) => ({ id: `proj_${i}` })) };
  const result = await executeAssistantTool(ports, 'list_projects', {});
  const observation = JSON.parse(result.observation);
  assert.equal(observation.total, 30);
  assert.equal(observation.items.length, 20);
});

test('估价卡：费用由预算决定、幂等键由服务端重写，确认后冻结提交', async () => {
  const created = [];
  const production = { create: async value => { created.push(value); return { id: 'run_1' }; } };
  const { service } = makeService({
    responses: [{ reply: '已准备估价卡。', toolCalls: [], quote: { summary: '60s 成片', request: validRequest() } }],
    production,
  });
  const session = await service.createSession({ label: '项目 · 吞噬星空', projectId: 'proj_1' });
  const events = await collect(service.send(session.id, { content: '帮我生成 60 秒成片，预算 30 元' }));
  const quoteEvent = events.find(event => event.type === 'generation_quote');
  assert.ok(quoteEvent, '必须生成估价确认卡而不是直接执行');
  assert.equal(quoteEvent.quote.estimateCostMicros, 30_000_000);
  assert.equal(quoteEvent.quote.status, 'pending');
  assert.equal(quoteEvent.quote.request.clientRequestId, `assistant_${quoteEvent.quote.id}`);
  assert.equal(created.length, 0, '建卡阶段绝不能触发付费创建');

  const submitted = await service.submitQuote(session.id, quoteEvent.quote.id);
  assert.equal(submitted.runId, 'run_1');
  assert.equal(created.length, 1);
  assert.equal(created[0].budgetMicros, 30_000_000);
  const again = await service.submitQuote(session.id, quoteEvent.quote.id);
  assert.equal(again.runId, 'run_1');
  assert.equal(created.length, 1, '重复确认必须幂等，不得重复扣费');
});

test('估价卡过期：拒绝提交并落 expired 状态', async () => {
  let now = new Date('2026-11-01T00:00:00Z');
  const clock = () => now;
  const { service, repository } = makeService({
    responses: [{ reply: '已准备估价卡。', toolCalls: [], quote: { summary: '60s 成片', request: validRequest() } }],
    production: { create: async () => ({ id: 'run_1' }) }, now: clock,
  });
  const session = await service.createSession({ label: '全局工作区' });
  const events = await collect(service.send(session.id, { content: '生成成片' }));
  const quote = events.find(event => event.type === 'generation_quote').quote;
  now = new Date(now.getTime() + 16 * 60 * 1000);
  await assert.rejects(() => service.submitQuote(session.id, quote.id), error => error.code === 'ASSISTANT_QUOTE_EXPIRED');
  assert.equal((await repository.getQuote(session.id, quote.id)).status, 'expired');
});

test('预算护栏：超额请求不建卡、不付费，只返回人话错误', async () => {
  const created = [];
  const request = { ...validRequest(), budgetMicros: 60_000_000 };
  const { service } = makeService({
    responses: [{ reply: '好。', toolCalls: [], quote: { summary: '大预算成片', request } }],
    production: { create: async value => { created.push(value); return { id: 'run_1' }; } },
  });
  const session = await service.createSession({ label: '全局工作区' });
  const events = await collect(service.send(session.id, { content: '预算 60 元生成' }));
  assert.equal(events.some(event => event.type === 'generation_quote'), false);
  assert.equal(events.find(event => event.type === 'error').code, 'ASSISTANT_QUOTE_BUDGET_EXCEEDED');
  assert.equal(created.length, 0);
  assert.equal(events.at(-1).message.status, 'failed');
});

test('非法估价请求：字段不完整直接拒绝，不静默修补', async () => {
  const { service } = makeService({
    responses: [{ reply: '好。', toolCalls: [], quote: { summary: '残缺请求', request: { projectId: 'proj_1' } } }],
  });
  const session = await service.createSession({ label: '全局工作区' });
  const events = await collect(service.send(session.id, { content: '生成成片' }));
  assert.equal(events.find(event => event.type === 'error').code, 'ASSISTANT_QUOTE_INVALID');
  assert.equal(events.some(event => event.type === 'generation_quote'), false);
});

test('模型不可用：如实失败，不生成任何模拟回答', async () => {
  const { service } = makeService({ responses: [new ModelError(503, 'MODEL_NOT_CONFIGURED', '模型服务尚未配置。')] });
  const session = await service.createSession({ label: '全局工作区' });
  const events = await collect(service.send(session.id, { content: '你好' }));
  assert.equal(events.find(event => event.type === 'error').code, 'MODEL_NOT_CONFIGURED');
  assert.equal(events.filter(event => event.type === 'text_delta').length, 0);
  assert.equal(events.at(-1).message.status, 'failed');
});

test('输入校验：空消息与非法会话 ID 被拒绝', async () => {
  const { service } = makeService();
  const session = await service.createSession({ label: '全局工作区' });
  await assert.rejects(async () => collect(service.send(session.id, { content: '   ' })),
    error => error.code === 'ASSISTANT_MESSAGE_EMPTY');
  await assert.rejects(() => service.history('not a valid id'), error => error.code === 'ASSISTANT_SESSION_NOT_FOUND');
});

test('Redis conversation snapshots are tenant scoped, version guarded and rebuildable from PostgreSQL', async () => {
  const values = new Map();
  const client = {
    async get(key) { return values.get(key) ?? null; },
    async del(key) { return values.delete(key) ? 1 : 0; },
    async eval(_script, { keys, arguments: args }) {
      const existing = values.get(keys[0]);
      if (existing && JSON.parse(existing).version > Number(args[0])) return 0;
      values.set(keys[0], args[1]); return 1;
    },
  };
  const scope = { workspaceId: `ws_${'4'.repeat(32)}` };
  const other = { workspaceId: `ws_${'5'.repeat(32)}` };
  const store = new RedisConversationContextStore(client);
  const snapshot = version => ({ schemaVersion: CONVERSATION_CONTEXT_SCHEMA, workspaceId: scope.workspaceId,
    sessionId: 'asst_context', version, messages: [{ role: 'user', content: `v${version}` }],
    tokenCount: version, createdAt: '2026-11-08T00:00:00.000Z' });
  assert.equal(await store.put(snapshot(2), 300), true);
  assert.equal(await store.put(snapshot(1), 300), false, 'an older worker must not replace a newer snapshot');
  assert.equal((await store.get(scope, 'asst_context')).version, 2);
  assert.equal(await store.get(other, 'asst_context'), null);

  const unavailable = { async get() { throw new Error('redis down'); }, async put() { throw new Error('redis down'); },
    async delete() {} };
  const cache = new ConversationContextCache(unavailable, 300);
  let postgresReads = 0;
  const rebuilt = await cache.readThrough(scope, 'asst_context', 3, async () => {
    postgresReads++; return snapshot(3);
  });
  assert.equal(rebuilt.version, 3);
  assert.equal(postgresReads, 1);
});

test('conversation runtime is PG-only by default and connects Redis only when explicitly configured', async () => {
  const local = await createConversationContextRuntime({});
  assert.equal(local.mode, 'noop');
  await local.close();

  let connected = 0; let closed = 0; let errorListener = 0;
  const client = {
    async get() { return null; }, async del() { return 0; }, async eval() { return 1; },
    async connect() { connected++; }, async quit() { closed++; },
    on(event) { if (event === 'error') errorListener++; },
  };
  const runtime = await createConversationContextRuntime({ REDIS_URL: 'redis://:secret@redis:6379',
    REDIS_HOST_ALLOWLIST: 'redis', CONVERSATION_CONTEXT_TTL_SECONDS: '300' }, {
    redisModule: { createClient() { return client; } },
  });
  assert.equal(runtime.mode, 'redis');
  assert.equal(connected, 1);
  assert.equal(errorListener, 1);
  await runtime.close();
  assert.equal(closed, 1);
});
