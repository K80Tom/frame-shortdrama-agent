const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseScriptStructure } = require('../dist/script-structure');
const {
  planEpisodeEntityCandidates,
  repairModelJsonPayload,
} = require('../dist/script-parse');

const draft = parseScriptStructure(`第1集

1-1 内景 钟表铺 日
林澈：这块表你认得吗？
老周：十一年前的东西了。`);

test('planEpisodeEntityCandidates：同名/别名复用既有资产，路人默认不勾选', () => {
  const candidates = planEpisodeEntityCandidates(draft, [
    { kind: 'character', name: '林澈', role: 'protagonist', confidence: 0.9 },
    { kind: 'character', name: '老周', aliases: ['老掌柜'], role: 'supporting' },
    { kind: 'character', name: '前台小妹', role: 'background' },
    { kind: 'location', name: '钟表铺', role: 'supporting' },
    { kind: 'location', name: '天台', role: 'supporting' },
    { kind: 'prop', name: '放大镜', role: 'supporting' },
  ], [
    { id: 'asset_aaa111', kind: 'character', name: '周师傅', aliases: ['老周', '老掌柜'] },
    { id: 'asset_bbb222', kind: 'location', name: '钟表铺' },
  ]);

  const byName = Object.fromEntries(candidates.map(item => [item.name, item]));
  assert.equal(byName['林澈'].existing, false);
  assert.equal(byName['林澈'].existingAssetId, null);
  assert.equal(byName['林澈'].suggested, true);
  assert.equal(byName['林澈'].confidence, 0.9);

  assert.equal(byName['老周'].existing, true);
  assert.equal(byName['老周'].existingAssetId, 'asset_aaa111');
  assert.equal(byName['老周'].suggested, true);

  // 路人即使出场也不默认勾选
  assert.equal(byName['前台小妹'].role, 'background');
  assert.equal(byName['前台小妹'].suggested, false);

  assert.equal(byName['钟表铺'].existing, true);
  assert.equal(byName['钟表铺'].existingAssetId, 'asset_bbb222');
  // 配角即使未在草稿中出场也默认建议勾选；只有路人默认不勾。
  assert.equal(byName['天台'].suggested, true);
  assert.equal(byName['放大镜'].suggested, true);
});

test('planEpisodeEntityCandidates：缺省角色按出场启发式兜底，出场归配角、未出场归路人', () => {
  const candidates = planEpisodeEntityCandidates(draft, [
    { kind: 'character', name: '林澈' },
    { kind: 'character', name: '无名过客' },
  ], []);
  const linche = candidates.find(item => item.name === '林澈');
  const stranger = candidates.find(item => item.name === '无名过客');
  assert.equal(linche.role, 'supporting');
  assert.equal(linche.suggested, true);
  assert.equal(stranger.role, 'background');
  assert.equal(stranger.suggested, false);
});

test('planEpisodeEntityCandidates：旁白保留叙事但不生成人物候选或出场判断', () => {
  const narrationDraft = parseScriptStructure(`第1集

1-1 内景 钟表铺 日
【旁白】时间留下残渣。`);
  narrationDraft.episodes[0].scenes[0].dialogues[0].characterName = '旁白';
  narrationDraft.episodes[0].scenes[0].dialogues.push({
    id: 'narration_named', type: 3, characterName: '林澈', parenthetical: '', content: '多年以后。',
  });
  const candidates = planEpisodeEntityCandidates(narrationDraft, [
    { kind: 'character', name: '旁白', role: 'supporting' },
    { kind: 'character', name: '林澈' },
  ], []);
  assert.ok(!candidates.some(item => item.name === '旁白'));
  assert.equal(candidates.find(item => item.name === '林澈').role, 'background');
  assert.equal(candidates.find(item => item.name === '林澈').suggested, false);
});

test('planEpisodeEntityCandidates：不修改入参，置信度越界被夹取', () => {
  const entities = [{ kind: 'prop', name: '怀表', role: 'supporting', confidence: 4 }];
  const snapshot = JSON.stringify(entities);
  const [candidate] = planEpisodeEntityCandidates(null, entities, []);
  assert.equal(candidate.confidence, 1);
  assert.equal(JSON.stringify(entities), snapshot);
});

test('repairModelJsonPayload：完整 JSON 原样通过，不标记已修复', () => {
  const direct = repairModelJsonPayload('{"a": 1, "b": ["x"]}');
  assert.equal(direct.ok, true);
  assert.equal(direct.repaired, false);
  assert.deepEqual(direct.value, { a: 1, b: ['x'] });
});

test('repairModelJsonPayload：补齐尾部缺失的容器闭合符', () => {
  const repaired = repairModelJsonPayload('{"characters": [{"name": "林澈"}, {"name": "老周"');
  assert.equal(repaired.ok, true);
  assert.equal(repaired.repaired, true);
  assert.deepEqual(repaired.value, { characters: [{ name: '林澈' }, { name: '老周' }] });
});

test('repairModelJsonPayload：丢弃未闭合字符串的残缺尾部与多余逗号', () => {
  const repaired = repairModelJsonPayload('{"title": "第1集", "synopsis": "重逢');
  assert.equal(repaired.ok, true);
  assert.equal(repaired.value.synopsis, undefined);
  assert.equal(typeof repaired.value.title, 'string');
});

test('repairModelJsonPayload：括号错配、空串或非容器内容明确报错，不吞错误', () => {
  assert.equal(repairModelJsonPayload('').ok, false);
  assert.equal(repairModelJsonPayload('').reason, 'EMPTY_JSON');
  const prose = repairModelJsonPayload('这不是 JSON');
  assert.equal(prose.ok, false);
  assert.equal(prose.reason, 'NOT_JSON_CONTAINER');
  const mismatched = repairModelJsonPayload('{"a": [1]} }');
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.reason, 'MISMATCHED_BRACKET');
  const unreparable = repairModelJsonPayload('{"a": "x" "b": 2}');
  assert.equal(unreparable.ok, false);
  assert.equal(unreparable.reason, 'UNREPAIRABLE_JSON');
});
