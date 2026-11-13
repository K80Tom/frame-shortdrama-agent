const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseScriptStructure } = require('@lyra/shared');
const { resolveEpisodeParseInput } = require('../dist/breakdown/script-parse');

const raw = '第1集\n\n1-1 内景 钟表铺 日\n老林：测试对白。\n\n第2集\n\n2-1 外景 江岸 夜\n【旁白】风很大。';
const script = { rawText: raw, structure: parseScriptStructure(raw) };

test('按集解析只把目标集文本送给模型，并记录集信息', () => {
  const target = script.structure.episodes[1];
  const scoped = resolveEpisodeParseInput(script, target.id);
  assert.equal(scoped.episode.episodeNumber, 2);
  assert.equal(scoped.episode.id, target.id);
  assert.ok(scoped.text.includes('江岸'));
  assert.ok(!scoped.text.includes('钟表铺'));
});

test('未指定集时沿用整本原文；指定未知集时明确报错', () => {
  assert.deepEqual(resolveEpisodeParseInput(script), { text: raw, episode: null });
  assert.throws(() => resolveEpisodeParseInput(script, 'episode_missing'), error => error.code === 'SCRIPT_EPISODE_NOT_FOUND' && error.status === 409);
});
