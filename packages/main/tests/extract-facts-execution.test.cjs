const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../dist/config');
const { InMemoryBreakdownRepository } = require('../dist/breakdown/repository');
const { BreakdownService } = require('../dist/breakdown/service');
const { MaasStageModelAdapter } = require('../dist/breakdown/model-adapter');
const { PiExtractFactsStageExecutor } = require('../dist/breakdown/pi-executor');
const {
  ExtractFactsStageRunner,
  SingleModelCallExtractFactsExecutor,
  resolveAliasedExtractFactsCandidate,
} = require('../dist/breakdown/execution');

const config = readConfig({ LLM_BASE_URL: 'https://model.test/openai', LLM_API_KEY: 'test-only-api-key' });

function fixture(options = {}) {
  let ordinal = 0;
  let tick = 0;
  const repository = new InMemoryBreakdownRepository();
  const now = () => new Date(Date.parse('2026-10-01T13:00:00.000Z') + tick++ * 1000);
  const nextId = (prefix) => `${prefix}_${String(++ordinal).padStart(4, '0')}`;
  const service = new BreakdownService(repository, config, { now, nextId });
  const runner = new ExtractFactsStageRunner(
    repository,
    service,
    options.executor ?? new SingleModelCallExtractFactsExecutor(),
    options.adapter,
    { now, nextId, targetEstimatedTokens: options.targetEstimatedTokens ?? 4000 },
  );
  return { repository, service, runner };
}

async function prepared(service, rawText = [
  '第1场 医院走廊 夜 内',
  '林晚推门进入。',
  '林晚：你终于来了。🙂',
  '顾沉：我知道。',
].join('\n')) {
  const project = await service.createProject({ title: 'P0.4 执行测试' });
  const script = await service.createScriptVersion(project.id, { rawText });
  const run = await service.createDraftRun(project.id, {
    requirements: { language: '中文', visualStyle: '真人拟真', aspectRatio: '9:16' },
    maxModelCalls: 1,
    maxOutputTokens: 4096,
  });
  return { project, script, run };
}

function allEvidence(context) {
  return context.chunks.flatMap((chunk) => chunk.evidence.map((entry) => ({
    ...entry,
    chunkId: chunk.id,
  })));
}

function pointer(context, quote, role = 'primary') {
  const found = allEvidence(context).find((entry) => entry.quote === quote && entry.role === role);
  assert.ok(found, `missing ${role} evidence: ${quote}`);
  return { chunkId: found.chunkId, alias: found.alias };
}

function aliasedCandidate(context) {
  const heading = pointer(context, '第1场 医院走廊 夜 内');
  const action = pointer(context, '林晚推门进入。');
  const linLine = pointer(context, '林晚：你终于来了。🙂');
  const guLine = pointer(context, '顾沉：我知道。');
  const sourced = (value, evidence) => ({ value, evidence });
  return {
    synopsis: sourced('林晚进入医院走廊，与顾沉交谈。', [heading, action, linLine, guLine]),
    characters: [
      { tempId: 'tmp_lin', name: sourced('林晚', [linLine]), aliases: [], description: null, evidence: [action, linLine] },
      { tempId: 'tmp_gu', name: sourced('顾沉', [guLine]), aliases: [], description: null, evidence: [guLine] },
    ],
    locations: [
      { tempId: 'tmp_hall', name: sourced('医院走廊', [heading]), aliases: [], description: null, evidence: [heading] },
    ],
    props: [],
    scenes: [{
      tempId: 'tmp_scene', order: 1, title: sourced('医院走廊相见', [heading, action]),
      locationTempId: 'tmp_hall', characterTempIds: ['tmp_lin', 'tmp_gu'],
      evidence: [heading, action, linLine, guLine], timeOfDay: sourced('夜', [heading]),
    }],
    dialogues: [
      {
        tempId: 'tmp_d1', sceneTempId: 'tmp_scene', speakerTempId: 'tmp_lin',
        speakerEvidence: [linLine], source: { evidence: linLine, quote: '你终于来了。🙂' },
      },
      {
        tempId: 'tmp_d2', sceneTempId: 'tmp_scene', speakerTempId: 'tmp_gu',
        speakerEvidence: [guLine], source: { evidence: guLine, quote: '我知道。' },
      },
    ],
  };
}

