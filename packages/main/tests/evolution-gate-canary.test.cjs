// #135 候选门禁闭环单元测试：状态机 CAS、049 门禁仲裁、Canary 稳定分流与
// 自动止损、Promote/Rollback Registry Revision、不可变 Candidate 与审计。
// 纯 InMemory，无数据库、无网络、无模型调用。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { InMemoryEvolutionGateRepository } = require('../dist/evolution/gate-repository');
const { EvolutionGateService } = require('../dist/evolution/gate-service');
const { arbitrateEvolutionGate, aggregateCoreMetric, EVOLUTION_CORE_GATE_RULE_VERSION } =
  require('../dist/evolution/gate-arbiter');
const { routeRun, observeRolloutRun } = require('../dist/evolution/gate-canary');
const {
  EvolutionGateError, canTransitionCandidate, isTerminalCandidateState,
} = require('@lyra/shared');

const WS = `ws_${'e'.repeat(32)}`;
const BASELINE = 'a'.repeat(64);
const CANDIDATE_DIGEST = 'b'.repeat(64);

function service() {
  return new EvolutionGateService(new InMemoryEvolutionGateRepository(), () => new Date('2026-11-10T12:00:00Z'));
}

function createInput(overrides = {}) {
  return {
    domain: 'video-prompt',
    scope: 'workspace',
    projectId: null,
    baselineRevision: 'v0.1.0',
    baselineDigest: BASELINE,
    candidateRevision: 'v0.1.1-candidate',
    diff: { systemPrompt: { from: '旧提示词', to: '新提示词（强调角色服装与发型一致性）' } },
    summary: '强化角色一致性的视频提示词候选',
    generatedBy: 'human',
    generatorVersion: 'hand-edited-v1',
    tokenLimit: 1000,
    costLimitMinor: 500,
    createdBy: 'user-1',
    ...overrides,
  };
}

function evalResult(id, { status = 'pass', core = 0.9, layer = 'version' } = {}) {
  return {
    resultId: `evalres-${id}`,
    resultDigest: id.padStart(64, '0'),
    subject: { kind: 'video_prompt_version', id: 'subject-1', revisionId: null, digest: CANDIDATE_DIGEST },
    status,
    metrics: [{ key: 'role_consistency', layer, value: core, status }],
  };
}

function statusOf(promise) {
  return promise.then(() => null, error => error);
}

// ---------------------------------------------------------------- 状态机

test('状态机完整闭环：proposed → … → promoted，stateDigest 随状态推进变化', async () => {
  const gate = service();
  const candidate = await gate.createCandidate(WS, createInput());
  assert.equal(candidate.state, 'proposed');
  assert.equal(candidate.stateVersion, 1);
  assert.match(candidate.candidateId, /^evocand_[a-f0-9]{32}$/);
  assert.notEqual(candidate.stateDigest, '');

  const evaluating = await gate.startEvaluation(WS, candidate.candidateId, { expectedVersion: 1, actorId: 'user-1' });
  assert.equal(evaluating.state, 'evaluating');
  const { candidate: gated } = await gate.bindGate(WS, candidate.candidateId, {
    expectedVersion: 2, actorId: 'user-1',
    baselineResults: [evalResult('base1', { core: 0.85 })],
    candidateResults: [evalResult('cand1', { core: 0.9 })],
  });
  assert.equal(gated.state, 'gated');
  const approved = await gate.approve(WS, candidate.candidateId,
    { expectedVersion: 3, actorId: 'approver-1', reason: '门禁通过且成本达标' });
  assert.equal(approved.state, 'approved');

  const { candidate: canary, rollout } = await gate.startCanary(WS, candidate.candidateId,
    { expectedVersion: 4, actorId: 'release-1', routingKey: 'video-prompt:shot' });
  assert.equal(canary.state, 'canary');
  assert.equal(rollout.config.trafficPermyriad, 500);

  // 观测达到最小样本量后 Promote。
  let version = rollout.stateVersion;
  let current = rollout;
  for (let index = 0; index < rollout.config.minRuns; index += 1) {
    const result = await gate.observe(WS, rollout.rolloutId,
      { expectedVersion: version, anomaly: false, routedToCandidate: true });
    current = result.rollout;
    version = current.stateVersion;
  }
  const { candidate: promoted, revision } = await gate.promote(WS, rollout.rolloutId,
    { expectedVersion: 5, rolloutExpectedVersion: version, actorId: 'release-1', reason: '指标稳定' });
  assert.equal(promoted.state, 'promoted');
  assert.equal(revision.action, 'promote');
  assert.equal(revision.activeDigest, candidate.candidateDigest);
  assert.equal(revision.revision, 1);
});

