const { test } = require('node:test');
const assert = require('node:assert/strict');
const { storyboardNarrativeBeats, buildStoryboardVideoBasePrompt, storyboardDialogueTimingIssue, storyboardSceneAtmosphere } = require('../dist/storyboard');

test('叙事节拍保留逐字证据、原文偏移和稳定 ID', () => {
  const quote = '钟表铺 日\n【旁白】这里收留坏掉的东西。\n【动作】老林夹起铜屑。\n【旁白】不是修好它们。';
  const beats = storyboardNarrativeBeats([{ id: 'scene_1', sourceRefs: [{ scriptVersionId: 'script_1', start: 100, end: 100 + quote.length, quote }] }]);
  assert.equal(beats.length, 3);
  assert.deepEqual(beats.map(beat => beat.kind), ['narration', 'action', 'narration']);
  assert.equal(beats[0].sourceRef.start, 100 + quote.indexOf('【旁白】'));
  assert.equal(beats[0].sourceRef.quote, '【旁白】这里收留坏掉的东西。');
  assert.equal(quote.slice(beats[1].sourceRef.start - 100, beats[1].sourceRef.end - 100), '【动作】老林夹起铜屑。');
  assert.equal(beats[0].id, `beat_scene_1_${beats[0].sourceRef.start}_${beats[0].sourceRef.end}`);
});

test('视频基础提示词只写当前镜画面和对白，不复制整场叙事或候选制作说明', () => {
  const prompt = buildStoryboardVideoBasePrompt({ visualStyle: '冷色现实主义',
    shot: { design: { visualDescription: '老林夹起铜屑', shotSize: '近景', cameraMovement: '缓推', durationMs: 5000,
      cameraAngle: '俯拍', sound: '钟表滴答声，镊子轻碰机芯' } },
    narrativeBeats: [{ kind: 'narration', text: '这里收留坏掉的东西。' }, { kind: 'action', text: '老林夹起铜屑。' }],
    dialogues: [{ speaker: '老林', quote: '时间也会疼。' }], references: [{ assetId: 'asset_1', names: ['老林'] }],
    candidateDirection: '1：保持表演克制' });
  assert.match(prompt, /冷色现实主义/);
  assert.doesNotMatch(prompt, /旁白|这里收留坏掉的东西|动作：|候选创作方向/);
  assert.match(prompt, /近景，俯拍，镜头缓慢推近。@图片1老林夹起铜屑/);
  assert.match(prompt, /老林：时间也会疼。/);
  assert.match(prompt, /环境音与音效：钟表滴答声，镊子轻碰机芯/);
  assert.match(prompt, /参考 @图片1老林，严格保持对应人物、场景、服装与道具一致/);
  assert.doesNotMatch(prompt, /。。/);
});