test('P0.4 executes one recorded model call, resolves aliases and waits for candidate review', async () => {
  let captured;
  const adapter = {
    async call(input) {
      captured = input;
      return {
        providerRequestId: 'fake-request-001',
        usage: { inputTokens: 120, outputTokens: 80, totalTokens: 200 },
        output: aliasedCandidate(input.payload.context),
      };
    },
  };
  const { repository, service, runner } = fixture({ adapter });
  const { project, run } = await prepared(service);
  const result = await runner.run(run.id);

  assert.equal(captured.model, run.modelConfig.model);
  assert.equal(captured.payload.promptVersion, 'extract-facts-prompt/3');
  assert.equal(captured.payload.context.schemaVersion, 'extract-facts-context/1');
  assert.equal(result.plan.attemptId, result.execution.attempt.id);
  assert.equal(result.plan.content.dialogues[0].sourceRef.quote, '你终于来了。🙂');
  assert.equal(result.execution.attempt.status, 'succeeded');
  assert.equal(result.execution.attempt.outputPlanRevisionId, result.plan.id);
  assert.equal(result.execution.modelCalls.length, 1);
  assert.equal(result.execution.modelCalls[0].status, 'succeeded');
  assert.equal(result.execution.modelCalls[0].providerRequestId, 'fake-request-001');
  assert.deepEqual(result.execution.modelCalls[0].usage, {
    inputTokens: 120, outputTokens: 80, totalTokens: 200,
  });
  assert.match(result.execution.modelCalls[0].requestDigest, /^[0-9a-f]{64}$/);

  const savedRun = await service.getRun(run.id);
  assert.equal(savedRun.status, 'waiting');
  assert.equal(savedRun.task.state, 'waitingHuman');
  assert.equal(savedRun.task.activeAttemptId, result.execution.attempt.id);
  assert.notEqual(savedRun.sealedAt, null);
  assert.equal((await repository.getProject(project.id)).activePlanRevisionId, null);
});

test('P0.4 rejects a fact supported only by a context alias and fails closed', async () => {
  const adapter = {
    async call(input) {
      const contextEvidence = allEvidence(input.payload.context).find((entry) => entry.role === 'context');
      assert.ok(contextEvidence, 'fixture must expose a context alias');
      return {
        providerRequestId: 'fake-context-only', usage: null,
        output: {
          synopsis: { value: '不能只靠上下文', evidence: [{ chunkId: contextEvidence.chunkId, alias: contextEvidence.alias }] },
          characters: [], locations: [], props: [], scenes: [], dialogues: [],
        },
      };
    },
  };
  const { service, runner, repository } = fixture({ adapter, targetEstimatedTokens: 6 });
  const rawText = ['甲走进房间。', '乙关上房门。', '甲看向窗外。', '乙放下钥匙。'].join('\n');
  const { run } = await prepared(service, rawText);
  await assert.rejects(runner.run(run.id), (error) => error.code === 'CONTEXT_ONLY_EVIDENCE'
    && error.paidModelCallState === 'confirmed');
  const failedRun = await service.getRun(run.id);
  assert.equal(failedRun.status, 'failed');
  assert.equal(failedRun.task.state, 'failed');
  const snapshot = await repository.getExecutionSnapshot(failedRun.task.activeAttemptId);
  assert.equal(snapshot.attempt.status, 'failed');
  assert.equal(snapshot.attempt.error.code, 'CONTEXT_ONLY_EVIDENCE');
  assert.equal(snapshot.modelCalls[0].status, 'succeeded', 'transport succeeded even though validation failed');
  assert.deepEqual(await service.listPlanRevisions(run.id), []);
});

