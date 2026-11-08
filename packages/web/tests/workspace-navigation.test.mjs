import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { commands, creationNavigation, projectWorkspaceHash, routeFromHash, screenplayProductionHash, workspaceNavigation } = await server.ssrLoadModule('/src/navigation.ts');
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

test('project workspace links preserve the project identity and map sections onto existing editors', () => {
  const mappings = {
    overview: 'projects', source: 'production', screenplay: 'production', storyboard: 'storyboard',
    director: 'director', production: 'automation', review: 'projects', history: 'projects',
  };
  for (const [projectSection, page] of Object.entries(mappings)) {
    const hash = projectWorkspaceHash('story/\u4e00', projectSection);
    assert.deepEqual(routeFromHash(hash), { page, step: 1, projectId: 'story/\u4e00', projectSection });
  }
  assert.deepEqual(routeFromHash('#/projects/project_test/director/'), {
    page: 'director', step: 1, projectId: 'project_test', projectSection: 'director',
  });
  assert.deepEqual(routeFromHash('#/projects/%broken/overview'), { page: 'projects', step: 1 });
  assert.deepEqual(routeFromHash('#/projects/project_test/unknown'), { page: 'projects', step: 1 });
});

test('global navigation contains only workspace-level destinations while commands preserve creation tools', () => {
  assert.deepEqual(workspaceNavigation.map(item => item.id), ['studio', 'projects', 'assets', 'methods', 'evolution']);
  assert.deepEqual(creationNavigation.map(item => item.id), ['automation', 'novel', 'production', 'storyboard', 'director']);
  for (const id of ['methods', 'evolution', 'automation', 'novel', 'production', 'storyboard', 'director']) {
    assert.ok(commands.some(item => item.id === id));
  }
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

test('switching project workspace section or project protects a dirty mapped editor', () => {
  const current = { route: routeFromHash('#/projects/project_one/screenplay'), hash: '#/projects/project_one/screenplay' };
  for (const hash of ['#/projects/project_one/source', '#/projects/project_two/screenplay']) {
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
