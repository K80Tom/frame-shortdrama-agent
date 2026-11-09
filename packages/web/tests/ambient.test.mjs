import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());

const { LyraBackdrop, WORKSPACE_PLAYBACK_RATE, backdropVariantForRoute, nextScrubTime } = await server.ssrLoadModule('/src/ambient.tsx');

test('workspace backdrop plays at one fifth of the source video speed', () => {
  assert.equal(WORKSPACE_PLAYBACK_RATE, 0.2);
});

test('backdrop intensity follows the workspace route instead of duplicating page backgrounds', () => {
  assert.equal(backdropVariantForRoute({ page: 'studio' }), 'workspace');
  assert.equal(backdropVariantForRoute({ page: 'projects' }), 'workspace');
  assert.equal(backdropVariantForRoute({ page: 'assets' }), 'workspace');
  assert.equal(backdropVariantForRoute({ page: 'evolution' }), 'workspace');
  assert.equal(backdropVariantForRoute({ page: 'projects', projectSection: 'overview' }), 'workspace');
  assert.equal(backdropVariantForRoute({ page: 'production' }), 'focus');
  assert.equal(backdropVariantForRoute({ page: 'director' }), 'focus');
  assert.equal(backdropVariantForRoute({ page: 'settings' }), 'focus');
  assert.equal(backdropVariantForRoute({ page: 'projects', projectSection: 'source' }), 'focus');
  assert.equal(backdropVariantForRoute({ page: 'projects', projectSection: 'director' }), 'focus');
});

test('scrub math moves in either direction and clamps to the video duration', () => {
  assert.equal(nextScrubTime(4, 100, 1000, 10), 4.8);
  assert.ok(Math.abs(nextScrubTime(4, -100, 1000, 10) - 3.2) < Number.EPSILON * 3);
  assert.equal(nextScrubTime(9.8, 1000, 1000, 10), 10);
  assert.equal(nextScrubTime(0.2, -1000, 1000, 10), 0);
  assert.equal(nextScrubTime(4, 20, 0, 10), 4);
  assert.equal(nextScrubTime(4, 20, 1000, Number.NaN), 4);
});

test('backdrop SSR keeps a CSS fallback and exposes its non-interactive state', () => {
  for (const variant of ['landing', 'auth', 'workspace', 'focus']) {
    const html = renderToStaticMarkup(createElement(LyraBackdrop, { variant, videoUrl: '', posterUrl: '' }));
    assert.match(html, new RegExp(`data-backdrop-variant="${variant}"`));
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /ambient-media/);
    assert.match(html, /data-video-active="false"/);
    assert.doesNotMatch(html, /<video/);
  }
});
