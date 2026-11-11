const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../dist/config');
const { InMemoryBreakdownRepository } = require('../dist/breakdown/repository');
const { BreakdownService } = require('../dist/breakdown/service');
const { parseCreateScriptVersion } = require('../dist/breakdown/contracts');
const { emptyScriptStructure } = require('@lyra/shared');

const config = readConfig({});

function createService() {
  let ordinal = 0;
  return new BreakdownService(new InMemoryBreakdownRepository(), config, {
    now: () => new Date('2026-10-01T08:00:00.000Z'),
    nextId: (prefix) => `${prefix}_${String(++ordinal).padStart(4, '0')}`,
  });
}

test('createScriptVersion accepts a structured script and derives canonical rawText', async () => {
  const structure = emptyScriptStructure();
  structure.episodes[0].scenes[0].location = '天台';
  structure.episodes[0].scenes[0].timeOfDay = '夜';
  structure.episodes[0].scenes[0].intExt = '外';
  structure.episodes[0].scenes[0].sceneDescription = '风很大。';
  structure.episodes[0].scenes[0].dialogues.push({
    id: 'element_1', type: 1, characterName: '林澈', parenthetical: '低声', content: '我会等你。',
  });
  const parsed = parseCreateScriptVersion({ structure });
  assert.equal(parsed.rawText, '第1集\n\n1-1 外景 天台 夜\n风很大。\n林澈（低声）：我会等你。');
  assert.equal(parsed.structure.episodes[0].scenes[0].dialogues[0].type, 1);

  const service = createService();
  const project = await service.createProject({ title: '结构化剧本' });
  const saved = await service.createScriptVersion(project.id, parsed);
  assert.equal(saved.structure.episodes[0].scenes[0].location, '天台');
  assert.equal(saved.rawText, parsed.rawText);
  const loaded = await service.getScriptVersion(project.id, saved.id);
  assert.equal(loaded.structure.episodes[0].scenes[0].dialogues[0].characterName, '林澈');
});

test('createScriptVersion accepts raw text and derives its structure', async () => {
  const parsed = parseCreateScriptVersion({ rawText: '第1集\n\n1-1 内景 客厅 日\n林澈：你好。' });
  assert.equal(parsed.structure.schemaVersion, 'script-structure/1');
  assert.equal(parsed.structure.episodes[0].scenes[0].dialogues[0].type, 1);
  const service = createService();
  const project = await service.createProject({ title: '旧原文' });
  const saved = await service.createScriptVersion(project.id, parsed);
  assert.equal(saved.structure.episodes[0].scenes[0].location, '客厅');
  assert.match(saved.rawText, /林澈：你好。/);
});

test('createScriptVersion rejects malformed structures and empty payloads', () => {
  assert.throws(() => parseCreateScriptVersion({}), /至少提供一项/);
  assert.throws(() => parseCreateScriptVersion({
    structure: { schemaVersion: 'script-structure/1', episodes: [] },
  }), /至少需要一集/);
  assert.throws(() => parseCreateScriptVersion({
    structure: { schemaVersion: 'script-structure/1', episodes: [{ id: 'e1' }] },
  }), /scenes|episodeNumber/);
});
