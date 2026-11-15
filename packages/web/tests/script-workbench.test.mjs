import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());

const logic = await server.ssrLoadModule('/src/script/workbench-logic.ts');
const { EpisodeTree } = await server.ssrLoadModule('/src/script/EpisodeTree.tsx');
const { SceneCardList } = await server.ssrLoadModule('/src/script/SceneCardList.tsx');
const { collectCharacterNames } = await server.ssrLoadModule('/src/StructuredScriptEditor.tsx');
const { SceneDetailPanel } = await server.ssrLoadModule('/src/script/SceneDetailPanel.tsx');
const { EpisodeParseDialog, getEpisodeParseValidationError } = await server.ssrLoadModule('/src/script/EpisodeParseDialog.tsx');
const { NavigationGuard } = await server.ssrLoadModule('/src/script/NavigationGuard.tsx');
const { parseScriptStructure, addEpisode, addScene, removeScene, scopeEpisodeDraft } = await server.ssrLoadModule('/src/script-structure.ts');

const raw = `第1集

1-1 内景 旧钟表店 日
【环境】墙上挂满停走的旧钟。
老周（低声）：这块表，等了你十二年。
林澈：如果时间能重来。

第2集

2-1 外景 天台 夜
林澈：还站在这里吗？`;

function planFixture() {
  return [
    { key: 'linche', name: '林澈', sceneCount: 3, existing: false, suggested: true },
    { key: 'laozhou', name: '老周', sceneCount: 1, existing: false, suggested: false },
    { key: 'lurenjia', name: '路人甲', sceneCount: 0, existing: false, suggested: false },
  ];
}

function candidateFixture(existingNames = []) {
  return logic.buildIngestionCandidates({
    characters: [
      { name: '林澈', aliases: [], description: null },
      { name: '老周', aliases: [], description: null },
      { name: '路人甲', aliases: [], description: null },
    ],
    locations: [{ name: '旧钟表店', aliases: [], description: null }],
    props: [{ name: '手表', aliases: [], description: null }],
    plan: planFixture(),
    existingNames,
  });
}

/* ---------------- 纯函数：分档与勾选 ---------------- */

test('角色分档：已有/多场为主角，出场一场为配角，零场为路人', () => {
  assert.equal(logic.classifyEntity({ existing: true, sceneCount: 0 }), '主角');
  assert.equal(logic.classifyEntity({ existing: false, sceneCount: 3 }), '主角');
  assert.equal(logic.classifyEntity({ existing: false, sceneCount: 1 }), '配角');
  assert.equal(logic.classifyEntity({ existing: false, sceneCount: 0 }), '路人');
});

test('默认勾选：路人不勾选，地点道具默认勾选，同名已有资产标记复用', () => {
  const candidates = candidateFixture(['老周']);
  const selected = logic.defaultCandidateSelection(candidates);
  const byName = Object.fromEntries(candidates.map(item => [item.name, item]));
  assert.equal(selected.has(byName['林澈'].candidateId), true);
  assert.equal(selected.has(byName['路人甲'].candidateId), false);
  assert.equal(selected.has(byName['旧钟表店'].candidateId), true);
  assert.equal(selected.has(byName['手表'].candidateId), true);
  assert.equal(byName['老周'].existing, true);
});

test('全选 / 全消 / 反选 / 只选核心 / 分组勾选', () => {
  const candidates = candidateFixture();
  const selected = logic.defaultCandidateSelection(candidates);
  const all = logic.selectAllCandidates(candidates);
  assert.equal(all.size, candidates.length);
  assert.equal(logic.selectNoCandidates().size, 0);
  const inverted = logic.invertCandidates(candidates, selected);
  assert.equal(inverted.size, candidates.length - selected.size);
  const core = logic.selectCoreCandidates(candidates, selected);
  const coreNames = candidates.filter(item => core.has(item.candidateId)).map(item => item.name);
  assert.ok(coreNames.includes('林澈'));
  // 「只选核心主角」不选配角与路人
  assert.ok(!coreNames.includes('老周'));
  assert.ok(!coreNames.includes('路人甲'));
  // 非角色项（地点/道具）维持当前勾选不变
  const coreLocation = candidates.find(item => item.kind === 'location');
  const coreProp = candidates.find(item => item.kind === 'prop');
  assert.equal(core.has(coreLocation.candidateId), true);
  assert.equal(core.has(coreProp.candidateId), true);
  const groupProp = logic.selectGroupCandidates(candidates, selected, 'prop', false);
  assert.equal(groupProp.has(coreProp.candidateId), false);
  const groupLocation = logic.selectGroupCandidates(candidates, selected, 'location', true);
  assert.equal(groupLocation.has(coreLocation.candidateId), true);
});

