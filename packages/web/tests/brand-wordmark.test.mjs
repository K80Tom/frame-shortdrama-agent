import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { BrandWordmark } = await server.ssrLoadModule('/src/components.tsx');

test('brand wordmark keeps real readable text under the decorative flow effect', () => {
  const markup = renderToStaticMarkup(createElement(BrandWordmark));
  assert.match(markup, /^<strong class="brand-lockup">/);
  assert.match(markup, /class="brand-wordmark" data-wordmark="Lyra">Lyra<\/span>/);
  assert.match(markup, /class="brand-subtitle">STORY STUDIO<\/span>/);
  assert.doesNotMatch(markup, /<button/);
});
