import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import sharedStoryboard from '../../shared/dist/storyboard.js';
const { storyboardNarrativeBeats } = sharedStoryboard;

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { automaticAssetVoiceBindings, episodeSceneIds, retainedPlanSceneIds, coverageForScenes, backfillStoryboardNarrativeBeats, storyboardDraftIssue, storyboardEditPayload, storyboardFrameImportInput, reindexSceneShots, shotVideoPromptPreview, storyboardGenerationBase, boardLabel } = await server.ssrLoadModule('/src/storyboard/workbench.ts');
const { default: StoryboardShotList } = await server.ssrLoadModule('/src/storyboard/StoryboardShotList.tsx');
const { default: StoryboardInspector } = await server.ssrLoadModule('/src/storyboard/StoryboardInspector.tsx');

const ref = id => ({ scriptVersionId: 'script_1', start: 0, end: 4, quote: id });
const plan = { content: {
  scenes: [{ id: 'scene_1', order: 1, sourceRefs: [] }, { id: 'scene_2', order: 2, sourceRefs: [] }, { id: 'scene_3', order: 3, sourceRefs: [] }],
  dialogues: [{ id: 'dialogue_1', sceneId: 'scene_1' }, { id: 'dialogue_2', sceneId: 'scene_2' }],
  characters: [], locations: [], props: [],
} };
const episodes = [{ id: 'episode_1', episodeNumber: 1, scenes: [{ id: 'a' }, { id: 'b' }] }, { id: 'episode_2', episodeNumber: 2, scenes: [{ id: 'c' }] }];
const shot = (id, sceneId, order = 1) => ({ id, sceneId, order,
  design: { origin: 'designSuggestion', visualDescription: '画面', shotSize: '中景', cameraMovement: '固定', durationMs: 3000 },
  sourceRefs: [ref(id)], dialogueIds: sceneId === 'scene_1' ? ['dialogue_1'] : [], assetRefs: [] });

test('单集场次按已采用事实顺序映射，不重算或跨集串场', () => {
  assert.deepEqual([...episodeSceneIds(episodes, plan, 1)], ['scene_1', 'scene_2']);
  assert.deepEqual([...episodeSceneIds(episodes, plan, 2)], ['scene_3']);
  assert.equal(episodeSceneIds(episodes, plan, 9).size, 0);
});

test('删除第一集后保留集仍映射原场次，不错位到被删除集', () => {
  const currentEpisodeIds = new Set(['episode_2']);
  assert.equal(episodeSceneIds(episodes, plan, 1, currentEpisodeIds).size, 0);
  assert.deepEqual([...episodeSceneIds(episodes, plan, 2, currentEpisodeIds)], ['scene_3']);
  assert.deepEqual([...retainedPlanSceneIds(episodes, plan, currentEpisodeIds)], ['scene_3']);
});

test('完整性同时检查场次和对白，部分覆盖不能误报完成', () => {
  const scenes = plan.content.scenes.slice(0, 2);
  assert.equal(coverageForScenes([shot('shot_1', 'scene_1')], scenes, plan.content.dialogues).complete, false);
  assert.equal(coverageForScenes([shot('shot_1', 'scene_1'), shot('shot_2', 'scene_2')], scenes, plan.content.dialogues).complete, false);
  const complete = shot('shot_2', 'scene_2'); complete.dialogueIds = ['dialogue_2'];
  assert.equal(coverageForScenes([shot('shot_1', 'scene_1'), complete], scenes, plan.content.dialogues).complete, true);
});

test('编辑请求转换为服务端扁平镜头 DTO，并保留证据和资产引用', () => {
  const input = shot('shot_1', 'scene_1');
  input.assetRefs = [{ entityId: 'char_1', assetId: 'asset_1', kind: 'character' }];
  const payload = storyboardEditPayload([input]);
  assert.equal(payload.shots[0].visualDescription, '画面');
  assert.equal(payload.shots[0].design, undefined);
  assert.deepEqual(payload.shots[0].sourceRefs, input.sourceRefs);
  assert.deepEqual(payload.shots[0].assetRefs, input.assetRefs);
});

