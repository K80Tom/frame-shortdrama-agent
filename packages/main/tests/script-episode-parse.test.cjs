const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../dist/config');
const { InMemoryBreakdownRepository } = require('../dist/breakdown/repository');
const { BreakdownService } = require('../dist/breakdown/service');
const { ScriptParseService } = require('../dist/breakdown/script-parse');
const { parseScriptStructure } = require('@lyra/shared');

const rawText = `第1集

1-1 内景 钟表铺 日
老周：这块表，你还认得吗？
林澈：十一年前的东西了。

第2集

2-1 外景 江岸 夜
旁白：风很大。`;

const episodeTwoOutput = {
  title: '第2集',
  synopsis: '江岸重逢。',
  characters: [
    { name: '林澈', aliases: [], description: '回到旧钟表店的年轻人。', role: 'protagonist', confidence: 0.86 },
    { name: '路人甲', aliases: [], description: '背景人物。', role: 'background' },
  ],
  locations: [{ name: '江岸', aliases: [], description: '江边码头。' }],
  props: [],
  scenes: [{
    sceneHeading: '江岸', location: '江岸', timeOfDay: '夜', intExt: '外',
    sceneDescription: '',
    elements: [{ type: 3, characterName: '', parenthetical: '', content: '风很大。' }],
  }],
};

const episodeOneDraftOutput = {
  title: '第1集',
  synopsis: '',
  characters: [
    { name: '林澈', aliases: [], description: '年轻人。', role: 'protagonist' },
    { name: '老周', aliases: [], description: '店主。', role: 'supporting' },
  ],
  locations: [{ name: '钟表铺', aliases: [], description: null }],
  props: [],
  scenes: [{
    sceneHeading: '钟表铺', location: '钟表铺', timeOfDay: '日', intExt: '内',
    sceneDescription: '',
    elements: [{ type: 1, characterName: '林澈', parenthetical: '', content: '新台词。' }],
  }],
};

function createConfig() {
  return { ...readConfig({}), baseUrl: 'https://stub.local', apiKey: 'test-key', defaultModel: 'parse-stub',
    reasoningEffort: 'model-default', maxOutputTokens: 8192, timeoutMs: 30000, connectionRevision: 'test-revision' };
}

