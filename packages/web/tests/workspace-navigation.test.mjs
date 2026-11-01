import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { routeFromHash } = await server.ssrLoadModule('/src/navigation.ts');
const { applyHashNavigation } = await server.ssrLoadModule('/src/navigation-guard.ts');

test('workspace routes preserve legacy flow links and safely decode project identities', () => {
  assert.deepEqual(routeFromHash('#step-5'), { page: 'flow', step: 5 });
  assert.deepEqual(routeFromHash('#/flow/9'), { page: 'flow', step: 9 });
  assert.deepEqual(routeFromHash('#/flow/99'), { page: 'flow', step: 1 });
  assert.deepEqual(routeFromHash('#/production'), { page: 'production', step: 1 });
  assert.deepEqual(routeFromHash('#/novel/new'), { page: 'novel', step: 1, resourceId: 'new' });
  assert.deepEqual(routeFromHash('#/novel/story%2F%E4%B8%80'), { page: 'novel', step: 1, resourceId: 'story/一' });
  assert.deepEqual(routeFromHash('#/novel/%broken'), { page: 'novel', step: 1 });
  assert.equal(routeFromHash('#/projects').page, 'projects');
  assert.equal(routeFromHash('#/plugins').page, 'plugins');
  assert.deepEqual(routeFromHash('#/assets/references'), { page: 'assets', step: 1, resourceId: 'references' });
  assert.deepEqual(routeFromHash('#/assets'), { page: 'assets', step: 1 });
  assert.equal(routeFromHash('#/unknown').page, 'studio');
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
