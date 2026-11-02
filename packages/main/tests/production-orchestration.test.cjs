const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { MemoryProductionRepository } = require('../dist/production/repository');
const { ProductionService } = require('../dist/production/service');
const { ProductionError } = require('@lyra/shared');

const input = (changes = {}) => ({
  projectId: 'project_0123456789abcdef0123456789abcdef',
  scriptVersionId: 'script_0123456789abcdef0123456789abcdef',
  ratio: '9:16', targetDurationSec: 90, visualStyle: '现实主义悬疑，冷色雨夜',
  qualityPreset: 'balanced', automationMode: 'auto', candidatePolicy: 'gacha', candidateLimit: 2,
  directorPolicy: 'auto', budgetMicros: 50_000_000, currency: 'CNY', allowPaid: true,
  clientRequestId: 'production-click-1', ...changes,
});

function executor(stage, outcome, prepare = {}) {
  let calls = 0;
  return {
    stage,
    calls: () => calls,
    async prepare({ task }) { return { executor: `test-${stage}/1`, inputDigest: task.inputManifest[0].digest,
      estimateCostMicros: 0, requiresPaid: false, provider: null, ...prepare }; },
    async execute(context) { calls++; return typeof outcome === 'function' ? outcome(context, calls) : structuredClone(outcome ?? { state: 'succeeded' }); },
  };
}

async function make(options = {}) {
  const repo = options.repo ?? new MemoryProductionRepository();
  let time = 0;
  const service = new ProductionService(repo, { pollIntervalMs: 60_000,
    now: () => new Date(Date.UTC(2026, 9, 23, 12, 0, time++)), executors: options.executors ?? [] });
  return { repo, service };
}
async function ticks(service, count = 30) { for (let index = 0; index < count; index++) await service.tick(); }