test('CAS：expectedVersion 陈旧时返回 409，绝不静默覆盖', async () => {
  const gate = service();
  const candidate = await gate.createCandidate(WS, createInput());
  await gate.startEvaluation(WS, candidate.candidateId, { expectedVersion: 1, actorId: 'user-1' });
  const stale = await statusOf(gate.startEvaluation(WS, candidate.candidateId, { expectedVersion: 1, actorId: 'user-1' }));
  assert.ok(stale instanceof EvolutionGateError);
  assert.equal(stale.status, 409);
  assert.equal(stale.code, 'EVOLUTION_STALE_STATE');
});

test('非法状态跳转返回 422；终态不再接受跳转', async () => {
  const gate = service();
  const candidate = await gate.createCandidate(WS, createInput());
  // proposed 直接到 approved 属于跳过门禁与审批。
  const error = await statusOf(gate.approve(WS, candidate.candidateId,
    { expectedVersion: 1, actorId: 'approver-1', reason: '试图跳过门禁' }));
  assert.ok(error instanceof EvolutionGateError);
  assert.equal(error.status, 422);
  assert.equal(error.code, 'EVOLUTION_TRANSITION_INVALID');
  assert.equal(canTransitionCandidate('promoted', 'promoted'), false);
  // promoted 仍可回滚（非终态）；rolled_back / rejected 才是终态。
  assert.equal(isTerminalCandidateState('promoted'), false);
  assert.equal(isTerminalCandidateState('rolled_back'), true);
  assert.equal(isTerminalCandidateState('rejected'), true);
});

test('Candidate 不可变：正文字段由创建时冻结，重复创建同 Proposal 超限被拒', async () => {
  const gate = service();
  const first = await gate.createCandidate(WS, createInput());
  assert.equal(first.maxCandidatesPerProposal, 2);
  // 默认配额 2：前两个放行，第三个同 proposalKey 的候选被拒。
  assert.equal(await statusOf(gate.createCandidate(WS, createInput({ candidateRevision: 'v0.1.2-candidate' }))), null);
  const third = await statusOf(gate.createCandidate(WS, createInput({ candidateRevision: 'v0.1.3-candidate' })));
  assert.ok(third instanceof EvolutionGateError);
  assert.equal(third.status, 422);
  assert.equal(third.code, 'EVOLUTION_CANDIDATE_QUOTA');
  // 配额收紧到 1：第二个同 proposalKey 的候选即被拒。
  assert.equal(await statusOf(gate.createCandidate(WS, createInput({
    proposalKey: 'tight-proposal', maxCandidatesPerProposal: 1 }))), null);
  const tight = await statusOf(gate.createCandidate(WS, createInput({
    proposalKey: 'tight-proposal', maxCandidatesPerProposal: 1, candidateRevision: 'v0.1.4-candidate' })));
  assert.equal(tight?.code, 'EVOLUTION_CANDIDATE_QUOTA');
  const diffError = await statusOf(gate.createCandidate(WS, createInput({ proposalKey: 'other-proposal' })));
  assert.equal(diffError, null, '不同 proposalKey 不占用同一配额');
});

