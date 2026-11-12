import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const {
  addElement, addElementAfter, addEpisode, addScene, parseScriptStructure, patchScene, removeElement, removeScene,
  serializeScriptStructure, updateElement,
} = await server.ssrLoadModule('/src/script-structure.ts');
const { ScriptParseEntityFields, repairSceneTarget, default: ProjectScriptWorkspace } = await server.ssrLoadModule('/src/ProjectScriptWorkspace.tsx');
const { default: StructuredScriptEditor } = await server.ssrLoadModule('/src/StructuredScriptEditor.tsx');

const raw = `第1集
剧情概览：林澈回到旧钟表店，寻找等了十二年的答案。

1-1 内景 旧钟表店 日
【环境】墙上挂满停走的旧钟，柜台里摆着同款手表。
老周（低声）：这块表，等了你十二年。
【旁白】林澈没有接话。
【镜头】特写两只旧表并排，秒针同时颤动。
【动作】林澈把手中的表轻轻放在柜台上。

第2集

2-1 外景 天台 夜
林澈：如果时间真的能重来，你会不会还站在这里？`;

function withoutIds(structure) {
  return structure.episodes.map(episode => ({
    episodeNumber: episode.episodeNumber, title: episode.title, synopsis: episode.synopsis,
    scenes: episode.scenes.map(scene => ({
      sceneNumber: scene.sceneNumber, intExt: scene.intExt, location: scene.location,
      timeOfDay: scene.timeOfDay, sceneDescription: scene.sceneDescription,
      dialogues: scene.dialogues.map(element => ({
        type: element.type, content: element.content,
        characterName: element.characterName, parenthetical: element.parenthetical,
      })),
    })),
  }));
}

test('parses episodes, scenes and all five element types', () => {
  const structure = parseScriptStructure(raw);
  assert.equal(structure.episodes.length, 2);
  assert.equal(structure.episodes[0].synopsis, '林澈回到旧钟表店，寻找等了十二年的答案。');
  assert.equal(structure.episodes[0].scenes[0].sceneNumber, '1-1');
  assert.equal(structure.episodes[0].scenes[0].location, '旧钟表店');
  assert.equal(structure.episodes[0].scenes[0].timeOfDay, '日');
  assert.deepEqual(structure.episodes[0].scenes[0].dialogues.map(element => element.type), [5, 1, 3, 4, 2]);
  assert.equal(structure.episodes[0].scenes[0].dialogues[1].characterName, '老周');
  assert.equal(structure.episodes[0].scenes[0].dialogues[1].parenthetical, '低声');
  assert.equal(structure.episodes[1].scenes[0].intExt, '外');
});

test('serializes to canonical text and round-trips without losing structure', () => {
  const structure = parseScriptStructure(raw);
  const text = serializeScriptStructure(structure);
  assert.match(text, /剧情概览：林澈回到旧钟表店/);
  assert.match(text, /1-1 内景 旧钟表店 日/);
  assert.match(text, /老周（低声）：这块表，等了你十二年。/);
  assert.match(text, /【镜头】特写两只旧表并排/);
  assert.deepEqual(withoutIds(parseScriptStructure(text)), withoutIds(structure));
});

test('adding episodes, scenes and typed elements keeps the document editable and serializable', () => {
  const first = addEpisode(parseScriptStructure(raw));
  assert.equal(first.episodes.length, 3);
  const episodeId = first.episodes.at(-1).id;
  const withScene = addScene(first, episodeId);
  const sceneId = withScene.episodes.at(-1).scenes.at(-1).id;
  let next = addElement(withScene, episodeId, sceneId, 1);
  next = addElement(next, episodeId, sceneId, 4);
  const final = addElement(next, episodeId, sceneId, 5);
  const saved = final.episodes.at(-1).scenes.at(-1);
  assert.equal(saved.dialogues.length, 3);
  assert.deepEqual(saved.dialogues.map(item => item.type), [1, 4, 5]);
  const inserted = addElementAfter(final, episodeId, sceneId, 1, 1);
  assert.deepEqual(inserted.episodes.at(-1).scenes.at(-1).dialogues.map(item => item.type), [1, 1, 4, 5]);
  assert.deepEqual(final.episodes.at(-1).scenes.at(-1).dialogues.map(item => item.type), [1, 4, 5]);

  const edited = updateElement(final, episodeId, sceneId, saved.dialogues[0].id, {
    characterName: '林澈', content: '我会等你。',
  });
  const sceneEdited = patchScene(edited, episodeId, sceneId, { location: '新地点', sceneDescription: '雨水打在窗上。' });
  const text = serializeScriptStructure(sceneEdited);
  assert.match(text, /新地点/);
  assert.match(text, /雨水打在窗上。/);
  assert.match(text, /林澈：我会等你。/);
  assert.match(text, /【镜头】/);
  assert.match(text, /【环境】/);
});

