import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { classifyStoryboards, isConflictError } = await server.ssrLoadModule('/src/ProjectStoryboardWorkspace.tsx');

test('isConflictError：仅识别 api() 打出的 409 冲突', () => {
  assert.equal(isConflictError({ status: 409 }), true);
  assert.equal(isConflictError({ status: 400 }), false);
  assert.equal(isConflictError(new Error('网络错误')), false);
  assert.equal(isConflictError(null), false);
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
