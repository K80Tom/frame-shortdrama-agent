import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { advancedNavigation, commands, creationNavigation, navigationHash, projectWorkspaceHash, routeFromHash, screenplayProductionHash, workspaceNavigation } = await server.ssrLoadModule('/src/navigation.ts');
const { applyHashNavigation } = await server.ssrLoadModule('/src/navigation-guard.ts');

test('workspace routes preserve legacy flow links and safely decode project identities', () => {
  const screenplay = { projectId: 'project_test', scriptVersionId: 'script_test' };
  assert.deepEqual(routeFromHash(screenplayProductionHash(screenplay)).screenplay, screenplay);
  assert.equal(routeFromHash('#/automation/from-script/project_test').screenplay, undefined);
  assert.deepEqual(routeFromHash('#step-5'), { page: 'flow', step: 5 });
  assert.deepEqual(routeFromHash('#/flow/9'), { page: 'flow', step: 9 });
  assert.deepEqual(routeFromHash('#/flow/99'), { page: 'flow', step: 1 });
  assert.deepEqual(routeFromHash('#/production'), { page: 'production', step: 1 });
  assert.deepEqual(routeFromHash('#/novel/new'), { page: 'novel', step: 1, resourceId: 'new' });
  assert.deepEqual(routeFromHash('#/novel/story%2F%E4%B8%80'), { page: 'novel', step: 1, resourceId: 'story/一' });
  assert.deepEqual(routeFromHash('#/novel/%broken'), { page: 'novel', step: 1 });
  assert.equal(routeFromHash('#/projects').page, 'projects');
  assert.equal(routeFromHash('#/plugins').page, 'studio');
  assert.deepEqual(routeFromHash('#/assets/references'), { page: 'assets', step: 1, resourceId: 'references' });
  assert.deepEqual(routeFromHash('#/assets'), { page: 'assets', step: 1 });
  assert.equal(routeFromHash('#/unknown').page, 'studio');
});

test('project workspace links preserve the project identity and normalize flow sections', () => {
  const mappings = {
    overview: 'overview', source: 'script', screenplay: 'script', storyboard: 'storyboard',
    canvas: 'canvas', director: 'storyboard', production: 'production', review: 'production', history: 'production',
  };
  for (const [legacySection, projectSection] of Object.entries(mappings)) {
    const hash = projectWorkspaceHash('story/\u4e00', legacySection);
    assert.deepEqual(routeFromHash(hash), { page: 'projects', step: 1, projectId: 'story/\u4e00', projectSection });
  }
  assert.deepEqual(routeFromHash('#/projects/project_test/director/'), {
    page: 'projects', step: 1, projectId: 'project_test', projectSection: 'storyboard',
  });
  assert.deepEqual(routeFromHash('#/projects/project_test/assets'), {
    page: 'projects', step: 1, projectId: 'project_test', projectSection: 'assets',
  });
  for (const panel of ['script-parse', 'script-structure']) {
    assert.deepEqual(routeFromHash(`#/projects/project_test/${panel}`), {
      page: 'projects', step: 1, projectId: 'project_test', projectSection: panel,
    });
  }
  assert.deepEqual(routeFromHash('#/projects/%broken/overview'), { page: 'projects', step: 1 });
  assert.deepEqual(routeFromHash('#/projects/project_test/unknown'), {
    page: 'projects', step: 1, projectId: 'project_test', projectSection: 'overview',
  });
});

test('only five global destinations are primary, while advanced tools and legacy routes remain reachable', () => {
  assert.deepEqual(workspaceNavigation.map(item => item.id), ['studio', 'projects', 'assets', 'automation', 'settings']);
  assert.deepEqual(workspaceNavigation.map(item => item.label), ['工作台', '项目', '资产库', 'AI 视频', '设置']);
  assert.equal(navigationHash(workspaceNavigation.find(item => item.id === 'automation')), '#/automation/video');
  assert.deepEqual(advancedNavigation.map(item => item.id), ['methods', 'evolution', 'director', 'flow']);
  for (const id of ['novel', 'production', 'storyboard', 'canvas', 'script']) {
    assert.equal(commands.some(item => item.id === id), false, 'project creation is not another global tool menu');
    assert.equal(routeFromHash(`#/${id}`).page, id, 'saved hashes and go() calls remain valid');
  }
  assert.deepEqual(creationNavigation.map(item => item.id), ['automation', 'novel', 'production', 'storyboard', 'canvas', 'director']);
  assert.deepEqual(routeFromHash('#/automation/video'), { page: 'automation', step: 1, resourceId: 'video' });
  assert.deepEqual(routeFromHash('#/canvas/prj_canvas'), { page: 'canvas', step: 1, resourceId: 'prj_canvas' });
  assert.deepEqual(routeFromHash('#/canvas'), { page: 'canvas', step: 1 });
});

test('switching to another item in the same editor cannot discard a dirty draft without confirmation', () => {
  for (const page of ['production', 'novel']) {
    const current = { route: { page, resourceId: 'first' }, hash: `#/${page}/first` };
    for (const destination of ['second', 'new']) {
      const next = { route: { page, resourceId: destination }, hash: `#/${page}/${destination}` };
      const restored = [];
      const result = applyHashNavigation(current, next, {
        hasUnsavedProduction: page === 'production', hasUnsavedNovel: page === 'novel',
        confirmLeave: () => false,
        restoreHash: hash => restored.push(hash),
        commitRoute: () => assert.fail('cancelled switch must preserve the mounted editor'),
      });
      assert.equal(result, current);
      assert.deepEqual(restored, [current.hash]);
    }
  }
});

test('a clean item switch is committed and an identical editor location does not prompt', () => {
  const current = { route: { page: 'novel', resourceId: 'first' }, hash: '#/novel/first' };
  const next = { route: { page: 'novel', resourceId: 'second' }, hash: '#/novel/second' };
  let committed;
  const options = { hasUnsavedProduction: false, hasUnsavedNovel: false,
    confirmLeave: () => assert.fail('no confirmation needed'),
    restoreHash: () => assert.fail('no rollback needed'), commitRoute: route => { committed = route; } };
  assert.equal(applyHashNavigation(current, next, options), next);
  assert.equal(committed, next.route);
  assert.equal(applyHashNavigation(current, current, { ...options, hasUnsavedNovel: true }), current);
});

test('dirty saved structure is protected when switching back to parse center', () => {
  const current = { route: routeFromHash('#/projects/project_one/script-structure'), hash: '#/projects/project_one/script-structure' };
  const hash = '#/projects/project_one/script-parse';
  const next = { route: routeFromHash(hash), hash };
  const restored = [];
  const result = applyHashNavigation(current, next, {
    hasUnsavedProduction: true,
    confirmLeave: () => false,
    restoreHash: value => restored.push(value),
    commitRoute: () => assert.fail('dirty structure must not be unmounted without confirmation'),
  });
  assert.equal(result, current);
  assert.deepEqual(restored, [current.hash]);
});

test('switching project workspace section or project protects a dirty mapped editor', () => {
  const current = { route: routeFromHash('#/projects/project_one/script'), hash: '#/projects/project_one/script' };
  for (const hash of ['#/projects/project_one/canvas', '#/projects/project_two/script']) {
    const next = { route: routeFromHash(hash), hash };
    const restored = [];
    const result = applyHashNavigation(current, next, {
      hasUnsavedProduction: true,
      confirmLeave: () => false,
      restoreHash: value => restored.push(value),
      commitRoute: () => assert.fail('cancelled project navigation must preserve the mounted editor'),
    });
    assert.equal(result, current);
    assert.deepEqual(restored, [current.hash]);
  }
});
