import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const production = await server.ssrLoadModule('/src/production-automation.ts');

function snapshot(version = 2) {
  return {
    id: 'production_1234567890abcdef1234567890abcdef', clientRequestId: 'client_12345678', projectId: 'project_demo', scriptVersionId: 'script_demo',
    status: 'waitingHuman', version, ratio: '9:16', targetDurationSec: 90, visualStyle: '现实主义', qualityPreset: 'balanced',
    automationMode: 'checkpoints', candidatePolicy: 'gacha', candidateLimit: 2, directorPolicy: 'auto', pausedAt: null,
    createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:01:00.000Z',
    summary: { tasks: { completed: 1, total: 10, running: 0, waitingHuman: 1, failed: 0 }, shots: { completed: 0, total: 0 }, issues: { open: 1, total: 1 }, budget: { limitMicros: 50_000_000, reservedMicros: 0, spentMicros: 0, currency: 'CNY' } },
    stages: [{ key: 'prepare', label: '输入与生产预检', state: 'succeeded', completed: 1, total: 1, needsAttention: 0 }, { key: 'breakdown', label: '剧本拆解', state: 'needsAttention', completed: 0, total: 1, needsAttention: 1 }],
    tasks: [{ id: 'ptask_123', stage: 'breakdown', label: '剧本拆解', scope: { kind: 'episode', id: null }, status: 'waitingHuman', dependencies: ['ptask_000'], attemptCount: 1, maxAttempts: 2, version: 3, blockingReason: { code: 'EXECUTOR_UNAVAILABLE', message: '执行器尚未接入。' }, inputManifest: [{ kind: 'script', id: 'script_demo', revisionId: 'script_demo', digest: 'a'.repeat(64) }], createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:01:00.000Z' }],
    issues: [{ id: 'pissue_1', runId: 'production_1234567890abcdef1234567890abcdef', taskId: 'ptask_123', stage: 'breakdown', scope: { kind: 'episode', id: null }, severity: 'warning', status: 'open', code: 'EXECUTOR_UNAVAILABLE', title: '节点需要人工接管', message: '执行器尚未接入。', impact: ['后续任务等待'], recommendedActions: ['配置执行器'], estimatedAdditionalCostMicros: null, createdAt: '2026-10-23T00:01:00.000Z', resolvedAt: null }],
    candidateSets: [{ id: 'pcset_1', runId: 'production_1234567890abcdef1234567890abcdef', taskId: 'ptask_123', kind: 'storyboard', scope: { kind: 'episode', id: null }, status: 'open', selectedCandidateId: null, candidates: [{ id: 'pcandidate_1', artifactId: null, label: '方案 A', summary: '平稳叙事', score: 0.82, status: 'available', createdAt: '2026-10-23T00:01:00.000Z' }], createdAt: '2026-10-23T00:01:00.000Z' }],
    artifacts: [{ id: 'partifact_1', runId: 'production_1234567890abcdef1234567890abcdef', taskId: 'ptask_123', kind: 'report', title: '预检报告', uri: '/private/do-not-open.json', sha256: null, metadata: {}, status: 'current', createdAt: '2026-10-23T00:01:00.000Z' }],
    qualityChecks: [{ id: 'pcheck_1', runId: 'production_1234567890abcdef1234567890abcdef', taskId: 'ptask_123', level: 'episode', result: 'uncertain', ruleVersion: 'v1', summary: '等待人工判断', issues: ['执行器缺失'], createdAt: '2026-10-23T00:01:00.000Z' }],
    reviews: [], timeline: [], delivery: null, budgetLedger: [], externalOperations: [], attempts: [],
    outbox: [{ id: 'pevent_1', runId: 'production_1234567890abcdef1234567890abcdef', sequence: 1, type: 'production.run.created', payload: {}, createdAt: '2026-10-23T00:00:00.000Z' }],
  };
}

test('create body freezes the production policy and omits the UI-only yuan field', () => {
  const body = production.productionCreateBody({ ...production.defaultProductionForm, projectId: 'project_demo', scriptVersionId: 'script_demo', budgetYuan: 36 }, 'client_12345678');
  assert.equal(body.budgetMicros, 36_000_000);
  assert.equal(body.allowPaid, true);
  assert.equal(body.currency, 'CNY');
  assert.equal(body.candidatePolicy, 'direct');
  assert.equal(body.candidateLimit, 1);
  assert.equal('budgetYuan' in body, false);
  assert.deepEqual(Object.keys(body).sort(), ['allowPaid', 'automationMode', 'budgetMicros', 'candidateLimit', 'candidatePolicy', 'clientRequestId', 'currency', 'directorPolicy', 'projectId', 'qualityPreset', 'ratio', 'scriptVersionId', 'targetDurationSec', 'visualStyle'].sort());
});

test('run overview preserves the frame estimate within spent and accepts older summaries', () => {
  const old = snapshot();
  assert.equal(production.parseProductionRun(old).summary.budget.frameAssessmentEstimateMicros, 0);
  old.summary.budget.spentMicros = 5_000_000;
  old.summary.budget.frameAssessmentEstimateMicros = 2_000_000;
  const budget = production.parseProductionRun(old).summary.budget;
  assert.equal(budget.spentMicros, 5_000_000);
  assert.equal(budget.frameAssessmentEstimateMicros, 2_000_000);
});

test('gacha flow keeps multiple candidates in the create body', () => {
  const body = production.productionCreateBody({ ...production.defaultProductionForm, projectId: 'project_demo', scriptVersionId: 'script_demo', candidatePolicy: 'gacha', candidateLimit: 3 }, 'client_12345678');
  assert.equal(body.candidatePolicy, 'gacha');
  assert.equal(body.candidateLimit, 3);
});

test('public production snapshot preserves server counts, attention and durable provenance', () => {
  const run = production.parseProductionRun(snapshot());
  assert.equal(run.status, 'waitingHuman');
  assert.equal(run.candidatePolicy, 'gacha');
  assert.equal(run.summary.tasks.completed, 1);
  assert.equal(run.stages[1].state, 'needsAttention');
  assert.equal(run.tasks[0].blockingReason.code, 'EXECUTOR_UNAVAILABLE');
  assert.equal(run.tasks[0].maxAttempts, 2);
  assert.equal(production.productionTaskCanRetry(run.tasks[0]), true);
  assert.equal(run.issues[0].impact[0], '后续任务等待');
  assert.equal(run.candidateSets[0].candidates[0].summary, '平稳叙事');
  assert.equal(run.timeline[0].message, '已创建生产运行');
  assert.equal(run.artifacts[0].url, undefined, 'local filesystem paths must not become browser links');
  assert.equal(run.qualityChecks[0].ruleVersion, 'v1');
});

test('quality-check rule versions stay short tokens', () => {
  const value = snapshot();
  value.qualityChecks = [
    { ...value.qualityChecks[0], id: 'pcheck_ok', ruleVersion: 'extract-facts-completeness/2' },
    { ...value.qualityChecks[0], id: 'pcheck_bad', ruleVersion: 'storyboard <script>' },
    { ...value.qualityChecks[0], id: 'pcheck_long', ruleVersion: 'a'.repeat(81) },
  ];
  const checks = production.parseProductionRun(value).qualityChecks;
  assert.equal(checks[0].ruleVersion, 'extract-facts-completeness/2');
  assert.equal(checks[1].ruleVersion, undefined);
  assert.equal(checks[2].ruleVersion, undefined);
});

test('retry eligibility stops exactly at the server-provided attempt limit', () => {
  const value = snapshot();
  value.tasks[0].attemptCount = 2;
  const task = production.parseProductionRun(value).tasks[0];
  assert.equal(task.maxAttempts, 2);
  assert.equal(production.productionTaskCanRetry(task), false);
});

test('artifact metadata survives parsing so node outputs can render breakdown, images and shots', () => {
  const value = snapshot();
  value.tasks[0].status = 'succeeded';
  value.artifacts = [
    { id: 'partifact_plan', runId: 'production_1234567890abcdef1234567890abcdef', taskId: 'ptask_123', kind: 'text', title: '已采用的剧本拆解', uri: null, sha256: null, metadata: { planRevisionId: 'plan_demo', adopted: true, scenes: 2, characters: 3 }, status: 'current', createdAt: '2026-10-23T00:01:00.000Z' },
    { id: 'partifact_image', runId: 'production_1234567890abcdef1234567890abcdef', taskId: 'ptask_123', kind: 'image', title: '人物·萧炎', uri: '/api/assets/asset_demo/content', sha256: 'a'.repeat(64), metadata: { model: 'demo-image-model', generated: true }, status: 'current', createdAt: '2026-10-23T00:01:00.000Z' },
    { id: 'partifact_board', runId: 'production_1234567890abcdef1234567890abcdef', taskId: 'ptask_123', kind: 'text', title: '已采用的分镜', uri: null, sha256: null, metadata: { storyboardRevisionId: 'board_demo', adopted: false, shots: [{ id: 'shot_1', sceneId: 'scene_1', order: 1, durationMs: 3200, shotSize: '中景', cameraMovement: '固定', visualDescription: '夜巷中人物对峙' }] }, status: 'current', createdAt: '2026-10-23T00:01:00.000Z' },
    { id: 'partifact_bare', runId: 'production_1234567890abcdef1234567890abcdef', taskId: 'ptask_123', kind: 'report', title: '预检报告', uri: null, sha256: null, metadata: {}, status: 'current', createdAt: '2026-10-23T00:01:00.000Z' },
  ];
  const run = production.parseProductionRun(value);
  assert.equal(run.artifacts[0].metadata.planRevisionId, 'plan_demo');
  assert.equal(run.artifacts[0].metadata.adopted, true);
  assert.equal(run.artifacts[1].url, '/api/assets/asset_demo/content');
  assert.equal(run.artifacts[1].metadata.model, 'demo-image-model');
  assert.equal(run.artifacts[2].metadata.shots[0].visualDescription, '夜巷中人物对峙');
  assert.equal(run.artifacts[3].metadata, undefined, 'empty metadata objects stay absent');
});

test('review, compose and delivery copy describe only implemented technical checks', () => {
  const value = snapshot();
  value.stages.push(
    { key: 'review', label: '自动复核', state: 'pending', completed: 0, total: 1, needsAttention: 0 },
    { key: 'compose', label: '剪辑合成', state: 'pending', completed: 0, total: 1, needsAttention: 0 },
  );
  value.delivery = { status: 'ready', artifactId: 'partifact_1' };
  value.artifacts[0].uri = '/api/production-media/media_123';
  const run = production.parseProductionRun(value);
  assert.equal(run.stages.at(-2).label, '镜头技术复核');
  assert.equal(run.stages.at(-1).label, '自动剪辑合成');
  assert.equal(run.delivery.message, '整集成片已完成本地技术校验。');
});

test('newer run versions win while a stale poll cannot roll the UI back', () => {
  const newer = production.parseProductionRun(snapshot(4));
  const stale = production.parseProductionRun(snapshot(3));
  assert.equal(production.mergeProductionRuns([newer], [stale])[0].version, 4);
  assert.equal(production.mergeProductionRuns([stale], [newer])[0].version, 4);
});

test('validation blocks missing immutable inputs and out-of-contract limits', () => {
  assert.match(production.validateProductionForm(production.defaultProductionForm), /项目/);
  assert.match(production.validateProductionForm({ ...production.defaultProductionForm, projectId: 'p', scriptVersionId: 's', candidatePolicy: 'direct', candidateLimit: 2 }), /直出版/);
  assert.match(production.validateProductionForm({ ...production.defaultProductionForm, projectId: 'p', scriptVersionId: 's', candidatePolicy: 'gacha', candidateLimit: 1 }), /2–4/);
  assert.match(production.validateProductionForm({ ...production.defaultProductionForm, projectId: 'p', scriptVersionId: 's', candidatePolicy: 'gacha', candidateLimit: 5 }), /2–4/);
  assert.equal(production.validateProductionForm({ ...production.defaultProductionForm, projectId: 'project_demo', scriptVersionId: 'script_demo' }), '');
  assert.equal(production.validateProductionForm({ ...production.defaultProductionForm, projectId: 'project_demo', scriptVersionId: 'script_demo', candidatePolicy: 'gacha', candidateLimit: 3 }), '');
});

test('automation/video remains a separate advanced single-shot route', async () => {
  const { routeFromHash } = await server.ssrLoadModule('/src/navigation.ts');
  assert.deepEqual(routeFromHash('#/automation'), { page: 'automation', step: 1 });
  assert.deepEqual(routeFromHash('#/automation/video'), { page: 'automation', step: 1, resourceId: 'video' });
});