test('removing a scene or element only removes the targeted item', () => {
  const structure = parseScriptStructure(raw);
  const episode = structure.episodes[0];
  const scene = episode.scenes[0];
  const trimmed = removeElement(structure, episode.id, scene.id, scene.dialogues[0].id);
  assert.equal(trimmed.episodes[0].scenes[0].dialogues.length, 4);
  assert.equal(trimmed.episodes[0].scenes[0].dialogues[0].type, 1);
  const withoutScene = removeScene(structure, episode.id, scene.id);
  assert.equal(withoutScene.episodes[0].scenes.length, 0);
});

test('typed labels are not stripped from user content on serialization', () => {
  const structure = parseScriptStructure(`第1集

1-1 内景 客厅 日
【旁白】旁白：窗外下雨了。
【镜头】镜头：缓慢推近。
【环境】环境：潮湿的旧木地板。`);
  const text = serializeScriptStructure(structure);
  assert.match(text, /【旁白】旁白：窗外下雨了。/);
  assert.match(text, /【镜头】镜头：缓慢推近。/);
  assert.match(text, /【环境】环境：潮湿的旧木地板。/);
});

test('AI parse preview exposes editable character, location and prop fields', () => {
  const cases = [
    { label: '人物', name: '林澈', add: '+ 添加人物' },
    { label: '场景 / 地点', name: '旧钟表店', add: '+ 添加地点' },
    { label: '道具', name: '放大镜', add: '+ 添加道具' },
  ];
  for (const item of cases) {
    const html = renderToStaticMarkup(createElement(ScriptParseEntityFields, {
      label: item.label,
      items: [{ name: item.name, aliases: [], description: null }],
      disabled: false,
      onPatch: () => undefined,
      onRemove: () => undefined,
      onAppend: () => undefined,
    }));
    assert.match(html, new RegExp(`aria-label="${item.label}解析结果"`));
    assert.match(html, new RegExp(`value="${item.name}"`));
    assert.match(html, new RegExp(`aria-label="删除${item.label === '场景 / 地点' ? '地点' : item.label} ${item.name}"`));
    assert.match(html, new RegExp(item.add.replace('+', '\\+')));
  }
});

test('AI parse center and saved structure are independent screens', () => {
  const parseHtml = renderToStaticMarkup(createElement(ProjectScriptWorkspace, { projectId: 'project_demo', panel: 'parse' }));
  assert.match(parseHtml, /原文与 AI 解析/);
  assert.match(parseHtml, /解析记录/);
  assert.match(parseHtml, /href="#\/projects\/project_demo\/script-structure"/);
  assert.doesNotMatch(parseHtml, /SAVED SCRIPT STRUCTURE/);

  const structureHtml = renderToStaticMarkup(createElement(ProjectScriptWorkspace, { projectId: 'project_demo', panel: 'structure' }));
  assert.match(structureHtml, /SAVED SCRIPT STRUCTURE/);
  assert.match(structureHtml, /还没有已确认的剧本结构/);
  assert.match(structureHtml, /href="#\/projects\/project_demo\/script-parse"/);
  assert.doesNotMatch(structureHtml, /id="project-script-raw"/);
});

test('校验问题可定位到独立结构页场次并显示手动修复入口', () => {
  const structure = parseScriptStructure(raw);
  const plan = { content: { scenes: [
    { id: 'scene_a', order: 1, title: { value: '旧钟表店' }, sourceRefs: [{ start: 0, end: 100 }] },
    { id: 'scene_b', order: 2, title: { value: '2-1' }, sourceRefs: [{ start: 101, end: 200 }] },
  ] } };
  const sceneIssue = { scope: { kind: 'scene', targetId: 'scene_b' }, sourceRefs: [] };
  assert.equal(repairSceneTarget(plan, sceneIssue, structure).sceneId, structure.episodes[1].scenes[0].id);
  const sourceIssue = { scope: { kind: 'sourceSpan', targetId: null }, sourceRefs: [{ start: 10, end: 20 }] };
  assert.equal(repairSceneTarget(plan, sourceIssue, structure).sceneId, structure.episodes[0].scenes[0].id);
  const target = structure.episodes[0].scenes[0];
  const html = renderToStaticMarkup(createElement(StructuredScriptEditor, {
    structure, onChange: () => undefined, repairNotice: '手动修复：请添加对白。',
    focusRequest: { sceneId: target.id, requestId: 1 },
  }));
  assert.match(html, /手动修复：请添加对白。/);
  assert.match(html, /is-repair-target/);
  assert.match(html, /上方补对白/);
  assert.match(html, /\+ 添加对白/);
});
