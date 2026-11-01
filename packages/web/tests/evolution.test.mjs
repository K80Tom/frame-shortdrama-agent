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
      issues: [issue('i2', 'STAGE_OUTPUT_INVALID', 'resolved', '协议字段缺失已修复'), issue('i4', 'STAGE_OUTPUT_INVALID', 'resolved', '同一次运行里的另一处协议缺失'), issue('i3', 'DIALOGUE_QUOTE_AMBIGUOUS', 'resolved', '对白证据不唯一')],
    })),
  ];
  const summary = evolution.buildEvolutionSummary(runs);
  assert.equal(summary.issuesTotal, 4);
  assert.equal(summary.issuesOpen, 1);
  assert.equal(summary.resolvedRate, 75);
  const group = summary.issueGroups.find(item => item.code === 'STAGE_OUTPUT_INVALID');
  assert.equal(group.count, 3);
  assert.equal(group.openCount, 1);
  assert.equal(group.resolvedCount, 2);
  assert.equal(group.latestMessage, '同一次运行里的另一处协议缺失', '取 updatedAt 较新运行的消息');
  assert.equal(group.runCount, 2, '同一运行里的重复问题只算一次关联运行');
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

test('质量检查上的规则版本计入台账，同一版本不因产物再计一次', () => {
  const task = { id: 't_storyboard', stage: 'storyboard', label: '分镜设计', scope: { kind: 'episode', id: null }, status: 'succeeded', dependencies: [], attemptCount: 1, maxAttempts: 1, version: 1, blockingReason: null, inputManifest: [], updatedAt: '2026-10-22T00:00:00.000Z' };
  const runs = [
    automation.parseProductionRun(rawRun('production_storyboard', '2026-10-22T00:00:00.000Z', {
      tasks: [task],
      artifacts: [
        { id: 'art_board', kind: 'text', title: '分镜候选', uri: null, metadata: { storyboardRevisionId: 'board_demo' } },
        { id: 'art_skip_1', kind: 'report', title: '3D 预演无需构建·1', uri: null, metadata: { ruleVersion: 'production-director-scene/1' } },
        { id: 'art_skip_2', kind: 'report', title: '3D 预演无需构建·2', uri: null, metadata: { ruleVersion: 'production-director-scene/1' } },
      ],
      qualityChecks: [{ id: 'q_board', taskId: 't_storyboard', level: 'episode', result: 'pass', ruleVersion: 'storyboard-validator/2', summary: '镜号、引用、对白覆盖和顺序检查已通过', issues: [] }],
    })),
    automation.parseProductionRun(rawRun('production_media', '2026-10-23T00:00:00.000Z', {
      tasks: [
        { ...task, id: 't_shot_a', stage: 'review', label: '镜头技术复核' },
        { ...task, id: 't_shot_b', stage: 'review', label: '镜头技术复核' },
        { ...task, id: 't_director', stage: 'director', label: '3D 预演' },
      ],
      artifacts: [
        { id: 'art_skip_a', kind: 'report', title: '3D 预演无需构建·1', uri: null, metadata: { ruleVersion: 'production-director-complexity/1' } },
        { id: 'art_skip_b', kind: 'report', title: '3D 预演无需构建·2', uri: null, metadata: { ruleVersion: 'production-director-complexity/1' } },
        { id: 'art_director', kind: 'director', title: '3D 导演预演决策', uri: null, metadata: { ruleVersion: 'production-director-complexity/1' } },
      ],
      qualityChecks: [
        { id: 'q_shot_a', taskId: 't_shot_a', level: 'shot', result: 'pass', ruleVersion: 'local-shot-media/1', summary: '镜头文件已校验', issues: [] },
        { id: 'q_shot_b', taskId: 't_shot_b', level: 'shot', result: 'fail', ruleVersion: 'local-shot-media/1', summary: '镜头时长不足', issues: ['时长不足'] },
        { id: 'q_director', taskId: 't_director', level: 'episode', result: 'pass', ruleVersion: 'production-director-complexity/1', summary: '复杂度规则已判定', issues: [] },
        { id: 'q_blank', taskId: 't_shot_a', level: 'shot', result: 'pass', ruleVersion: 'not a rule!!!', summary: '非法版本号', issues: [] },
      ],
    })),
  ];
  const summary = evolution.buildEvolutionSummary(runs);
  const storyboard = summary.rules.find(rule => rule.version === 'storyboard-validator/2');
  assert.equal(storyboard.occurrences, 1);
  assert.equal(storyboard.runCount, 1);
  assert.equal(storyboard.sampleStage, '分镜设计');
  assert.equal(evolution.evolutionRuleKind(storyboard.version), '分镜规则');
  const skippedShots = summary.rules.find(rule => rule.version === 'production-director-scene/1');
  assert.equal(skippedShots.occurrences, 2, '没有配套质量检查时，每个产物各记一条');
  assert.equal(skippedShots.runCount, 1);
  assert.equal(evolution.evolutionRuleKind('extract-facts-completeness/2'), '拆解检查规则');
  assert.equal(evolution.evolutionRuleKind('production-asset-match/2'), '资产规则');
  const media = summary.rules.find(rule => rule.version === 'local-shot-media/1');
  assert.equal(media.occurrences, 2, '同一运行里的两次镜头检查都要计入');
  assert.equal(media.runCount, 1);
  assert.equal(evolution.evolutionRuleKind(media.version), '成片技术规则');
  const director = summary.rules.find(rule => rule.version === 'production-director-complexity/1');
  assert.equal(director.occurrences, 1, '质量检查已经记录该版本时，不再把同版本产物再计一次');
  assert.equal(director.runCount, 1);
  assert.equal(director.sampleStage, '3D 预演');
  assert.equal(summary.rules.some(rule => rule.version.includes(' ')), false);
  assert.ok(summary.steps[0].ruleVersions.includes('storyboard-validator/2'));
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
  assert.equal(summary.rules.length, 0, '没有规则版本的质量检查不生成规则条目');
  assert.equal(summary.activeRunId, 'production_live');
  assert.equal(evolution.evolutionStatusNote('pausedBudget'), '停在预算检查点');
  assert.equal(evolution.evolutionRuleKind('production-director-scene/1'), '3D 导演台规则');
});
