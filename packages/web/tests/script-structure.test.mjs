import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const {
  addElement, addElementAfter, addEpisode, addScene, appendEpisodeFromText, applySelectedDiffs, countScriptCharacters,
  buildStructureFactCandidate, diffScriptStructures, estimateSceneCount, mergeScenes, parseScriptStructure, patchScene, planCharacterImport,
  removeElement, removeScene, scopeEpisodeDraft, serializeScriptStructure, splitScene, summarizeScriptStructure, updateElement,
} = await server.ssrLoadModule('/src/script-structure.ts');
const { default: ProjectScriptWorkspace } = await server.ssrLoadModule('/src/ProjectScriptWorkspace.tsx');
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

test('两个旧剧本路由都进入同一融光工作台，不再显示两阶段向导', () => {
  for (const panel of ['parse', 'structure']) {
    const html = renderToStaticMarkup(createElement(ProjectScriptWorkspace, { projectId: 'project_demo', panel }));
    assert.match(html, /script-fusion-workspace/);
    assert.match(html, /打开剧本目录/);
    assert.match(html, /打开场景详情/);
    assert.match(html, /正在读取剧本/);
    assert.doesNotMatch(html, /阶段一|阶段二|原文与 AI 解析|事实候选与采用|选择性差异比对/);
  }
});

test('录入区统计字数并按场次标题预估场次数量', () => {
  assert.equal(countScriptCharacters('第1集\n\n1-1 内景 客厅 日\n林澈：你好。'), '第1集1-1内景客厅日林澈：你好。'.length);
  assert.equal(estimateSceneCount(raw), 2);
  assert.equal(estimateSceneCount('普通一行\n没有场次编号'), 0);
});

test('相邻场次合并后拼接元素并按顺序重排编号', () => {
  const structure = parseScriptStructure(`第1集

1-1 内景 客厅 日
林澈：第一场。

1-2 外景 街道 夜
老周：第二场。

1-3 内景 走廊 晨
旁白：第三场。`);
  const episode = structure.episodes[0];
  const merged = mergeScenes(structure, episode.id, episode.scenes[0].id);
  const scene = merged.episodes[0].scenes[0];
  assert.equal(merged.episodes[0].scenes.length, 2);
  assert.equal(scene.sceneNumber, '1-1');
  assert.equal(scene.dialogues.length, episode.scenes[0].dialogues.length + episode.scenes[1].dialogues.length);
  assert.equal(scene.location, '客厅');
  assert.deepEqual(merged.episodes[0].scenes.map(item => item.sceneNumber), ['1-1', '1-2']);
});

test('场次工作台卡片展示时空徽标、角色标签、说话人下拉与合并入口', () => {
  const structure = parseScriptStructure(raw);
  const html = renderToStaticMarkup(createElement(StructuredScriptEditor, {
    structure, onChange: () => undefined,
  }));
  assert.match(html, /第 1 场/);
  assert.match(html, /1-1 · 内景 · 旧钟表店 · 日/);
  assert.match(html, /出场角色/);
  assert.match(html, /structured-character-tag">老周/);
  assert.match(html, /list="structured-character-options"/);
  assert.match(html, /<option value="老周"/);
  assert.match(html, /与下一场合并/);
  assert.match(html, /拆分/);
  assert.match(html, /is-bubble/);
});

test('长场次可一键拆分为两场并继承时空、重排编号', () => {
  const structure = parseScriptStructure(`第1集

1-1 内景 客厅 日
林澈：第一句。
老周：第二句。
【动作】林澈起身。
林澈：第三句。

1-2 外景 街道 夜
老周：另一场。`);
  const episode = structure.episodes[0];
  const target = episode.scenes[0];
  const elementIds = target.dialogues.map(item => item.id);
  const split = splitScene(structure, episode.id, target.id);
  const scenes = split.episodes[0].scenes;
  assert.equal(scenes.length, 3);
  assert.deepEqual(scenes.map(item => item.sceneNumber), ['1-1', '1-2', '1-3']);
  assert.equal(scenes[0].dialogues.length, 2);
  assert.equal(scenes[1].dialogues.length, target.dialogues.length - 2);
  assert.equal(scenes[1].location, target.location);
  assert.equal(scenes[1].intExt, target.intExt);
  assert.equal(scenes[1].timeOfDay, target.timeOfDay);
  assert.notEqual(scenes[1].id, target.id);
  assert.deepEqual([...scenes[0].dialogues, ...scenes[1].dialogues].map(item => item.id), elementIds);
  // 只有一个元素的场次不可拆分。
  const single = splitScene(structure, episode.id, episode.scenes[1].id);
  assert.equal(single.episodes[0].scenes.length, 2);
});

test('步骤二概览统计场次数、核心角色与对白句数', () => {
  const structure = parseScriptStructure(raw);
  const summary = summarizeScriptStructure(structure);
  assert.equal(summary.scenes, 2);
  assert.equal(summary.characters, 2);
  assert.equal(summary.dialogues, 2);
});

test('推进分镜前可从当前结构补齐角色与地点候选', () => {
  const structure = parseScriptStructure(raw);
  const facts = buildStructureFactCandidate(structure);
  assert.deepEqual(facts.characters.map(item => item.name).sort(), ['林澈', '老周']);
  assert.ok(facts.characters.every(item => item.name !== '旁白'));
  assert.ok(facts.locations.some(item => item.name === '旧钟表店'));
  assert.deepEqual(facts.props, []);
});

test('按集草稿嵌回整本后，差异与合并只作用于目标集，新增场次也归入该集', () => {
  const base = parseScriptStructure(raw);
  assert.ok(base.episodes.length >= 2);
  const target = base.episodes[1];
  // AI 只返回目标集：改地点，并新增一场
  const aiEpisode = structuredClone(target);
  aiEpisode.scenes[0].location = '江岸仓库';
  const extra = structuredClone(aiEpisode.scenes[0]);
  extra.id = 'scene_ai_new'; extra.sceneNumber = '2-99'; extra.location = '新码头';
  aiEpisode.scenes.push(extra);
  const draft = { ...base, episodes: [aiEpisode] };

  const scoped = scopeEpisodeDraft(base, draft, target.id);
  assert.equal(scoped.episodes.length, base.episodes.length);
  assert.deepEqual(scoped.episodes[0], base.episodes[0]);
  assert.equal(scoped.episodes[1].id, target.id);
  assert.equal(scoped.episodes[1].episodeNumber, target.episodeNumber);

  const diffs = diffScriptStructures(base, scoped);
  assert.ok(diffs.length > 0);
  const merged = applySelectedDiffs(base, scoped, diffs.map(item => item.id));
  assert.deepEqual(merged.episodes[0], base.episodes[0]);
  assert.ok(merged.episodes[1].scenes.some(scene => scene.location === '新码头'));
});

test('新建集只追加新集，既有集结构与 ID 保持不变', () => {
  const base = parseScriptStructure(raw);
  const merged = appendEpisodeFromText(base, '第3集\n\n3-1 外景 码头 夜\n老林：到了。', 3);
  assert.equal(merged.episodes.length, base.episodes.length + 1);
  assert.deepEqual(merged.episodes.slice(0, base.episodes.length), base.episodes);
  const added = merged.episodes[merged.episodes.length - 1];
  assert.equal(added.episodeNumber, 3);
  const ids = merged.episodes.flatMap(episode => [episode.id, ...episode.scenes.map(scene => scene.id)]);
  assert.equal(new Set(ids).size, ids.length);
});
