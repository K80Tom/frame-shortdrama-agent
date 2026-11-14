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
    assert.deepEqual(request.thinking, { type: 'disabled' });
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

test('AI parse preserves editable locations and props through the facts candidate', async () => {
  let ordinal = 0;
  const breakdown = new BreakdownService(new InMemoryBreakdownRepository(), createConfig(), {
    now: () => new Date('2026-10-01T08:00:00.000Z'),
    nextId: (prefix) => `${prefix}_${String(++ordinal).padStart(4, '0')}`,
  });
  const project = await breakdown.createProject({ title: '人物地点道具解析' });
  const script = await breakdown.createScriptVersion(project.id, { rawText });
  const transport = async () => new Response(JSON.stringify({
    id: 'chatcmpl-entities', model: 'parse-stub',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({
      ...modelOutput,
      characters: [...modelOutput.characters, { name: '旁白', aliases: [], description: '叙事声音。' }],
      locations: [{ name: '旧钟表店', aliases: ['钟表店'], description: '林澈与老周重逢的地点。' }],
      props: [{ name: '放大镜', aliases: [], description: '老周修表使用的工具。' }],
    }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const service = new ScriptParseService({ query: async () => ({ rows: [], rowCount: 1 }) }, breakdown, createConfig(), transport);
  const parsed = await service.parse(project.id, script.id);
  assert.equal(parsed.locations.length, 1);
  assert.equal(parsed.locations[0].aliases[0], '钟表店');
  assert.equal(parsed.props.length, 1);
  assert.equal(parsed.props[0].name, '放大镜');
  assert.ok(!parsed.characters.some(item => item.name === '旁白'));

  const saved = await breakdown.createScriptVersion(project.id, { rawText, structure: parsed.structure });
  const candidate = await service.createCharacterCandidate(project.id, saved.id,
    parsed.characters, parsed.locations, parsed.props);
  assert.equal(candidate.content.characters.length, 2);
  assert.equal(candidate.content.locations.length, 1);
  assert.equal(candidate.content.locations[0].aliases[0].value, '钟表店');
  assert.equal(candidate.content.props.length, 1);
  assert.equal(candidate.content.props[0].name.value, '放大镜');
  assert.equal(candidate.content.scenes.length, 1);
});

test('事实候选拒绝把旁白叙事标签保存为人物', async () => {
  const breakdown = new BreakdownService(new InMemoryBreakdownRepository(), createConfig());
  const project = await breakdown.createProject({ title: '旁白不是人物' });
  const script = await breakdown.createScriptVersion(project.id, { rawText });
  const service = new ScriptParseService({ query: async () => ({ rows: [], rowCount: 1 }) }, breakdown, createConfig());
  await assert.rejects(service.createCharacterCandidate(project.id, script.id, [
    { name: '旁白', aliases: [], description: '叙事声音。' },
  ]), error => error.code === 'SCRIPT_NARRATION_CHARACTER_INVALID');
});

test('AI parse history returns success and failure records with reusable entity output', async () => {
  let ordinal = 0;
  const breakdown = new BreakdownService(new InMemoryBreakdownRepository(), createConfig(), {
    now: () => new Date('2026-10-01T08:00:00.000Z'),
    nextId: (prefix) => `${prefix}_${String(++ordinal).padStart(4, '0')}`,
  });
  const project = await breakdown.createProject({ title: '解析记录' });
  const output = { structure: emptyScriptStructure(), characters: [], locations: [], props: [
    { name: '放大镜', aliases: [], description: '修表工具。' },
  ] };
  const calls = [];
  const database = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{
      id: 'scriptparse_success', script_version_id: 'script_0001', script_version: 3,
      model: 'parse-stub', prompt_version: 'script-parse/2', status: 'succeeded', error_code: null,
      output_json: output, created_at: new Date('2026-10-01T08:00:00.000Z'), ended_at: new Date('2026-10-01T08:00:01.000Z'),
    }, {
      id: 'scriptparse_failed', script_version_id: 'script_0001', script_version: 3,
      model: 'parse-stub', prompt_version: 'script-parse/2', status: 'failed', error_code: 'UPSTREAM_ERROR',
      output_json: null, created_at: new Date('2026-10-01T07:00:00.000Z'), ended_at: new Date('2026-10-01T07:00:01.000Z'),
    }] };
  } };
  const service = new ScriptParseService(database, breakdown, createConfig(), async () => { throw new Error('unused'); });
  const history = await service.list(project.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].scriptVersion, 3);
  assert.equal(history[0].output.props[0].name, '放大镜');
  assert.equal(history[1].status, 'failed');
  assert.equal(history[1].errorCode, 'UPSTREAM_ERROR');
  assert.match(calls[0].sql, /WHERE\s+[^\n]*project_id\s*=\s*\$1/i);
  assert.equal(calls[0].params[0], project.id);
});