test('P0.4 records a sanitized adapter failure and does not save raw errors or a plan', async () => {
  const adapter = {
    async call() { throw new Error('secret vendor payload must not persist'); },
  };
  const { service, runner, repository } = fixture({ adapter });
  const { run } = await prepared(service);
  await assert.rejects(runner.run(run.id), (error) => error.code === 'MODEL_ADAPTER_FAILED'
    && error.paidModelCallState === 'unknown');
  const failedRun = await service.getRun(run.id);
  const snapshot = await repository.getExecutionSnapshot(failedRun.task.activeAttemptId);
  assert.equal(snapshot.attempt.status, 'failed');
  assert.equal(snapshot.modelCalls[0].status, 'failed');
  assert.equal(snapshot.modelCalls[0].error.message, '模型适配器调用失败。');
  assert.equal(JSON.stringify(snapshot).includes('secret vendor payload'), false);
  assert.deepEqual(await service.listPlanRevisions(run.id), []);
});

test('P0.4 preserves the sanitized upstream cause on an adapter failure', async () => {
  const { ModelError } = require('@lyra/shared');
  const adapter = {
    async call() { throw new ModelError(502, 'UPSTREAM_ERROR', '上游服务失败，请检查模型服务。', { upstreamStatus: 504 }); },
  };
  const { service, runner, repository } = fixture({ adapter });
  const { run } = await prepared(service);
  await assert.rejects(runner.run(run.id), (error) => error.code === 'MODEL_ADAPTER_FAILED'
    && error.message === '模型适配器调用失败。（UPSTREAM_ERROR，上游状态 504）'
    && error.paidModelCallState === 'unknown');
  const failedRun = await service.getRun(run.id);
  const snapshot = await repository.getExecutionSnapshot(failedRun.task.activeAttemptId);
  assert.equal(snapshot.modelCalls[0].status, 'failed');
  assert.equal(snapshot.modelCalls[0].error.code, 'MODEL_ADAPTER_FAILED');
  assert.equal(snapshot.modelCalls[0].error.message, '模型适配器调用失败。（UPSTREAM_ERROR，上游状态 504）');
});

test('a ledger write failure after a successful model call is not recorded as an adapter failure', async () => {
  const output = { synopsis: null, characters: [], locations: [], props: [], scenes: [], dialogues: [] };
  let calls = 0;
  let persisted;
  const adapter = {
    async call() {
      calls += 1;
      return { providerRequestId: 'paid-then-ledger-failed', usage: null, output };
    },
  };
  const { service, runner, repository } = fixture({ adapter });
  const { run } = await prepared(service);
  const driverError = 'column "response_json" of relation "model_calls" does not exist';
  repository.completeModelCall = async (input) => {
    persisted = input.response;
    throw new Error(driverError);
  };
  await assert.rejects(runner.run(run.id), (error) => error.status === 503
    && error.code === 'MODEL_CALL_LEDGER_UNAVAILABLE'
    && error.paidModelCallState === 'unknown'
    && !error.message.includes('response_json')
    && !error.message.includes(driverError));
  const failedRun = await service.getRun(run.id);
  const snapshot = await repository.getExecutionSnapshot(failedRun.task.activeAttemptId);
  assert.equal(calls, 1);
  assert.deepEqual(persisted, output);
  assert.equal(snapshot.modelCalls.length, 1);
  assert.equal(snapshot.modelCalls[0].status, 'submitted');
  assert.equal(snapshot.modelCalls[0].error, null);
  assert.equal(snapshot.attempt.status, 'failed');
  assert.equal(snapshot.attempt.error.code, 'MODEL_CALL_LEDGER_UNAVAILABLE');
  assert.equal(JSON.stringify(snapshot).includes(driverError), false);
  assert.deepEqual(await service.listPlanRevisions(run.id), []);
});

