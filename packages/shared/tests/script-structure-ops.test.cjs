const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ScriptStructureError,
  mergeSceneDown,
  parseScriptStructure,
  renameEntityInEpisode,
  splitElementAt,
} = require('../dist/script-structure');

function twoEpisodeStructure() {
  return parseScriptStructure(`第1集

1-1 内景 钟表铺 日
老周：第一场对白甲。
林澈：第一场对白乙。

1-2 外景 江岸 夜
【旁白】第二场旁白。

第2集

2-1 内景 办公室 日
老周：第二集对白。`);
}

test('mergeSceneDown：源场次元素并入下一场，源场次删除并重排编号，其他集不受影响', () => {
  const base = twoEpisodeStructure();
  const snapshot = JSON.stringify(base);
  const episode1 = base.episodes[0];
  const sourceScene = episode1.scenes[0];
  const merged = mergeSceneDown(base, 1, sourceScene.id);

  assert.equal(merged.episodes[0].scenes.length, 1);
  const remaining = merged.episodes[0].scenes[0];
  assert.equal(remaining.sceneNumber, '1-1');
  assert.equal(remaining.dialogues.length, 3);
  assert.deepEqual(remaining.dialogues.map(item => item.content), [
    '第一场对白甲。', '第一场对白乙。', '第二场旁白。',
  ]);
  // 入参不被修改
  assert.equal(JSON.stringify(base), snapshot);
  assert.equal(base.episodes[0].scenes.length, 2);
  // 其他集保持原样
  assert.equal(merged.episodes[1].scenes.length, 1);
  assert.equal(merged.episodes[1].scenes[0].dialogues[0].characterName, '老周');
});

test('mergeSceneDown：最后一场没有下一场可合并时明确报错', () => {
  const base = twoEpisodeStructure();
  const lastScene = base.episodes[0].scenes[1];
  assert.throws(() => mergeSceneDown(base, 1, lastScene.id),
    error => error instanceof ScriptStructureError && error.code === 'SCRIPT_SCENE_NO_NEXT');
});

test('splitElementAt：在码点索引处拆成两个元素，前半保留原 ID', () => {
  const base = twoEpisodeStructure();
  const episode1 = base.episodes[0];
  const scene = episode1.scenes[0];
  const element = scene.dialogues.find(item => item.characterName === '林澈');
  const snapshot = JSON.stringify(base);

  const split = splitElementAt(base, 1, scene.id, element.id, 5);
  const targetScene = split.episodes[0].scenes[0];
  assert.equal(targetScene.dialogues.length, 3);
  const head = targetScene.dialogues[1];
  const tail = targetScene.dialogues[2];
  assert.equal(head.id, element.id);
  assert.notEqual(tail.id, element.id);
  assert.equal(head.content, '第一场对白乙。'.slice(0, 5));
  assert.equal(tail.content, '第一场对白乙。'.slice(5));
  assert.equal(head.type, tail.type);
  assert.equal(head.characterName, tail.characterName);
  assert.equal(JSON.stringify(base), snapshot);
});

test('splitElementAt：越界或空拆分位置报错，不产生空元素', () => {
  const base = twoEpisodeStructure();
  const scene = base.episodes[0].scenes[0];
  const element = scene.dialogues[0];
  assert.throws(() => splitElementAt(base, 1, scene.id, element.id, 0),
    error => error.code === 'INVALID_SPLIT_INDEX');
  assert.throws(() => splitElementAt(base, 1, scene.id, element.id, 100),
    error => error.code === 'INVALID_SPLIT_INDEX');
  assert.throws(() => splitElementAt(base, 1, scene.id, 'element_missing', 2),
    error => error.code === 'SCRIPT_ELEMENT_NOT_FOUND');
});

test('renameEntityInEpisode：角色说话人与别名在目标集级联更名，其他集不动', () => {
  const base = twoEpisodeStructure();
  const snapshot = JSON.stringify(base);
  const renamed = renameEntityInEpisode(base, 1, 'character',
    { name: '老周', aliases: ['老掌柜'] }, '周掌柜');

  const ep1 = renamed.episodes[0];
  assert.ok(ep1.scenes.every(scene => scene.dialogues
    .every(item => item.characterName !== '老周')));
  assert.equal(ep1.scenes[0].dialogues[0].characterName, '周掌柜');
  // 第二集的同名角色保持不变
  assert.equal(renamed.episodes[1].scenes[0].dialogues[0].characterName, '老周');
  assert.equal(JSON.stringify(base), snapshot);
});

test('renameEntityInEpisode：地点按名称/别名级联替换，新名称为空时报错', () => {
  const base = twoEpisodeStructure();
  const renamed = renameEntityInEpisode(base, 1, 'location',
    { name: '江岸' }, '江边码头');
  assert.equal(renamed.episodes[0].scenes[1].location, '江边码头');
  assert.notEqual(renamed.episodes[1].scenes[0].location, '江边码头');
  assert.throws(() => renameEntityInEpisode(base, 1, 'location', { name: '江岸' }, '  '),
    error => error.code === 'INVALID_ENTITY_NAME');
});

test('renameEntityInEpisode：目标集不存在时明确报错', () => {
  const base = twoEpisodeStructure();
  assert.throws(() => renameEntityInEpisode(base, 99, 'character', { name: '老周' }, '周掌柜'),
    error => error.code === 'SCRIPT_EPISODE_NOT_FOUND');
});