function fakeAttemptDatabase() {
  const attempts = new Map();
  return {
    attempts,
    async query(sql, params) {
      if (/INSERT INTO script_parse_attempts/i.test(sql)) {
        const [id, projectId, scriptVersionId, model, promptVersion, inputDigest, commandId] = params;
        attempts.set(id, {
          id, project_id: projectId, script_version_id: scriptVersionId, model, prompt_version: promptVersion,
          input_digest: inputDigest, command_id: commandId, status: 'running', output_json: null,
          usage_json: null, error_code: null, provider_request_id: null,
          created_at: new Date().toISOString(), ended_at: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE script_parse_attempts/i.test(sql)) {
        const row = attempts.get(params[0]);
        if (!row) return { rows: [], rowCount: 0 };
        if (/status='succeeded'/.test(sql)) {
          row.status = 'succeeded';
          row.output_json = params[1] ? JSON.parse(params[1]) : null;
          row.provider_request_id = params[2];
          row.usage_json = params[3] ? JSON.parse(params[3]) : null;
          row.ended_at = new Date().toISOString();
        } else {
          row.status = 'failed';
          row.error_code = params[1];
          row.usage_json = params[3] ? JSON.parse(params[3]) : null;
        }
        return { rows: [], rowCount: 1 };
      }
      if (/WHERE id=\$1 AND project_id=\$2/i.test(sql)) {
        const [id, projectId] = params;
        const row = attempts.get(id);
        return { rows: row && row.project_id === projectId ? [row] : [] };
      }
      if (/FROM script_parse_attempts/i.test(sql)) {
        const [projectId, commandId] = params;
        return { rows: [...attempts.values()].filter(item =>
          item.project_id === projectId && item.command_id === commandId) };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

async function setupProject(transport, assets) {
  let ordinal = 0;
  const breakdown = new BreakdownService(new InMemoryBreakdownRepository(), createConfig(), {
    now: () => new Date('2026-10-01T08:00:00.000Z'),
    nextId: (prefix) => `${prefix}_${String(++ordinal).padStart(4, '0')}`,
  });
  const project = await breakdown.createProject({ title: '单集解析' });
  const structure = parseScriptStructure(rawText);
  const script = await breakdown.createScriptVersion(project.id, { rawText, structure });
  const database = fakeAttemptDatabase();
  const service = new ScriptParseService(database, breakdown, createConfig(), transport, assets ?? null);
  return { project, script, breakdown, service, database };
}

function stubTransport(output) {
  let modelCalls = 0;
  const requests = [];
  const transport = async (_url, init) => {
    modelCalls += 1;
    const request = JSON.parse(init.body);
    requests.push(request);
    assert.deepEqual(request.thinking, { type: 'disabled' });
    return new Response(JSON.stringify({
      id: 'chatcmpl-test', model: 'parse-stub',
      choices: [{ index: 0, message: { role: 'assistant', content: typeof output === 'string' ? output : JSON.stringify(output) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { transport, get calls() { return modelCalls; }, get requests() { return requests; } };
}

test('单集作用域：模型收到弹窗新原文而非旧版本文本，响应结构只含该集', async () => {
  const pasted = '【新粘贴文本】林澈：这是弹窗里的新内容。';
  const stub = stubTransport(episodeTwoOutput);
  const { project, script, service } = await setupProject(stub.transport);
  const parsed = await service.parseEpisode(project.id, {
    episodeNumber: 2, rawText: pasted, commandId: 'cmd-scope-1', overwriteConfirmed: true,
    allowPaid: true, scriptVersionId: script.id,
  });
  assert.equal(parsed.episodeNumber, 2);
  assert.equal(parsed.structure.episodes.length, 1);
  assert.equal(parsed.structure.episodes[0].episodeNumber, 2);
  assert.equal(parsed.reused, false);
  assert.equal(stub.calls, 1);
  // 模型输入是弹窗新文本，不是已保存版本里的旧集文本
  assert.equal(stub.requests[0].messages[1].content, pasted);
  assert.ok(!stub.requests[0].messages[1].content.includes('这块表'));
  assert.ok(!JSON.stringify(parsed.structure).includes('钟表铺'));
});

test('覆盖确认：只要目标集已存在场次（含空场）就要求 overwriteConfirmed，确认后才放行', async () => {
  const stub = stubTransport(episodeTwoOutput);
  const { project, script, service } = await setupProject(stub.transport);
  await assert.rejects(service.parseEpisode(project.id, {
    episodeNumber: 1, rawText: '林澈：新内容。', commandId: 'cmd-overwrite-1',
    overwriteConfirmed: false, allowPaid: true, scriptVersionId: script.id,
  }), error => error.code === 'SCRIPT_EPISODE_OVERWRITE_CONFIRM_REQUIRED' && error.status === 409);
  assert.equal(stub.calls, 0);

  const parsed = await service.parseEpisode(project.id, {
    episodeNumber: 1, rawText: '林澈：新内容。', commandId: 'cmd-overwrite-2',
    overwriteConfirmed: true, allowPaid: true, scriptVersionId: script.id,
  });
  assert.equal(parsed.episodeNumber, 1);
  assert.equal(stub.calls, 1);
});

test('commandId 幂等：重复命令在配置/覆盖检查前回放历史结果，不再次调用模型', async () => {
  const stub = stubTransport(episodeTwoOutput);
  const { project, script, service } = await setupProject(stub.transport);
  const first = await service.parseEpisode(project.id, {
    episodeNumber: 2, rawText: '江岸夜景。', commandId: 'cmd-idem-1',
    overwriteConfirmed: true, allowPaid: true, scriptVersionId: script.id,
  });
  const second = await service.parseEpisode(project.id, {
    episodeNumber: 2, rawText: '江岸夜景。', commandId: 'cmd-idem-1',
    overwriteConfirmed: true, allowPaid: true, scriptVersionId: script.id,
  });
  assert.equal(stub.calls, 1);
  assert.equal(second.reused, true);
  assert.equal(second.attemptId, first.attemptId);
  assert.deepEqual(second.structure, first.structure);
});

test('候选标记：既有资产按同名/别名复用 ID，路人默认不勾选；缺省角色按出场启发式兜底', async () => {
  const stub = stubTransport(episodeTwoOutput);
  const assets = {
    async list() { return [{ id: 'asset_old_character', kind: 'character', name: '老周', description: '旧设定', resourceUrl: null }]; },
  };
  const { project, script, service } = await setupProject(stub.transport, assets);
  const parsed = await service.parseEpisode(project.id, {
    episodeNumber: 2, rawText: '江岸。', commandId: 'cmd-candidates-1', overwriteConfirmed: true,
    allowPaid: true, scriptVersionId: script.id,
  });
  const linche = parsed.characters.find(item => item.name === '林澈');
  const passerby = parsed.characters.find(item => item.name === '路人甲');
  assert.equal(linche.existing, false);
  assert.equal(linche.suggested, true);
  assert.equal(linche.confidence, 0.86);
  assert.equal(passerby.role, 'background');
  assert.equal(passerby.suggested, false);
  const location = parsed.locations.find(item => item.name === '江岸');
  assert.equal(location.existing, false);
});

test('截断 JSON：有界闭合修复成功，仍按契约校验；无法修复时明确报错', async () => {
  const truncated = '{"title":"第2集","synopsis":"江岸重逢。","characters":[{"name":"林澈","aliases":[],"description":"年轻人。","role":"protagonist"}],"locations":[{"name":"江岸","aliases":[],"description":"江边。"}],"props":[],"scenes":[{"sceneHeading":"江岸","location":"江岸","timeOfDay":"夜","intExt":"外","sceneDescription":"","elements":[{"type":3,"characterName":"","parenthetical":"","content":"风很大。"}]';
  const stub = stubTransport(truncated);
  const { project, script, service } = await setupProject(stub.transport);
  const parsed = await service.parseEpisode(project.id, {
    episodeNumber: 2, rawText: '江岸。', commandId: 'cmd-repair-1', overwriteConfirmed: true,
    allowPaid: true, scriptVersionId: script.id,
  });
  assert.equal(parsed.structure.episodes[0].scenes.length, 1);
  assert.equal(stub.calls, 1);

  const broken = stubTransport('{"characters": [{"name": "x" "b": 1}');
  const other = await setupProject(broken.transport);
  await assert.rejects(other.service.parseEpisode(other.project.id, {
    episodeNumber: 2, rawText: '江岸。', commandId: 'cmd-repair-bad', overwriteConfirmed: true,
    allowPaid: true, scriptVersionId: other.script.id,
  }), error => ['SCRIPT_PARSE_OUTPUT_NOT_JSON', 'SCRIPT_PARSE_OUTPUT_UNREPAIRABLE', 'SCRIPT_PARSE_OUTPUT_INVALID'].includes(error.code));
});

test('确认入库：解析草稿新场次真正保存，其他集不变；选择性勾选、复用 ID、级联改名、不可变版本与校验', async () => {
  const stub = stubTransport(episodeOneDraftOutput);
  const assets = {
    async list() { return [{ id: 'asset_old_zhou', kind: 'character', name: '老周', description: '旧店主设定', resourceUrl: null }]; },
  };
  const { project, script, breakdown, service } = await setupProject(stub.transport, assets);

  const parsed = await service.parseEpisode(project.id, {
    episodeNumber: 1, rawText: '林澈：新台词。', commandId: 'cmd-confirm-1', overwriteConfirmed: true,
    allowPaid: true, scriptVersionId: script.id,
  });

  await assert.rejects(service.confirmEpisodeEntities(project.id, {
    scriptVersionId: script.id,
    attemptId: parsed.attemptId,
    episodeNumber: 1,
    selections: [
      { candidateId: 'candidate_1', kind: 'character', name: '林澈', aliases: [], description: '年轻人。', selected: true, renameTo: '旁白' },
    ],
  }), error => error.code === 'SCRIPT_NARRATION_CHARACTER_INVALID');

  const confirmed = await service.confirmEpisodeEntities(project.id, {
    scriptVersionId: script.id,
    attemptId: parsed.attemptId,
    episodeNumber: 1,
    selections: [
      { candidateId: 'candidate_1', kind: 'character', name: '林澈', aliases: [], description: '年轻人。', selected: true, renameTo: '林晨' },
      { candidateId: 'candidate_2', kind: 'character', name: '老周', aliases: [], description: '不应覆盖旧设定。', selected: true },
      { candidateId: 'candidate_3', kind: 'location', name: '钟表铺', aliases: [], description: null, selected: true },
      { candidateId: 'candidate_4', kind: 'prop', name: '放大镜', aliases: [], description: null, selected: false },
    ],
  });

  // 旧版本不可变
  const oldVersion = await breakdown.getScriptVersion(project.id, script.id);
  assert.equal(oldVersion.structure.episodes[0].scenes[0].dialogues[1].characterName, '林澈');
  assert.notEqual(confirmed.scriptVersion.id, script.id);

  // AI 草稿新场次已保存：旧台词不再出现，草稿内容进入新版本；第 2 集原样保留
  const newEpisode = confirmed.scriptVersion.structure.episodes[0];
  assert.equal(newEpisode.scenes[0].dialogues[0].characterName, '林晨');
  assert.equal(newEpisode.scenes[0].dialogues[0].content, '新台词。');
  assert.ok(!JSON.stringify(confirmed.scriptVersion.structure).includes('这块表'));
  assert.equal(confirmed.scriptVersion.structure.episodes[1].scenes[0].dialogues[0].content, '风很大。');

  // 既有资产复用 ID；未勾选道具不进入候选
  const reusedZhou = confirmed.reusedAssets.find(item => item.name === '老周');
  assert.equal(reusedZhou.existingAssetId, 'asset_old_zhou');
  const planCharacters = confirmed.plan.content.characters.map(item => item.name.value);
  assert.ok(planCharacters.includes('林晨'));
  assert.ok(planCharacters.includes('老周'));
  assert.ok(!confirmed.plan.content.props.length);

  assert.ok(confirmed.check.check.id);
  assert.equal(['passed', 'failed'].includes(confirmed.check.check.result), true);
});

test('第 2 集端到端：新场次写入新版本，编号重排为 2-1，旧目标集被替换，其他集完全不变', async () => {
  const episodeTwoConfirmOutput = {
    title: '第2集', synopsis: '江岸重逢。',
    characters: [{ name: '林澈', aliases: [], description: '年轻人。', role: 'protagonist' }],
    locations: [{ name: '江岸码头', aliases: [], description: null }],
    props: [],
    scenes: [{
      sceneHeading: '江岸码头', location: '江岸码头', timeOfDay: '黄昏', intExt: '外',
      sceneDescription: '',
      elements: [{ type: 1, characterName: '林澈', parenthetical: '', content: '新的江边对白。' }],
    }],
  };
  const stub = stubTransport(episodeTwoConfirmOutput);
  const { project, script, breakdown, service } = await setupProject(stub.transport);

  const parsed = await service.parseEpisode(project.id, {
    episodeNumber: 2, rawText: '江岸黄昏。', commandId: 'cmd-ep2-e2e',
    overwriteConfirmed: true, allowPaid: true, scriptVersionId: script.id,
  });

  // 响应草稿：集号、场次编号、场次/元素 ID 都归属第 2 集，不沿用第 1 集骨架。
  const draft = parsed.structure.episodes[0];
  assert.equal(draft.episodeNumber, 2);
  assert.equal(draft.title, '第2集');
  assert.equal(draft.scenes[0].id, 'scene_2_1');
  assert.equal(draft.scenes[0].sceneNumber, '2-1');
  assert.equal(draft.scenes[0].dialogues[0].id, 'element_2_1_1');

  const confirmed = await service.confirmEpisodeEntities(project.id, {
    scriptVersionId: script.id, attemptId: parsed.attemptId, episodeNumber: 2, selections: [],
  });

  // 旧版本不可变：第 2 集仍是旧旁白。
  const oldVersion = await breakdown.getScriptVersion(project.id, script.id);
  assert.equal(oldVersion.structure.episodes[1].scenes[0].dialogues[0].content, '风很大。');

  const next = confirmed.scriptVersion.structure;
  // 第 2 集旧目标集被草稿替换。
  const nextEp2 = next.episodes.find(item => item.episodeNumber === 2);
  assert.equal(nextEp2.scenes[0].location, '江岸码头');
  assert.equal(nextEp2.scenes[0].sceneNumber, '2-1');
  assert.equal(nextEp2.scenes[0].dialogues[0].content, '新的江边对白。');
  assert.ok(!JSON.stringify(nextEp2).includes('风很大。'));
  // 第 1 集完全不变。
  const nextEp1 = next.episodes.find(item => item.episodeNumber === 1);
  assert.equal(nextEp1.scenes[0].dialogues[0].characterName, '老周');
  assert.equal(nextEp1.scenes[0].dialogues[0].content, '这块表，你还认得吗？');
  assert.notEqual(confirmed.scriptVersion.id, script.id);
  assert.ok(confirmed.check.check.id);
});

test('分集标题归属：非第一集不沿用提示词示例“第1集”，自定义剧名保持不变', async () => {
  const generic = structuredClone(episodeTwoOutput);
  generic.title = '第1集';
  const stub = stubTransport(generic);
  const { project, script, service } = await setupProject(stub.transport);
  const parsed = await service.parseEpisode(project.id, {
    episodeNumber: 2, rawText: '江岸黄昏。', commandId: 'cmd-ep2-generic-title',
    overwriteConfirmed: true, allowPaid: true, scriptVersionId: script.id,
  });
  assert.equal(parsed.structure.episodes[0].title, '第2集');
  const confirmed = await service.confirmEpisodeEntities(project.id, {
    scriptVersionId: script.id, attemptId: parsed.attemptId, episodeNumber: 2, selections: [],
  });
  assert.equal(confirmed.scriptVersion.structure.episodes.find(item => item.episodeNumber === 2).title, '第2集');
  assert.equal(confirmed.scriptVersion.structure.episodes.find(item => item.episodeNumber === 1).title, '第1集');

  const custom = structuredClone(episodeTwoOutput);
  custom.title = '江岸重逢';
  const other = await setupProject(stubTransport(custom).transport);
  const customParsed = await other.service.parseEpisode(other.project.id, {
    episodeNumber: 2, rawText: '江岸黄昏。', commandId: 'cmd-ep2-custom-title',
    overwriteConfirmed: true, allowPaid: true, scriptVersionId: other.script.id,
  });
  assert.equal(customParsed.structure.episodes[0].title, '江岸重逢');
});

test('第二集重复对白：证据定位限定目标集并按场次推进，不能引用第一集或前一场同名文本', async () => {
  const repeatedOutput = structuredClone(episodeTwoOutput);
  repeatedOutput.characters = [{ name: '老周', aliases: [], description: '店主。', role: 'supporting' }];
  repeatedOutput.scenes = [0, 1].map(() => ({
    ...repeatedOutput.scenes[0],
    elements: [{ type: 1, characterName: '老周', parenthetical: '', content: '这块表，你还认得吗？' }],
  }));
  const stub = stubTransport(repeatedOutput);
  const { project, script, service } = await setupProject(stub.transport);
  const parsed = await service.parseEpisode(project.id, {
    episodeNumber: 2, rawText: '老周：这块表，你还认得吗？\n老周：这块表，你还认得吗？',
    commandId: 'cmd-ep2-duplicate-dialogue', overwriteConfirmed: true, allowPaid: true, scriptVersionId: script.id,
  });
  const selections = [...parsed.characters, ...parsed.locations, ...parsed.props].map(item => ({
    candidateId: item.candidateId, kind: item.kind, name: item.name, aliases: item.aliases,
    description: item.description, selected: true,
  }));

  const confirmed = await service.confirmEpisodeEntities(project.id, {
    scriptVersionId: script.id, attemptId: parsed.attemptId, episodeNumber: 2, selections,
  });

  const secondEpisodeStart = confirmed.scriptVersion.rawText.indexOf('第2集');
  assert.ok(secondEpisodeStart >= 0);
  assert.equal(confirmed.scriptVersion.structure.episodes[1].scenes.length, 2);
  assert.equal(confirmed.plan.content.dialogues.length, 2);
  assert.notEqual(confirmed.plan.content.dialogues[0].sourceRef.start, confirmed.plan.content.dialogues[1].sourceRef.start);
  for (const dialogue of confirmed.plan.content.dialogues) {
    assert.equal(dialogue.sourceRef.quote, '这块表，你还认得吗？');
    assert.ok(dialogue.sourceRef.start > secondEpisodeStart);
    const scene = confirmed.plan.content.scenes.find(item => item.id === dialogue.sceneId);
    assert.ok(scene.sourceRefs.some(ref => ref.start <= dialogue.sourceRef.start && ref.end >= dialogue.sourceRef.end));
  }
});

test('确认允许 0 勾选：仍保存解析草稿场次并创建空实体候选跑完整性校验', async () => {
  const stub = stubTransport(episodeOneDraftOutput);
  const { project, script, service } = await setupProject(stub.transport);
  const parsed = await service.parseEpisode(project.id, {
    episodeNumber: 1, rawText: '林澈：新台词。', commandId: 'cmd-confirm-empty', overwriteConfirmed: true,
    allowPaid: true, scriptVersionId: script.id,
  });
  const confirmed = await service.confirmEpisodeEntities(project.id, {
    scriptVersionId: script.id, attemptId: parsed.attemptId, episodeNumber: 1, selections: [],
  });
  assert.notEqual(confirmed.scriptVersion.id, script.id);
  assert.equal(confirmed.scriptVersion.structure.episodes[0].scenes[0].dialogues[0].content, '新台词。');
  // 未勾选人物/道具；场景地点由既有 factsCandidate 按场次派生，不强制录入勾选实体。
  assert.equal(confirmed.plan.content.characters.length, 0);
  assert.equal(confirmed.plan.content.props.length, 0);
  assert.ok(confirmed.check.check.id);
});

test('确认拒绝跨项目、跨版本、未成功的 attempt', async () => {
  const stubA = stubTransport(episodeOneDraftOutput);
  const first = await setupProject(stubA.transport);
  const parsedA = await first.service.parseEpisode(first.project.id, {
    episodeNumber: 1, rawText: '林澈：新台词。', commandId: 'cmd-reject-a', overwriteConfirmed: true,
    allowPaid: true, scriptVersionId: first.script.id,
  });

  // 跨项目：找不到该 attempt
  const stubB = stubTransport(episodeOneDraftOutput);
  const second = await setupProject(stubB.transport);
  await assert.rejects(second.service.confirmEpisodeEntities(second.project.id, {
    scriptVersionId: second.script.id, attemptId: parsedA.attemptId, episodeNumber: 1, selections: [],
  }), error => error.code === 'SCRIPT_PARSE_ATTEMPT_NOT_FOUND');

  // 跨版本：attempt 绑定在旧版本上
  const otherVersion = await first.breakdown.createScriptVersion(first.project.id, { rawText, structure: parseScriptStructure(rawText) });
  await assert.rejects(first.service.confirmEpisodeEntities(first.project.id, {
    scriptVersionId: otherVersion.id, attemptId: parsedA.attemptId, episodeNumber: 1, selections: [],
  }), error => error.code === 'SCRIPT_PARSE_ATTEMPT_VERSION_MISMATCH');

  // 未成功的 attempt 被拒绝（直接造一条 running 记录）
  await first.database.query(`INSERT INTO script_parse_attempts
    (id, project_id, script_version_id, model, prompt_version, input_digest, command_id, status, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'running',now())`,
  ['scriptparse_running', first.project.id, first.script.id, 'parse-stub', 'script-parse/2', 'digest', 'cmd-running']);
  await assert.rejects(first.service.confirmEpisodeEntities(first.project.id, {
    scriptVersionId: first.script.id, attemptId: 'scriptparse_running', episodeNumber: 1, selections: [],
  }), error => error.code === 'SCRIPT_PARSE_ATTEMPT_NOT_READY');
});

test('当前版本事实恢复：不调用模型、不新增剧本版本，并把全部分集合并进同一候选', async () => {
  let modelCalls = 0;
  const transport = async () => { modelCalls += 1; throw new Error('恢复链不得调用模型'); };
  const assets = { list: async () => [{ id: 'asset_prop_1', kind: 'prop', name: '表', description: '旧手表。' }] };
  const { project, script, service, breakdown } = await setupProject(transport, assets);
  const versionsBefore = await breakdown.listScriptVersions(project.id);
  const restored = await service.rebuildCurrentFactPlan(project.id);

  assert.equal(modelCalls, 0);
  assert.equal(restored.scriptVersion.id, script.id);
  assert.equal(restored.plan.scriptVersionId, script.id);
  assert.equal(restored.plan.status, 'candidate');
  assert.equal(restored.plan.content.scenes.length, 2);
  assert.deepEqual(restored.plan.content.characters.map(item => item.name.value).sort(), ['林澈', '老周']);
  assert.deepEqual(restored.plan.content.locations.map(item => item.name.value).sort(), ['江岸', '钟表铺']);
  assert.equal(restored.plan.content.props[0].name.value, '表');
  assert.ok(restored.check.check.id);
  assert.equal((await breakdown.listScriptVersions(project.id)).length, versionsBefore.length);
});