test('首尾帧绑定进入编辑 DTO，清除和非法组合保持明确行为', () => {
  const input = shot('shot_frames', 'scene_1');
  input.firstFrameAssetId = `asset_${'a'.repeat(32)}`;
  input.lastFrameAssetId = `asset_${'b'.repeat(32)}`;
  const payload = storyboardEditPayload([input]).shots[0];
  assert.equal(payload.firstFrameAssetId, input.firstFrameAssetId);
  assert.equal(payload.lastFrameAssetId, input.lastFrameAssetId);
  const scene = { ...plan.content.scenes[0], title: { value: '钟表铺 日' } };
  assert.deepEqual(storyboardFrameImportInput(input, scene, 'first', 'aGVsbG8='), {
    kind: 'prop', name: '钟表铺 日 · 镜 1 · 首帧',
    description: '分镜镜头首尾帧控制图片，不作为角色、场景或道具参考。', contentBase64: 'aGVsbG8=',
  });
  input.firstFrameAssetId = input.lastFrameAssetId;
  assert.match(storyboardDraftIssue([input], plan.content.scenes), /首帧和尾帧不能使用同一图片资产/);
  delete input.firstFrameAssetId;
  assert.match(storyboardDraftIssue([input], plan.content.scenes), /请先设置首帧/);
  delete input.lastFrameAssetId;
  assert.equal(storyboardEditPayload([input]).shots[0].firstFrameAssetId, undefined);
  assert.equal(storyboardEditPayload([input]).shots[0].lastFrameAssetId, undefined);
});

test('旁白动作不再影响采用覆盖，视频预览继续排除文学旁白', () => {
  const narrativeRef = { scriptVersionId: 'script_1', start: 0, end: 29,
    quote: '【旁白】时间留下残渣。\n【动作】老林夹起铜屑。' };
  const scene = { ...plan.content.scenes[0], sourceRefs: [narrativeRef] };
  const beats = storyboardNarrativeBeats([scene]);
  const input = shot('shot_narrative', 'scene_1');
  input.sourceRefs = [narrativeRef];
  assert.equal(coverageForScenes([input], [scene], plan.content.dialogues).complete, true);
  input.narrativeBeatIds = beats.map(beat => beat.id);
  const coverage = coverageForScenes([input], [scene], plan.content.dialogues);
  assert.equal(coverage.complete, true);
  assert.equal(coverage.narrativeBeats, 2);
  assert.equal(coverageForScenes([input, { ...input, id: 'shot_duplicate', order: 2 }], [scene], plan.content.dialogues).complete, true);
  input.design.cameraAngle = '仰拍';
  input.design.sound = '远处钟声与钟表滴答声';
  assert.deepEqual(storyboardEditPayload([input]).shots[0].narrativeBeatIds, input.narrativeBeatIds);
  assert.equal(storyboardEditPayload([input]).shots[0].cameraAngle, '仰拍');
  assert.equal(storyboardEditPayload([input]).shots[0].sound, '远处钟声与钟表滴答声');
  const promptPlan = { content: { ...plan.content, scenes: [scene], characters: [{ id: 'char_1', name: { value: '老林' } }],
    dialogues: [{ id: 'dialogue_1', sceneId: 'scene_1', speakerId: 'char_1', sourceRef: { ...narrativeRef, quote: '时间也会疼。' } }] } };
  input.assetRefs = [{ entityId: 'char_1', assetId: 'asset_1', kind: 'character' }];
  input.design.visualDescription = '老林夹起铜屑。时间留下残渣。';
  const prompt = shotVideoPromptPreview(input, promptPlan, []);
  assert.doesNotMatch(prompt.prompt, /旁白：|动作：|时间留下残渣|候选创作方向/);
  assert.match(prompt.prompt, /@图片1老林夹起铜屑/);
  assert.match(prompt.prompt, /老林：时间也会疼。/);
  assert.match(prompt.prompt, /中景，仰拍，固定镜头/);
  assert.match(prompt.prompt, /环境音与音效：远处钟声与钟表滴答声/);
  assert.match(prompt.prompt, /参考 @图片1老林，严格保持对应人物、场景、服装与道具一致/);
});