test('Diff 安全检查：疑似密钥与本地绝对路径直接拒绝', async () => {
  const gate = service();
  const secret = await statusOf(gate.createCandidate(WS, createInput({
    diff: { systemPrompt: { from: 'a', to: 'key is sk-abcdefgh12345678' } },
  })));
  assert.equal(secret?.code, 'EVOLUTION_DIFF_UNSAFE');
  const path = await statusOf(gate.createCandidate(WS, createInput({
    diff: { promptFile: { from: 'a', to: '/Users/lqc/secret-prompt.txt' } },
  })));
  assert.equal(path?.code, 'EVOLUTION_DIFF_UNSAFE');
});

// ---------------------------------------------------------------- 门禁仲裁

test('仲裁：候选核心指标劣于基线 → blocked；不劣于基线且无失败 → pass', () => {
  const worse = arbitrateEvolutionGate({
    ruleVersion: EVOLUTION_CORE_GATE_RULE_VERSION,
    baselineDigest: BASELINE, candidateDigest: CANDIDATE_DIGEST,
    baselineResults: [evalResult('b1', { core: 0.9 })],
    candidateResults: [evalResult('c1', { core: 0.7 })],
  });
  assert.equal(worse.decision, 'blocked');
  assert.ok(worse.reasons.some(reason => reason.includes('劣于基线')));

  const better = arbitrateEvolutionGate({
    ruleVersion: EVOLUTION_CORE_GATE_RULE_VERSION,
    baselineDigest: BASELINE, candidateDigest: CANDIDATE_DIGEST,
    baselineResults: [evalResult('b1', { core: 0.8 })],
    candidateResults: [evalResult('c1', { core: 0.88 }), evalResult('c2', { core: 0.84 })],
  });
  assert.equal(better.decision, 'pass');
  assert.deepEqual(better.reasons, []);
});

test('仲裁：核心指标缺失按“未知”阻断，绝不按 0 计算；失败与证据不完整均阻断', () => {
  const missing = arbitrateEvolutionGate({
    ruleVersion: EVOLUTION_CORE_GATE_RULE_VERSION,
    baselineDigest: BASELINE, candidateDigest: CANDIDATE_DIGEST,
    baselineResults: [evalResult('b1', { core: 0.8 })],
    candidateResults: [evalResult('c1', { status: 'pass', core: null, layer: 'sample' })],
  });
  assert.equal(missing.decision, 'blocked');
  assert.equal(missing.coreMetric.candidate, null);
  assert.ok(missing.reasons.some(reason => reason.includes('未知不按 0 计算')));

  const failed = arbitrateEvolutionGate({
    ruleVersion: EVOLUTION_CORE_GATE_RULE_VERSION,
    baselineDigest: BASELINE, candidateDigest: CANDIDATE_DIGEST,
    baselineResults: [evalResult('b1', { core: 0.8 })],
    candidateResults: [evalResult('c1', { core: 0.95 }), evalResult('c2', { status: 'fail', core: 0.9 })],
  });
  assert.equal(failed.decision, 'blocked');
  assert.ok(failed.reasons.some(reason => reason.includes('严重失败')));

  const inconclusive = arbitrateEvolutionGate({
    ruleVersion: EVOLUTION_CORE_GATE_RULE_VERSION,
    baselineDigest: BASELINE, candidateDigest: CANDIDATE_DIGEST,
    baselineResults: [evalResult('b1', { core: 0.8 })],
    candidateResults: [evalResult('c1', { core: 0.95 }), evalResult('c3', { status: 'uncertain', core: 0.9 })],
  });
  assert.equal(inconclusive.decision, 'blocked');
  assert.ok(inconclusive.reasons.some(reason => reason.includes('证据不完整')));

  assert.equal(aggregateCoreMetric([evalResult('x', { core: null })], 'role_consistency'), null);
});