test('015 migration persists CAS aggregates and a transactional outbox', () => {
  const sql = readFileSync(join(__dirname, '../migrations/015_production_orchestration.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE production_runs/);
  assert.match(sql, /client_request_id TEXT NOT NULL UNIQUE/);
  assert.match(sql, /run_json JSONB NOT NULL/);
  assert.match(sql, /CREATE TABLE production_outbox_events/);
  assert.match(sql, /UNIQUE\(run_id, sequence\)/);
  assert.match(sql, /WHERE delivered_at IS NULL/);
});

test('016 migration permits audited agent adoption while preserving the actor constraint', () => {
  const sql = readFileSync(join(__dirname, '../migrations/016_agent_adoptions.sql'), 'utf8');
  assert.match(sql, /plan_adoptions_actor_check/);
  assert.match(sql, /storyboard_adoptions_actor_check/);
  assert.match(sql, /actor IN \('user', 'agent'\)/);
});

test('creation freezes policy, compiles the complete DAG, and deduplicates the client request', async () => {
  const { repo, service } = await make();
  const first = await service.create(input());
  const second = await service.create(input());
  assert.equal(first.id, second.id);
  assert.equal((await repo.list()).length, 1);
  assert.deepEqual(first.stages.map(stage => stage.key), [
    'prepare', 'breakdown', 'assets', 'storyboard', 'director', 'video', 'candidates', 'review', 'compose', 'deliver',
  ]);
  assert.equal(first.tasks.length, 10);
  assert.equal(first.tasks[0].status, 'ready');
  assert.ok(first.tasks.slice(1).every(task => task.status === 'pending'));
  assert.equal(first.summary.tasks.total, 10);
  await assert.rejects(service.create(input({ visualStyle: '另一种风格' })), error => error.code === 'PRODUCTION_REQUEST_REUSED');
});

test('the built-in preflight is real while an unavailable capability stops honestly', async () => {
  const { service } = await make();
  const created = await service.create(input());
  await service.tick(created.id);
  let run = await service.get(created.id);
  assert.equal(run.tasks.find(task => task.stage === 'prepare').status, 'succeeded');
  assert.equal(run.artifacts[0].kind, 'report');
  await service.tick(created.id);
  run = await service.get(created.id);
  const breakdown = run.tasks.find(task => task.stage === 'breakdown');
  assert.equal(breakdown.status, 'waitingHuman');
  assert.equal(breakdown.blockingReason.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(run.status, 'waitingHuman');
  assert.equal(run.summary.tasks.completed, 1);
  assert.equal(run.inbox[0].code, 'CAPABILITY_UNAVAILABLE');
});

test('executors can expand stable per-shot tasks and a verified local delivery completes the run', async () => {
  const storyboard = executor('storyboard', ({ task }) => task.scope.kind === 'episode' ? {
    state: 'succeeded', artifacts: [{ key: 'board', kind: 'text', title: '分镜版本' }], spawnTasks: [
      { key: 's01-01-assets', stage: 'assets', label: 'S01-01 资产', scope: { kind: 'shot', id: 'S01-01' } },
      { key: 's01-01-director', stage: 'director', label: 'S01-01 3D', scope: { kind: 'shot', id: 'S01-01' }, dependsOn: ['s01-01-assets'] },
      { key: 's01-01-video', stage: 'video', label: 'S01-01 视频', scope: { kind: 'shot', id: 'S01-01' }, dependsOn: ['s01-01-director'] },
      { key: 's01-01-candidates', stage: 'candidates', label: 'S01-01 抽卡', scope: { kind: 'shot', id: 'S01-01' }, dependsOn: ['s01-01-video'] },
      { key: 's01-01-review', stage: 'review', label: 'S01-01 复核', scope: { kind: 'shot', id: 'S01-01' }, dependsOn: ['s01-01-candidates'] },
      { key: 's01-02-assets', stage: 'assets', label: 'S01-02 资产', scope: { kind: 'shot', id: 'S01-02' } },
      { key: 's01-02-review', stage: 'review', label: 'S01-02 复核', scope: { kind: 'shot', id: 'S01-02' }, dependsOn: ['s01-02-assets'] },
    ],
  } : { state: 'succeeded' });
  const deliver = executor('deliver', { state: 'succeeded',
    artifacts: [{ key: 'master', kind: 'delivery', title: '成片 MP4', uri: '/api/production-media/object-1', sha256: 'a'.repeat(64) }],
    qualityChecks: [{ level: 'episode', result: 'pass', ruleVersion: 'test/1', summary: '规格与必需质量门已通过' }],
    delivery: { artifactKey: 'master', durationSec: 89.5, container: 'mp4', verified: true },
  });
  const executors = ['breakdown', 'assets', 'director', 'video', 'candidates', 'review', 'compose']
    .map(stage => executor(stage, { state: 'succeeded' }));
  executors.push(storyboard, deliver);
  const { service } = await make({ executors }); const created = await service.create(input());
  await ticks(service, 40); const run = await service.get(created.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.delivery.status, 'ready');
  assert.equal(run.summary.shots.total, 2);
  assert.equal(run.summary.shots.completed, 2);
  assert.ok(run.tasks.length > 10);
  const shotReviewIds = run.tasks.filter(task => task.scope.kind === 'shot' && task.stage === 'review').map(task => task.id);
  const compose = run.tasks.find(task => task.scope.kind === 'episode' && task.stage === 'compose');
  assert.ok(shotReviewIds.every(id => compose.dependencies.includes(id)));
  assert.equal(new Set(run.tasks.map(task => task.id)).size, run.tasks.length);
});

test('candidate selection is a durable human decision and only unblocks its task', async () => {
  const candidateExecutor = executor('candidates', { state: 'succeeded',
    artifacts: [
      { key: 'take-a', kind: 'video', title: '候选 A' },
      { key: 'take-b', kind: 'video', title: '候选 B' },
    ], candidateSets: [{ kind: 'video', candidates: [
      { label: 'A', summary: '表演更克制', artifactKey: 'take-a', score: 0.82 },
      { label: 'B', summary: '动作更强', artifactKey: 'take-b', score: 0.79 },
    ] }],
  });
  const executors = ['breakdown', 'assets', 'storyboard', 'director', 'video'].map(stage => executor(stage));
  executors.push(candidateExecutor);
  const { service } = await make({ executors }); const created = await service.create(input()); await ticks(service, 8);
  let run = await service.get(created.id); const task = run.tasks.find(item => item.stage === 'candidates' && item.scope.kind === 'episode');
  assert.equal(task.status, 'waitingHuman');
  const set = run.candidateSets[0]; assert.equal(set.status, 'open');
  run = await service.review(run.id, { taskId: task.id, decision: 'selectCandidate', candidateId: set.candidates[0].id,
    issueId: null, feedback: '选择表演更克制的版本' });
  assert.equal(run.candidateSets[0].status, 'selected');
  assert.equal(run.candidateSets[0].selectedCandidateId, set.candidates[0].id);
  assert.equal(run.tasks.find(item => item.id === task.id).status, 'succeeded');
  assert.equal(run.reviews.at(-1).decision, 'selectCandidate');
  await assert.rejects(service.review(run.id, { taskId: task.id, decision: 'selectCandidate',
    candidateId: set.candidates[1].id, issueId: null, feedback: '尝试覆盖既有选择' }),
  error => error.code === 'PRODUCTION_CANDIDATE_SELECTION_CLOSED');
  const unchanged = await service.get(run.id);
  assert.equal(unchanged.candidateSets[0].selectedCandidateId, set.candidates[0].id);
  assert.equal(unchanged.reviews.length, 1);
});

test('auto mode selects a valid recommendation while checkpoint mode keeps the set open', async () => {
  const candidateOutcome = { state: 'succeeded', artifacts: [
    { key: 'take-a', kind: 'video', title: '候选 A' }, { key: 'take-b', kind: 'video', title: '候选 B' },
  ], candidateSets: [{ kind: 'video', recommendedIndex: 1, candidates: [
    { label: 'A', summary: '备选', artifactKey: 'take-a', score: 0.7 },
    { label: 'B', summary: '程序评分最高', artifactKey: 'take-b', score: 0.9 },
  ] }] };
  const stages = ['breakdown', 'assets', 'storyboard', 'director', 'video'];
  const autoExecutors = stages.map(stage => executor(stage));
  autoExecutors.push(executor('candidates', candidateOutcome));
  const { service: auto } = await make({ executors: autoExecutors });
  const autoRun = await auto.create(input({ clientRequestId: 'recommended-auto' }));
  await ticks(auto, 8);
  const selected = (await auto.get(autoRun.id)).candidateSets[0];
  assert.equal(selected.status, 'selected');
  assert.equal(selected.candidates[1].status, 'selected');
  assert.equal(selected.candidates[0].status, 'rejected');

  const checkpointExecutors = stages.map(stage => executor(stage));
  checkpointExecutors.push(executor('candidates', candidateOutcome));
  const { service: checkpoints } = await make({ executors: checkpointExecutors });
  let manual = await checkpoints.create(input({ automationMode: 'checkpoints', clientRequestId: 'recommended-manual' }));
  for (let index = 0; index < 20 && manual.candidateSets.length === 0; index++) {
    await checkpoints.tick(manual.id); manual = await checkpoints.get(manual.id);
    const checkpoint = manual.tasks.find(task => task.status === 'waitingHuman'
      && task.blockingReason?.code === 'CHECKPOINT_REVIEW_REQUIRED');
    if (checkpoint) manual = await checkpoints.review(manual.id, { taskId: checkpoint.id, decision: 'approve',
      candidateId: null, issueId: null, feedback: '' });
  }
  assert.equal(manual.candidateSets[0].status, 'open');
  assert.ok(manual.candidateSets[0].candidates.every(candidate => candidate.status === 'available'));
});

test('invalid recommended indexes fail without persisting a partial candidate set', async () => {
  const bad = executor('candidates', { state: 'succeeded', candidateSets: [{ kind: 'video', recommendedIndex: 2,
    candidates: [{ label: 'only', summary: '唯一候选' }] }] });
  const executors = ['breakdown', 'assets', 'storyboard', 'director', 'video'].map(stage => executor(stage));
  executors.push(bad);
  const { service } = await make({ executors }); const created = await service.create(input({ clientRequestId: 'bad-recommendation' }));
  await ticks(service, 8); const run = await service.get(created.id);
  assert.equal(run.tasks.find(task => task.stage === 'candidates' && task.scope.kind === 'episode').status, 'failed');
  assert.equal(run.candidateSets.length, 0);
});

test('same-stage scoped children gate the directly dependent episode stage', async () => {
  const assets = executor('assets', ({ task }) => task.scope.kind === 'episode'
    ? { state: 'succeeded', spawnTasks: [{ key: 'shot-assets', stage: 'assets', label: '镜头资产',
      scope: { kind: 'shot', id: 'shot-real-1' } }] }
    : { state: 'succeeded' });
  const { service } = await make({ executors: [executor('breakdown'), assets, executor('storyboard')] });
  const created = await service.create(input({ clientRequestId: 'same-stage-gate' }));
  await ticks(service, 3); let run = await service.get(created.id);
  const child = run.tasks.find(task => task.stage === 'assets' && task.scope.kind === 'shot');
  const storyboard = run.tasks.find(task => task.stage === 'storyboard' && task.scope.kind === 'episode');
  assert.ok(child); assert.ok(storyboard.dependencies.includes(child.id));
  assert.equal(child.status, 'ready'); assert.equal(storyboard.status, 'pending');
  await service.tick(run.id); run = await service.get(run.id);
  assert.equal(run.tasks.find(task => task.id === child.id).status, 'succeeded');
  assert.equal(run.tasks.find(task => task.id === storyboard.id).status, 'ready');
});

test('failed quality can continue only through an explicit auto repair subgraph', async () => {
  const repair = executor('breakdown', ({ task }) => task.scope.kind === 'episode' ? {
    state: 'succeeded', qualityChecks: [{ level: 'episode', result: 'fail', ruleVersion: 'qc/1', summary: '需要返修' }],
    spawnTasks: [{ key: 'repair-shot', stage: 'breakdown', label: '局部返修', scope: { kind: 'shot', id: 'shot-repair' } }],
    continueOnFailedQuality: true,
  } : { state: 'succeeded' });
  const { service } = await make({ executors: [repair] });
  const created = await service.create(input({ clientRequestId: 'quality-repair' }));
  await ticks(service, 2); const run = await service.get(created.id);
  const parent = run.tasks.find(task => task.stage === 'breakdown' && task.scope.kind === 'episode');
  const child = run.tasks.find(task => task.scope.kind === 'shot' && task.scope.id === 'shot-repair');
  assert.equal(parent.status, 'succeeded'); assert.equal(child.status, 'ready');
  assert.equal(run.qualityChecks.at(-1).result, 'fail');
  assert.ok(run.inbox.some(issue => issue.code === 'AUTOMATED_REPAIR_SCHEDULED'));

  const invalid = executor('breakdown', { state: 'succeeded',
    qualityChecks: [{ level: 'episode', result: 'fail', ruleVersion: 'qc/1', summary: '失败' }],
    continueOnFailedQuality: true });
  const { service: invalidService } = await make({ executors: [invalid] });
  const invalidRun = await invalidService.create(input({ clientRequestId: 'quality-no-repair' }));
  await ticks(invalidService, 2); const rejected = await invalidService.get(invalidRun.id);
  assert.equal(rejected.tasks.find(task => task.stage === 'breakdown').status, 'failed');
  assert.equal(rejected.qualityChecks.length, 0);
});

test('budget reservation pauses before a paid executor call', async () => {
  const paid = executor('breakdown', { state: 'succeeded' }, { estimateCostMicros: 2_000_000, requiresPaid: true, provider: 'test' });
  const { service } = await make({ executors: [paid] }); const created = await service.create(input({ budgetMicros: 1_000_000 }));
  await service.tick(created.id); await service.tick(created.id);
  const run = await service.get(created.id);
  assert.equal(run.status, 'pausedBudget');
  assert.equal(run.tasks.find(task => task.stage === 'breakdown').status, 'waitingHuman');
  assert.equal(paid.calls(), 0);
  assert.equal(run.inbox.find(issue => issue.code === 'PRODUCTION_BUDGET_EXCEEDED').estimatedAdditionalCostMicros, 1_000_000);
});

test('raiseBudget unlocks a budget-paused run in place without re-paying finished stages', async () => {
  const paid = executor('breakdown', { state: 'succeeded' }, { estimateCostMicros: 2_000_000, requiresPaid: true, provider: 'test' });
  const { service } = await make({ executors: [paid] }); const created = await service.create(input({ budgetMicros: 1_000_000 }));
  await service.tick(created.id); await service.tick(created.id);
  let run = await service.get(created.id);
  assert.equal(run.status, 'pausedBudget');
  assert.equal(run.tasks.find(task => task.stage === 'breakdown').status, 'waitingHuman');
  assert.equal(paid.calls(), 0);
  assert.ok(run.inbox.some(issue => issue.code === 'PRODUCTION_BUDGET_EXCEEDED' && issue.status === 'open'));

  await assert.rejects(service.action(created.id, { type: 'raiseBudget', budgetMicros: 1_000_000, reason: 'no' }),
    error => error.code === 'PRODUCTION_BUDGET_NOT_RAISED');

  run = await service.action(created.id, { type: 'raiseBudget', budgetMicros: 5_000_000, reason: '继续授权' });
  assert.equal(run.status, 'running');
  assert.equal(run.tasks.find(task => task.stage === 'breakdown').status, 'ready');
  assert.equal(run.summary.budget.limitMicros, 5_000_000);

  await service.tick(created.id); await service.tick(created.id); await service.tick(created.id);
  run = await service.get(created.id);
  assert.equal(run.tasks.find(task => task.stage === 'breakdown').status, 'succeeded');
  assert.equal(paid.calls(), 1);
  assert.ok(run.inbox.every(issue => issue.code !== 'PRODUCTION_BUDGET_EXCEEDED' || issue.status === 'resolved'));
});

test('an external submission is never submitted twice and missing reconciliation becomes human work', async () => {
  const paid = executor('breakdown', { state: 'waitingExternal', providerTaskId: 'provider-1' },
    { estimateCostMicros: 100, requiresPaid: true, provider: 'test-provider' });
  const { repo, service } = await make({ executors: [paid] }); const created = await service.create(input());
  await service.tick(created.id); await service.tick(created.id);
  let run = await service.get(created.id);
  assert.equal(run.tasks.find(task => task.stage === 'breakdown').status, 'waitingExternal');
  assert.equal(paid.calls(), 1);
  await service.tick(created.id);
  run = await service.get(created.id);
  assert.equal(run.tasks.find(task => task.stage === 'breakdown').status, 'waitingHuman');
  assert.equal(run.externalOperations[0].providerTaskId, 'provider-1');
  assert.equal(paid.calls(), 1);
  const restarted = new ProductionService(repo, { pollIntervalMs: 60_000, executors: [paid] });
  await restarted.start(); restarted.stop();
  assert.equal(paid.calls(), 1);
});

test('local retry invalidates only descendants and preserves completed ancestors', async () => {
  const failing = executor('assets', (_context, call) => call === 1
    ? { state: 'failed', code: 'ASSET_MATCH_LOW_CONFIDENCE', message: '匹配置信不足', retryable: true }
    : { state: 'succeeded' });
  const { service } = await make({ executors: [executor('breakdown'), failing] }); const created = await service.create(input());
  await ticks(service, 4); let run = await service.get(created.id);
  const assets = run.tasks.find(task => task.stage === 'assets');
  assert.equal(assets.status, 'waitingHuman');
  const prepareId = run.tasks.find(task => task.stage === 'prepare').id;
  run = await service.action(run.id, { type: 'retryTask', taskId: assets.id, reason: '更新匹配策略' });
  assert.equal(run.tasks.find(task => task.id === prepareId).status, 'succeeded');
  assert.equal(run.tasks.find(task => task.id === assets.id).status, 'ready');
  assert.ok(run.tasks.filter(task => task.stage === 'storyboard').every(task => task.status === 'pending'));
  await service.tick(run.id); run = await service.get(run.id);
  assert.equal(run.tasks.find(task => task.id === assets.id).status, 'succeeded');
  assert.equal(failing.calls(), 2);
});

test('dynamic task expansion rejects a cycle instead of corrupting the DAG', async () => {
  const cyclic = executor('storyboard', ({ run }) => {
    const compose = run.tasks.find(task => task.stage === 'compose');
    return { state: 'succeeded', spawnTasks: [{ key: 'bad-review', stage: 'review', label: '循环复核',
      scope: { kind: 'shot', id: 'S01-01' }, dependsOn: [compose.id] }] };
  });
  const { service } = await make({ executors: [executor('breakdown'), executor('assets'), cyclic] });
  const created = await service.create(input()); await ticks(service, 5); const run = await service.get(created.id);
  const storyboard = run.tasks.find(task => task.stage === 'storyboard');
  assert.equal(storyboard.status, 'failed');
  assert.equal(run.tasks.filter(task => task.scope.kind === 'shot').length, 0);
});

test('retrying an episode expansion supersedes the stale dynamic branch', async () => {
  const changingStoryboard = executor('storyboard', (_context, call) => ({ state: 'succeeded', spawnTasks: [
    { key: `shot-${call}-assets`, stage: 'assets', label: `镜头 ${call} 资产`, scope: { kind: 'shot', id: `shot-${call}` } },
    { key: `shot-${call}-review`, stage: 'review', label: `镜头 ${call} 复核`, scope: { kind: 'shot', id: `shot-${call}` },
      dependsOn: [`shot-${call}-assets`] },
  ] }));
  const { service } = await make({ executors: [executor('breakdown'), executor('assets'), changingStoryboard] });
  const created = await service.create(input({ clientRequestId: 'replace-shot-branch' }));
  await ticks(service, 4); let run = await service.get(created.id);
  const storyboard = run.tasks.find(task => task.stage === 'storyboard' && task.scope.kind === 'episode');
  assert.deepEqual(run.shotMatrix.map(shot => shot.shotId), ['shot-1']);
  run = await service.review(run.id, { taskId: storyboard.id, decision: 'reject', issueId: null,
    candidateId: null, feedback: '重新生成分镜' });
  run = await service.action(run.id, { type: 'retryTask', taskId: storyboard.id, reason: '重新生成分镜' });
  await service.tick(run.id); run = await service.get(run.id);
  assert.deepEqual(run.shotMatrix.map(shot => shot.shotId), ['shot-2']);
  assert.ok(run.tasks.filter(task => task.scope.kind === 'shot' && task.scope.id === 'shot-1')
    .every(task => task.status === 'superseded'));
  assert.ok(run.tasks.some(task => task.scope.kind === 'shot' && task.scope.id === 'shot-2'));
});

test('memory repository compare-and-swap and immutable input prevent stale overwrite', async () => {
  const { repo, service } = await make(); const created = await service.create(input());
  const first = await repo.get(created.id); const changed = structuredClone(first); changed.status = 'running';
  const saved = await repo.replace(changed, first.version); assert.equal(saved.version, 1);
  await assert.rejects(repo.replace(first, first.version), error => error.code === 'PRODUCTION_RUN_CONFLICT');
  const mutated = structuredClone(saved); mutated.visualStyle = '偷换输入';
  await assert.rejects(repo.replace(mutated, saved.version), error => error.code === 'PRODUCTION_RUN_CONFLICT');
});

test('strict input and review parsing reject caller-controlled fields', async () => {
  const { service } = await make();
  for (const bad of [null, {}, input({ allowPaid: false }), input({ ratio: '1:1' }), input({ budgetMicros: -1 }),
    { ...input(), providerApiKey: 'secret' }]) {
    await assert.rejects(service.create(bad), error => error.code === 'PRODUCTION_REQUEST_INVALID');
  }
  const run = await service.create(input());
  await assert.rejects(service.action(run.id, { type: 'resume', allowPaid: true }), error => error.code === 'PRODUCTION_REQUEST_INVALID');
  await assert.rejects(service.review(run.id, { taskId: run.tasks[0].id, decision: 'approve', secret: 'x' }),
    error => error.code === 'PRODUCTION_REQUEST_INVALID');
});

test('resolveIssue cannot bypass capability, checkpoint, quality, candidate, unknown, or failure gates', async () => {
  const { service } = await make(); const created = await service.create(input({ clientRequestId: 'gate-resolution' }));
  await service.tick(created.id); await service.tick(created.id);
  let run = await service.get(created.id); const task = run.tasks.find(item => item.stage === 'breakdown');
  const issue = run.inbox.find(item => item.taskId === task.id && item.code === 'CAPABILITY_UNAVAILABLE');
  await assert.rejects(service.review(run.id, { taskId: task.id, decision: 'resolveIssue', issueId: issue.id,
    candidateId: null, feedback: '已处理' }), error => error.code === 'PRODUCTION_ISSUE_RESOLUTION_NOT_ALLOWED');
  run = await service.get(run.id);
  assert.equal(run.tasks.find(item => item.id === task.id).status, 'waitingHuman');
  assert.equal(run.inbox.find(item => item.id === issue.id).status, 'open');
});

test('retryTask force overrides an exhausted attempt limit after an infrastructure fix', async () => {
  const flaky = executor('breakdown', (_context, calls) => calls >= 3 ? { state: 'succeeded' } : {
    state: 'blocked', issue: { code: 'PROVIDER_VIDEO_LOCALIZATION_FAILED', message: '远程视频下载失败。' },
  });
  const { service } = await make({ executors: [flaky] });
  const created = await service.create(input({ clientRequestId: 'force-retry' }));
  await service.tick(created.id);
  await service.tick(created.id);
  await service.action(created.id, { type: 'retryTask', taskId: created.tasks.find(task => task.stage === 'breakdown').id, reason: '第一次重试' });
  await service.tick(created.id);
  let run = await service.get(created.id);
  const task = run.tasks.find(item => item.stage === 'breakdown');
  assert.equal(task.status, 'waitingHuman');
  assert.equal(task.attemptCount, 2);
  assert.equal(task.maxAttempts, 2);
  await assert.rejects(service.action(created.id, { type: 'retryTask', taskId: task.id, reason: '不再付费重试' }),
    error => error.code === 'PRODUCTION_RETRY_LIMIT');
  run = await service.action(created.id, { type: 'retryTask', taskId: task.id, reason: '基础设施已修复，强制重试', force: true });
  const forced = run.tasks.find(item => item.id === task.id);
  assert.equal(forced.status, 'ready');
  assert.equal(forced.maxAttempts, 3);
  await service.tick(created.id); run = await service.get(created.id);
  assert.equal(run.tasks.find(item => item.id === task.id).status, 'succeeded');
  assert.equal(flaky.calls(), 3);
});

test('scheduler blocks a ready task whose durable attempt limit is already exhausted', async () => {
  const work = executor('breakdown'); const { repo, service } = await make({ executors: [work] });
  const created = await service.create(input({ qualityPreset: 'fast', clientRequestId: 'attempt-cap' }));
  await service.tick(created.id);
  const stored = await repo.get(created.id); const task = stored.tasks.find(item => item.stage === 'breakdown');
  task.attemptCount = task.maxAttempts; task.status = 'ready';
  await repo.replace(stored, stored.version);
  await service.tick(created.id);
  const run = await service.get(created.id); const blocked = run.tasks.find(item => item.id === task.id);
  assert.equal(blocked.status, 'failed'); assert.equal(blocked.blockingReason.code, 'PRODUCTION_RETRY_LIMIT');
  assert.equal(work.calls(), 0);
});

test('queued ticks are serialized and stop waits for the in-flight and already queued work', async () => {
  let release; let entered;
  const inside = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const breakdown = executor('breakdown', async () => { entered(); await gate; return { state: 'succeeded' }; });
  const { service } = await make({ executors: [breakdown] });
  const created = await service.create(input({ clientRequestId: 'serialized-ticks' }));
  await service.tick(created.id);
  const first = service.tick(created.id); await inside;
  const second = service.tick(created.id);
  let stopped = false; const stopping = service.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  release(); await Promise.all([first, second, stopping]);
  const run = await service.get(created.id);
  assert.equal(breakdown.calls(), 1);
  assert.equal(run.tasks.find(item => item.stage === 'breakdown').status, 'succeeded');
  assert.equal(run.tasks.find(item => item.stage === 'assets').blockingReason.code, 'CAPABILITY_UNAVAILABLE');
});

test('one tick reconciles an external task and still advances one independent ready branch', async () => {
  let reconciles = 0;
  const external = {
    stage: 'breakdown',
    async prepare({ task }) { return { executor: 'external-test/1', inputDigest: task.inputManifest[0].digest,
      estimateCostMicros: 100, requiresPaid: true, provider: 'offline-test' }; },
    async execute() { return { state: 'waitingExternal', providerTaskId: 'provider_parallel' }; },
    async reconcile() { reconciles++; return { state: 'waitingExternal', providerTaskId: 'provider_parallel' }; },
  };
  const assets = executor('assets'); const { repo, service } = await make({ executors: [external, assets] });
  const created = await service.create(input({ clientRequestId: 'parallel-branch' }));
  await service.tick(created.id);
  const stored = await repo.get(created.id); const assetTask = stored.tasks.find(item => item.stage === 'assets');
  assetTask.dependencies = [];
  await repo.replace(stored, stored.version);
  await service.tick(created.id);
  let run = await service.get(created.id);
  assert.equal(run.tasks.find(item => item.stage === 'breakdown').status, 'waitingExternal');
  assert.equal(run.tasks.find(item => item.stage === 'assets').status, 'ready');
  await service.tick(created.id); run = await service.get(created.id);
  assert.equal(reconciles, 1); assert.equal(assets.calls(), 1);
  assert.equal(run.tasks.find(item => item.stage === 'assets').status, 'succeeded');
  assert.equal(run.tasks.find(item => item.stage === 'breakdown').status, 'waitingExternal');
});

test('temporary executor back-pressure consumes no attempt and lets another ready branch advance', async () => {
  let executes = 0;
  const deferred = { stage: 'breakdown', async prepare({ task }) { return { executor: 'deferred/1',
    inputDigest: task.inputManifest[0].digest, estimateCostMicros: 0, requiresPaid: false, provider: null,
    defer: { code: 'LOCAL_SLOT_BUSY', message: '本机通道繁忙' } }; }, async execute() { executes++; return { state: 'succeeded' }; } };
  const assets = executor('assets'); const { repo, service } = await make({ executors: [deferred, assets] });
  const created = await service.create(input({ clientRequestId: 'deferred-ready' })); await service.tick(created.id);
  const stored = await repo.get(created.id); const assetTask = stored.tasks.find(item => item.stage === 'assets');
  assetTask.dependencies = []; await repo.replace(stored, stored.version);
  await service.tick(created.id); const run = await service.get(created.id);
  const breakdown = run.tasks.find(item => item.stage === 'breakdown');
  assert.equal(breakdown.status, 'ready'); assert.equal(breakdown.attemptCount, 0); assert.equal(executes, 0);
  assert.equal(run.tasks.find(item => item.stage === 'assets').status, 'succeeded'); assert.equal(assets.calls(), 1);
});

test('pause CAS conflict preserves an already returned provider task instead of marking executor failure', async () => {
  let release; let entered; let submissions = 0;
  const inside = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const paid = {
    stage: 'breakdown',
    async prepare({ task }) { return { executor: 'pause-paid/1', inputDigest: task.inputManifest[0].digest,
      estimateCostMicros: 100, requiresPaid: true, provider: 'offline-test' }; },
    async execute() { submissions++; entered(); await gate; return { state: 'waitingExternal', providerTaskId: 'provider_after_pause' }; },
    async reconcile() { return { state: 'succeeded', actualCostMicros: 100 }; },
  };
  const { service } = await make({ executors: [paid] }); const created = await service.create(input({ clientRequestId: 'pause-cas' }));
  await service.tick(created.id);
  const ticking = service.tick(created.id); await inside;
  await service.action(created.id, { type: 'pause' }); release(); await ticking;
  let run = await service.get(created.id); const task = run.tasks.find(item => item.stage === 'breakdown');
  assert.equal(run.status, 'paused'); assert.equal(task.status, 'waitingExternal');
  assert.equal(run.externalOperations[0].providerTaskId, 'provider_after_pause');
  assert.equal(run.externalOperations[0].status, 'submitted');
  assert.equal(run.inbox.some(item => item.code === 'EXECUTOR_FAILED'), false);
  await service.action(run.id, { type: 'resume' }); await service.tick(run.id); run = await service.get(run.id);
  assert.equal(run.tasks.find(item => item.id === task.id).status, 'succeeded'); assert.equal(submissions, 1);
});

test('a second outcome CAS conflict persists a reconciliation gate and never resubmits the paid request', async () => {
  class OutcomeConflictsTwiceRepository {
    constructor() { this.inner = new MemoryProductionRepository(); this.conflicts = 0; }
    list() { return this.inner.list(); }
    get(id) { return this.inner.get(id); }
    getByClientRequestId(id) { return this.inner.getByClientRequestId(id); }
    create(run) { return this.inner.create(run); }
    replace(run, expectedVersion) {
      if (run.outbox.at(-1)?.type === 'production.external.submitted' && this.conflicts < 2) {
        this.conflicts++;
        throw new ProductionError(409, 'PRODUCTION_RUN_CONFLICT', 'synthetic concurrent update');
      }
      return this.inner.replace(run, expectedVersion);
    }
  }
  let submissions = 0; let reconciliations = 0;
  const paid = {
    stage: 'breakdown',
    async prepare({ task }) { return { executor: 'cas-paid/1', inputDigest: task.inputManifest[0].digest,
      estimateCostMicros: 100, requiresPaid: true, provider: 'offline-test' }; },
    async execute() { submissions++; return { state: 'waitingExternal', providerTaskId: 'provider_after_two_conflicts' }; },
    async reconcile() { reconciliations++; return { state: 'succeeded', actualCostMicros: 100 }; },
  };
  const repo = new OutcomeConflictsTwiceRepository();
  const { service } = await make({ repo, executors: [paid] });
  const created = await service.create(input({ clientRequestId: 'outcome-double-cas' }));
  await service.tick(created.id); await service.tick(created.id);
  let run = await service.get(created.id); const task = run.tasks.find(item => item.stage === 'breakdown');
  const operation = run.externalOperations.find(item => item.taskId === task.id);
  assert.equal(repo.conflicts, 2); assert.equal(submissions, 1);
  assert.equal(task.status, 'reconciling'); assert.equal(task.blockingReason.code, 'EXTERNAL_OUTCOME_UNKNOWN_AFTER_CONFLICT');
  assert.equal(operation.status, 'unknown'); assert.equal(operation.providerTaskId, 'provider_after_two_conflicts');
  assert.equal(run.summary.budget.reservedMicros, 100); assert.equal(run.summary.budget.spentMicros, 0);
  assert.ok(run.inbox.some(item => item.code === 'EXTERNAL_OUTCOME_UNKNOWN_AFTER_CONFLICT'));
  await service.tick(run.id); run = await service.get(run.id);
  assert.equal(reconciliations, 1); assert.equal(submissions, 1);
  assert.equal(run.tasks.find(item => item.id === task.id).status, 'succeeded');
  assert.equal(run.summary.budget.reservedMicros, 0); assert.equal(run.summary.budget.spentMicros, 100);
});

test('a stale reconciliation failure cannot overwrite a concurrently completed external operation', async () => {
  let beginReconcile; let rejectReconcile;
  const reconciling = new Promise(resolve => { beginReconcile = resolve; });
  const finish = new Promise((_, reject) => { rejectReconcile = reject; });
  const paid = {
    stage: 'breakdown',
    async prepare({ task }) { return { executor: 'reconcile-cas/1', inputDigest: task.inputManifest[0].digest,
      estimateCostMicros: 100, requiresPaid: true, provider: 'offline-test' }; },
    async execute() { return { state: 'waitingExternal', providerTaskId: 'provider_reconcile_cas' }; },
    async reconcile() { beginReconcile(); return finish; },
  };
  const { repo, service } = await make({ executors: [paid] });
  const created = await service.create(input({ clientRequestId: 'reconcile-cas-completion' }));
  await service.tick(created.id); await service.tick(created.id);
  const ticking = service.tick(created.id); await reconciling;
  const concurrent = await repo.get(created.id);
  const task = concurrent.tasks.find(item => item.stage === 'breakdown');
  const operation = concurrent.externalOperations.find(item => item.taskId === task.id);
  const attempt = concurrent.attempts.find(item => item.id === operation.attemptId);
  operation.status = 'succeeded'; operation.actualCostMicros = 100;
  task.status = 'succeeded'; task.blockingReason = null;
  attempt.status = 'succeeded'; attempt.endedAt = concurrent.updatedAt;
  await repo.replace(concurrent, concurrent.version);
  rejectReconcile(new Error('stale query failed')); await ticking;
  const run = await service.get(created.id);
  assert.equal(run.tasks.find(item => item.id === task.id).status, 'succeeded');
  assert.equal(run.externalOperations.find(item => item.id === operation.id).status, 'succeeded');
  assert.equal(run.inbox.some(item => item.code === 'EXTERNAL_RECONCILIATION_FAILED'), false);
});

test('a successful shot repair review closes the earlier automated repair notice', async () => {
  const review = executor('review'); const { repo, service } = await make({ executors: [review] });
  const created = await service.create(input({ clientRequestId: 'repair-notice-close' })); await service.tick(created.id);
  const stored = await repo.get(created.id); const task = stored.tasks.find(item => item.stage === 'review');
  for (const item of stored.tasks) if (item.id !== task.id && item.stage !== 'prepare') {
    item.status = 'waitingHuman'; item.blockingReason = { code: 'TEST_HOLD', message: '离线测试占位' };
  }
  task.scope = { kind: 'shot', id: 'shot_repaired' }; task.dependencies = []; task.status = 'ready';
  stored.issues.push({ id: 'pissue_repair_notice', runId: stored.id, taskId: task.id, stage: 'review',
    scope: { kind: 'shot', id: 'shot_repaired' }, severity: 'warning', status: 'open', code: 'AUTOMATED_REPAIR_SCHEDULED',
    title: '已进入局部返修', message: '等待返修复核', impact: ['镜头'], recommendedActions: [],
    estimatedAdditionalCostMicros: null, createdAt: stored.updatedAt, resolvedAt: null });
  await repo.replace(stored, stored.version); await service.tick(created.id);
  const run = await service.get(created.id); const notice = run.issues.find(item => item.id === 'pissue_repair_notice');
  assert.equal(run.tasks.find(item => item.id === task.id).status, 'succeeded'); assert.equal(notice.status, 'resolved');
});

test('reported actual cost cannot exceed the durable reservation or complete the task', async () => {
  const over = executor('breakdown', { state: 'succeeded', actualCostMicros: 200,
    artifacts: [{ key: 'must-not-persist', kind: 'report', title: '未授权成果' }] },
  { estimateCostMicros: 100, requiresPaid: true, provider: 'offline-test' });
  const { service } = await make({ executors: [over] }); const created = await service.create(input({ clientRequestId: 'cost-overrun' }));
  await service.tick(created.id); await service.tick(created.id);
  const run = await service.get(created.id); const task = run.tasks.find(item => item.stage === 'breakdown');
  assert.equal(task.status, 'waitingHuman'); assert.equal(task.blockingReason.code, 'PRODUCTION_ACTUAL_COST_UNAUTHORIZED');
  assert.equal(run.summary.budget.spentMicros, 0); assert.equal(run.summary.budget.reservedMicros, 100);
  assert.equal(run.artifacts.some(item => item.metadata.key === 'must-not-persist'), false);
  assert.equal(run.externalOperations[0].status, 'unknown'); assert.equal(run.externalOperations[0].actualCostMicros, null);
});

test('an external submission cannot report more than its reservation while entering reconciliation', async () => {
  const over = executor('breakdown', { state: 'waitingExternal', providerTaskId: 'provider_cost_overrun', actualCostMicros: 200 },
    { estimateCostMicros: 100, requiresPaid: true, provider: 'offline-test' });
  const { service } = await make({ executors: [over] });
  const created = await service.create(input({ clientRequestId: 'external-cost-overrun' }));
  await service.tick(created.id); await service.tick(created.id);
  const run = await service.get(created.id); const task = run.tasks.find(item => item.stage === 'breakdown');
  assert.equal(task.status, 'waitingHuman'); assert.equal(task.blockingReason.code, 'PRODUCTION_ACTUAL_COST_UNAUTHORIZED');
  assert.equal(run.summary.budget.spentMicros, 0); assert.equal(run.summary.budget.reservedMicros, 100);
  assert.equal(run.externalOperations[0].providerTaskId, 'provider_cost_overrun');
  assert.equal(run.externalOperations[0].status, 'unknown'); assert.equal(run.externalOperations[0].actualCostMicros, null);
});

test('an uncertain paid result retains its reservation and blocks a second submission', async () => {
  const uncertain = executor('breakdown', { state: 'waitingHuman', operationUnknown: true,
    artifacts: [{ key: 'uncertain-local-run', kind: 'report', title: '原本地任务' }],
    issue: { code: 'MODEL_EXECUTION_UNKNOWN', title: '模型调用结果不明', message: '需要对账', severity: 'error' } },
  { estimateCostMicros: 100, requiresPaid: true, provider: 'offline-test' });
  const { service } = await make({ executors: [uncertain] });
  const created = await service.create(input({ clientRequestId: 'paid-result-unknown' }));
  await service.tick(created.id); await service.tick(created.id);
  const run = await service.get(created.id); const task = run.tasks.find(item => item.stage === 'breakdown');
  const operation = run.externalOperations[0]; const attempt = run.attempts.find(item => item.id === operation.attemptId);
  assert.equal(task.status, 'waitingHuman'); assert.equal(task.blockingReason.code, 'MODEL_EXECUTION_UNKNOWN');
  assert.equal(operation.status, 'unknown'); assert.equal(operation.actualCostMicros, null);
  assert.equal(attempt.status, 'interrupted');
  assert.equal(run.summary.budget.spentMicros, 0); assert.equal(run.summary.budget.reservedMicros, 100);
  assert.equal(run.artifacts.some(item => item.metadata.key === 'uncertain-local-run'), true);
  await assert.rejects(service.action(run.id, { type: 'retryTask', taskId: task.id, reason: '再试一次' }),
    error => error.code === 'PRODUCTION_EXTERNAL_OPERATION_UNKNOWN');
  assert.equal(uncertain.calls(), 1);
});

test('abandonOperation releases an irrecoverable synchronous submission and requeues the task', async () => {
  let executions = 0;
  const synchronous = {
    stage: 'breakdown',
    calls: () => executions,
    async prepare({ task }) { return { executor: 'test-abandon/1', inputDigest: task.inputManifest[0].digest,
      estimateCostMicros: 100, requiresPaid: true, provider: 'offline-test' }; },
    async execute() { executions++;
      return executions === 1
        ? { state: 'waitingHuman', operationUnknown: true,
            issue: { code: 'MODEL_EXECUTION_UNKNOWN', title: '模型调用结果不明', message: '同步接口无任务号，无法查询。', severity: 'error' } }
        : { state: 'succeeded', actualCostMicros: 60 }; },
  };
  const { service } = await make({ executors: [synchronous] });
  const created = await service.create(input({ clientRequestId: 'abandon-unknown-op' }));
  await service.tick(created.id); await service.tick(created.id);
  let run = await service.get(created.id); let task = run.tasks.find(item => item.stage === 'breakdown');
  assert.equal(task.status, 'waitingHuman');
  assert.equal(run.externalOperations[0].status, 'unknown');
  assert.equal(run.externalOperations[0].providerTaskId, null);
  assert.equal(run.summary.budget.reservedMicros, 100); assert.equal(run.summary.budget.spentMicros, 0);
  // The double-charge guard still blocks a plain retry for provider-less ops.
  await assert.rejects(service.action(run.id, { type: 'retryTask', taskId: task.id, reason: '再试一次' }),
    error => error.code === 'PRODUCTION_EXTERNAL_OPERATION_UNKNOWN');
  assert.equal(executions, 1);
  // Human authority: abandoning the original result releases the guard.
  run = await service.action(run.id, { type: 'abandonOperation', taskId: task.id, reason: '人工确认同步结果不可恢复，放弃原调用' });
  task = run.tasks.find(item => item.stage === 'breakdown');
  assert.equal(run.externalOperations[0].status, 'abandoned');
  assert.equal(task.status, 'ready');
  assert.equal(task.blockingReason, null);
  assert.equal(run.issues.some(item => item.code === 'MODEL_EXECUTION_UNKNOWN' && item.status === 'open'), false);
  await ticks(service);
  run = await service.get(created.id); task = run.tasks.find(item => item.stage === 'breakdown');
  assert.equal(task.status, 'succeeded');
  assert.equal(run.externalOperations.length, 2);
  assert.equal(run.externalOperations[1].status, 'succeeded');
  assert.equal(run.summary.budget.spentMicros, 60);
  assert.equal(run.summary.budget.reservedMicros, 0);
  // Terminal tasks cannot be abandoned again.
  await assert.rejects(service.action(run.id, { type: 'abandonOperation', taskId: task.id, reason: '再次放弃' }),
    error => error.code === 'PRODUCTION_TASK_NOT_ABANDONABLE');
});

test('a manual retry reconciles a definitively failed external operation and resubmits', async () => {
  const script = [];
  const reconciling = {
    stage: 'breakdown',
    calls: () => script.filter(item => item.kind === 'execute').length,
    async prepare({ task }) { return { executor: 'test-reconcile/1', inputDigest: task.inputManifest[0].digest,
      estimateCostMicros: 100, requiresPaid: true, provider: 'offline-test' }; },
    async execute() { script.push({ kind: 'execute' });
      return script.filter(item => item.kind === 'execute').length === 1
        ? { state: 'waitingExternal', providerTaskId: 'draft-run-1' }
        : { state: 'succeeded', actualCostMicros: 60 }; },
    async reconcile(_context, operation) { script.push({ kind: 'reconcile', providerTaskId: operation.providerTaskId });
      return script.filter(item => item.kind === 'reconcile').length === 1
        ? { state: 'waitingHuman', operationUnknown: true,
            issue: { code: 'MODEL_EXECUTION_UNKNOWN', title: '模型调用结果不明', message: '付费请求超时，需要人工对账。', severity: 'error' } }
        : { state: 'failed', code: 'BREAKDOWN_RUN_FAILED', message: '原拆解执行已确认失败。', retryable: false }; },
  };
  const { service } = await make({ executors: [reconciling] });
  const created = await service.create(input({ clientRequestId: 'retry-reconciles-failed-op' }));
  await service.tick(created.id);
  await service.tick(created.id);
  await service.tick(created.id);
  let run = await service.get(created.id); let task = run.tasks.find(item => item.stage === 'breakdown');
  assert.equal(task.status, 'waitingHuman'); assert.equal(task.blockingReason.code, 'MODEL_EXECUTION_UNKNOWN');
  assert.equal(run.externalOperations[0].status, 'unknown');
  assert.equal(run.externalOperations[0].providerTaskId, 'draft-run-1');
  assert.equal(run.summary.budget.reservedMicros, 100); assert.equal(run.summary.budget.spentMicros, 0);
  run = await service.action(run.id, { type: 'retryTask', taskId: task.id, reason: '人工确认原调用已失败后重试' });
  task = run.tasks.find(item => item.stage === 'breakdown');
  assert.equal(script.filter(item => item.kind === 'reconcile').length, 2);
  assert.equal(run.externalOperations[0].status, 'failed');
  assert.equal(task.status, 'ready');
  await ticks(service);
  run = await service.get(created.id); task = run.tasks.find(item => item.stage === 'breakdown');
  assert.equal(task.status, 'succeeded');
  assert.equal(run.externalOperations.length, 2);
  assert.equal(run.externalOperations[1].status, 'succeeded');
  assert.equal(run.summary.budget.spentMicros, 60);
  assert.equal(run.summary.budget.reservedMicros, 0);
});
test('direct candidate policy skips the gacha stage and re-routes review to the video stage', async () => {
  const { service } = await make();
  const run = await service.create(input({ candidatePolicy: 'direct', candidateLimit: 1, clientRequestId: 'production-direct-1' }));
  const stageTask = key => run.tasks.find(task => task.stage === key && task.scope.kind === 'episode');
  const candidates = stageTask('candidates');
  assert.equal(candidates.status, 'skipped');
  assert.equal(candidates.blockingReason.code, 'CANDIDATE_POLICY_DISABLED');
  assert.deepEqual(stageTask('review').dependencies, [stageTask('video').id]);
  assert.deepEqual(stageTask('video').dependencies, [stageTask('director').id]);
});

test('direct and gacha flows enforce their own candidate limits at creation time', async () => {
  const { service } = await make();
  const invalid = /创建参数不完整或超出限制/;
  await assert.rejects(service.create(input({ candidatePolicy: 'direct', candidateLimit: 2 })), invalid);
  await assert.rejects(service.create(input({ candidatePolicy: 'gacha', candidateLimit: 1 })), invalid);
  await assert.rejects(service.create(input({ candidatePolicy: 'random', candidateLimit: 1 })), invalid);
});

test('a partial run accepts repair actions instead of requiring database surgery', async () => {
  let assetCalls = 0;
  const breakdownOk = executor('breakdown', () => ({ state: 'succeeded',
    artifacts: [{ key: 'breakdown-plan', kind: 'report', title: '拆解计划', metadata: { facts: [] } }] }));
  const assets = {
    stage: 'assets', calls: () => assetCalls,
    async prepare({ task }) { return { executor: 'test-assets/1', inputDigest: task.inputManifest[0].digest,
      estimateCostMicros: 0, requiresPaid: false, provider: null }; },
    async execute() { assetCalls++; return assetCalls === 1
      ? { state: 'failed', code: 'ASSETS_MISSING', message: '参考图缺失。', retryable: false }
      : { state: 'succeeded', artifacts: [{ key: 'asset-report', kind: 'report', title: '资产就绪', metadata: {} }] }; },
  };
  const { service } = await make({ executors: [breakdownOk, assets] });
  const created = await service.create(input({ clientRequestId: 'partial-repair' }));
  await ticks(service, 6);
  let run = await service.get(created.id);
  assert.equal(run.status, 'partial');
  const task = run.tasks.find(item => item.stage === 'assets');
  assert.equal(task.status, 'failed');
  // The repair action must pass the old PRODUCTION_RUN_TERMINAL gate.
  run = await service.action(run.id, { type: 'retryTask', taskId: task.id, reason: '补好参考图后重跑' });
  assert.notEqual(run.status, 'partial');
  assert.equal(run.tasks.find(item => item.id === task.id).status, 'ready');
  await ticks(service, 6);
  run = await service.get(created.id);
  assert.equal(run.tasks.find(item => item.id === task.id).status, 'succeeded');
});

test('partial runs still reject non-repair actions such as pause', async () => {
  const breakdownOk = executor('breakdown', () => ({ state: 'succeeded',
    artifacts: [{ key: 'breakdown-plan', kind: 'report', title: '拆解计划', metadata: {} }] }));
  const assetsFail = executor('assets', () => ({ state: 'failed', code: 'ASSETS_MISSING', message: '参考图缺失。', retryable: false }));
  const { service } = await make({ executors: [breakdownOk, assetsFail] });
  const created = await service.create(input({ clientRequestId: 'partial-no-pause' }));
  await ticks(service, 6);
  const run = await service.get(created.id);
  assert.equal(run.status, 'partial');
  await assert.rejects(service.action(run.id, { type: 'pause' }),
    error => error.code === 'PRODUCTION_RUN_TERMINAL');
});

test('a succeeded task can be rerun with force when downstream inputs change', async () => {
  let calls = 0;
  const breakdown = executor('breakdown', () => { calls++; return { state: 'succeeded',
    artifacts: [{ key: 'breakdown-plan', kind: 'report', title: '拆解计划', metadata: { revision: calls } }] }; });
  const assets = executor('assets', () => ({ state: 'succeeded',
    artifacts: [{ key: 'asset-report', kind: 'report', title: '资产就绪', metadata: {} }] }));
  const { service } = await make({ executors: [breakdown, assets] });
  const created = await service.create(input({ clientRequestId: 'rerun-succeeded' }));
  await ticks(service, 4);
  let run = await service.get(created.id);
  const task = run.tasks.find(item => item.stage === 'breakdown');
  assert.equal(task.status, 'succeeded');
  await assert.rejects(service.action(run.id, { type: 'retryTask', taskId: task.id, reason: '未显式确认' }),
    error => error.code === 'PRODUCTION_RETRY_REQUIRES_FORCE');
  run = await service.action(run.id, { type: 'retryTask', taskId: task.id, reason: '目标时长变化后重跑', force: true });
  assert.equal(run.tasks.find(item => item.id === task.id).status, 'ready');
  // The stale artifact and its downstream must be invalidated, not silently kept.
  assert.equal(run.artifacts.filter(item => item.taskId === task.id && item.status === 'current').length, 0);
  await ticks(service, 4);
  run = await service.get(created.id);
  assert.equal(run.tasks.find(item => item.id === task.id).status, 'succeeded');
  assert.equal(calls, 2);
});

test('reconcileOperation re-queries an unknown external operation without resubmitting', async () => {
  let reconcileCalls = 0;
  const reconciling = {
    stage: 'breakdown',
    async prepare({ task }) { return { executor: 'test-manual-reconcile/1', inputDigest: task.inputManifest[0].digest,
      estimateCostMicros: 100, requiresPaid: true, provider: 'offline-test' }; },
    async execute() { return { state: 'waitingExternal', providerTaskId: 'draft-run-9' }; },
    async reconcile() { reconcileCalls++;
      return reconcileCalls === 1
        ? { state: 'waitingHuman', operationUnknown: true,
            issue: { code: 'MODEL_EXECUTION_UNKNOWN', title: '模型调用结果不明', message: '付费请求超时，需要人工对账。', severity: 'error' } }
        : { state: 'succeeded', actualCostMicros: 60 }; },
  };
  const { service } = await make({ executors: [reconciling] });
  const created = await service.create(input({ clientRequestId: 'manual-reconcile' }));
  await ticks(service, 6);
  let run = await service.get(created.id);
  const task = run.tasks.find(item => item.stage === 'breakdown');
  assert.equal(task.status, 'waitingHuman');
  assert.equal(run.externalOperations[0].status, 'unknown');
  run = await service.action(run.id, { type: 'reconcileOperation', taskId: task.id, reason: '人工触发对账' });
  assert.equal(run.tasks.find(item => item.id === task.id).status, 'succeeded');
  assert.equal(run.externalOperations[0].status, 'succeeded');
  assert.equal(reconcileCalls, 2);
});

test('reconcileOperation refuses operations that are not in an unknown state', async () => {
  const { service } = await make();
  const created = await service.create(input({ clientRequestId: 'reconcile-not-needed' }));
  const task = created.tasks.find(item => item.stage === 'breakdown');
  // A task that has never run has no external operation at all: refuse early.
  await assert.rejects(service.action(created.id, { type: 'reconcileOperation', taskId: task.id, reason: '无需对账' }),
    error => error.code === 'PRODUCTION_TASK_NOT_RECONCILABLE' || error.code === 'PRODUCTION_OPERATION_NOT_FOUND');
});

test('reconcileOperations queries every unknown external operation and does not submit again', async () => {
  const queried = [];
  let executions = 0;
  const paid = {
    stage: 'breakdown',
    async prepare({ task }) { return { executor: 'test-batch-reconcile/1', inputDigest: task.inputManifest[0].digest,
      estimateCostMicros: 100, requiresPaid: true, provider: 'offline-test' }; },
    async execute() { executions++;
      return { state: 'waitingHuman', operationUnknown: true,
        issue: { code: 'MODEL_EXECUTION_UNKNOWN', title: '模型调用结果不明', message: '同步接口无任务号。', severity: 'error' } }; },
    async reconcile(_context, operation) { queried.push(operation.providerTaskId);
      return { state: 'succeeded', actualCostMicros: 0 }; },
  };
  const { repo, service } = await make({ executors: [paid] });
  const created = await service.create(input({ clientRequestId: 'batch-reconcile-unknown' }));
  const before = await service.action(created.id, { type: 'reconcileOperations', reason: '尚无未知操作' });
  assert.equal(executions, 0);
  assert.equal(before.tasks.find(item => item.stage === 'prepare').status, 'ready');
  assert.equal(before.tasks.find(item => item.stage === 'breakdown').status, 'pending');
  assert.equal(before.outbox.some(event => event.type === 'production.run.operations_reconciled'), false);
  await service.tick(created.id); await service.tick(created.id);
  const stored = await repo.get(created.id);
  const task = stored.tasks.find(item => item.stage === 'breakdown');
  const operation = stored.externalOperations.find(item => item.taskId === task.id);
  const attempt = stored.attempts.find(item => item.id === operation.attemptId);
  assert.equal(task.status, 'waitingHuman');
  assert.equal(operation.status, 'unknown');
  assert.equal(operation.providerTaskId, null);
  const copyTask = { ...structuredClone(task), id: 'ptask_batchreconcile0000000000000001', label: '第二项未知操作' };
  const copyAttempt = { ...structuredClone(attempt), id: 'pattempt_batchreconcile00000000000001', taskId: copyTask.id };
  const copyOperation = { ...structuredClone(operation), id: 'pop_batchreconcile000000000000000001',
    taskId: copyTask.id, attemptId: copyAttempt.id, providerTaskId: 'provider_batch_2', estimatedCostMicros: 0 };
  stored.tasks.push(copyTask); stored.attempts.push(copyAttempt); stored.externalOperations.push(copyOperation);
  await repo.replace(stored, stored.version);
  let run = await service.action(created.id, { type: 'reconcileOperations', reason: '一次对账两项未知操作' });
  assert.equal(executions, 1);
  assert.deepEqual(queried, ['provider_batch_2']);
  assert.equal(run.externalOperations.find(item => item.id === operation.id).status, 'unknown');
  assert.equal(run.tasks.find(item => item.id === task.id).status, 'waitingHuman');
  assert.equal(run.externalOperations.find(item => item.id === copyOperation.id).status, 'succeeded');
  assert.equal(run.tasks.find(item => item.id === copyTask.id).status, 'succeeded');
  assert.equal(run.summary.budget.spentMicros, 0);
  assert.equal(run.summary.budget.reservedMicros, 100);
  const event = run.outbox.find(item => item.type === 'production.run.operations_reconciled');
  assert.equal(event.payload.reason, '一次对账两项未知操作');
  assert.deepEqual(event.payload.results.map(item => item.taskId), [copyTask.id, task.id].sort((left, right) => left.localeCompare(right)));
  const statusByTask = Object.fromEntries(event.payload.results.map(item => [item.taskId, item.operationStatus]));
  assert.equal(statusByTask[copyTask.id], 'succeeded');
  assert.equal(statusByTask[task.id], 'unknown');
  const version = run.version;
  run = await service.action(created.id, { type: 'reconcileOperations', reason: '没有新的未知操作' });
  assert.equal(executions, 1);
  assert.deepEqual(queried, ['provider_batch_2']);
  assert.equal(run.version, version);
  assert.equal(run.outbox.filter(item => item.type === 'production.run.operations_reconciled').length, 1);
});

test('a thrown local attempt releases its reservation so a retry is not blocked by its own hold', async () => {
  let calls = 0;
  const local = {
    stage: 'breakdown',
    async prepare({ task }) { return { executor: 'test-local-throw/1', inputDigest: task.inputManifest[0].digest,
      estimateCostMicros: 100, requiresPaid: false, provider: null }; },
    async execute() { calls++; if (calls === 1) throw new Error('local executor crashed after reserve');
      return { state: 'succeeded', actualCostMicros: 0 }; },
  };
  const { service } = await make({ executors: [local] });
  const created = await service.create(input({ budgetMicros: 100, clientRequestId: 'local-throw-releases-reserve' }));
  await service.tick(created.id); await service.tick(created.id);
  let run = await service.get(created.id);
  const task = run.tasks.find(item => item.stage === 'breakdown');
  assert.equal(task.status, 'failed');
  assert.equal(task.blockingReason.code, 'EXECUTOR_FAILED');
  assert.equal(run.externalOperations.length, 0);
  assert.equal(run.summary.budget.reservedMicros, 0);
  assert.equal(run.summary.budget.spentMicros, 0);
  assert.equal(calls, 1);
  run = await service.action(run.id, { type: 'retryTask', taskId: task.id, reason: '本地失败后重试' });
  assert.equal(run.tasks.find(item => item.id === task.id).status, 'ready');
  await service.tick(run.id);
  run = await service.get(created.id);
  assert.equal(run.tasks.find(item => item.id === task.id).status, 'succeeded');
  assert.equal(calls, 2);
  assert.equal(run.summary.budget.reservedMicros, 0);
  assert.equal(run.summary.budget.spentMicros, 0);
  assert.equal(run.tasks.find(item => item.id === task.id).blockingReason?.code, undefined);
});

test('a thrown paid attempt keeps its reservation and does not open a second submission', async () => {
  const paid = {
    stage: 'breakdown',
    async prepare({ task }) { return { executor: 'test-paid-throw/1', inputDigest: task.inputManifest[0].digest,
      estimateCostMicros: 100, requiresPaid: true, provider: 'offline-test' }; },
    async execute() { throw new Error('provider response lost'); },
  };
  const { service } = await make({ executors: [paid] });
  const created = await service.create(input({ budgetMicros: 100, clientRequestId: 'paid-throw-keeps-reserve' }));
  await service.tick(created.id); await service.tick(created.id);
  const run = await service.get(created.id);
  const task = run.tasks.find(item => item.stage === 'breakdown');
  assert.equal(task.status, 'reconciling');
  assert.equal(run.externalOperations[0].status, 'unknown');
  assert.equal(run.summary.budget.reservedMicros, 100);
  assert.equal(run.summary.budget.spentMicros, 0);
  await assert.rejects(service.action(run.id, { type: 'retryTask', taskId: task.id, reason: '不能直接重提' }),
    error => error.code === 'PRODUCTION_EXTERNAL_OPERATION_UNKNOWN');
});

test('restart releases a local running reservation and keeps an external one', async () => {
  const { repo, service } = await make();
  const created = await service.create(input({ budgetMicros: 200, clientRequestId: 'restart-local-reserve' }));
  await service.tick(created.id);
  const stored = await repo.get(created.id);
  const breakdown = stored.tasks.find(item => item.stage === 'breakdown');
  const assets = stored.tasks.find(item => item.stage === 'assets');
  const at = stored.updatedAt;
  breakdown.status = 'running'; breakdown.attemptCount = 1;
  assets.status = 'running'; assets.attemptCount = 1;
  stored.attempts.push(
    { id: 'pattempt_local_hold', runId: stored.id, taskId: breakdown.id, number: 1, status: 'running',
      executor: 'test-local/1', inputDigest: breakdown.inputManifest[0].digest, error: null, startedAt: at, endedAt: null },
    { id: 'pattempt_paid_hold', runId: stored.id, taskId: assets.id, number: 1, status: 'running',
      executor: 'test-paid/1', inputDigest: assets.inputManifest[0].digest, error: null, startedAt: at, endedAt: null },
  );
  stored.externalOperations.push({ id: 'pop_paid_hold', runId: stored.id, taskId: assets.id, attemptId: 'pattempt_paid_hold',
    operationKey: 'op_paid_hold', provider: 'offline-test', providerTaskId: 'provider_hold', status: 'submitted',
    estimatedCostMicros: 80, actualCostMicros: null, createdAt: at, updatedAt: at });
  stored.budgetLedger.push(
    { id: 'pbudget_local', runId: stored.id, taskId: breakdown.id, attemptId: 'pattempt_local_hold',
      kind: 'reserve', amountMicros: 40, currency: 'CNY', note: '执行前预留', createdAt: at },
    { id: 'pbudget_paid', runId: stored.id, taskId: assets.id, attemptId: 'pattempt_paid_hold',
      kind: 'reserve', amountMicros: 80, currency: 'CNY', note: '执行前预留', createdAt: at },
  );
  await repo.replace(stored, stored.version);
  const restarted = new ProductionService(repo, { pollIntervalMs: 60_000, executors: [] });
  await restarted.start(); restarted.stop();
  const run = await restarted.get(created.id);
  assert.equal(run.tasks.find(item => item.id === breakdown.id).status, 'waitingHuman');
  assert.equal(run.tasks.find(item => item.id === breakdown.id).blockingReason.code, 'TASK_EXECUTION_INTERRUPTED');
  assert.equal(run.externalOperations[0].status, 'unknown');
  assert.equal(run.summary.budget.reservedMicros, 80);
  assert.equal(run.summary.budget.spentMicros, 0);
});