test('换小说后生成不携带旧分镜基础，仅同剧本同事实候选可以合并', async () => {
  const currentPlan = { ...plan, id: 'plan_new', scriptVersionId: 'script_new' };
  const old = { id: 'board_old', scriptVersionId: 'script_old', sourcePlanRevisionId: 'plan_old', createdAt: '2026-01-01T00:00:00Z' };
  assert.equal(storyboardGenerationBase([old], currentPlan, old.id), null);
  const older = { id: 'board_older', scriptVersionId: 'script_new', sourcePlanRevisionId: 'plan_new', createdAt: '2026-01-02T00:00:00Z' };
  const latest = { id: 'board_latest', scriptVersionId: 'script_new', sourcePlanRevisionId: 'plan_new', createdAt: '2026-01-03T00:00:00Z' };
  assert.equal(storyboardGenerationBase([old, older, latest], currentPlan, old.id)?.id, 'board_latest');
  assert.equal(storyboardGenerationBase([old, older, latest], currentPlan, older.id)?.id, 'board_older');
  assert.equal(storyboardGenerationBase([old], null, old.id), null);
  const source = await readFile(new URL('../src/ProjectStoryboardWorkspace.tsx', import.meta.url), 'utf8');
  assert.match(source, /baseRevisionId: generationBase\?\.id/);
  assert.doesNotMatch(source, /baseRevisionId: board\?\.id/);
  assert.match(source, /不合并旧剧本分镜/);
  assert.doesNotMatch(source, /当前选中的是旧剧本分镜/);
  assert.match(boardLabel({ ...old, scope: { kind: 'episode', episodeNumber: 2 } }, null, currentPlan.id), /第 2 集 · 旧版本 · 只读/);
});

test('旧版本只保留简洁只读标识，不叠加无关的覆盖和删集警告', () => {
  const html = renderToStaticMarkup(createElement(StoryboardInspector, {
    shot: null, scene: null, plan, assets: [], readOnly: true, coverageComplete: false,
    adopted: false, stale: true, dirty: false, pruneRequired: true,
    onProduction() {}, onAdopt() {},
  }));
  assert.match(html, /旧版本仅供查看，不能编辑或采用/);
  assert.doesNotMatch(html, /覆盖全部保留场次|已删除集的镜头|旧事实候选/);
});

test('视觉节拍与氛围保留在编辑 DTO 和同源预览，不再暴露重复编辑控件', () => {
  const narrativeRef = { scriptVersionId: 'script_1', start: 0, end: 14, quote: '【动作】老林皱眉看向瓶底。' };
  const scene = { ...plan.content.scenes[0], title: { value: '钟表铺 日' }, timeOfDay: { value: '日' }, sourceRefs: [narrativeRef] };
  const visualPlan = { content: { ...plan.content, scenes: [scene], characters: [{ id: 'char_1', name: { value: '老林' } }],
    dialogues: [{ id: 'dialogue_1', sceneId: 'scene_1', speakerId: 'char_1', sourceRef: { ...narrativeRef, quote: '时间也会疼。' } }] } };
  const input = shot('shot_visual', 'scene_1');
  input.sourceRefs = [narrativeRef];
  input.narrativeBeatIds = storyboardNarrativeBeats([scene]).map(beat => beat.id);
  input.design.visualDescription = '工作台前，老林右手持镊子';
  input.design.visualBeats = ['老林夹起铜屑，手悬在瓷瓶上方', '铜屑落入瓶底，老林抬眼望向来客'];
  input.design.atmosphere = '台灯暖光聚在机芯上，背景货架沉入阴影';
  input.design.timeline = true;
  input.design.durationMs = 8000;
  const payload = storyboardEditPayload([input]).shots[0];
  assert.deepEqual(payload.visualBeats, input.design.visualBeats);
  assert.equal(payload.atmosphere, input.design.atmosphere);
  const prompt = shotVideoPromptPreview(input, visualPlan, []).prompt;
  assert.match(prompt, /【0–3秒】.*工作台前，老林右手持镊子/);
  assert.match(prompt, /【3–6秒】.*手悬在瓷瓶上方/);
  assert.match(prompt, /【6–8秒】.*铜屑落入瓶底，老林抬眼望向来客/);
  assert.equal(prompt.split('老林夹起铜屑').length - 1, 1, '绑定动作与视觉节拍重复时只保留更具体的一项');
  assert.match(prompt, /老林皱眉看向瓶底/);
  assert.doesNotMatch(prompt, /延续上一段/);
  assert.equal(prompt.split('\n').filter(line => line.includes('台灯暖光聚在机芯上')).length, 3);
  const html = renderToStaticMarkup(createElement(StoryboardInspector, { projectId: 'project_1', plan: visualPlan, scene, shot: input,
    assets: [], readOnly: false, coverageComplete: true, adopted: false, stale: false, dirty: true, adopting: false,
    frameUploading: null, voiceUploading: false, voiceLibrary: [], onVoiceUpload: async () => {},
    onVoiceSelect() {}, onAsset() {}, onNarrativeBeat() {}, onFrame() {}, onFrameUpload: async () => {}, onProduction() {}, onAdopt() {} }));
  assert.doesNotMatch(html, /aria-label="当前镜动作与表情"/);
  assert.doesNotMatch(html, /aria-label="当前镜氛围与光线"/);
  assert.match(html, /铜屑落入瓶底，老林抬眼望向来客/);
  assert.match(html, /台灯暖光聚在机芯上，背景货架沉入阴影/);
});