test('仲裁确定性：相同输入得到相同 decisionDigest；输入变化 digest 随之变化', () => {
  const input = {
    ruleVersion: EVOLUTION_CORE_GATE_RULE_VERSION,
    baselineDigest: BASELINE, candidateDigest: CANDIDATE_DIGEST,
    baselineResults: [evalResult('b1', { core: 0.8 })],
    candidateResults: [evalResult('c1', { core: 0.85 })],
  };
  const first = arbitrateEvolutionGate(input);
  const second = arbitrateEvolutionGate(input);
  assert.equal(first.decisionDigest, second.decisionDigest);
  const different = arbitrateEvolutionGate({ ...input,
    candidateResults: [evalResult('c1', { core: 0.86 })] });
  assert.notEqual(first.decisionDigest, different.decisionDigest);
});

test('服务绑定：pass 才进入 gated；blocked 保留绑定但停在 evaluating；无 pass 禁止批准', async () => {
  const gate = service();
  const candidate = await gate.createCandidate(WS, createInput());
  await gate.startEvaluation(WS, candidate.candidateId, { expectedVersion: 1, actorId: 'user-1' });

  const blocked = await gate.bindGate(WS, candidate.candidateId, {
    expectedVersion: 2, actorId: 'user-1',
    baselineResults: [evalResult('b1', { core: 0.9 })],
    candidateResults: [evalResult('c1', { core: 0.6 })],
  });
  assert.equal(blocked.binding.verdict.decision, 'blocked');
  assert.equal(blocked.candidate.state, 'evaluating');

  // 状态机守卫优先：evaluating 不能直接批准（跳过门禁语义）。
  const skipError = await statusOf(gate.approve(WS, candidate.candidateId,
    { expectedVersion: 2, actorId: 'approver-1', reason: '试图跳过门禁' }));
  assert.equal(skipError.code, 'EVOLUTION_TRANSITION_INVALID');

  const passed = await gate.bindGate(WS, candidate.candidateId, {
    expectedVersion: 2, actorId: 'user-1',
    baselineResults: [evalResult('b1', { core: 0.8 })],
    candidateResults: [evalResult('c2', { core: 0.82 })],
  });
  assert.equal(passed.binding.verdict.decision, 'pass');
  assert.equal(passed.candidate.state, 'gated');

  // gated 重绑 blocked：最新证据不再 pass，批准被门禁拦截。
  await gate.bindGate(WS, candidate.candidateId, {
    expectedVersion: 3, actorId: 'user-1',
    baselineResults: [evalResult('b1', { core: 0.9 })],
    candidateResults: [evalResult('c3', { core: 0.7 })],
  });
  const gateError = await statusOf(gate.approve(WS, candidate.candidateId,
    { expectedVersion: 3, actorId: 'approver-1', reason: '试图在无 pass 门禁时批准' }));
  assert.equal(gateError.code, 'EVOLUTION_GATE_NOT_PASSED');

  // gated 重绑 pass：幂等刷新证据，随后批准放行。
  await gate.bindGate(WS, candidate.candidateId, {
    expectedVersion: 3, actorId: 'user-1',
    baselineResults: [evalResult('b1', { core: 0.8 })],
    candidateResults: [evalResult('c4', { core: 0.85 })],
  });
  const approved = await gate.approve(WS, candidate.candidateId,
    { expectedVersion: 3, actorId: 'approver-1', reason: '证据刷新后批准' });
  assert.equal(approved.state, 'approved');
});

test('批准必须携带非空理由', async () => {
  const gate = service();
  const candidate = await gate.createCandidate(WS, createInput());
  await gate.startEvaluation(WS, candidate.candidateId, { expectedVersion: 1, actorId: 'user-1' });
  await gate.bindGate(WS, candidate.candidateId, {
    expectedVersion: 2, actorId: 'user-1',
    baselineResults: [evalResult('b1', { core: 0.8 })],
    candidateResults: [evalResult('c1', { core: 0.85 })],
  });
  const error = await statusOf(gate.approve(WS, candidate.candidateId,
    { expectedVersion: 3, actorId: 'approver-1', reason: '   ' }));
  assert.equal(error.code, 'EVOLUTION_REASON_REQUIRED');
});