test('repairs a field-level protocol violation with one bounded correction call', async () => {
  const requests = [];
  let firstContext = null;
  const adapter = {
    async call(input) {
      requests.push(input.payload);
      if (requests.length === 1) {
        firstContext = input.payload.context;
        const candidate = aliasedCandidate(firstContext);
        // The exact failure kimi produced: a bare string where the protocol
        // requires a {value, evidence} sourced-text object.
        candidate.scenes[0].title = '医院走廊相见';
        return {
          providerRequestId: 'fake-repair-001',
          usage: { inputTokens: 4000, outputTokens: 9000, totalTokens: 13000 },
          output: candidate,
        };
      }
      return {
        providerRequestId: 'fake-repair-002',
        usage: { inputTokens: 12000, outputTokens: 9000, totalTokens: 21000 },
        output: aliasedCandidate(firstContext),
      };
    },
  };
  const { repository, service, runner } = fixture({ adapter });
  const project = await service.createProject({ title: '修正通道测试' });
  const script = await service.createScriptVersion(project.id, { rawText: [
    '第1场 医院走廊 夜 内',
    '林晚推门进入。',
    '林晚：你终于来了。🙂',
    '顾沉：我知道。',
  ].join('\n') });
  const run = await service.createDraftRun(project.id, {
    requirements: { language: '中文', visualStyle: '真人拟真', aspectRatio: '9:16' },
    maxModelCalls: 2,
    maxOutputTokens: 4096,
  });

  const result = await runner.run(run.id);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].operation, 'extractFacts');
  assert.equal(requests[1].operation, 'extractFacts');
  assert.ok(requests[1].systemPrompt.includes('修正上一次输出'));
  const repairMessage = JSON.parse(requests[1].messages[0].content);
  assert.equal(repairMessage.operation, 'repairExtractFacts');
  assert.ok(repairMessage.ruleViolationReport.includes('scenes[0].title'));
  assert.equal(repairMessage.previousOutput.scenes[0].title, '医院走廊相见');
  assert.ok(Array.isArray(repairMessage.evidenceCatalog) && repairMessage.evidenceCatalog.length > 0,
    'repair message carries the evidence catalog');
  const catalogEntry = repairMessage.evidenceCatalog.find((entry) => entry.quote === '林晚：你终于来了。🙂');
  assert.ok(catalogEntry, 'catalog contains span quotes for precise pointer repair');
  assert.equal(catalogEntry.role, 'primary');
  assert.equal(result.execution.attempt.status, 'succeeded');
  assert.equal(result.execution.modelCalls.length, 2);
  assert.ok(result.execution.modelCalls.every(call => call.status === 'succeeded'));
  assert.equal(result.plan.content.scenes[0].title.value, '医院走廊相见');
});

test('surfaces the original validation failure when the repair budget is exhausted', async () => {
  let calls = 0;
  const adapter = {
    async call(input) {
      calls += 1;
      const candidate = aliasedCandidate(input.payload.context);
      candidate.scenes[0].title = '医院走廊相见';
      return { providerRequestId: `fake-budget-${calls}`, usage: null, output: candidate };
    },
  };
  const { repository, service, runner } = fixture({ adapter });
  const { run } = await prepared(service); // maxModelCalls: 1

  await assert.rejects(runner.run(run.id), (error) => error.code === 'STAGE_OUTPUT_INVALID'
    && error.message.includes('scenes[0].title'));
  const failedRun = await service.getRun(run.id);
  const snapshot = await repository.getExecutionSnapshot(failedRun.task.activeAttemptId);
  assert.equal(calls, 1);
  assert.equal(snapshot.modelCalls.length, 1);
  assert.equal(snapshot.attempt.status, 'failed');
});