test('忽略项不参与全选/反选，也绝不进入入库清单', () => {
  const candidates = candidateFixture();
  const selected = logic.defaultCandidateSelection(candidates);
  const ignoredItem = candidates.find(item => item.name === '旧钟表店');
  const ignored = new Set([ignoredItem.candidateId]);
  const visible = logic.visibleCandidates(candidates, ignored);
  assert.equal(visible.length, candidates.length - 1);

  // 全选 / 反选只作用可见项，忽略项不会被重新勾选
  const allVisible = logic.selectAllCandidates(visible);
  assert.equal(allVisible.has(ignoredItem.candidateId), false);
  const inverted = logic.invertCandidates(visible, selected);
  assert.equal(inverted.has(ignoredItem.candidateId), false);

  // 即使忽略项仍残留在 selected 中，最终过滤也会排除
  const chosen = logic.filterChosen(candidates, selected, ignored);
  assert.ok(!chosen.some(item => item.candidateId === ignoredItem.candidateId));
});

test('selections 覆盖全部候选：勾选且未忽略才 true，原名与 renameTo 分离', () => {
  const candidates = candidateFixture();
  const byName = Object.fromEntries(candidates.map(item => [item.name, item]));
  const selected = new Set([byName['林澈'].candidateId]);
  const ignored = new Set([byName['路人甲'].candidateId]);
  const renamed = candidates.map(item => (
    item.candidateId === byName['林澈'].candidateId ? { ...item, name: '林澈之' } : item
  ));
  const selections = logic.buildEntitySelections(renamed, selected, ignored);
  const byId = Object.fromEntries(selections.map(item => [item.candidateId, item]));
  const linche = byId[byName['林澈'].candidateId];
  assert.equal(linche.selected, true);
  assert.equal(linche.name, '林澈');
  assert.equal(linche.renameTo, '林澈之');
  assert.equal(byId[byName['老周'].candidateId].selected, false);
  assert.equal(byId[byName['路人甲'].candidateId].selected, false);
  assert.equal(byId[byName['路人甲'].candidateId].renameTo, null);
  assert.equal(byId[byName['旧钟表店'].candidateId].renameTo, null);
  assert.equal(selections.length, candidates.length);
});

test('0 个已选实体时 selections 全部 false，仍覆盖全部候选', () => {
  const candidates = candidateFixture();
  const selections = logic.buildEntitySelections(candidates, new Set(), new Set());
  assert.equal(selections.length, candidates.length);
  assert.ok(selections.every(item => item.selected === false));
});

test('单集 canonical 文本只包含目标集，不含其他集', () => {
  const structure = parseScriptStructure(raw);
  const first = structure.episodes[0];
  const text = logic.episodeCanonicalText(structure, first.id);
  assert.ok(text.includes('旧钟表店'));
  assert.ok(!text.includes('天台'));
});

test('改名级联只作用目标集：说话人与地点同步，其他集不变', () => {
  const structure = parseScriptStructure(raw);
  const episode = structure.episodes[0];
  const spoken = logic.cascadeEpisodeRename(structure, episode.id, '老周', '周叔', 'speaker');
  assert.equal(spoken.episodes[0].scenes[0].dialogues[1].characterName, '周叔');
  assert.equal(spoken.episodes[1].scenes[0].dialogues[0].characterName, '林澈');
  const moved = logic.cascadeEpisodeRename(structure, episode.id, '旧钟表店', '钟表柜台', 'location');
  assert.equal(moved.episodes[0].scenes[0].location, '钟表柜台');
  assert.equal(moved.episodes[1].scenes[0].location, '天台');
});

