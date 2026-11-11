import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { deriveScriptState } = await server.ssrLoadModule('/src/ProjectScriptWorkspace.tsx');
const { classifyStoryboards } = await server.ssrLoadModule('/src/ProjectStoryboardWorkspace.tsx');

const base = {
  currentScriptVersionId: 'script_2',
  runs: [{ id: 'run_1', status: 'succeeded', scriptVersionId: 'script_2' }],
  plans: [{ id: 'plan_1', scriptVersionId: 'script_2', runId: 'run_1', reason: 'extract' }],
  activePlanRevisionId: null,
  check: null,
};

test('deriveScriptState：无剧本→add-script；有剧本无 run→start-breakdown', () => {
  assert.equal(deriveScriptState({ ...base, currentScriptVersionId: null, runs: [], plans: [] }), 'add-script');
  assert.equal(deriveScriptState({ ...base, runs: [] }), 'start-breakdown');
});

test('deriveScriptState：候选未校验/校验未过→review-facts；校验通过未采用→adopt-facts；已采用→into-storyboard', () => {
  assert.equal(deriveScriptState(base), 'review-facts');
  const failed = { ...base, check: { id: 'c1', result: 'failed', ruleVersion: 'extract-facts-completeness/2' } };
  assert.equal(deriveScriptState(failed), 'review-facts');
  const passed = { ...base, check: { id: 'c1', result: 'passed', ruleVersion: 'extract-facts-completeness/2' } };
  assert.equal(deriveScriptState(passed), 'adopt-facts');
  const staleRule = { ...base, check: { id: 'c1', result: 'passed', ruleVersion: 'old-rule/1' } };
  assert.equal(deriveScriptState(staleRule), 'review-facts');
  assert.equal(deriveScriptState({ ...passed, activePlanRevisionId: 'plan_1' }), 'into-storyboard');
});

test('classifyStoryboards：标注已采用/候选/旧事实候选，不替用户覆盖选择', () => {
  const boards = [
    { id: 'board_old', projectId: 'p', scriptVersionId: 'script_2', sourcePlanRevisionId: 'plan_old', shots: [] },
    { id: 'board_new', projectId: 'p', scriptVersionId: 'script_2', sourcePlanRevisionId: 'plan_1', shots: [] },
  ];
  const rows = classifyStoryboards(boards, 'board_new', 'plan_1');
  assert.equal(rows[0].adopted, false);
  assert.equal(rows[0].stale, true);
  assert.equal(rows[1].adopted, true);
  assert.equal(rows[1].stale, false);
});