test('tolerant quote matching snaps full-width variance back to the original text', async () => {
  const adapter = {
    async call(input) {
      const candidate = aliasedCandidate(input.payload.context);
      // Half-width colon and dropped emoji: exact match fails, the tolerant
      // tier must snap the ref to the ORIGINAL span text with correct offsets.
      candidate.dialogues[0].source.quote = '你终于来了。';
      candidate.dialogues[1].source.quote = '顾沉:我知道。';
      return { providerRequestId: 'fake-tolerant', usage: null, output: candidate };
    },
  };
  const { service, runner } = fixture({ adapter });
  const { run } = await prepared(service);
  const result = await runner.run(run.id);

  assert.equal(result.execution.attempt.status, 'succeeded');
  assert.equal(result.plan.content.dialogues[0].sourceRef.quote, '你终于来了。');
  assert.equal(result.plan.content.dialogues[1].sourceRef.quote, '顾沉：我知道。');
});

test('still-ambiguous quotes after tolerant matching surface a repairable error', async () => {
  const rawText = ['第1场 医院走廊 夜 内', '林晚推门进入。', '林晚：来了，终于来了。🙂', '顾沉：我知道。'].join('\n');
  const adapter = {
    async call(input) {
      const context = input.payload.context;
      const linLine = pointer(context, '林晚：来了，终于来了。🙂');
      const guLine = pointer(context, '顾沉：我知道。');
      const heading = pointer(context, '第1场 医院走廊 夜 内');
      const action = pointer(context, '林晚推门进入。');
      const sourced = (value, evidence) => ({ value, evidence });
      return {
        providerRequestId: 'fake-repeat', usage: null,
        output: {
          synopsis: sourced('林晚进入医院走廊，与顾沉交谈。', [heading, action, linLine, guLine]),
          characters: [
            { tempId: 'tmp_lin', name: sourced('林晚', [linLine]), aliases: [], description: null, evidence: [action, linLine] },
            { tempId: 'tmp_gu', name: sourced('顾沉', [guLine]), aliases: [], description: null, evidence: [guLine] },
          ],
          locations: [{ tempId: 'tmp_hall', name: sourced('医院走廊', [heading]), aliases: [], description: null, evidence: [heading] }],
          props: [],
          scenes: [{ tempId: 'tmp_scene', order: 1, title: sourced('医院走廊相见', [heading, action]), locationTempId: 'tmp_hall', characterTempIds: ['tmp_lin', 'tmp_gu'], evidence: [heading, action, linLine, guLine], timeOfDay: sourced('夜', [heading]) }],
          dialogues: [
            // '来了' appears twice inside the cited line — genuinely ambiguous.
            { tempId: 'tmp_d1', sceneTempId: 'tmp_scene', speakerTempId: 'tmp_lin', speakerEvidence: [linLine], source: { evidence: linLine, quote: '来了' } },
            { tempId: 'tmp_d2', sceneTempId: 'tmp_scene', speakerTempId: 'tmp_gu', speakerEvidence: [guLine], source: { evidence: guLine, quote: '我知道。' } },
          ],
        },
      };
    },
  };
  const { service, runner } = fixture({ adapter });
  const { run } = await prepared(service, rawText); // maxModelCalls: 1 → no repair budget

  await assert.rejects(runner.run(run.id), (error) => error.code === 'DIALOGUE_QUOTE_AMBIGUOUS'
    && error.message.includes('tmp_d1'));
});

