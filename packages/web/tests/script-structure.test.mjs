import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const {
  addElement, addElementAfter, addEpisode, addScene, applySelectedDiffs, countScriptCharacters,
  buildStructureFactCandidate, diffScriptStructures, estimateSceneCount, mergeScenes, parseScriptStructure, patchScene, planCharacterImport,
  removeElement, removeScene, serializeScriptStructure, splitScene, summarizeScriptStructure, updateElement,
} = await server.ssrLoadModule('/src/script-structure.ts');
const {
  ScriptParseEntityFields, ScriptDiffReviewPanel, canStartParse, groupScriptDiffs, parseStartBlockReason, repairSceneTarget,
  scriptDiffCounts, default: ProjectScriptWorkspace,
} = await server.ssrLoadModule('/src/ProjectScriptWorkspace.tsx');
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
  assert.doesNotMatch(parseHtml, /SCENES &amp; CHARACTERS/);
  assert.doesNotMatch(parseHtml, /事实候选与采用/);

  const structureHtml = renderToStaticMarkup(createElement(ProjectScriptWorkspace, { projectId: 'project_demo', panel: 'structure' }));
  assert.match(structureHtml, /SCENES &amp; CHARACTERS/);
  assert.match(structureHtml, /data-testid="script-structure-summary"/);
  assert.match(structureHtml, /还没有已确认的剧本结构/);
  assert.match(structureHtml, /href="#\/projects\/project_demo\/script-parse"/);
  assert.doesNotMatch(structureHtml, /id="project-script-raw"/);
});