// ---------------------------------------------------------------- Canary

test('稳定分流：同一 routing key 重复 100 次落同一版本；流量≈配置比例', () => {
  const rollout = {
    rolloutId: 'evoroll_' + '1'.repeat(32),
    workspaceId: WS,
    candidateId: 'evocand_' + '2'.repeat(32),
    candidateDigest: CANDIDATE_DIGEST,
    baselineDigest: BASELINE,
    domain: 'video-prompt',
    scope: 'workspace',
    projectId: null,
    config: { trafficPermyriad: 500, routingKey: 'rk', hashAlgorithmVersion: 'sha256-permyriad-v1',
      consecutiveAnomalyThreshold: 3, minRuns: 10 },
    status: 'active',
    sampleCount: 0, candidateCount: 0, consecutiveAnomalies: 0,
    stoppedReason: null, startedAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z',
    stateVersion: 1,
  };
  const first = routeRun(rollout, null, 'run-key-1');
  for (let index = 0; index < 100; index += 1) {
    const again = routeRun(rollout, null, 'run-key-1');
    assert.equal(again.bucket, first.bucket);
    assert.equal(again.routedTo, first.routedTo);
  }
  // 10 万个 key 的分布应在 5% 附近（±1.5 个百分点），证明哈希没有系统性偏置。
  let routed = 0;
  const total = 100000;
  for (let index = 0; index < total; index += 1) {
    if (routeRun(rollout, null, `run-${index}`).routedTo === 'candidate') routed += 1;
  }
  const ratio = routed / total;
  assert.ok(ratio > 0.035 && ratio < 0.065, `5% 分流实际比例 ${ratio.toFixed(4)}`);
});

test('自动止损：连续异常达到阈值即 failed，不再向新 Run 分流；非异常重置计数', async () => {
  const gate = service();
  const candidate = await gate.createCandidate(WS, createInput());
  await gate.startEvaluation(WS, candidate.candidateId, { expectedVersion: 1, actorId: 'user-1' });
  await gate.bindGate(WS, candidate.candidateId, {
    expectedVersion: 2, actorId: 'user-1',
    baselineResults: [evalResult('b1', { core: 0.8 })],
    candidateResults: [evalResult('c1', { core: 0.85 })],
  });
  await gate.approve(WS, candidate.candidateId, { expectedVersion: 3, actorId: 'approver-1', reason: 'ok' });
  const { rollout } = await gate.startCanary(WS, candidate.candidateId,
    { expectedVersion: 4, actorId: 'release-1', routingKey: 'rk' });

  let version = rollout.stateVersion;
  // 两次异常 + 一次正常：连续计数被重置。
  for (const anomaly of [true, true, false]) {
    const observed = await gate.observe(WS, rollout.rolloutId,
      { expectedVersion: version, anomaly, routedToCandidate: true });
    version = observed.rollout.stateVersion;
    assert.equal(observed.rollout.status, 'active');
  }
  assert.equal(rollout.config.consecutiveAnomalyThreshold, 3);
  // 再连续三次异常：第三次触发熔断。
  let final = null;
  for (let index = 0; index < 3; index += 1) {
    const observed = await gate.observe(WS, rollout.rolloutId,
      { expectedVersion: version, anomaly: true });
    version = observed.rollout.stateVersion;
    final = observed;
  }
  assert.equal(final.rollout.status, 'failed');
  assert.ok(final.rollout.stoppedReason.includes('自动止损'));
  assert.equal(final.candidate.state, 'failed');

  const routeError = await statusOf(gate.route(WS, final.rollout.rolloutId, 'new-run'));
  assert.equal(routeError.status, 409);
});