test('dialogues are sorted into script order regardless of emission order', async () => {
  const rawText = [
    '第1场 医院走廊 夜 内',
    '林晚推门进入。',
    '林晚：你终于来了。🙂',
    '第2场 天台 日 外',
    '顾沉：我知道。',
  ].join('\n');
  const adapter = {
    async call(input) {
      const context = input.payload.context;
      const heading = pointer(context, '第1场 医院走廊 夜 内');
      const heading2 = pointer(context, '第2场 天台 日 外');
      const action = pointer(context, '林晚推门进入。');
      const linLine = pointer(context, '林晚：你终于来了。🙂');
      const guLine = pointer(context, '顾沉：我知道。');
      const sourced = (value, evidence) => ({ value, evidence });
      return {
        providerRequestId: 'fake-sort', usage: null,
        output: {
          synopsis: sourced('林晚与顾沉相遇。', [heading, linLine, heading2, guLine]),
          characters: [
            { tempId: 'tmp_lin', name: sourced('林晚', [linLine]), aliases: [], description: null, evidence: [action, linLine] },
            { tempId: 'tmp_gu', name: sourced('顾沉', [guLine]), aliases: [], description: null, evidence: [guLine] },
          ],
          locations: [
            { tempId: 'tmp_hall', name: sourced('医院走廊', [heading]), aliases: [], description: null, evidence: [heading] },
            { tempId: 'tmp_roof', name: sourced('天台', [heading2]), aliases: [], description: null, evidence: [heading2] },
          ],
          props: [],
          scenes: [
            { tempId: 'tmp_scene1', order: 1, title: sourced('医院走廊相见', [heading, action]), locationTempId: 'tmp_hall', characterTempIds: ['tmp_lin'], evidence: [heading, action, linLine], timeOfDay: sourced('夜', [heading]) },
            { tempId: 'tmp_scene2', order: 2, title: sourced('天台对峙', [heading2, guLine]), locationTempId: 'tmp_roof', characterTempIds: ['tmp_gu'], evidence: [heading2, guLine], timeOfDay: sourced('日', [heading2]) },
          ],
          // Emitted out of script order on purpose: scene 2's dialogue first.
          dialogues: [
            { tempId: 'tmp_d2', sceneTempId: 'tmp_scene2', speakerTempId: 'tmp_gu', speakerEvidence: [guLine], source: { evidence: guLine, quote: '我知道。' } },
            { tempId: 'tmp_d1', sceneTempId: 'tmp_scene1', speakerTempId: 'tmp_lin', speakerEvidence: [linLine], source: { evidence: linLine, quote: '你终于来了。🙂' } },
          ],
        },
      };
    },
  };
  const { service, runner } = fixture({ adapter });
  const { run } = await prepared(service, rawText);

  const result = await runner.run(run.id);
  assert.equal(result.execution.attempt.status, 'succeeded');
  assert.deepEqual(result.plan.content.dialogues.map(d => d.sourceRef.quote), ['你终于来了。🙂', '我知道。']);
});

test('P0.4 enforces maxModelCalls before a second adapter invocation', async () => {
  let adapterCalls = 0;
  const adapter = {
    async call() {
      adapterCalls += 1;
      return {
        providerRequestId: `fake-${adapterCalls}`, usage: null,
        output: { synopsis: null, characters: [], locations: [], props: [], scenes: [], dialogues: [] },
      };
    },
  };
  const executor = {
    version: 'two-call-test-executor/1',
    async execute(context, model) {
      await model.call({ operation: 'first', context });
      return model.call({ operation: 'second', context });
    },
  };
  const { service, runner, repository } = fixture({ adapter, executor });
  const { run } = await prepared(service);
  await assert.rejects(runner.run(run.id), (error) => error.code === 'MODEL_CALL_LIMIT_REACHED'
    && error.paidModelCallState === 'confirmed');
  const failedRun = await service.getRun(run.id);
  const snapshot = await repository.getExecutionSnapshot(failedRun.task.activeAttemptId);
  assert.equal(adapterCalls, 1);
  assert.equal(snapshot.modelCalls.length, 1);
  assert.equal(snapshot.modelCalls[0].status, 'succeeded');
  assert.equal(snapshot.attempt.status, 'failed');
});