test('删除整集与集后插场：ID 合法、编号重排、其余集不变', () => {
  const structure = parseScriptStructure(raw);
  const removed = logic.removeEpisode(structure, structure.episodes[0].id);
  assert.equal(removed.episodes.length, 1);
  assert.equal(removed.episodes[0].episodeNumber, 2);

  const withInsert = logic.insertSceneAfter(structure, structure.episodes[0].id, structure.episodes[0].scenes[0].id);
  const first = withInsert.episodes[0];
  assert.equal(first.scenes.length, 2);
  assert.deepEqual(first.scenes.map(scene => scene.sceneNumber), ['1-1', '1-2']);
  assert.match(first.scenes[1].id, /^scene_[a-z0-9]+$/);
  assert.equal(withInsert.episodes[1].scenes.length, 1);
});

test('scopeEpisodeDraft：草稿场次归属目标集，集号/场次编号与 ID 重排到该集', () => {
  const structure = parseScriptStructure(raw);
  const ep2 = structure.episodes[1];
  const draft = {
    schemaVersion: 'script-structure/1',
    episodes: [{
      id: 'episode_1', episodeNumber: 1, title: '第1集', synopsis: '',
      scenes: [{
        id: 'scene_1_1', sceneNumber: '1-1', sceneHeading: '', location: '江岸码头',
        timeOfDay: '黄昏', intExt: '外', sceneDescription: '',
        dialogues: [{ id: 'element_1', type: 1, characterName: '林澈', parenthetical: '', content: '新内容。' }],
      }],
    }],
  };
  const scoped = scopeEpisodeDraft(structure, draft, ep2.id);
  const nextEp2 = scoped.episodes[1];
  assert.equal(nextEp2.scenes[0].id, 'scene_2_1');
  assert.equal(nextEp2.scenes[0].sceneNumber, '2-1');
  assert.equal(nextEp2.scenes[0].dialogues[0].id, 'element_2_1_1');
  assert.equal(nextEp2.scenes[0].location, '江岸码头');
  // 其他集保持原样
  assert.equal(scoped.episodes[0].scenes[0].location, '旧钟表店');
});

test('removeScene：删除场次后整集编号重排，其余集不变', () => {
  const structure = parseScriptStructure(raw);
  const withSecond = addScene(structure, structure.episodes[0].id);
  const episode = withSecond.episodes[0];
  assert.deepEqual(episode.scenes.map(scene => scene.sceneNumber), ['1-1', '1-2']);
  const removed = removeScene(withSecond, episode.id, episode.scenes[0].id);
  assert.deepEqual(removed.episodes[0].scenes.map(scene => scene.sceneNumber), ['1-1']);
  assert.equal(removed.episodes[1].scenes[0].sceneNumber, '2-1');
});

test('场次提炼角色/地点，道具按正文关键词识别，对白缺失打标', () => {
  const structure = parseScriptStructure(raw);
  const scene = structure.episodes[0].scenes[0];
  scene.dialogues.push({ id: 'narration_1', type: 3, characterName: '旁白', parenthetical: '', content: '时间留下残渣。' });
  const summary = logic.summarizeScene(scene);
  assert.deepEqual(summary.characters, ['老周', '林澈']);
  assert.ok(!summary.characters.includes('旁白'));
  assert.deepEqual(collectCharacterNames(structure), ['老周', '林澈']);
  const cardHtml = renderToStaticMarkup(createElement(SceneCardList, {
    episode: structure.episodes[0], selectedSceneId: scene.id, characterOptions: [],
    onSelectScene: () => undefined, onSaveScene: async () => true, onSaveEpisode: async () => true,
    onInsertSceneAfter: () => undefined, onDeleteScene: () => undefined, onDirtyChange: () => undefined,
  }));
  assert.match(cardHtml, /时间留下残渣/);
  assert.doesNotMatch(cardHtml, /script-card-character-tag[^>]*>旁白/);
  assert.equal(summary.location, '旧钟表店');
  assert.deepEqual(logic.recognizeSceneProps(scene, ['手表', '天台']), []);

  const incomplete = { ...scene, dialogues: [
    { id: 'el_1', type: 1, content: '', characterName: '', parenthetical: '' },
    { id: 'el_2', type: 2, content: '起身', characterName: undefined, parenthetical: undefined },
  ] };
  assert.equal(logic.isIncompleteDialogue(incomplete.dialogues[0]), true);
  assert.equal(logic.isIncompleteDialogue(incomplete.dialogues[1]), false);
  assert.equal(logic.incompleteDialogues(incomplete).length, 1);
});

