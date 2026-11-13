const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  applySelectedDiffs,
  diffScriptStructures,
  parseScriptStructure,
  ScriptStructureError,
  validateScriptStructure,
} = require('../dist/script-structure');

/** 去掉服务端/客户端分配的对象 ID，只比较语义内容。 */
function withoutIds(structure) {
  return structure.episodes.map(episode => ({
    episodeNumber: episode.episodeNumber,
    title: episode.title,
    synopsis: episode.synopsis,
    scenes: episode.scenes.map(scene => ({
      sceneNumber: scene.sceneNumber,
      sceneHeading: scene.sceneHeading,
      intExt: scene.intExt,
      location: scene.location,
      timeOfDay: scene.timeOfDay,
      sceneDescription: scene.sceneDescription,
      dialogues: scene.dialogues.map(element => ({
        type: element.type,
        characterName: element.characterName,
        parenthetical: element.parenthetical,
        content: element.content,
      })),
    })),
  }));
}

const base = parseScriptStructure(`第1集
剧情概览：林澈回到旧钟表店。

1-1 内景 旧钟表店 日
老周（低声）：这块表，等了你十二年。
林澈：我来取回我爸留下的东西。
【动作】林澈把手中的表放在柜台上。`);

/** 模拟 AI 解析：同一集，修正地点/时间、纠正说话人、拆出一场新戏。 */
function draftStructure() {
  const draft = structuredClone(base);
  const episode = draft.episodes[0];
  const scene = episode.scenes[0];
  scene.location = '旧钟表店 · 柜台前';
  scene.timeOfDay = '黄昏';
  scene.dialogues[0].characterName = '周叔';
  scene.dialogues.splice(1, 0, {
    id: 'element_ai_1', type: 1, characterName: '林澈', parenthetical: '', content: '这块表为什么会停？',
  });
  episode.scenes.push({
    id: 'scene_ai_2', sceneNumber: '1-2', sceneHeading: '', location: '旧钟表店', timeOfDay: '黄昏', intExt: '内',
    sceneDescription: '', dialogues: [
      { id: 'element_ai_2', type: 2, content: '林澈抬头看向墙上的钟。' },
    ],
  });
  return validateScriptStructure(draft);
}

test('diff 只返回真正变化的项，相同内容不出现在结果里', () => {
  const items = diffScriptStructures(base, draftStructure());
  const kinds = new Set(items.map(item => item.kind));
  assert.ok(kinds.has('scene-location'), '地点变化应被识别');
  assert.ok(kinds.has('scene-time'), '时间变化应被识别');
  assert.ok(kinds.has('dialogue-speaker'), '说话人纠正应被识别');
  assert.ok(kinds.has('element-inserted'), '新增对白应被识别');
  assert.ok(kinds.has('scene-inserted'), '场次切分应被识别');
  assert.ok(!kinds.has('element-content'), '原文没有被改写，不应出现内容差异');
  assert.ok(!kinds.has('scene-int-ext'), '内/外景没有变化，不应出现差异');
  const speaker = items.find(item => item.kind === 'dialogue-speaker');
  assert.equal(speaker.before, '老周');
  assert.equal(speaker.after, '周叔');
  assert.equal(speaker.elementIndex, 0);
  const location = items.find(item => item.kind === 'scene-location');
  assert.equal(location.before, '旧钟表店');
  assert.equal(location.after, '旧钟表店 · 柜台前');
});

test('差异项 ID 在多次计算中保持稳定，可直接作为勾选键', () => {
  const first = diffScriptStructures(base, draftStructure()).map(item => item.id);
  const second = diffScriptStructures(structuredClone(base), draftStructure()).map(item => item.id);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, first.length, '差异项 ID 不应重复');
});

test('没有正式结构时，整份草稿只呈现为一条新增分集', () => {
  const items = diffScriptStructures(null, draftStructure());
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'episode-inserted');
  assert.equal(items[0].episodeNumber, 1);
});

test('全选时合并结果与解析草稿语义一致', () => {
  const draft = draftStructure();
  const items = diffScriptStructures(base, draft);
  const merged = applySelectedDiffs(base, draft, items.map(item => item.id));
  assert.deepEqual(withoutIds(merged), withoutIds(draft));
});

test('全不选时合并结果严格保持原版', () => {
  const draft = draftStructure();
  const merged = applySelectedDiffs(base, draft, []);
  assert.deepEqual(withoutIds(merged), withoutIds(base));
});

test('只勾选说话人纠正时，地点保持原版而说话人已更新', () => {
  const draft = draftStructure();
  const speakerId = diffScriptStructures(base, draft).find(item => item.kind === 'dialogue-speaker').id;
  const merged = applySelectedDiffs(base, draft, [speakerId]);
  const scene = merged.episodes[0].scenes[0];
  assert.equal(scene.location, '旧钟表店');
  assert.equal(scene.timeOfDay, '日');
  assert.equal(scene.dialogues[0].characterName, '周叔');
  assert.equal(scene.dialogues.length, 3, '未采纳的新增元素不应出现');
});

test('采纳场次切分后按顺序重排场次编号，且元素 ID 不重复', () => {
  const draft = draftStructure();
  const items = diffScriptStructures(base, draft);
  const merged = applySelectedDiffs(base, draft, items.map(item => item.id));
  assert.deepEqual(merged.episodes[0].scenes.map(scene => scene.sceneNumber), ['1-1', '1-2']);
  const ids = merged.episodes.flatMap(episode => episode.scenes.flatMap(scene => [
    scene.id, ...scene.dialogues.map(element => element.id),
  ]));
  assert.equal(new Set(ids).size, ids.length);
  assert.doesNotThrow(() => validateScriptStructure(merged));
});

test('缺少正式结构且一项都不采纳时拒绝产出空剧本', () => {
  assert.throws(
    () => applySelectedDiffs(null, draftStructure(), []),
    error => error instanceof ScriptStructureError && error.code === 'EMPTY_MERGE',
  );
});

test('解析草稿删除整集时，默认保留原版，勾选后才删除', () => {
  const twoEpisodes = structuredClone(base);
  twoEpisodes.episodes.push({
    ...structuredClone(twoEpisodes.episodes[0]),
    id: 'episode_2', episodeNumber: 2, title: '第2集',
    scenes: [{ ...structuredClone(twoEpisodes.episodes[0].scenes[0]), id: 'scene_2_1', sceneNumber: '2-1' }],
  });
  const single = structuredClone(base);
  const items = diffScriptStructures(validateScriptStructure(twoEpisodes), single);
  const removed = items.find(item => item.kind === 'episode-removed');
  assert.equal(removed.episodeNumber, 2);
  const kept = applySelectedDiffs(validateScriptStructure(twoEpisodes), single, []);
  assert.equal(kept.episodes.length, 2);
  const dropped = applySelectedDiffs(validateScriptStructure(twoEpisodes), single, [removed.id]);
  assert.equal(dropped.episodes.length, 1);
  assert.equal(dropped.episodes[0].episodeNumber, 1);
});
