import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { buildEntityEdits, changedEntityFields, createEntityDrafts, entityDraftKey, entityEvidence, latestPlanForScript, validateEntityDrafts } = await server.ssrLoadModule('/src/facts-editor.ts');
const ref = { scriptVersionId: 'script_1', start: 3, end: 10, quote: '林晚握着钥匙。' };
const value = (text, refs = [ref]) => ({ value: text, origin: 'source', sourceRefs: refs, answerIds: [] });
const entity = (id, name) => ({ id, name: value(name), aliases: [], description: null, sourceRefs: [ref] });
const content = () => ({ characters: [entity('character_1', '林晚')], locations: [entity('location_1', '医院')], props: [entity('prop_1', '钥匙')] });

test('unchanged entities never create an edit and changes are scoped by stable identity', () => {
  const facts = content();
  const original = JSON.stringify(facts);
  const drafts = createEntityDrafts(facts);
  assert.deepEqual(buildEntityEdits(facts, drafts), []);
  drafts[entityDraftKey('character', 'character_1')].name = ' 林小姐 ';
  drafts[entityDraftKey('character', 'character_1')].aliases = ' 林晚\n\n小晚\r\n';
  assert.deepEqual(buildEntityEdits(facts, drafts), [{ kind: 'character', entityId: 'character_1', name: '林小姐', aliases: ['林晚', '小晚'], description: null }]);
  assert.equal(JSON.stringify(facts), original);
  assert.deepEqual(changedEntityFields(facts.characters[0], drafts['character:character_1']), ['name', 'aliases']);
});

test('all three entity groups can be edited and clearing a description is explicit null', () => {
  const facts = content();
  facts.props[0].description = value('生锈的钥匙');
  const drafts = createEntityDrafts(facts);
  drafts['character:character_1'].description = '由用户核实的人物说明';
  drafts['location:location_1'].name = '医院走廊';
  drafts['prop:prop_1'].description = '   ';
  const edits = buildEntityEdits(facts, drafts);
  assert.deepEqual(edits.map(edit => edit.kind), ['character', 'location', 'prop']);
  assert.equal(edits[2].description, null);
  assert.deepEqual(validateEntityDrafts(facts, drafts), []);
});

test('draft validation catches blank and duplicate names or aliases without changing evidence', () => {
  const facts = content();
  facts.characters.push(entity('character_2', '顾沉'));
  const drafts = createEntityDrafts(facts);
  drafts['character:character_2'].name = '林晚';
  drafts['prop:prop_1'].name = ' ';
  drafts['location:location_1'].aliases = '走廊\n走廊';
  const errors = validateEntityDrafts(facts, drafts);
  assert.ok(errors.some(error => error.includes('名称不能为空')));
  assert.ok(errors.some(error => error.includes('名称「林晚」重复')));
  assert.ok(errors.some(error => error.includes('重复别名')));
  assert.deepEqual(facts.characters[0].sourceRefs, [ref]);
});

test('evidence merges entity and field citations but never rewrites original quotes', () => {
  const person = entity('character_1', '林晚');
  const earlier = { ...ref, start: 0, end: 2, quote: '林晚' };
  person.aliases = [value('小晚', [earlier])];
  person.description = value('用户说明');
  person.description.origin = 'user';
  const evidence = entityEvidence(person);
  assert.deepEqual(evidence.map(item => item.ref), [earlier, ref]);
  assert.deepEqual(evidence[1].labels, ['实体依据', '名称', '说明']);
  assert.equal(evidence[1].ref.quote, '林晚握着钥匙。');
});

test('refresh selects newest saved manual revision for current script, not newest run or old script', () => {
  const plans = [
    { id: 'extract_1', scriptVersionId: 'script_1', runId: 'run_1' },
    { id: 'manual_1', scriptVersionId: 'script_1', runId: 'run_1' },
    { id: 'other_1', scriptVersionId: 'script_2', runId: 'run_2' },
  ];
  assert.equal(latestPlanForScript(plans, 'script_1').id, 'manual_1');
  assert.equal(latestPlanForScript(plans, 'script_3'), null);
  assert.equal(latestPlanForScript(plans, null), null);
});

test('opening source text with whitespace does not create silent manual edits', () => {
  const facts = content();
  facts.characters[0].name.value = ' 林晚 ';
  facts.characters[0].aliases = [value(' 小晚 ')];
  const drafts = createEntityDrafts(facts);
  assert.deepEqual(buildEntityEdits(facts, drafts), []);
  drafts['character:character_1'].description = '人工说明';
  const [edit] = buildEntityEdits(facts, drafts);
  assert.equal(edit.name, ' 林晚 ');
  assert.deepEqual(edit.aliases, [' 小晚 ']);
});

test('entity cards expose all groups, read-only evidence, and saved user provenance', async () => {
  const { default: FactsEditor } = await server.ssrLoadModule('/src/FactsEditor.tsx');
  const facts = content();
  facts.characters[0].name.origin = 'user';
  const plan = { id: 'plan_2', content: { ...facts, manualLocks: [{ targetType: 'entity', targetId: 'character_1', fields: ['name'], introducedInRevisionId: 'plan_2' }] } };
  const html = renderToStaticMarkup(createElement(FactsEditor, { plan, drafts: createEntityDrafts(facts), disabled: true, onChange() {} }));
  assert.match(html, /场景 \/ 地点/);
  assert.match(html, /道具/);
  assert.match(html, /原文依据/);
  assert.match(html, /林晚握着钥匙。/);
  assert.match(html, /人工修改 · 已记录/);
  assert.match(html, /disabled=""/);
  assert.equal((html.match(/<blockquote>/gu) ?? []).length, 3);
});
