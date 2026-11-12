const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  filterImportEntities,
  normalizeScriptCharacterName,
  parseScriptStructure,
  planCharacterImport,
} = require('../dist/script-structure');

const raw = `第1集

1-1 内景 客厅 日
林澈：你回来了。
老周：嗯。

1-2 外景 街道 夜
林澈：又见面了。

1-3 内景 办公室 日
前台小妹：请先登记。`;

test('planCharacterImport：统计出场场数并标记项目已有角色', () => {
  const structure = parseScriptStructure(raw);
  const plan = planCharacterImport(structure, [
    { name: '林澈' },
    { name: '老周' },
    { name: '前台小妹' },
    { name: '黑衣人首领' },
  ], ['老周']);
  assert.deepEqual(plan.map(item => [item.name, item.sceneCount, item.existing, item.suggested]), [
    ['林澈', 2, false, true],
    ['老周', 1, true, true],
    ['前台小妹', 1, false, false],
    ['黑衣人首领', 0, false, false],
  ]);
  assert.equal(plan[0].key, normalizeScriptCharacterName('林澈'));
});

test('planCharacterImport：别名命中的说话人也计入场次，空草稿安全', () => {
  const structure = parseScriptStructure(raw);
  const [item] = planCharacterImport(structure, [{ name: '林辰', aliases: ['林澈'] }], []);
  assert.equal(item.sceneCount, 2);
  assert.deepEqual(planCharacterImport(null, [{ name: '林澈' }], []), [{ key: '林澈', name: '林澈', sceneCount: 0, existing: false, suggested: false }]);
});

test('filterImportEntities：总开关关闭时一个角色都不导入', () => {
  const characters = [{ name: '林澈' }, { name: '前台小妹' }];
  assert.deepEqual(filterImportEntities(characters, { enabled: false, selectedNames: new Set(['林澈', '前台小妹']) }), []);
});

test('filterImportEntities：只保留勾选角色且不修改入参', () => {
  const characters = [{ name: '林澈' }, { name: '前台小妹' }];
  const snapshot = JSON.stringify(characters);
  const selected = filterImportEntities(characters, { enabled: true, selectedNames: new Set([normalizeScriptCharacterName('林澈')]) });
  assert.deepEqual(selected, [{ name: '林澈' }]);
  assert.equal(JSON.stringify(characters), snapshot);
});

test('normalizeScriptCharacterName：忽略空白与大小写', () => {
  assert.equal(normalizeScriptCharacterName(' Lin  Che '), 'linche');
  assert.equal(normalizeScriptCharacterName('老 周'), '老周');
});