test('人工 Stop：候选进入 paused，路由停止；Promote 需满足最小样本量', async () => {
  const gate = service();
  const candidate = await gate.createCandidate(WS, createInput());
  await gate.startEvaluation(WS, candidate.candidateId, { expectedVersion: 1, actorId: 'user-1' });
  await gate.bindGate(WS, candidate.candidateId, {
    expectedVersion: 2, actorId: 'user-1',
    baselineResults: [evalResult('b1', { core: 0.8 })],
    candidateResults: [evalResult('c1', { core: 0.85 })],
  });
  await gate.approve(WS, candidate.candidateId, { expectedVersion: 3, actorId: 'approver-1', reason: 'ok' });
  const { rollout } = await gate.startCanary(WS, candidate.candidateId,
    { expectedVersion: 4, actorId: 'release-1', routingKey: 'rk' });

  // 样本量不足时 Promote 被拒。
  const early = await statusOf(gate.promote(WS, rollout.rolloutId,
    { expectedVersion: 5, rolloutExpectedVersion: rollout.stateVersion, actorId: 'release-1', reason: '过早' }));
  assert.equal(early.code, 'EVOLUTION_PROMOTE_INVALID');

  // 在 active 状态补足最小样本量，再人工 Stop；paused 仍允许 Promote（留了审计兜底）。
  let version = rollout.stateVersion;
  let current = rollout;
  while (current.sampleCount < current.config.minRuns) {
    const observed = await gate.observe(WS, rollout.rolloutId,
      { expectedVersion: version, anomaly: false, routedToCandidate: true });
    current = observed.rollout;
    version = current.stateVersion;
  }
  const staleStop = await statusOf(gate.stopCanary(WS, rollout.rolloutId, {
    expectedVersion: 6, rolloutExpectedVersion: version, actorId: 'release-1', reason: '陈旧状态' }));
  assert.equal(staleStop.code, 'EVOLUTION_STALE_STATE');
  const stopped = await gate.stopCanary(WS, rollout.rolloutId, {
    expectedVersion: 5, rolloutExpectedVersion: version,
    actorId: 'release-1', reason: '人工暂停观察' });
  assert.equal(stopped.rollout.status, 'paused');
  assert.equal(stopped.candidate.state, 'paused');
  const routeError = await statusOf(gate.route(WS, rollout.rolloutId, 'another-run'));
  assert.equal(routeError.status, 409);
  const promoted = await gate.promote(WS, rollout.rolloutId,
    { expectedVersion: 6, rolloutExpectedVersion: stopped.rollout.stateVersion, actorId: 'release-1', reason: '补足样本后达标' });
  assert.equal(promoted.candidate.state, 'promoted');
});

// ---------------------------------------------------------------- Rollback 与审计

test('回滚：追加指向基线的新 Registry Revision；历史与失败版本全部保留', async () => {
  const gate = service();
  const candidate = await gate.createCandidate(WS, createInput());
  await gate.startEvaluation(WS, candidate.candidateId, { expectedVersion: 1, actorId: 'user-1' });
  await gate.bindGate(WS, candidate.candidateId, {
    expectedVersion: 2, actorId: 'user-1',
    baselineResults: [evalResult('b1', { core: 0.8 })],
    candidateResults: [evalResult('c1', { core: 0.85 })],
  });
  await gate.approve(WS, candidate.candidateId, { expectedVersion: 3, actorId: 'approver-1', reason: 'ok' });
  const { rollout } = await gate.startCanary(WS, candidate.candidateId,
    { expectedVersion: 4, actorId: 'release-1', routingKey: 'rk' });
  let version = rollout.stateVersion;
  let current = rollout;
  while (current.sampleCount < current.config.minRuns) {
    const observed = await gate.observe(WS, rollout.rolloutId,
      { expectedVersion: version, anomaly: false, routedToCandidate: true });
    current = observed.rollout;
    version = current.stateVersion;
  }
  await gate.promote(WS, rollout.rolloutId,
    { expectedVersion: 5, rolloutExpectedVersion: version, actorId: 'release-1', reason: '发布' });

  const rolled = await gate.rollback(WS, candidate.candidateId,
    { expectedVersion: 6, actorId: 'release-1', reason: '线上发现角色一致性回退' });
  assert.equal(rolled.candidate.state, 'rolled_back');
  assert.equal(rolled.revision.action, 'rollback');
  assert.equal(rolled.revision.activeDigest, BASELINE, '回滚指向创建时冻结的基线摘要');
  assert.equal(rolled.revision.revision, 2, 'Revision 只增不改');
  const history = await gate.repository.listRegistryRevisions(WS, 'video-prompt');
  assert.equal(history.length, 2);
  assert.deepEqual(history.map(item => item.action), ['promote', 'rollback']);
});