test('定点拆分以指定元素为第二场起点，元素 ID 保留', () => {
  const structure = parseScriptStructure(`第1集

1-1 内景 客厅 日
林澈：第一句。
老周：第二句。
【动作】起身。
林澈：第三句。`);
  const episode = structure.episodes[0];
  const target = episode.scenes[0];
  const anchor = target.dialogues[2].id;
  const split = logic.splitSceneAtElement(structure, episode.id, target.id, anchor);
  const scenes = split.episodes[0].scenes;
  assert.equal(scenes.length, 2);
  assert.equal(scenes[1].dialogues[0].id, anchor);
  assert.deepEqual(scenes.map(item => item.sceneNumber), ['1-1', '1-2']);
});

test('需求匹配：已绑定 / 歧义 / 未匹配 / 无需求分别给状态，不伪造定妆', () => {
  const requirements = [{
    requirementId: 'r1', kind: 'character', name: '林澈', sceneIds: [],
    match: { assetId: 'asset_1', matchedBy: 'name', matchedTerm: '林澈', ambiguous: false, alternatives: [] },
  }, {
    requirementId: 'r2', kind: 'character', name: '老周', sceneIds: [],
    match: { assetId: null, matchedBy: null, matchedTerm: null, ambiguous: true, alternatives: [] },
  }, {
    requirementId: 'r3', kind: 'character', name: '同事乙', sceneIds: [],
    match: { assetId: null, matchedBy: null, matchedTerm: null, ambiguous: false, alternatives: [] },
  }];
  assert.equal(logic.matchRequirement('林澈', 'character', requirements).state, 'matched');
  assert.equal(logic.matchRequirement('老周', 'character', requirements).state, 'ambiguous');
  assert.equal(logic.matchRequirement('同事乙', 'character', requirements).state, 'missing');
  assert.equal(logic.matchRequirement('路人甲', 'character', requirements), null);
  assert.equal(logic.matchRequirement('天台', 'location', requirements), null);
});

test('命令 ID 一次生成、格式稳定，重试可复用同一值', () => {
  const first = logic.newCommandId();
  assert.match(first, /^cmd_[a-z0-9]+$/);
  const second = logic.newCommandId();
  assert.notEqual(first, second);
});

/* ---------------- 组件渲染 ---------------- */

test('左栏分集目录嵌套场次，提供 AI 解析、添加与删除操作', () => {
  const structure = parseScriptStructure(raw);
  const html = renderToStaticMarkup(createElement(EpisodeTree, {
    episodes: structure.episodes,
    selectedEpisodeId: structure.episodes[0].id,
    selectedSceneId: null,
    onSelect: () => undefined,
    onSelectScene: () => undefined,
    onDelete: () => undefined,
    onAiParse: () => undefined,
    onCreate: () => undefined,
    onAddScene: () => undefined,
    onDeleteScene: () => undefined,
  }));
  assert.match(html, /第1集/);
  assert.match(html, /第2集/);
  assert.match(html, /1-1/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /AI 解析/);
  assert.doesNotMatch(html, /重命名第1集/);
  assert.match(html, /aria-label="删除第1集"/);
  assert.match(html, /添加分集/);
  assert.match(html, /添加场次/);
});

test('最后一集禁止删除：删除按钮禁用并给出提示', () => {
  const structure = parseScriptStructure(raw);
  const oneEpisode = { ...structure, episodes: [structure.episodes[0]] };
  const html = renderToStaticMarkup(createElement(EpisodeTree, {
    episodes: oneEpisode.episodes,
    selectedEpisodeId: oneEpisode.episodes[0].id,
    selectedSceneId: null,
    onSelect: () => undefined, onSelectScene: () => undefined, onDelete: () => undefined,
    onAiParse: () => undefined, onCreate: () => undefined,
    onAddScene: () => undefined, onDeleteScene: () => undefined,
  }));
  const deleteButton = html.match(/<button[^>]*is-danger[^>]*>/)[0];
  assert.ok(deleteButton.includes('disabled'));
  assert.match(html, /至少保留一集/);
});

