import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { default: GitHubDock, githubDockLinks } = await server.ssrLoadModule('/src/GitHubDock.tsx');

test('GitHub dock exposes safe project links without claiming anonymous actions completed', () => {
  assert.deepEqual(githubDockLinks.map(link => link.id), ['follow', 'star', 'fork', 'watch', 'run']);
  assert.ok(githubDockLinks.every(link => link.href.startsWith('https://')));
  assert.equal(githubDockLinks.find(link => link.id === 'fork').href, 'https://github.com/K80Tom/frame-shortdrama-agent/fork');
  assert.equal(githubDockLinks.find(link => link.id === 'watch').href, 'https://github.com/K80Tom/frame-shortdrama-agent/subscription');
  assert.match(githubDockLinks.find(link => link.id === 'run').href, /^https:\/\/codespaces\.new\/K80Tom\/frame-shortdrama-agent/);

  const html = renderToStaticMarkup(createElement(GitHubDock));
  assert.equal((html.match(/target="_blank"/g) ?? []).length, githubDockLinks.length + 1);
  assert.equal((html.match(/rel="noopener noreferrer"/g) ?? []).length, githubDockLinks.length + 1);
  assert.doesNotMatch(html, /token|api[_-]?key|authorization/i);
  assert.match(html, /前往 GitHub 为 Lyra 添加 Star/);
  assert.match(html, /在 GitHub Codespaces 中运行 Lyra/);
});