test('可选时间轴保留单场景连续性，并按最终对白顺序引用授权音色', () => {
  const prompt = buildStoryboardVideoBasePrompt({
    shot: { design: { visualDescription: '老林修理钟表', shotSize: '中景', cameraMovement: '跟拍', durationMs: 8000,
      cameraAngle: '平视', timeline: true } },
    narrativeBeats: [{ kind: 'action', text: '老林低头校准机芯。' }],
    dialogues: [{ speaker: '老林', quote: '别回头。' }, { speaker: '老林', quote: '听见了吗？' }],
    references: [{ assetId: 'asset_1', names: ['老林'] }, { assetId: 'asset_2', names: ['老林'] }],
    voiceBindings: [{ speakerName: '老林', profileId: 'voice_1' }], candidateDirection: '1：保持表演克制',
  });
  assert.match(prompt, /【0–3秒】/); assert.match(prompt, /【3–6秒】/); assert.match(prompt, /【6–8秒】/);
  assert.match(prompt, /#老林（音色参考音频1）：别回头。/);
  assert.match(prompt, /#老林（音色参考音频1）：听见了吗？/);
  assert.match(prompt, /@图片1老林修理钟表/);
  assert.match(prompt, /中景，平视，跟随主体/);
  assert.doesNotMatch(prompt, /@图片2老林修理钟表|【动作】|候选创作方向/);
});
test('新镜头未写时间轴字段时默认使用新版分段，并保留实际小数时长', () => {
  const shot = { design: { visualDescription: '破庙木门被踹开。林砚继续擦剑。',
    shotSize: '全景', cameraMovement: '缓推', durationMs: 4200 } };
  const prompt = buildStoryboardVideoBasePrompt({ shot, references: [] });
  assert.match(prompt, /【0–3秒】/);
  assert.match(prompt, /【3–4.2秒】/);
  assert.doesNotMatch(prompt, /【3–5秒】/);
  const legacy = buildStoryboardVideoBasePrompt({
    shot: { design: { ...shot.design, timeline: false } }, references: [] });
  assert.doesNotMatch(legacy, /【0–3秒】/);
});
test('时间轴段数不足时仍保留当前镜动作与全部对白，不混入整场旁白', () => {
  const prompt = buildStoryboardVideoBasePrompt({
    shot: { design: { visualDescription: '修理钟表', shotSize: '中景', cameraMovement: '固定', durationMs: 3000,
      cameraAngle: '平视', timeline: true } },
    narrativeBeats: [{ kind: 'narration', text: '不该进入单镜的整场旁白' },
      { kind: 'action', text: '动作一' }, { kind: 'action', text: '动作二' }, { kind: 'action', text: '动作三' }],
    dialogues: [{ speaker: '老林', quote: '第一句' }, { speaker: '老林', quote: '第二句' }, { speaker: '老林', quote: '第三句' }],
    references: [], candidateDirection: '1：连续表演',
  });
  for (const text of ['第一句', '第二句', '第三句', '动作一', '动作二', '动作三']) assert.ok(prompt.includes(text), text);
  for (const text of ['不该进入单镜的整场旁白', '旁白：', '动作：', '候选创作方向']) assert.ok(!prompt.includes(text), text);
  assert.ok(prompt.indexOf('第一句') < prompt.indexOf('第二句') && prompt.indexOf('第二句') < prompt.indexOf('第三句'));
});

test('结构化视觉节拍逐段推进，并写出具体光线与收尾构图', () => {
  const prompt = buildStoryboardVideoBasePrompt({
    shot: { design: { visualDescription: '钟表铺工作台前，老林坐在台灯下，右手持镊子',
      visualBeats: ['老林用镊子夹起铜屑，手悬在瓷瓶上方', '铜屑滑入瓶底，老林抬眼望向来客，手指停在瓶沿',
        '老林保持目光，青色瓷瓶留在前景，画面收束'],
      atmosphere: '台灯的暖黄聚光落在机芯上，背景货架沉在阴影里',
      shotSize: '近景', cameraMovement: '固定', cameraAngle: '平视', durationMs: 9000, timeline: true } },
    dialogues: [{ speaker: '老林', quote: '别回头。' }], references: [{ assetId: 'asset_1', names: ['老林'] }],
  });
  const lines = prompt.split('\n').filter(line => line.startsWith('【'));
  assert.match(lines[0], /钟表铺工作台前，@图片1老林坐在台灯下/);
  assert.match(lines[1], /夹起铜屑，手悬在瓷瓶上方/);
  assert.match(lines[2], /铜屑滑入瓶底.*保持目光.*画面收束/);
  assert.equal(lines.filter(line => line.includes('台灯的暖黄聚光落在机芯上')).length, 3);
  assert.doesNotMatch(prompt, /延续上一段/);
});

test('旧候选按已有画面分句并使用当前场次时段，不虚构新剧情', () => {
  const atmosphere = storyboardSceneAtmosphere({ timeOfDay: { value: '日' } });
  const prompt = buildStoryboardVideoBasePrompt({
    shot: { design: { visualDescription: '老林将铜屑倒入瓷瓶，抬眼对来客说话', shotSize: '近景',
      cameraMovement: '固定', durationMs: 5000, timeline: true } }, atmosphere, references: [],
  });
  const lines = prompt.split('\n');
  assert.match(lines[0], /【0–3秒】近景，固定镜头。老林将铜屑倒入瓷瓶。/);
  assert.match(lines[1], /【3–5秒】抬眼对来客说话。/);
  assert.equal(lines.filter(line => line.includes('日间自然光照亮人物与关键道具')).length, 2);
  assert.doesNotMatch(prompt, /延续上一段/);
});

test('长对白从首个画面段之后连续拆段，时长不足给出明确提示', () => {
  const quote = '那就是人们在焦虑和蹉跎里，碎裂的时间残渣。';
  const input = {
    shot: { design: { visualDescription: '老林将铜屑倒入瓷瓶', shotSize: '近景', cameraMovement: '固定', durationMs: 8000,
      cameraAngle: '平视', timeline: true } },
    dialogues: [{ speaker: '老林', quote }], references: [], candidateDirection: '1：连续表演',
  };
  const prompt = buildStoryboardVideoBasePrompt(input);
  const lines = prompt.split('\n');
  assert.doesNotMatch(lines[0], /那就是/);
  assert.match(lines[1], /#?老林|老林：那就是/);
  assert.match(lines[2], /碎裂的时间残渣/);
  assert.equal(storyboardDialogueTimingIssue(8000, [{ quote }]), null);
  assert.match(storyboardDialogueTimingIssue(4500, [{ quote }]), /当前镜头 4.5 秒.*至少需要 4.8 秒.*增加镜头时长或拆分到其他镜头/);
});

test('旧画面字段中的整场旁白复述被剔除，当前镜动作仍保留', () => {
  const prompt = buildStoryboardVideoBasePrompt({
    shot: { design: { visualDescription: '老林将铜屑倒入瓷瓶。他忽然意识到，过去这几年走得太急。雨声盖住脚步。',
      shotSize: '近景', cameraMovement: '固定', durationMs: 5000 } },
    narrativeBeats: [{ kind: 'action', text: '老林抬眼望向来客' }],
    narrativeExclusions: ['他忽然意识到，过去这几年走得太急。', '雨声盖住脚步。'], references: [],
  });
  assert.match(prompt, /老林将铜屑倒入瓷瓶/);
  assert.match(prompt, /老林抬眼望向来客/);
  assert.doesNotMatch(prompt, /他忽然意识到|雨声盖住脚步/);
});

test('集中绑定的整场动作只保留与当前画面重合的可见动作', () => {
  const prompt = buildStoryboardVideoBasePrompt({
    shot: { design: { visualDescription: '老林叹气，从抽屉里翻出机械发条盒递给年轻人。',
      shotSize: '中景', cameraMovement: '固定', durationMs: 5000 } },
    narrativeBeats: [
      { kind: 'action', text: '有一年冬天，一个年轻人跌跌撞撞推开门。' },
      { kind: 'action', text: '老林叹了口气，没开螺丝，只是从抽屉里翻出一枚机械发条盒递给他。' },
      { kind: 'action', text: '他忽然意识到，过去这几年走得太急。' },
    ], references: [],
  });
  assert.match(prompt, /从抽屉里翻出.*机械发条盒/);
  assert.doesNotMatch(prompt, /有一年冬天|跌跌撞撞|忽然意识到/);
});

test('当前动作前的背景条件被去掉，保留可见操作过程', () => {
  const prompt = buildStoryboardVideoBasePrompt({
    shot: { design: { visualDescription: '老林戴着单眼放大镜，用镊子夹出铜屑。',
      shotSize: '近景', cameraMovement: '固定', durationMs: 5000 } },
    narrativeBeats: [{ kind: 'action', text: '每当客人抱怨时间不够用时，老林就戴上单眼放大镜，用镊子夹出铜屑。' }], references: [],
  });
  assert.match(prompt, /老林戴着单眼放大镜/);
  assert.doesNotMatch(prompt, /每当客人抱怨/);
});