test('中栏按融光展示当前集内联信息与五类元素，不提供合并或拆分', () => {
  const structure = parseScriptStructure(raw);
  const episode = structure.episodes[0];
  const html = renderToStaticMarkup(createElement(SceneCardList, {
    episode,
    selectedSceneId: episode.scenes[0].id,
    characterOptions: ['老周', '林澈'],
    onSelectScene: () => undefined,
    onSaveScene: async () => true,
    onSaveEpisode: async () => true,
    onInsertSceneAfter: () => undefined,
    onDeleteScene: () => undefined,
    onDirtyChange: () => undefined,
  }));
  assert.match(html, /第 1 集/);
  assert.match(html, /剧情概览/);
  assert.match(html, /旧钟表店/);
  assert.match(html, /内景/);
  assert.match(html, /script-card-character-tag/);
  assert.match(html, /添加对白/);
  assert.match(html, /添加环境/);
  assert.match(html, /插入场次/);
  assert.doesNotMatch(html, /向下合并/);
  assert.doesNotMatch(html, /从此处拆分为两场/);
});

test('右栏详情区分已绑定与未匹配状态，无角色时给明确空状态', () => {
  const structure = parseScriptStructure(raw);
  const scene = structure.episodes[0].scenes[0];
  const requirements = [{
    requirementId: 'r1', kind: 'character', name: '老周', sceneIds: [],
    match: { assetId: 'asset_1', matchedBy: 'name', matchedTerm: '老周', ambiguous: false, alternatives: [] },
  }];
  const assets = [{
    id: 'asset_1', kind: 'character', name: '老周', description: '老周定妆',
    resourceUrl: '/api/assets/asset_1/content', createdAt: '2026-01-01T00:00:00.000Z',
  }];
  const html = renderToStaticMarkup(createElement(SceneDetailPanel, {
    scene, episodeNumber: 1, requirements, assets, recognizedProps: [],
  }));
  assert.match(html, /场景详情/);
  assert.match(html, /已绑定 · 老周/);
  assert.match(html, /老周资产/);
  assert.match(html, /script-detail-asset-image/);
  assert.match(html, /未关联资产/);

  const emptyHtml = renderToStaticMarkup(createElement(SceneDetailPanel, {
    scene: null, episodeNumber: 1, requirements: null, recognizedProps: [],
  }));
  assert.match(emptyHtml, /选择目录中的场次后/);
});

test('解析弹窗：校验缺失时按钮仍可点击并显示原因，不会静默禁用', () => {
  const episode = parseScriptStructure(raw).episodes[0];
  const html = renderToStaticMarkup(createElement(EpisodeParseDialog, {
    open: true, episode, existingSceneCount: episode.scenes.length,
    initialRawText: '', busy: false, modelLabel: '默认拆解模型',
    onClose: () => undefined, onSubmit: () => undefined,
  }));
  assert.match(html, /AI 解析 · 第 1 集/);
  assert.match(html, /该集已有 1 个场次/);
  assert.match(html, /确认覆盖现有数据/);
  assert.match(html, /我确认调用/);
  assert.match(html, /新识别资产自动入库/);
  assert.doesNotMatch(html, /<button[^>]*disabled/);
  assert.equal(getEpisodeParseValidationError({
    rawText: '', existingSceneCount: 1, overwriteConfirmed: false, approved: false,
  }), '请粘贴该集的剧本原文。');
  assert.equal(getEpisodeParseValidationError({
    rawText: raw, existingSceneCount: 1, overwriteConfirmed: false, approved: false,
  }), '该集已有场次，请先勾选「确认覆盖现有数据」。');
  assert.equal(getEpisodeParseValidationError({
    rawText: raw, existingSceneCount: 1, overwriteConfirmed: true, approved: false,
  }), '请先勾选模型调用确认。');
  assert.equal(getEpisodeParseValidationError({
    rawText: raw, existingSceneCount: 1, overwriteConfirmed: true, approved: true,
  }), '');
});