test('角色音色进入编辑 DTO、同源预览和可访问控件，时间轴自动组织', () => {
  const scene = { ...plan.content.scenes[0], title: { value: '钟表铺' }, sourceRefs: [] };
  const dialogue = { id: 'dialogue_1', sceneId: 'scene_1', speakerId: 'char_1', sourceRef: ref('别回头。') };
  const voicePlan = { content: { ...plan.content, scenes: [scene], dialogues: [dialogue], characters: [{ id: 'char_1', name: { value: '老林' } }] } };
  const input = shot('shot_voice', 'scene_1'); input.design.timeline = true;
  const reference = { artifactId: `audio_${'a'.repeat(64)}`, provider: 's3', bucket: 'voices', key: 'voice.wav',
    sha256: 'a'.repeat(64), sizeBytes: 44, contentType: 'audio/wav' };
  input.voiceBindings = [{ speakerEntityId: 'char_1', reference,
    profile: { id: 'voice_1', displayName: '老林参考音色', projectId: 'project_1' } }];
  input.assetRefs = [{ entityId: 'char_1', kind: 'character', assetId: 'asset_1' }];
  const payload = storyboardEditPayload([input]).shots[0];
  assert.equal(payload.timeline, true); assert.deepEqual(payload.voiceBindings, input.voiceBindings);
  assert.match(shotVideoPromptPreview(input, voicePlan, []).prompt, /#老林（音色参考音频1）：别回头。/);
  const html = renderToStaticMarkup(createElement(StoryboardInspector, { projectId: 'project_1', plan: voicePlan, scene, shot: input,
    assets: [], readOnly: false, coverageComplete: true, adopted: false, stale: false, dirty: true, adopting: false,
    frameUploading: null, voiceUploading: false, voiceLibrary: input.voiceBindings,
    voiceAssets: [{ assetId: 'asset_1', binding: input.voiceBindings[0] }],
    onVoiceUpload: async () => {}, onVoiceSelect() {}, onAsset() {}, onNarrativeBeat() {},
    onFrame() {}, onFrameUpload: async () => {}, onProduction() {}, onAdopt() {} }));
  assert.match(html, /aria-label="老林参考音色"/); assert.match(html, /aria-label="上传老林音色"/);
  assert.doesNotMatch(html, /授权类型|同意记录编号|已授权/);
  assert.match(html, /已从人物资产装填/); assert.doesNotMatch(html, /使用可选 3 秒时间轴/);
  assert.match(html, /原生参考音色已启用/);
});

test('人物资产音色自动填入同人物镜头，保留已有手工选择且不误配其他人物', () => {
  const dialogues = [
    { id: 'line_1', sceneId: 'scene_1', speakerId: 'char_1', sourceRef: ref('一') },
    { id: 'line_2', sceneId: 'scene_1', speakerId: 'char_2', sourceRef: ref('二') },
  ];
  const first = { ...shot('shot_a', 'scene_1'), dialogueIds: ['line_1'], assetRefs: [{ entityId: 'char_1', kind: 'character', assetId: 'asset_1' }] };
  const second = { ...shot('shot_b', 'scene_1', 2), dialogueIds: ['line_1'], assetRefs: [{ entityId: 'char_1', kind: 'character', assetId: 'asset_1' }],
    voiceBindings: [{ speakerEntityId: 'char_1', profile: { id: 'manual_voice' } }] };
  const other = { ...shot('shot_c', 'scene_1', 3), dialogueIds: ['line_2'], assetRefs: [{ entityId: 'char_2', kind: 'character', assetId: 'asset_2' }] };
  const binding = { speakerEntityId: 'char_1', profile: { id: 'asset_voice' } };
  const filled = automaticAssetVoiceBindings([first, second, other], [{ assetId: 'asset_1', binding }], dialogues);
  assert.equal(filled.changed, true);
  assert.equal(filled.shots[0].voiceBindings[0].profile.id, 'asset_voice');
  assert.equal(filled.shots[1].voiceBindings[0].profile.id, 'manual_voice');
  assert.equal(filled.shots[2].voiceBindings, undefined);
  assert.equal(automaticAssetVoiceBindings(filled.shots, [{ assetId: 'asset_1', binding }], dialogues).changed, false);
});

test('对白时长不足在同源预览和镜头检查器中给出明确警告', () => {
  const quote = '那就是人们在焦虑和蹉跎里碎裂的时间残渣，真的值得被重新拼回来。';
  const longPlan = { content: { ...plan.content, characters: [{ id: 'char_1', name: { value: '老林' } }],
    dialogues: [{ id: 'dialogue_long', sceneId: 'scene_1', speakerId: 'char_1', sourceRef: ref(quote) }] } };
  const input = { ...shot('shot_long', 'scene_1'), dialogueIds: ['dialogue_long'],
    design: { ...shot('shot_long', 'scene_1').design, durationMs: 4500, timeline: true } };
  const preview = shotVideoPromptPreview(input, longPlan, []);
  assert.match(preview.prompt, /【0–3秒】/);
  assert.match(preview.prompt, /【3–4.5秒】/);
  assert.match(preview.timingIssue, /当前镜头 4.5 秒.*增加镜头时长或拆分到其他镜头/);
  const html = renderToStaticMarkup(createElement(StoryboardInspector, { projectId: 'project_1', plan: longPlan,
    scene: { ...plan.content.scenes[0], title: { value: '钟表铺' } }, shot: input, assets: [], readOnly: false, coverageComplete: true,
    adopted: true, stale: false, dirty: false, adopting: false, frameUploading: null, voiceLibrary: [], voiceUploading: false,
    onVoiceUpload: async () => {}, onVoiceSelect() {}, onAsset() {}, onNarrativeBeat() {},
    onFrame() {}, onFrameUpload() {}, onProduction() {}, onAdopt() {} }));
  assert.match(html, /role="alert"/);
  assert.match(html, /增加镜头时长或拆分到其他镜头/);
});

test('旧候选可按镜头原文补回缺失节拍，保留已有绑定且不改写原草稿', () => {
  const narrativeRef = { scriptVersionId: 'script_1', start: 0, end: 29,
    quote: '【旁白】时间留下残渣。\n【动作】老林夹起铜屑。' };
  const scene = { ...plan.content.scenes[0], sourceRefs: [narrativeRef] };
  const beats = storyboardNarrativeBeats([scene]);
  const legacy = { ...shot('shot_legacy', 'scene_1'), sourceRefs: [narrativeRef], narrativeBeatIds: [beats[1].id] };
  const result = backfillStoryboardNarrativeBeats([legacy], [scene]);
  assert.equal(result.added, 1);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.shots[0].narrativeBeatIds, beats.map(beat => beat.id));
  assert.deepEqual(legacy.narrativeBeatIds, [beats[1].id], '原候选草稿保持不变');
  assert.equal(coverageForScenes(result.shots, [scene], plan.content.dialogues).complete, true);
  const unproven = backfillStoryboardNarrativeBeats([{ ...legacy, sourceRefs: [], narrativeBeatIds: [] }], [scene]);
  assert.equal(unproven.added, 0);
  assert.equal(unproven.missing.length, 2);
});

