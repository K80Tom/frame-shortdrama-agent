const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  SCRIPT_STRUCTURE_SCHEMA_VERSION,
  ScriptStructureError,
  emptyScriptStructure,
  parseScriptStructure,
  serializeScriptStructure,
  validateScriptStructure,
} = require('../dist/script-structure');

test('empty structure is valid and serializable', () => {
  const structure = emptyScriptStructure();
  assert.equal(structure.schemaVersion, SCRIPT_STRUCTURE_SCHEMA_VERSION);
  assert.equal(structure.episodes.length, 1);
  assert.doesNotThrow(() => validateScriptStructure(structure));
  assert.match(serializeScriptStructure(structure), /1-1/);
});

test('parses legacy text into episodes, scenes and five typed elements', () => {
  const structure = parseScriptStructure(`第1集
剧情概览：旧钟表店。

1-1 内景 旧钟表店 日
老周（低声）：这块表，等了你十二年。
【旁白】林澈没有接话。
【动作】林澈放下表。
【镜头】特写两只表。
【环境】墙上挂满旧钟。`);
  assert.deepEqual(structure.episodes[0].scenes[0].dialogues.map(item => item.type), [1, 3, 2, 4, 5]);
  assert.equal(structure.episodes[0].scenes[0].dialogues[0].characterName, '老周');
  assert.equal(structure.episodes[0].scenes[0].dialogues[0].parenthetical, '低声');
});

test('serialization is canonical and round-trips', () => {
  const source = parseScriptStructure(`第1集
1-1 外景 天台 夜
林澈：如果时间真的能重来。`);
  const text = serializeScriptStructure(source);
  assert.match(text, /第1集/);
  assert.match(text, /1-1 外景 天台 夜/);
  assert.match(text, /林澈：如果时间真的能重来。/);
  const reparsed = parseScriptStructure(text);
  assert.equal(reparsed.episodes[0].scenes[0].sceneNumber, '1-1');
  assert.equal(reparsed.episodes[0].scenes[0].dialogues[0].content, '如果时间真的能重来。');
});

test('rejects duplicate ids, duplicate episode numbers and unknown element types', () => {
  const base = emptyScriptStructure();
  const duplicateScene = structuredClone(base);
  duplicateScene.episodes[0].scenes.push(structuredClone(duplicateScene.episodes[0].scenes[0]));
  assert.throws(() => validateScriptStructure(duplicateScene), /场次 ID 重复|场次编号重复/);

  const duplicateEpisode = structuredClone(base);
  duplicateEpisode.episodes.push(structuredClone(duplicateEpisode.episodes[0]));
  assert.throws(() => validateScriptStructure(duplicateEpisode), ScriptStructureError);

  const invalidType = structuredClone(base);
  invalidType.episodes[0].scenes[0].dialogues.push({ id: 'element_x', type: 9, content: 'x' });
  assert.throws(() => validateScriptStructure(invalidType), /type 必须是/);
});

test('rejects unsupported schema versions and empty episode lists', () => {
  assert.throws(() => validateScriptStructure({ schemaVersion: 'other/1', episodes: [] }), /schemaVersion/);
  assert.throws(() => validateScriptStructure({
    schemaVersion: SCRIPT_STRUCTURE_SCHEMA_VERSION, episodes: [],
  }), /至少需要一集/);
});