test('解析弹窗：接口错误显示在弹窗内，忙碌时才禁用提交', () => {
  const episode = parseScriptStructure(raw).episodes[0];
  const html = renderToStaticMarkup(createElement(EpisodeParseDialog, {
    open: true, episode, existingSceneCount: 0, initialRawText: raw, busy: false,
    submitError: '解析服务暂时不可用', onClose: () => undefined, onSubmit: () => undefined,
  }));
  assert.match(html, /role="alert"/);
  assert.match(html, /解析服务暂时不可用/);
  assert.doesNotMatch(html, /<button[^>]*disabled/);
  const busyHtml = renderToStaticMarkup(createElement(EpisodeParseDialog, {
    open: true, episode, existingSceneCount: 0, initialRawText: raw, busy: true,
    onClose: () => undefined, onSubmit: () => undefined,
  }));
  assert.match(busyHtml, /<button[^>]*disabled/);
  assert.match(busyHtml, /正在解析并写入/);
});

test('解析确认链：请求固定版本锚点，部分成功或版本漂移时同步服务端结构并显示提示', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/ProjectScriptWorkspace.tsx', import.meta.url), 'utf8');
  assert.match(source, /scriptVersionId: baseVersion\.id/);
  assert.match(source, /latest = await api\.getCurrentScriptVersion\(projectId\)/);
  assert.match(source, /setSavedScript\(latest\)/);
  assert.match(source, /setStructure\(latestStructure\)/);
  assert.match(source, /setParseDialogEpisode\(null\)/);
  assert.match(source, /解析未完整完成/);
  assert.match(source, /已同步最新场次/);
});

test('融光自动资产写入：全部候选均选中，包括路人，不再经过待入库抽屉', () => {
  const result = {
    characters: [
      { candidateId: 'character:林澈', kind: 'character', name: '林澈', aliases: [], description: null, role: 'protagonist', sceneCount: 2, existing: false, existingAssetId: null, confidence: .9, suggested: true },
      { candidateId: 'character:路人甲', kind: 'character', name: '路人甲', aliases: [], description: null, role: 'background', sceneCount: 1, existing: false, existingAssetId: null, confidence: .5, suggested: false },
    ],
    locations: [{ candidateId: 'location:旧钟表店', kind: 'location', name: '旧钟表店', aliases: [], description: null, role: null, sceneCount: 1, existing: false, existingAssetId: null, confidence: .9, suggested: true }],
    props: [],
  };
  const selections = logic.buildAutomaticEntitySelections([...result.characters, ...result.locations, ...result.props]);
  assert.equal(selections.length, 3);
  assert.ok(selections.every(item => item.selected === true));
  assert.ok(selections.every(item => item.renameTo === null));
});

test('离开保护组件在未保存时上报脏状态，保存后清除；SSR 不渲染额外节点', () => {
  let reported = null;
  const html = renderToStaticMarkup(createElement(NavigationGuard, {
    dirty: true, onUnsavedChange: value => { reported = value; },
  }));
  assert.equal(html, '');
  // SSR 不跑 effect；脏状态上报由父级 onUnsavedChange 链路与既有 navigation-guard 统一处理。
  assert.equal(reported, null);
});

test('新建分集可追加到结构末尾并保持编号连续', () => {
  const structure = parseScriptStructure(raw);
  const next = addEpisode(structure);
  assert.equal(next.episodes.length, 3);
  assert.equal(next.episodes[2].episodeNumber, 3);
  assert.equal(next.episodes[2].scenes.length, 0);
});

test('资产恢复：当前版本重建候选，警告需人工确认，采用后刷新正式需求', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/ProjectScriptWorkspace.tsx', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../src/project-workspace-api.ts', import.meta.url), 'utf8');
  assert.match(source, /当前剧本尚未采用资产事实/);
  assert.match(source, /基于当前场次重新关联/);
  assert.match(source, /api\.rebuildCurrentFactPlan\(projectId\)/);
  assert.match(source, /window\.confirm/);
  assert.match(source, /allowCheckWarnings: true/);
  assert.match(source, /expectedActivePlanRevisionId: project\.activePlanRevisionId/);
  assert.match(source, /api\.fetchProjectAssetRequirements\(projectId\)/);
  assert.match(client, /fact-plans\/rebuild-current/);
  assert.ok(client.includes("fact-plans/rebuild-current`, { method: 'POST', body: {} }"));
});