test('右栏移除叙事勾选和逐镜视觉编辑，保留资产、音色与自动提示词', () => {
  const scene = { ...plan.content.scenes[0], title: { value: '钟表铺' } };
  const html = renderToStaticMarkup(createElement(StoryboardInspector, {
    shot: { ...shot('shot_1', 'scene_1'), dialogueIds: [] }, scene, plan, assets: [], readOnly: false,
    coverageComplete: false, adopted: false, stale: false, dirty: false,
    adopting: false, frameUploading: null, onAsset() {},
    onFrame() {}, onFrameUpload() {}, onProduction() {}, onAdopt() {},
  }));
  assert.doesNotMatch(html, /叙事节拍|从原文补齐|使用可选 3 秒时间轴/);
  assert.doesNotMatch(html, /aria-label="当前镜动作与表情"/);
  assert.doesNotMatch(html, /aria-label="当前镜氛围与光线"/);
  assert.match(html, /覆盖全部保留场次和对白后才能采用/);
  assert.match(html, /<button class="sbw-adopt" disabled=""[^>]*>/);
});

test('单镜与整集视频入口留在分镜页并展示真实运行产物', () => {
  const scene = { ...plan.content.scenes[0], title: { value: '钟表铺' } };
  const base = { projectId: 'project_1', plan, scene, shot: { ...shot('shot_1', 'scene_1'), dialogueIds: [] }, assets: [], readOnly: false,
    coverageComplete: true, adopted: true, stale: false, dirty: false, adopting: false, frameUploading: null,
    voiceUploading: false, voiceLibrary: [], onVoiceUpload: async () => {}, onVoiceSelect() {}, onAsset() {},
    onFrame() {}, onFrameUpload: async () => {}, onProduction() {}, onAdopt() {}, videoBusy: false };
  const empty = renderToStaticMarkup(createElement(StoryboardInspector, { ...base, videoRun: null }));
  assert.match(empty, /生成当前镜视频/); assert.match(empty, /生成本集视频/);
  assert.doesNotMatch(empty, /打开单镜制作入口|整集制作/);
  const completed = renderToStaticMarkup(createElement(StoryboardInspector, { ...base, videoRun: { status: 'completed', issues: [],
    artifacts: [{ kind: 'video', url: '/api/production-media/media_1234567890abcdef1234567890abcdef' }] } }));
  assert.match(completed, /重新生成当前镜/);
  assert.match(completed, /src="\/api\/production-media\/media_1234567890abcdef1234567890abcdef"/);
});