test('AI parse preserves an actionable upstream model error and records its real code', async () => {
  let ordinal = 0;
  const breakdown = new BreakdownService(new InMemoryBreakdownRepository(), createConfig(), {
    now: () => new Date('2026-10-01T08:00:00.000Z'),
    nextId: (prefix) => `${prefix}_${String(++ordinal).padStart(4, '0')}`,
  });
  const project = await breakdown.createProject({ title: '上游鉴权失败' });
  const script = await breakdown.createScriptVersion(project.id, { rawText });
  const calls = [];
  const database = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  let modelCalls = 0;
  const transport = async () => {
    modelCalls += 1;
    return new Response(JSON.stringify({ error: { message: 'upstream detail must not leak' } }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  };
  const service = new ScriptParseService(database, breakdown, createConfig(), transport);
  await assert.rejects(service.parse(project.id, script.id), error => {
    assert.equal(error.code, 'UPSTREAM_ERROR');
    assert.match(error.message, /API key/);
    assert.doesNotMatch(error.message, /upstream detail must not leak/);
    return true;
  });
  assert.equal(modelCalls, 1);
  const failure = calls.find(call => /status='failed'/.test(call.sql));
  assert.ok(failure);
  assert.equal(failure.params[1], 'UPSTREAM_ERROR');
});

function structureWithOnlySecondDialogue() {
  const structure = emptyScriptStructure();
  const episode = structure.episodes[0];
  episode.title = '第1集';
  const scene = episode.scenes[0];
  scene.sceneHeading = '旧钟表店·重逢';
  scene.location = '旧钟表店';
  scene.timeOfDay = '夜';
  scene.intExt = '内';
  scene.dialogues = [
    { id: 'element_1', type: 2, content: '老周把放大镜推到额头上，抬头看见推门进来的林澈。' },
    { id: 'element_2', type: 1, characterName: '老周', parenthetical: '', content: '十一年前的东西了。' },
  ];
  return structure;
}

test('AI dialogue repair appends only a source-backed missing dialogue and stays a preview', async () => {
  let ordinal = 0;
  const breakdown = new BreakdownService(new InMemoryBreakdownRepository(), createConfig(), {
    now: () => new Date('2026-10-01T08:00:00.000Z'),
    nextId: (prefix) => `${prefix}_${String(++ordinal).padStart(4, '0')}`,
  });
  const project = await breakdown.createProject({ title: '对白修复预览' });
  const script = await breakdown.createScriptVersion(project.id, { rawText, structure: structureWithOnlySecondDialogue() });
  const transport = async (url, init) => {
    const request = JSON.parse(init.body);
    assert.match(request.messages[0].content, /不得改写|不得新增/);
    assert.deepEqual(request.thinking, { type: 'disabled' });
    return new Response(JSON.stringify({
      id: 'chatcmpl-repair', model: 'parse-stub',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({
        action: 'append', reason: '补齐林澈在原文中的对白。',
        dialogues: [{ candidateId: 'dialogue_1', characterName: '林澈', parenthetical: '' }],
      }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const service = new ScriptParseService({ query: async () => ({ rows: [], rowCount: 1 }) }, breakdown, createConfig(), transport);
  const candidate = await service.createCharacterCandidate(project.id, script.id, modelOutput.characters);
  const failed = await breakdown.checkPlan(candidate.id);
  const issue = failed.issues.find(item => item.code === 'DIALOGUE_MISSING' && item.sourceRefs[0].quote.includes('林澈'));
  assert.ok(issue);
  const repaired = await service.repair(project.id, {
    planRevisionId: candidate.id, checkId: failed.check.id, issueId: issue.id,
    expectedModelConnectionRevision: 'test-revision',
  });
  assert.equal(repaired.promptVersion, 'script-dialogue-repair/1');
  assert.equal(repaired.repair.kind, 'append');
  assert.equal(repaired.repair.addedDialogues.length, 1);
  assert.equal(repaired.repair.addedDialogues[0].content, '这块表，你还认得吗？');
  assert.equal(repaired.structure.episodes[0].scenes[0].dialogues.filter(item => item.type === 1).length, 2);
  assert.equal((await breakdown.getProject(project.id)).currentScriptVersionId, script.id);

  const saved = await breakdown.createScriptVersion(project.id, { rawText, structure: repaired.structure });
  const savedCandidate = await service.createCharacterCandidate(project.id, saved.id, repaired.characters,
    repaired.locations, repaired.props);
  const checked = await breakdown.checkPlan(savedCandidate.id);
  assert.equal(checked.check.result, 'passed');
  assert.equal(checked.issues.length, 0);
});

test('AI dialogue repair can preview a sourced non-dialogue exclusion and recheck both linked findings', async () => {
  const narrative = '老林有个怪脾气：他不按修理费收钱，只收客人“多出来的钟点”。';
  let ordinal = 0;
  const breakdown = new BreakdownService(new InMemoryBreakdownRepository(), createConfig(), {
    now: () => new Date('2026-10-01T08:00:00.000Z'),
    nextId: (prefix) => `${prefix}_${String(++ordinal).padStart(4, '0')}`,
  });
  const project = await breakdown.createProject({ title: '叙事误报修复' });
  const structure = emptyScriptStructure();
  structure.episodes[0].scenes[0].sceneHeading = '怪脾气';
  structure.episodes[0].scenes[0].location = '钟表铺';
  structure.episodes[0].scenes[0].dialogues = [{ id: 'element_1', type: 2, content: narrative }];
  const script = await breakdown.createScriptVersion(project.id, { rawText: narrative, structure });
  const transport = async () => new Response(JSON.stringify({
    id: 'chatcmpl-exclude', model: 'parse-stub',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({
      action: 'exclude', candidateIds: ['dialogue_1'], reason: '这是叙事说明，引号内是称谓，不是人物对白。',
    }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const service = new ScriptParseService({ query: async () => ({ rows: [], rowCount: 1 }) }, breakdown, createConfig(), transport);
  const candidate = await service.createCharacterCandidate(project.id, script.id,
    [{ name: '老林', aliases: [], description: null }]);
  const failed = await breakdown.checkPlan(candidate.id);
  assert.ok(failed.issues.some(item => item.code === 'DIALOGUE_MISSING'));
  assert.ok(failed.issues.some(item => item.code === 'SCENE_DIALOGUE_MISSING'));
  const issue = failed.issues.find(item => item.code === 'DIALOGUE_MISSING');
  const repaired = await service.repair(project.id, {
    planRevisionId: candidate.id, checkId: failed.check.id, issueId: issue.id,
    expectedModelConnectionRevision: 'test-revision',
  });
  assert.equal(repaired.repair.kind, 'exclude');
  assert.equal(repaired.repair.exclusions.length, 1);
  assert.equal(repaired.repair.exclusions[0].sourceRef.quote, narrative);
  assert.deepEqual(repaired.structure, structure);

  const saved = await breakdown.createScriptVersion(project.id, { rawText: narrative, structure: repaired.structure });
  const exclusions = repaired.repair.exclusions.map(item => ({
    ...item, sourceRef: { ...item.sourceRef, scriptVersionId: saved.id },
  }));
  const savedCandidate = await service.createCharacterCandidate(project.id, saved.id, repaired.characters,
    repaired.locations, repaired.props, exclusions);
  const checked = await breakdown.checkPlan(savedCandidate.id);
  assert.equal(checked.check.result, 'passed');
  assert.equal(checked.issues.length, 0);
});
