import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { applyHashNavigation } = await server.ssrLoadModule('/src/navigation-guard.ts');
const production = { route: { page: 'production', step: 1 }, hash: '#/production' };
const studio = { route: { page: 'studio', step: 1 }, hash: '#/studio' };

test('unsaved asset registration uses the same pre-unmount leave guard', () => {
  const assets = { route: { page: 'assets' }, hash: '#/assets' };
  const restored = [];
  assert.equal(applyHashNavigation(assets, studio, {
    hasUnsavedProduction: false, hasUnsavedAssets: true, confirmLeave: () => false,
    restoreHash: hash => restored.push(hash), commitRoute: () => assert.fail('do not unmount the asset form'),
  }), assets);
  assert.deepEqual(restored, ['#/assets']);
});

test('cancelled leave restores URL without committing route or unmounting the editor', () => {
  const committed = [];
  const restored = [];
  let confirmations = 0;
  const current = applyHashNavigation(production, studio, {
    hasUnsavedProduction: true,
    confirmLeave: () => { confirmations += 1; return false; },
    restoreHash: hash => restored.push(hash),
    commitRoute: route => committed.push(route),
  });
  assert.equal(current, production);
  assert.deepEqual(committed, []);
  assert.deepEqual(restored, ['#/production']);
  assert.equal(confirmations, 1);
});

test('confirmed leave commits route once; cancelling a later leave still keeps editor state', () => {
  const committed = [];
  const restored = [];
  let current = applyHashNavigation(production, studio, {
    hasUnsavedProduction: true, confirmLeave: () => true,
    restoreHash: hash => restored.push(hash), commitRoute: route => committed.push(route),
  });
  assert.equal(current, studio);
  current = applyHashNavigation(current, production, {
    hasUnsavedProduction: false, confirmLeave: () => assert.fail('clean navigation should not ask'),
    restoreHash: hash => restored.push(hash), commitRoute: route => committed.push(route),
  });
  current = applyHashNavigation(current, studio, {
    hasUnsavedProduction: true, confirmLeave: () => false,
    restoreHash: hash => restored.push(hash), commitRoute: route => committed.push(route),
  });
  assert.equal(current, production);
  assert.deepEqual(committed, [studio.route, production.route]);
  assert.deepEqual(restored, ['#/production']);
});

test('clean or same-page navigation does not show a leave confirmation', () => {
  let commits = 0;
  for (const [next, dirty] of [[studio, false], [production, true]]) {
    applyHashNavigation(production, next, {
      hasUnsavedProduction: dirty,
      confirmLeave: () => assert.fail('no confirmation expected'),
      restoreHash: () => assert.fail('no rollback expected'),
      commitRoute: () => { commits += 1; },
    });
  }
  assert.equal(commits, 2);
});

test('novel drafts use the same pre-commit protection, including navigation to the other editor', () => {
  const novel = { route: { page: 'novel', step: 1 }, hash: '#/novel' };
  for (const next of [studio, production]) {
    const restored = [];
    const result = applyHashNavigation(novel, next, {
      hasUnsavedProduction: false, hasUnsavedNovel: true,
      confirmLeave: () => false,
      restoreHash: hash => restored.push(hash),
      commitRoute: () => assert.fail('cancelled novel navigation must not unmount the editor'),
    });
    assert.equal(result, novel);
    assert.deepEqual(restored, ['#/novel']);
  }
  const result = applyHashNavigation(novel, studio, {
    hasUnsavedProduction: false, hasUnsavedNovel: false,
    confirmLeave: () => assert.fail('clean novel editor should not prompt'),
    restoreHash: () => assert.fail('no rollback expected'), commitRoute: () => undefined,
  });
  assert.equal(result, studio);
});