test('已采用版本存在草稿时可一次保存并采用新版本，保存失败不得继续采用', async () => {
  const scene = { ...plan.content.scenes[0], title: { value: '钟表铺' } };
  const html = renderToStaticMarkup(createElement(StoryboardInspector, {
    shot: { ...shot('shot_1', 'scene_1'), dialogueIds: [] }, scene, plan, assets: [], readOnly: false,
    coverageComplete: true, adopted: true, stale: false, dirty: true,
    adopting: false, frameUploading: null, onAsset() {}, onNarrativeBeat() {},
    onFrame() {}, onFrameUpload() {}, onProduction() {}, onAdopt() {},
  }));
  assert.match(html, /将先保存为新候选，再采用；原版本保持不变/);
  assert.match(html, /<button class="sbw-adopt">/);
  assert.match(html, /保存并采用新版本/);
  assert.doesNotMatch(html, /请先保存当前修改/);
  const workspace = await readFile(new URL('../src/ProjectStoryboardWorkspace.tsx', import.meta.url), 'utf8');
  assert.match(workspace, /const revision = dirty \|\| pruneRequired \? await save\(\) : board/);
  assert.match(workspace, /storyboardEditPayload\(prunedShots\)/);
  assert.match(workspace, /if \(!revision\) return/);
  assert.match(workspace, /encodeURIComponent\(revision\.id\)\}\/adoptions/);
});

test('空白镜头在保存前指出具体场次和字段，不再只报结构错误', () => {
  const blank = shot('shot_blank', 'scene_2', 3);
  blank.design.visualDescription = '  ';
  assert.equal(storyboardDraftIssue([shot('shot_1', 'scene_1'), blank], plan.content.scenes),
    '场 2 · 镜 3：画面描述不能为空，请补充后再保存。');
  assert.equal(storyboardDraftIssue([shot('shot_1', 'scene_1')], plan.content.scenes), null);
});

test('删除镜头后只重排当前场次，不影响其他场次顺序', () => {
  const result = reindexSceneShots([shot('a', 'scene_1', 1), shot('b', 'scene_1', 3), shot('c', 'scene_2', 4)], 'scene_1');
  assert.deepEqual(result.map(item => item.order), [1, 2, 4]);
});

test('分镜页读取与服务端生成一致的 general 模型连接版本', async () => {
  const workspace = await readFile(new URL('../src/ProjectStoryboardWorkspace.tsx', import.meta.url), 'utf8');
  const api = await readFile(new URL('../src/project-workspace-api.ts', import.meta.url), 'utf8');
  assert.match(workspace, /getStoryboardModel\(\)/);
  assert.doesNotMatch(workspace, /getBreakdownModel\(\)/);
  assert.match(api, /export async function getStoryboardModel[\s\S]*?\/models\?role=general/);
});

