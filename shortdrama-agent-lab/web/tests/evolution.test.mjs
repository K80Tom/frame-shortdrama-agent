import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const automation = await server.ssrLoadModule('/src/production-automation.ts');
const evolution = await server.ssrLoadModule('/src/evolution.ts');

function rawRun(id, createdAt, over = {}) {
  return {
    id, clientRequestId: `client_${id.slice(-4)}`, projectId: 'project_demo', scriptVersionId: 'script_demo',
    status: 'partial', version: 2, createdAt, updatedAt: createdAt,
    summary: { tasks: { completed: 1, total: 10, running: 0, waitingHuman: 0, failed: 1 }, shots: { completed: 0, total: 0 }, issues: { open: 1, total: 1 }, budget: { limitMicros: 50_000_000, reservedMicros: 0, spentMicros: 0, currency: 'CNY' } },
    stages: [{ key: 'prepare', label: '输入与生产预检', state: 'succeeded', completed: 1, total: 1, needsAttention: 0 }],
    tasks: [], candidateSets: [], artifacts: [], qualityChecks: [], reviews: [], timeline: [], delivery: null, ...over,
  };
}

test('按时间排序并只在节点数超过历史最深处标记推进', () => {
  const runs = [
    automation.parseProductionRun(rawRun('production_laterfirst', '2026-10-24T00:00:00.000Z', {
      summary: { tasks: { completed: 5, total: 10, running: 0, waitingHuman: 0, failed: 0 }, shots: { completed: 0, total: 0 }, issues: { open: 0, total: 2 }, budget: { limitMicros: 0, reservedMicros: 0, spentMicros: 0, currency: 'CNY' } },
    })),
    automation.parseProductionRun(rawRun('production_earlysecond', '2026-10-23T00:00:00.000Z', {
      summary: { tasks: { completed: 5, total: 10, running: 0, waitingHuman: 0, failed: 0 }, shots: { completed: 0, total: 0 }, issues: { open: 0, total: 1 }, budget: { limitMicros: 0, reservedMicros: 0, spentMicros: 0, currency: 'CNY' } },
    })),
    automation.parseProductionRun(rawRun('production_earliest', '2026-10-22T00:00:00.000Z')),
  ];
  const summary = evolution.buildEvolutionSummary(runs);
  assert.equal(summary.steps.length, 3);
  assert.equal(summary.steps[0].runId, 'production_earliest');
  assert.equal(summary.steps[0].breakthrough, false, '首个运行只建立基线，不算推进');
  assert.ok(summary.steps[1].breakthrough, '5 > 1 视为推进');
  assert.equal(summary.steps[2].breakthrough, false, '5 未超过历史最深 5，不再标记');
  assert.equal(summary.loop.furthestTasks, 5);
  assert.equal(summary.loop.furthestTotal, 10);
});

test('问题按 code 归并并统计处置状态与最近消息', () => {
  const issue = (id, code, status, message) => ({
    id, taskId: null, stage: 'video', scope: { kind: 'episode', id: null }, code, title: `问题 ${code}`,
    message, severity: 'error', status, recommendedActions: [], impact: [], estimatedAdditionalCostMicros: null,
  });
  const runs = [
    automation.parseProductionRun(rawRun('production_a', '2026-10-22T00:00:00.000Z', {
      summary: { tasks: { completed: 1, total: 10, running: 0, waitingHuman: 0, failed: 1 }, shots: { completed: 0, total: 0 }, issues: { open: 1, total: 1 }, budget: { limitMicros: 0, reservedMicros: 0, spentMicros: 0, currency: 'CNY' } },
      issues: [issue('i1', 'STAGE_OUTPUT_INVALID', 'open', '协议字段缺失')],
    })),
    automation.parseProductionRun(rawRun('production_b', '2026-10-23T00:00:00.000Z', {
      summary: { tasks: { completed: 2, total: 10, running: 0, waitingHuman: 0, failed: 1 }, shots: { completed: 0, total: 0 }, issues: { open: 0, total: 2 }, budget: { limitMicros: 0, reservedMicros: 0, spentMicros: 0, currency: 'CNY' } },
      issues: [issue('i2', 'STAGE_OUTPUT_INVALID', 'resolved', '协议字段缺失已修复'), issue('i3', 'DIALOGUE_QUOTE_AMBIGUOUS', 'resolved', '对白证据不唯一')],
    })),
  ];
  const summary = evolution.buildEvolutionSummary(runs);
  assert.equal(summary.issuesTotal, 3);
  assert.equal(summary.issuesOpen, 1);
  assert.equal(summary.resolvedRate, 67);
  const group = summary.issueGroups.find(item => item.code === 'STAGE_OUTPUT_INVALID');
  assert.equal(group.count, 2);
  assert.equal(group.openCount, 1);
  assert.equal(group.resolvedCount, 1);
  assert.equal(group.latestMessage, '协议字段缺失已修复', '取 updatedAt 较新运行的消息');
  assert.equal(group.runCount, 2);
  assert.deepEqual(group.stages.sort(), ['video'], '归并发生阶段');
});