test('校验问题可定位到当前结构中的对应场次', () => {
  const structure = parseScriptStructure(raw);
  const plan = { content: { scenes: [
    { id: 'scene_a', order: 1, title: { value: '旧钟表店' }, sourceRefs: [{ start: 0, end: 100 }] },
    { id: 'scene_b', order: 2, title: { value: '2-1' }, sourceRefs: [{ start: 101, end: 200 }] },
  ] } };
  const sceneIssue = { scope: { kind: 'scene', targetId: 'scene_b' }, sourceRefs: [] };
  assert.equal(repairSceneTarget(plan, sceneIssue, structure).sceneId, structure.episodes[1].scenes[0].id);
  const sourceIssue = { scope: { kind: 'sourceSpan', targetId: null }, sourceRefs: [{ start: 10, end: 20 }] };
  assert.equal(repairSceneTarget(plan, sourceIssue, structure).sceneId, structure.episodes[0].scenes[0].id);
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

test('差异比对只保留变动项，统计可区分新增/修改/删除', () => {
  const base = parseScriptStructure(raw);
  const draft = structuredClone(base);
  draft.episodes[0].scenes[0].location = '旧钟表店 · 柜台前';
  draft.episodes[0].scenes[0].dialogues[1].characterName = '周叔';
  const items = diffScriptStructures(base, draft);
  const summary = scriptDiffCounts(items);
  assert.equal(summary.total, 2);
  assert.equal(summary.modified, 2);
  assert.equal(summary.inserted, 0);
  assert.deepEqual(groupScriptDiffs(items).length, 1);
  const merged = applySelectedDiffs(base, draft, [items.find(item => item.kind === 'dialogue-speaker').id]);
  assert.equal(merged.episodes[0].scenes[0].dialogues[1].characterName, '周叔');
  assert.equal(merged.episodes[0].scenes[0].location, '旧钟表店');
});

test('差异比对面板提供全选/全消与逐项勾选，并展示采纳或保留状态', () => {
  const base = parseScriptStructure(raw);
  const draft = structuredClone(base);
  draft.episodes[0].scenes[0].location = '旧钟表店 · 柜台前';
  draft.episodes[0].scenes[0].dialogues[1].characterName = '周叔';
  const items = diffScriptStructures(base, draft);
  const speaker = items.find(item => item.kind === 'dialogue-speaker');
  const html = renderToStaticMarkup(createElement(ScriptDiffReviewPanel, {
    base,
    draft,
    selectedIds: new Set([speaker.id]),
    onToggle: () => undefined,
    onSelectAll: () => undefined,
    onSelectNone: () => undefined,
  }));
  assert.match(html, /选择性差异比对/);
  assert.match(html, /全部采纳修改/);
  assert.match(html, /全部保留原版/);
  assert.match(html, /data-testid="script-diff-selected-count">1</);
  assert.match(html, /采纳 AI 修改/);
  assert.match(html, /保留原版内容/);
  assert.match(html, /<del>旧钟表店<\/del>/);
  assert.match(html, /<ins>旧钟表店 · 柜台前<\/ins>/);
  assert.match(html, /<del>老周<\/del>/);
  assert.match(html, /<ins>周叔<\/ins>/);
  assert.match(html, /第1集 · 第1场 1-1/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /aria-label="采纳对白说话人（第1集 1-1 第/);
});

test('未勾选模型确认时禁止发起 AI 解析', () => {
  const saved = { rawText: '剧本原文' };
  assert.equal(canStartParse({ approved: false, busy: false, modelRevision: 'rev-1', savedScript: saved, script: saved.rawText, dirty: false }), false);
  assert.equal(canStartParse({ approved: true, busy: false, modelRevision: 'rev-1', savedScript: saved, script: saved.rawText, dirty: false }), true);
  assert.equal(canStartParse({ approved: true, busy: false, modelRevision: '', savedScript: saved, script: saved.rawText, dirty: false }), false);
  assert.equal(canStartParse({ approved: true, busy: false, modelRevision: 'rev-1', savedScript: saved, script: '改过的原文', dirty: true }), false);
  assert.equal(canStartParse({ approved: true, busy: false, modelRevision: 'rev-1', savedScript: null, script: '', dirty: false }), false);
});

test('解析按钮禁用时给出具体的门禁原因', () => {
  const saved = { rawText: '剧本原文' };
  const base = { approved: true, modelRevision: 'rev-1', savedScript: saved, script: saved.rawText, dirty: false };
  assert.equal(parseStartBlockReason(base), '');
  assert.match(parseStartBlockReason({ ...base, approved: false }), /请先勾选/);
  assert.match(parseStartBlockReason({ ...base, modelRevision: '' }), /未检测到可用解析模型/);
  assert.match(parseStartBlockReason({ ...base, dirty: true }), /保存原文/);
  assert.match(parseStartBlockReason({ ...base, savedScript: null }), /请先保存剧本原文/);
});

test('阶段向导展示两步门禁与录入统计', () => {
  const parseHtml = renderToStaticMarkup(createElement(ProjectScriptWorkspace, { projectId: 'project_demo', panel: 'parse' }));
  assert.match(parseHtml, /剧本录入与智能解析/);
  assert.match(parseHtml, /场次与角色工作台/);
  assert.match(parseHtml, /data-stage="1"/);
  assert.match(parseHtml, /data-stage="2"/);
  assert.match(parseHtml, /data-testid="script-source-stats"/);
  assert.match(parseHtml, /预估 1 场/);
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

test('角色导入总控渲染总开关、单角色勾选与已有角色/龙套标记', () => {
  const draft = parseScriptStructure(`第1集

1-1 内景 客厅 日
林澈：第一句。
老周：回应。

1-2 外景 街道 夜
林澈：第二句。`);
  const characters = [
    { name: '老周', aliases: [], description: null },
    { name: '林澈', aliases: [], description: null },
    { name: '前台小妹', aliases: [], description: null },
  ];
  const plan = planCharacterImport(draft, characters, ['老周']);
  assert.deepEqual(plan.map(item => item.suggested), [true, true, false]);
  const html = renderToStaticMarkup(createElement(ScriptParseEntityFields, {
    label: '人物', items: characters, disabled: false,
    onPatch: () => undefined, onRemove: () => undefined, onAppend: () => undefined,
    importControl: {
      enabled: true, onEnabledChange: () => undefined, plan,
      selected: new Set(plan.filter(item => item.suggested).map(item => item.key)),
      onToggle: () => undefined, onSelectAll: () => undefined, onSelectNone: () => undefined,
    },
  }));
  assert.match(html, /导入本次识别出的角色/);
  assert.match(html, /已匹配已有角色/);
  assert.match(html, /建议不导入/);
  assert.match(html, /已选 2\/3 位角色/);
  assert.match(html, /aria-label="导入人物 前台小妹"/);
  const disabledHtml = renderToStaticMarkup(createElement(ScriptParseEntityFields, {
    label: '人物', items: characters, disabled: false,
    onPatch: () => undefined, onRemove: () => undefined, onAppend: () => undefined,
    importControl: {
      enabled: false, onEnabledChange: () => undefined, plan,
      selected: new Set(), onToggle: () => undefined, onSelectAll: () => undefined, onSelectNone: () => undefined,
    },
  }));
  assert.doesNotMatch(disabledHtml, /character-import-count/);
  assert.match(disabledHtml, /关闭后不会创建任何新角色/);
});

test('推进分镜前可从当前结构补齐角色与地点候选', () => {
  const structure = parseScriptStructure(raw);
  const facts = buildStructureFactCandidate(structure);
  assert.deepEqual(facts.characters.map(item => item.name).sort(), ['林澈', '老周']);
  assert.ok(facts.characters.every(item => item.name !== '旁白'));
  assert.ok(facts.locations.some(item => item.name === '旧钟表店'));
  assert.deepEqual(facts.props, []);
});
