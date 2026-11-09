import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { default: HoloCard } = await server.ssrLoadModule('/src/HoloCard.jsx');
const { ProjectCard } = await server.ssrLoadModule('/src/ProjectsPage.tsx');
const { shouldShowLocalPractice } = await server.ssrLoadModule('/src/project-catalog.ts');

const practice = { id: 'practice', title: '赴约 · 分镜练习', kind: 'practice', date: null, status: '手写样例' };
const project = { id: 'project', title: '远程项目', kind: 'project', date: '2026-11-08T00:00:00.000Z', status: '等待剧本' };

test('local practice is an automatic fallback until the first real project exists', () => {
  assert.equal(shouldShowLocalPractice({ items: [], status: 'loading' }), false, 'avoid flashing practice while the catalog loads');
  assert.equal(shouldShowLocalPractice({ items: [], status: 'ready' }), true, 'show onboarding practice for an empty catalog');
  assert.equal(shouldShowLocalPractice({ items: [], status: 'error' }), true, 'keep a usable fallback when the catalog is unavailable');
  assert.equal(shouldShowLocalPractice({ items: [{ id: 'project_1' }], status: 'ready' }), false, 'hide practice after a real project exists');
});

test('HoloCard keeps an image fallback when WebGL has not started', () => {
  const markup = renderToStaticMarkup(createElement(HoloCard, {
    image: '/assets/duel.png', alt: '项目封面', preset: 'gold', idle: false, shadow: false,
  }));
  assert.match(markup, /class="holo-card"/);
  assert.match(markup, /role="img"/);
  assert.match(markup, /aria-label="项目封面"/);
  assert.match(markup, /data-preset="gold"/);
  assert.match(markup, /data-idle="false"/);
  assert.match(markup, /<img src="\/assets\/duel\.png" alt=""/);
  assert.match(markup, /<canvas><\/canvas>/);
  assert.doesNotMatch(markup, /data-ready/);
  assert.doesNotMatch(markup, /holo-card__shadow/);
});

test('grid practice card adds a non-idle gold cover without replacing the project button', () => {
  const markup = renderToStaticMarkup(ProjectCard({ entry: practice, open: () => {}, view: 'grid' }));
  assert.match(markup, /<button class="hub-card"/);
  assert.equal(markup.match(/<button/g)?.length, 1);
  assert.match(markup, /aria-label="打开本地练习：赴约 · 分镜练习"/);
  assert.match(markup, /class="holo-card hub-holo-card"/);
  assert.match(markup, /data-preset="gold"/);
  assert.match(markup, /data-idle="false"/);
  assert.match(markup, /src="\/assets\/duel\.png"/);
});

test('list and placeholder cards stay lightweight', () => {
  const listMarkup = renderToStaticMarkup(ProjectCard({ entry: practice, open: () => {}, view: 'list' }));
  const projectMarkup = renderToStaticMarkup(ProjectCard({ entry: project, open: () => {}, view: 'grid' }));
  assert.doesNotMatch(listMarkup, /holo-card/);
  assert.match(listMarkup, /class="hub-cover-image"/);
  assert.doesNotMatch(projectMarkup, /holo-card/);
  assert.match(projectMarkup, /hub-cover-placeholder/);
  assert.match(projectMarkup, /aria-label="打开剧本项目：远程项目"/);
});