test('从产物元数据提取规则版本并统计运行覆盖', () => {
  const runs = [
    automation.parseProductionRun(rawRun('production_a', '2026-10-22T00:00:00.000Z', {
      artifacts: [{ id: 'art1', kind: 'director', title: '镜头机位约束', uri: null, metadata: { ruleVersion: 'production-director-scene/1', ruleBased: true } }],
    })),
    automation.parseProductionRun(rawRun('production_b', '2026-10-23T00:00:00.000Z', {
      artifacts: [
        { id: 'art2', kind: 'director', title: '复杂镜头分级', uri: null, metadata: { ruleVersion: 'production-director-complexity/1' } },
        { id: 'art3', kind: 'director', title: '场景构图约束', uri: null, metadata: { ruleVersion: 'production-director-scene/1' } },
      ],
    })),
  ];
  const summary = evolution.buildEvolutionSummary(runs);
  assert.equal(summary.rules.length, 2);
  const scene = summary.rules.find(rule => rule.version === 'production-director-scene/1');
  assert.equal(scene.occurrences, 2);
  assert.equal(scene.runCount, 2);
  assert.equal(scene.sampleStage, '镜头机位约束');
  assert.equal(summary.steps[1].ruleVersions.length, 2);
});

test('空运行列表返回零值摘要且不抛错', () => {
  const summary = evolution.buildEvolutionSummary([]);
  assert.equal(summary.runsTotal, 0);
  assert.equal(summary.issuesTotal, 0);
  assert.equal(summary.resolvedRate, 0);
  assert.equal(summary.qualityPassRate, 0);
  assert.equal(summary.activeRunId, null);
  assert.deepEqual(summary.steps, []);
});

test('质量检查通过率与活跃运行判定', () => {
  const runs = [
    automation.parseProductionRun(rawRun('production_done', '2026-10-22T00:00:00.000Z', {
      qualityChecks: [{ id: 'q1', taskId: 't1', level: 'shot', result: 'pass', issues: [] }, { id: 'q2', taskId: 't2', level: 'shot', result: 'fail', issues: ['时长不足'] }],
      issues: [], summary: { tasks: { completed: 1, total: 10, running: 0, waitingHuman: 0, failed: 0 }, shots: { completed: 0, total: 0 }, issues: { open: 0, total: 0 }, budget: { limitMicros: 0, reservedMicros: 0, spentMicros: 0, currency: 'CNY' } },
    })),
    automation.parseProductionRun(rawRun('production_live', '2026-10-23T00:00:00.000Z', {
      status: 'pausedBudget',
      qualityChecks: [{ id: 'q3', taskId: 't3', level: 'shot', result: 'pass', issues: [] }],
      issues: [], summary: { tasks: { completed: 2, total: 10, running: 0, waitingHuman: 0, failed: 0 }, shots: { completed: 0, total: 0 }, issues: { open: 0, total: 0 }, budget: { limitMicros: 0, reservedMicros: 0, spentMicros: 0, currency: 'CNY' } },
    })),
  ];
  const summary = evolution.buildEvolutionSummary(runs);
  assert.equal(summary.qualityChecksTotal, 3);
  assert.equal(summary.qualityPassRate, 67);
  assert.equal(summary.activeRunId, 'production_live');
  assert.equal(evolution.evolutionStatusNote('pausedBudget'), '停在预算检查点');
  assert.equal(evolution.evolutionRuleKind('production-director-scene/1'), '3D 导演台规则');
});