test('removed provider, model and reasoning snapshots remain readable but cannot begin another attempt', async () => {
  const legacyConfigurations = [
    { provider: 'local-proxy', model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
    { provider: 'maas', model: 'gpt-5.6-terra', reasoningEffort: 'model-default' },
    { provider: 'maas', model: config.defaultModel, reasoningEffort: 'high' },
  ];
  for (const modelConfig of legacyConfigurations) {
    let calls = 0;
    const { repository, service, runner } = fixture({ adapter: { async call() { calls++; throw new Error('must not execute'); } } });
    const { run } = await prepared(service);
    // Simulate the immutable snapshot saved by the previous provider version.
    repository.runs.get(run.id).modelConfig = structuredClone(modelConfig);
    const before = await service.getRun(run.id);
    assert.deepEqual(before.modelConfig, modelConfig);
    await assert.rejects(runner.run(run.id), error => error.status === 409 && error.code === 'MODEL_CONFIGURATION_CHANGED');
    assert.deepEqual(await service.getRun(run.id), before);
    assert.equal(repository.attempts.size, 0);
    assert.equal(repository.modelCalls.size, 0);
    assert.equal(calls, 0);
  }
});

test('unconfigured MAAS adapter blocks execution before creating attempt or call records', async () => {
  let calls = 0;
  const adapter = new MaasStageModelAdapter(readConfig({}), async () => { calls++; throw new Error('must not call'); });
  const { repository, service, runner } = fixture({ adapter });
  const { run } = await prepared(service);
  await assert.rejects(runner.run(run.id), error => error.status === 503 && error.code === 'MODEL_NOT_CONFIGURED');
  assert.equal((await service.getRun(run.id)).status, 'draft');
  assert.equal(repository.attempts.size, 0);
  assert.equal(repository.modelCalls.size, 0);
  assert.equal(calls, 0);
});

test('a frozen method reaches the actual extractFacts provider payload as user context; base facts remain valid', async () => {
  let captured;
  const adapter = new MaasStageModelAdapter(config, async (_url, options) => {
    captured = JSON.parse(options.body);
    const { context } = JSON.parse(captured.messages[1].content);
    return new Response(JSON.stringify({ id: 'fake-methods', model: captured.model, choices: [
      { finish_reason: 'stop', message: { content: JSON.stringify(aliasedCandidate(context)) } },
    ] }));
  });
  const { runner, service } = fixture({ executor: new PiExtractFactsStageExecutor(), adapter });
  const { run } = await prepared(service);
  const result = await runner.run(run.id, 'METHOD_EXAMPLE 依原文核对');
  assert.match(captured.messages[1].content, /METHOD_EXAMPLE/);
  assert.doesNotMatch(captured.messages[0].content, /METHOD_EXAMPLE/);
  assert.equal(result.plan.content.dialogues.length, 2);
});

test('MAAS stage adapter sends only the new model and parses the controlled JSON result', async () => {
  let calls = 0;
  const output = { synopsis: null, characters: [], locations: [], props: [], scenes: [], dialogues: [] };
  const adapter = new MaasStageModelAdapter(config, async (url, options) => {
    calls++;
    assert.equal(url, 'https://model.test/openai/chat/completions');
    assert.equal(options.headers['api-key'], 'test-only-api-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, config.defaultModel);
    assert.equal(body.stream, false);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
    assert.equal(body.max_tokens, 4096);
    return new Response(JSON.stringify({ id: 'maas-stage-fake', model: body.model,
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  const result = await adapter.call({ model: config.defaultModel, reasoningEffort: 'model-default', maxOutputTokens: 4096,
    payload: { operation: 'extractFacts', systemPrompt: 'Return JSON', messages: [{ role: 'user', content: 'synthetic test' }] } });
  assert.deepEqual(result.output, output);
  assert.equal(result.providerRequestId, 'maas-stage-fake');
  assert.equal(calls, 1);
});

const validEmptyCandidate = { synopsis: null, characters: [], locations: [], props: [], scenes: [], dialogues: [] };
const primaryAlias = {
  alias: 'E001', role: 'primary', spanId: 'span_0001', kind: 'dialogueTurnCandidate',
  sourceRef: { scriptVersionId: 'sv_test', start: 0, end: 9, quote: '林晚：你来了。' },
  speakerCandidate: '林晚',
};
const primaryAliases = () => new Map([['chunk_0001:E001', primaryAlias]]);

function rejectsResolve(value, aliases) {
  try {
    resolveAliasedExtractFactsCandidate(value, aliases);
  } catch (error) {
    return error;
  }
  assert.fail('resolveAliasedExtractFactsCandidate should have rejected the input');
}

test('schema failures now carry sanitized field-level diagnostics instead of one opaque code', () => {
  const missingSynopsis = rejectsResolve(
    { characters: [], locations: [], props: [], scenes: [], dialogues: [] }, primaryAliases());
  assert.equal(missingSynopsis.code, 'STAGE_OUTPUT_INVALID');
  assert.match(missingSynopsis.message, /顶层：缺少必需字段 synopsis/);

  const wrongDialoguesType = rejectsResolve(
    { ...validEmptyCandidate, dialogues: 'oops' }, primaryAliases());
  assert.equal(wrongDialoguesType.code, 'STAGE_OUTPUT_INVALID');
  assert.match(wrongDialoguesType.message, /dialogues：类型应为 array/);

  const extraField = rejectsResolve(
    { ...validEmptyCandidate, extraField: 1 }, primaryAliases());
  assert.equal(extraField.code, 'STAGE_OUTPUT_INVALID');
  assert.match(extraField.message, /顶层：出现未约定字段 extraField（协议不接受额外字段）/);

  const missingDialogueSource = rejectsResolve({
    ...validEmptyCandidate,
    dialogues: [{ tempId: 'tmp_d1', sceneTempId: 'tmp_s1', speakerTempId: null, speakerEvidence: [] }],
  }, primaryAliases());
  assert.equal(missingDialogueSource.code, 'STAGE_OUTPUT_INVALID');
  assert.match(missingDialogueSource.message, /dialogues\[0\]：缺少必需字段 source/);
});

test('diagnostics cap length and never copy model-generated values into the message', () => {
  const longKey = 'a'.repeat(120);
  const error = rejectsResolve({ ...validEmptyCandidate, [longKey]: 'secret model text' }, primaryAliases());
  assert.equal(error.code, 'STAGE_OUTPUT_INVALID');
  assert.ok(!error.message.includes('secret model text'), 'model values must not leak');
  assert.ok(!error.message.includes(longKey), 'long keys must be truncated');
  assert.ok(error.message.length < 600, `message stays bounded, got ${error.message.length}`);
  assert.ok(error.message.includes(`${'a'.repeat(40)}…`), 'truncated key marker expected');
});

test('speaker evidence inconsistencies get their own error codes with the dialogue id', () => {
  const missing = rejectsResolve({
    ...validEmptyCandidate,
    dialogues: [{
      tempId: 'tmp_d1', sceneTempId: 'tmp_s1', speakerTempId: 'tmp_lin', speakerEvidence: [],
      source: { evidence: { chunkId: 'chunk_0001', alias: 'E001' }, quote: '你来了。' },
    }],
  }, primaryAliases());
  assert.equal(missing.code, 'SPEAKER_EVIDENCE_MISSING');
  assert.match(missing.message, /对白 tmp_d1/);

  const orphaned = rejectsResolve({
    ...validEmptyCandidate,
    dialogues: [{
      tempId: 'tmp_d2', sceneTempId: 'tmp_s1', speakerTempId: null,
      speakerEvidence: [{ chunkId: 'chunk_0001', alias: 'E001' }],
      source: { evidence: { chunkId: 'chunk_0001', alias: 'E001' }, quote: '你来了。' },
    }],
  }, primaryAliases());
  assert.equal(orphaned.code, 'SPEAKER_EVIDENCE_ORPHANED');
  assert.match(orphaned.message, /对白 tmp_d2/);
});
