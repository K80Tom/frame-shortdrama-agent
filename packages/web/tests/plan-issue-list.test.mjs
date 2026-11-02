import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { PlanIssueList } = await server.ssrLoadModule('/src/plan-issue-list.tsx');

test('issue cards show the field path, object, expected value, actual value and source quote', () => {
  const html = renderToStaticMarkup(createElement(PlanIssueList, { issues: [
    { id: 'issue_1', code: 'DIALOGUE_INCOMPLETE', message: '对白只提取了原文的一部分。',
      scope: { kind: 'scene', targetId: 'scene_1', field: {
        objectKind: 'dialogue', objectId: 'dialogue_1', fieldPath: '/dialogues/dialogue_1/sourceRef',
        expected: '你终于来了。🙂', actual: '你' } },
      sourceRefs: [{ quote: '你终于来了。🙂' }] },
    { id: 'issue_legacy', code: 'DIALOGUE_MISSING', message: '原文对白没有进入拆解结果。',
      scope: { kind: 'project', targetId: null }, sourceRefs: [{ quote: '顾沉：我知道。' }] },
  ] }));
  assert.match(html, /data-field-path="\/dialogues\/dialogue_1\/sourceRef"/);
  assert.match(html, /dialogue dialogue_1/);
  assert.match(html, /期望：你终于来了。🙂/);
  assert.match(html, /实际：你</);
  assert.match(html, /DIALOGUE_MISSING/);
  assert.match(html, /顾沉：我知道。/);
  assert.equal(html.includes('data-field-path=""'), false);
  assert.equal((html.match(/data-field-path=/g) ?? []).length, 1);
});

test('an empty issue list renders nothing', () => {
  assert.equal(renderToStaticMarkup(createElement(PlanIssueList, { issues: [] })), '');
});