test('分镜页按真实 assets 响应加载资产，选中首镜后右栏可安全查找', async () => {
  const workspace = await readFile(new URL('../src/ProjectStoryboardWorkspace.tsx', import.meta.url), 'utf8');
  assert.match(workspace, /request<\{ assets: AssetRecord\[\] \}>\('\/assets'\)/);
  assert.match(workspace, /setAssets\(assetResult\.assets\)/);
  assert.doesNotMatch(workspace, /setAssets\(assetResult\.items\)/);
});

test('首尾帧右栏提供上传、资产选择、预览、替换和清除入口', async () => {
  const inspector = await readFile(new URL('../src/storyboard/StoryboardInspector.tsx', import.meta.url), 'utf8');
  const workspace = await readFile(new URL('../src/ProjectStoryboardWorkspace.tsx', import.meta.url), 'utf8');
  for (const label of ['上传替换', '清除', '预览', '图片资产']) {
    assert.ok(inspector.includes(label), `missing frame control: ${label}`);
  }
  assert.ok(inspector.includes('aria-label={`${label}图片资产`}'));
  assert.ok(inspector.includes('aria-label={`上传${label}图片`}'));
  assert.match(workspace, /request<AssetRecord>\('\/assets\/import'/);
  assert.match(workspace, /storyboardFrameImportInput/);
  assert.doesNotMatch(inspector, /尚未在制作链生成/);
});

test('分镜三栏按容器宽度收缩，镜头和详情拥有可滚动高度', async () => {
  const css = await readFile(new URL('../src/storyboard/storyboard-workspace.css', import.meta.url), 'utf8');
  assert.match(css, /\.project-section-storyboard\{container-type:inline-size\}/);
  assert.match(css, /grid-template-columns:240px minmax\(0,1fr\) 300px/);
  assert.match(css, /\.sbw-scene-list\{[^}]*min-height:0;[^}]*overflow-y:auto/);
  assert.match(css, /\.sbw-inspector-scroll\{[^}]*min-height:0;[^}]*overflow-y:auto/);
  assert.match(css, /@container \(max-width:1100px\)/);
  assert.doesNotMatch(css, /minmax\(480px,1fr\)/);
});

