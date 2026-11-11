const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../dist/config');
const { InMemoryBreakdownRepository } = require('../dist/breakdown/repository');
const { BreakdownService } = require('../dist/breakdown/service');
const { ScriptParseService } = require('../dist/breakdown/script-parse');
const { emptyScriptStructure } = require('@lyra/shared');

const rawText = [
  '深夜的旧钟表店，老周把放大镜推到额头上，抬头看见推门进来的林澈。',
  '林澈：这块表，你还认得吗？',
  '老周：十一年前的东西了。',
].join('\n');

const modelOutput = {
  title: '第1集',
  synopsis: '林澈回到旧钟表店，问起一只停了十一年的表。',
  characters: [
    { name: '林澈', aliases: [], description: '回到旧钟表店的年轻人。' },
    { name: '老周', aliases: [], description: '旧钟表店店主。' },
  ],
  scenes: [{
    sceneHeading: '旧钟表店·重逢', location: '旧钟表店', timeOfDay: '夜', intExt: '内',
    sceneDescription: '林澈推门进入旧钟表店。',
    elements: [
      { type: 2, content: '老周把放大镜推到额头上，抬头看见推门进来的林澈。' },
      { type: 1, characterName: '林澈', parenthetical: '', content: '这块表，你还认得吗？' },
      { type: 1, characterName: '老周', parenthetical: '', content: '十一年前的东西了。' },
    ],
  }],
};

function createConfig() {
  return { ...readConfig({}), baseUrl: 'https://stub.local', apiKey: 'test-key', defaultModel: 'parse-stub',
    reasoningEffort: 'model-default', maxOutputTokens: 8192, timeoutMs: 30000, connectionRevision: 'test-revision' };
}

test('AI parse normalizes a heading-less script and candidate passes completeness', async () => {
  let ordinal = 0;
  const breakdown = new BreakdownService(new InMemoryBreakdownRepository(), createConfig(), {
    now: () => new Date('2026-10-01T08:00:00.000Z'),
    nextId: (prefix) => `${prefix}_${String(++ordinal).padStart(4, '0')}`,
  });
  const project = await breakdown.createProject({ title: '整段解析' });
  const structure = emptyScriptStructure();
  structure.episodes[0].title = '第1集';
  const script = await breakdown.createScriptVersion(project.id, { rawText, structure });
  const calls = [];
  const database = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  const transport = async (url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.messages[1].content, rawText);
    return new Response(JSON.stringify({
      id: 'chatcmpl-test', model: 'parse-stub',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(modelOutput) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const service = new ScriptParseService(database, breakdown, createConfig(), transport);
  const parsed = await service.parse(project.id, script.id);
  assert.equal(parsed.structure.schemaVersion, 'script-structure/1');
  assert.equal(parsed.structure.episodes.length, 1);
  assert.equal(parsed.structure.episodes[0].scenes.length, 1);
  assert.equal(parsed.structure.episodes[0].scenes[0].sceneNumber, '1-1');
  assert.equal(parsed.characters.length, 2);
  assert.equal(calls.some(call => /succeeded/.test(call.sql)), true);

  const saved = await breakdown.createScriptVersion(project.id, { rawText, structure: parsed.structure });
  const candidate = await service.createCharacterCandidate(project.id, saved.id, parsed.characters);
  assert.equal(candidate.content.characters.length, 2);
  assert.equal(candidate.content.scenes.length, 1);
  assert.equal(candidate.content.dialogues.length, 2);
  assert.equal(candidate.content.synopsis.value, modelOutput.synopsis);
  const check = await breakdown.checkPlan(candidate.id);
  assert.equal(check.check.result, 'passed');
  assert.equal(check.issues.length, 0);
});