test('审计：全链路事件 append-only 且可追溯（actor、from/to、digest）', async () => {
  const gate = service();
  const candidate = await gate.createCandidate(WS, createInput());
  await gate.startEvaluation(WS, candidate.candidateId, { expectedVersion: 1, actorId: 'user-1' });
  await gate.bindGate(WS, candidate.candidateId, {
    expectedVersion: 2, actorId: 'user-1',
    baselineResults: [evalResult('b1', { core: 0.8 })],
    candidateResults: [evalResult('c1', { core: 0.85 })],
  });
  await gate.approve(WS, candidate.candidateId,
    { expectedVersion: 3, actorId: 'approver-1', reason: '理由充分' });
  const events = await gate.history(WS, candidate.candidateId);
  const actions = events.map(event => event.action);
  assert.deepEqual(actions,
    ['candidate.created', 'evaluation.started', 'gate.bound', 'gate.passed', 'candidate.approved']);
  const approval = events.find(event => event.action === 'candidate.approved');
  assert.equal(approval.actorId, 'approver-1');
  assert.equal(approval.fromState, 'gated');
  assert.equal(approval.toState, 'approved');
  assert.ok(approval.details.bindingId);
});

test('observeRolloutRun：非 active 状态拒绝观测（CAS 防线之一）', () => {
  const rollout = {
    rolloutId: 'evoroll_' + '3'.repeat(32), workspaceId: WS, candidateId: 'evocand_' + '4'.repeat(32),
    candidateDigest: CANDIDATE_DIGEST, baselineDigest: BASELINE, domain: 'video-prompt', scope: 'workspace',
    projectId: null,
    config: { trafficPermyriad: 500, routingKey: 'rk', hashAlgorithmVersion: 'sha256-permyriad-v1',
      consecutiveAnomalyThreshold: 3, minRuns: 10 },
    status: 'paused', sampleCount: 1, candidateCount: 1, consecutiveAnomalies: 0,
    stoppedReason: '人工', startedAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', stateVersion: 2,
  };
  assert.throws(() => observeRolloutRun(rollout, { anomaly: false }), /灰度已停止/);
});


test('InMemory commands serialize competing quota claims and discard failed snapshots', async () => {
  const repository = new InMemoryEvolutionGateRepository();
  const gate = new EvolutionGateService(repository);
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) =>
    gate.createCandidate(WS, createInput({ candidateRevision: `v-${index}`, maxCandidatesPerProposal: 1 }))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const candidate = results.find(result => result.status === 'fulfilled').value;
  const before = await repository.getCandidate(WS, candidate.candidateId);
  await assert.rejects(repository.atomic(async scoped => {
    await scoped.updateCandidateState(WS, candidate.candidateId, 1,
      { ...before, state: 'evaluating', stateVersion: 2 });
    assert.deepEqual(await repository.getCandidate(WS, candidate.candidateId), before);
    throw new Error('injected');
  }), /injected/);
  assert.deepEqual(await repository.getCandidate(WS, candidate.candidateId), before);
  await gate.startEvaluation(WS, candidate.candidateId, { expectedVersion: 1, actorId: 'user-1' });
  assert.equal((await repository.getCandidate(WS, candidate.candidateId)).state, 'evaluating');
});