test('融光式目录、视图切换和详情入口均连接真实 Lyra 操作', async () => {
  const [workspace, sidebar, shots, inspector] = await Promise.all([
    readFile(new URL('../src/ProjectStoryboardWorkspace.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/storyboard/StoryboardEpisodeSidebar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/storyboard/StoryboardShotList.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/storyboard/StoryboardInspector.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(workspace, /const \[viewMode, setViewMode\]/);
  assert.match(workspace, /onRefresh=\{\(\) => void refresh\(\)\}/);
  assert.match(workspace, /onCollapsedChange=\{setSidebarCollapsed\}/);
  assert.match(workspace, /onUpdate=\{updateShotField\}/);
  assert.match(workspace, /durationMs: Number\(value\) \* 1000/);
  assert.match(workspace, /保存候选/);
  assert.match(workspace, /\/edits`/);
  assert.doesNotMatch(workspace, /自动保存/);
  assert.match(sidebar, /刷新分镜目录/);
  assert.match(sidebar, /onScene\(episode\.episodeNumber, scene\.id\)/);
  assert.match(sidebar, /script-structure/);
  assert.match(shots, /viewMode === 'card'/);
  assert.match(shots, /sbw-shot-table/);
  assert.match(shots, /onOpenFrames\(shot\.id\)/);
  assert.match(inspector, /id="sbw-shot-frames"/);
});

test('表格模式按融光媒体列展示，并连接同源提示词、资产和制作入口', async () => {
  const scene = { id: 'scene_1', order: 1, title: { value: '钟表铺' }, sourceRefs: [], characterIds: ['character_1'], locationId: null };
  const dialogue = { id: 'dialogue_1', sceneId: 'scene_1', speakerId: 'character_1', sourceRef: { quote: '对白原文' } };
  const tablePlan = { content: { scenes: [scene], dialogues: [dialogue],
    characters: [{ id: 'character_1', name: { value: '老林' } }], locations: [], props: [] } };
  const tableShot = { ...shot('shot_1', 'scene_1'), design: { ...shot('shot_1', 'scene_1').design, cameraAngle: '俯拍', sound: '钟表滴答声' },
    assetRefs: [{ entityId: 'character_1', kind: 'character', assetId: 'asset_1' }] };
  const html = renderToStaticMarkup(createElement(StoryboardShotList, {
    scenes: [scene], shots: [tableShot], plan: tablePlan, dialogues: [dialogue],
    assets: [{ id: 'asset_1', kind: 'character', name: '老林', resourceUrl: '' }],
    selectedShotId: 'shot_1', viewMode: 'table', readOnlyReason: null,
    onSelect() {}, onAdd() {}, onDelete() {}, onOpenFrames() {}, onOpenAssets() {}, onProduction() {},
  }));
  const header = [...html.matchAll(/<th scope="col">(.*?)<\/th>/g)].map(match => match[1]);
  assert.deepEqual(header, ['镜号', '画面', '首尾帧', '视频', '视频提示词', '关联资产', '景别', '时长', '摄像机角度', '运镜', '分镜内容', '对白', '声音', '操作']);
  assert.match(html, /aria-label="镜 1 视频提示词"[^>]*readOnly/);
  assert.match(html, /aria-label="编辑镜 1 关联资产"/);
  assert.match(html, /aria-label="打开镜 1 视频制作"/);
  assert.ok(html.includes('老林'));
  assert.ok(html.includes('对白原文'));
  assert.doesNotMatch(html, /条叙事节拍/);
  const css = await readFile(new URL('../src/storyboard/storyboard-workspace.css', import.meta.url), 'utf8');
  assert.match(css, /\.sbw-table-wrap\{[^}]*max-width:100%;[^}]*overflow-x:auto/);
  assert.match(css, /\.sbw-shot-table\{[^}]*min-width:1762px/);
  assert.match(html, /aria-label="镜 1 摄像机角度"[^>]*value="俯拍"/);
  assert.match(html, /aria-label="镜 1 声音"[^>]*>钟表滴答声<\/textarea>/);
  assert.match(html, /中景，俯拍，固定/);
  assert.match(html, /环境音与音效：钟表滴答声/);
});
test('人物面板支持添加剧本人物和移除已绑定参考，未绑定项不显示无效删除', () => {
  const old = { id: 'character_1', name: { value: '老林' } };
  const young = { id: 'character_2', name: { value: '年轻人' } };
  const scene = { id: 'scene_1', order: 1, title: { value: '钟表铺' }, sourceRefs: [], characterIds: [old.id], locationId: null };
  const inspectorPlan = { content: { scenes: [scene], dialogues: [], characters: [old, young], locations: [], props: [] } };
  const assets = [
    { id: 'asset_1', kind: 'character', name: '老林', resourceUrl: '' },
    { id: 'asset_2', kind: 'character', name: '年轻人', resourceUrl: '' },
  ];
  const render = assetRefs => renderToStaticMarkup(createElement(StoryboardInspector, {
    shot: { ...shot('shot_1', 'scene_1'), assetRefs }, scene, plan: inspectorPlan, assets,
    readOnly: false, canAdopt: false, adoptReason: '', source: null,
    onAsset() {}, onFrame() {}, onFrameUpload() {}, onBeat() {}, onSourcePreview() {}, onAdopt() {}, onProduction() {},
  }));
  const bound = render([{ entityId: old.id, kind: 'character', assetId: 'asset_1' }]);
  assert.match(bound, /将老林移出本镜/);
  assert.match(bound, /选择要添加的人物/);
  assert.match(bound, /<option value="character_2">年轻人<\/option>/);
  assert.match(bound, /添加到本镜/);
  assert.doesNotMatch(render([]), /将老林移出本镜/);
});

test('分镜沿用 Lyra 深色主题，详情栏不覆盖镜头工作区', async () => {
  const [css, projectCss] = await Promise.all([
    readFile(new URL('../src/storyboard/storyboard-workspace.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/project-workspace.css', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(projectCss, /--project-accent:\s*#22b8cf/);
  assert.match(css, /color-scheme:\s*dark/);
  assert.doesNotMatch(css, /\.sbw-layout\.inspector-open \.sbw-inspector\{position:absolute/);
  assert.ok(!css.includes('position:absolute;z-index:20;top:0;right:0;bottom:0'), '详情栏不得覆盖镜头工作区');
});
