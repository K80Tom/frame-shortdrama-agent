const { test } = require('node:test');
const assert = require('node:assert/strict');
const shared = require('@lyra/shared');
const { sealProductionInputSnapshot, verifyProductionInputSnapshot } = require('../dist/production/input-snapshot');
const { verifyShotSpecV2 } = require('../dist/production/shot-spec');
const { productionOutboxDataEvent } = require('../dist/data/production-outbox');
const h = require('./support/e2e-pipeline-harness.cjs');

function assertHex64(value, label) {
  assert.match(String(value), /^[a-f0-9]{64}$/u, `${label} 必须是 64 位 SHA-256`);
}

function taskByStage(run, stage, scopeKind) {
  return run.tasks.filter(task => task.stage === stage && (!scopeKind || task.scope.kind === scopeKind));
}

function artifactByKey(run, task, key) {
  return run.artifacts.find(artifact => artifact.taskId === task.id
    && (artifact.key === key || artifact.metadata?.key === key));
}

test('短剧生产全链路端到端冒烟：8 阶段串联出片', async t => {
  const ctx = {
    fixture: null,
    repository: null,
    run: null,
    video: null,
    service: null,
    tickUntil: null,
    observation: { assetBindings: new Map(), videoJobs: [], composition: null, ticks: 0, clock: Date.parse(h.AT) },
  };

  await t.test('阶段 1｜剧本拆解与 lyra-shot-spec/2 分镜规格', async () => {
    ctx.fixture = h.buildFixture();
    const fixture = ctx.fixture;
    assert.equal(fixture.storyboardShots.length, 2, '两场剧本必须编译出两个镜头');
    assert.deepEqual(fixture.storyboardShots.map(shot => shot.sceneId),
      ['scene_e2e_1', 'scene_e2e_2'], '镜头必须按已采用的场次顺序排列');
    assert.deepEqual(fixture.storyboardShots.map(shot => shot.dialogueIds),
      [['dialogue_e2e_1'], ['dialogue_e2e_2']], '每句对白恰好绑定一次');
    assert.equal(fixture.shots.length, 2);

    const [first, second] = fixture.shots;
    for (const shot of fixture.shots) {
      verifyShotSpecV2(shot);
      assert.equal(shot.schemaVersion, 'lyra-shot-spec/2');
      assertHex64(shot.contentDigest, '镜头 contentDigest');
      assert.equal(shot.ratio, '9:16');
      assert.ok(shot.durationMs >= 100 && shot.durationMs <= 60_000);
    }
    assert.equal(first.dialogue[0].text, '你终于来了。');
    assert.equal(first.dialogue[0].speakerEntityId, 'character_linwan');
    assert.equal(first.shotSize, '中景');
    assert.equal(first.camera.movement, '缓慢推近');
    assert.equal(first.durationMs, 5000);
    assert.match(first.visualStyle, /雨夜/u);
    assert.match(second.visualStyle, /室内/u);
    assert.equal(second.dialogue[0].text, '我以为你不会来。');
    assert.equal(first.assetPacks[0].pack.versionId, fixture.packs.get('character_linwan').id);
    assert.ok(first.assetPacks[0].media.some(item => item.objectVersionId.startsWith('objver_')));
  });

  await t.test('阶段 2｜ProductionInputSnapshot 冻结且不可变', async () => {
    const fixture = ctx.fixture;
    const snapshot = fixture.input.snapshot;
    assert.equal(snapshot.state, 'frozen');
    assertHex64(snapshot.snapshotDigest, '快照 snapshotDigest');
    assert.equal(verifyProductionInputSnapshot(snapshot).snapshotDigest, snapshot.snapshotDigest);

    // 同一份草稿重复固化必须得到同一个摘要；上游改动不能穿透已经固化的快照。
    const { snapshotDigest: _digest, ...draft } = structuredClone(snapshot);
    assert.equal(sealProductionInputSnapshot(draft).snapshotDigest, snapshot.snapshotDigest);
    fixture.plan.content.scenes[0].title.value = '上游改写的场次';
    fixture.storyboardShots[0].design.durationMs = 9000;
    assert.equal(snapshot.snapshotDigest, verifyProductionInputSnapshot(snapshot).snapshotDigest);
    assert.equal(snapshot.shots[0].contentDigest, fixture.shots[0].contentDigest);
    assert.equal(snapshot.shots[1].contentDigest, fixture.shots[1].contentDigest);

    const tamperedSnapshot = structuredClone(snapshot);
    tamperedSnapshot.shots[0].contentDigest = 'f'.repeat(64);
    assert.throws(() => verifyProductionInputSnapshot(tamperedSnapshot),
      error => error.code === 'DIGEST_MISMATCH');
    const tamperedShot = structuredClone(fixture.shots[0]);
    tamperedShot.durationMs = 6000;
    assert.throws(() => verifyShotSpecV2(tamperedShot),
      error => error.code === 'SHOT_SPEC_DIGEST_MISMATCH');

    const created = await h.createProductionRun(fixture);
    ctx.repository = created.repository;
    ctx.run = created.run;
    assert.equal(ctx.run.inputSnapshot.snapshotDigest, snapshot.snapshotDigest);
    assert.equal(taskByStage(ctx.run, 'assets', 'episode')[0].status, 'skipped',
      'V2 已将全局资产引用冻结，不再运行 V1 可变目录');

    ctx.video = h.createVideoPipeline();
    const built = h.createPipelineExecutors({
      fixture, video: ctx.video, observation: ctx.observation,
    });
    const drive = await h.driveProduction({
      fixture, run: ctx.run, repository: ctx.repository,
      executors: built.executors, observation: ctx.observation,
    });
    ctx.service = drive.service;
    ctx.tickUntil = drive.tickUntil;
  });

  await t.test('阶段 3｜角色多角度 AssetPack 混合检索与镜头绑定', async () => {
    const fixture = ctx.fixture;
    for (const shot of fixture.input.shots) {
      for (const assetPack of shot.assetPacks) {
        const pack = fixture.packs.get(assetPack.entityId);
        assert.ok(pack, `缺少 ${assetPack.entityId} 的资产包`);
        const views = new Set(pack.mediaEntries.map(entry => entry.view));
        assert.ok(views.has('front') && views.has('side_left') && views.has('close_up'),
          '角色资产包必须包含正面、侧面与特写视图');
        const retrieval = h.retrieveAssetForGeneration({
          kind: 'character',
          name: pack.displayName,
          aliases: pack.aliases,
          description: pack.description,
          workspaceId: h.TENANT.workspaceId,
          projectId: h.PROJECT_ID,
          shotId: shot.shotId,
          requiredView: 'front',
          usage: 'production',
          authorizationRequired: true,
          reviewRequired: true,
          topK: 3,
        }, [h.assetSubject(pack)]);
        assert.equal(retrieval.status, 'unique');
        assert.equal(retrieval.asset.assetPackVersionId, pack.id);
        const front = pack.mediaEntries.find(entry => entry.view === 'front');
        assert.ok(front.objectVersionId.startsWith('objver_'));
      }
    }

    const samplePack = fixture.packs.get('character_linwan');
    const sampleShot = fixture.input.shots[0];
    const query = {
      kind: 'character', name: samplePack.displayName, aliases: samplePack.aliases,
      description: samplePack.description, workspaceId: h.TENANT.workspaceId, projectId: h.PROJECT_ID,
      shotId: sampleShot.shotId, requiredView: 'front', usage: 'production',
      authorizationRequired: true, reviewRequired: true, topK: 3,
    };
    const hybridAssets = [h.assetSubject(samplePack)];
    const hybrid = await h.createHybridAssetRetriever(hybridAssets, { score: 0.9 }).retrieve(query, hybridAssets);
    assert.equal(hybrid.ruleVersion, 'asset-rag-hybrid/1');
    assert.equal(hybrid.retrievalMode, 'hybrid');
    assert.equal(hybrid.semantic.status, 'available');
    assert.equal(hybrid.semantic.candidateCount, 1);
    assert.equal(hybrid.status, 'unique');
    assert.equal(hybrid.asset.assetPackVersionId, samplePack.id);

    const degraded = await h.createDegradedAssetRetriever().retrieve(query, hybridAssets);
    assert.equal(degraded.ruleVersion, 'asset-rag-hybrid/1');
    assert.equal(degraded.retrievalMode, 'degraded-lexical');
    assert.equal(degraded.degradationReason, 'milvus-unreachable');
    assert.equal(degraded.semantic.status, 'degraded');
    assert.equal(degraded.semantic.reason, 'projection_unavailable');
    assert.equal(degraded.status, 'unique');
    assert.equal(degraded.asset.assetPackVersionId, samplePack.id);

    await ctx.tickUntil(stored => taskByStage(stored, 'assets', 'shot').length === 2
      && taskByStage(stored, 'assets', 'shot').every(task => task.status === 'succeeded'),
    '两个镜头的资产绑定完成');
    const stored = await ctx.repository.get(ctx.run.id);
    const assetTasks = taskByStage(stored, 'assets', 'shot');
    assert.equal(assetTasks.length, 2);
    for (const task of assetTasks) {
      const artifact = artifactByKey(stored, task, 'shot-asset-bindings');
      assert.ok(artifact, '每个镜头必须有资产绑定成果');
      assert.equal(artifact.metadata.bindings.length, 1);
      assert.equal(artifact.metadata.retrievalMode, 'degraded-lexical');
      assert.equal(artifact.metadata.degradationReason, 'milvus-unreachable');
      const binding = artifact.metadata.bindings[0];
      assert.equal(binding.view, 'front');
      assert.equal(binding.retrievalStatus, 'unique');
      assert.equal(binding.retrievalRuleVersion, 'asset-rag-structured/1');
      assert.equal(binding.hybridRetrievalRuleVersion, 'asset-rag-hybrid/1');
      assert.equal(binding.hybridRetrievalMode, 'degraded-lexical');
      assert.equal(binding.hybridSemanticStatus, 'degraded');
      assert.equal(binding.hybridDegradationReason, 'milvus-unreachable');
      assert.equal(binding.hybridStatus, 'unique');
      assert.match(binding.objectVersionId, /^objver_[a-f0-9]{32}$/u);
      assert.match(binding.assetPackVersionId, /^apv_[a-f0-9]{32}$/u);
      assert.equal(binding.packInputVersionId, fixture.packs.get(binding.entityId).id);
    }
    assert.equal(ctx.observation.assetBindings.size, 2);
  });

  await t.test('阶段 4｜视频生成 Worker 调度与 9:16 产物', async () => {
    const before = await ctx.repository.get(ctx.run.id);
    const videoTasksBefore = taskByStage(before, 'video', 'shot');
    assert.equal(videoTasksBefore.length, 2);
    assert.ok(videoTasksBefore.some(task => task.status === 'pending' || task.status === 'ready'),
      '进入阶段 4 时至少应有一个视频任务处于排队态');

    await ctx.tickUntil(stored => taskByStage(stored, 'video', 'shot').length === 2
      && taskByStage(stored, 'video', 'shot').every(task => task.status === 'succeeded'),
    '两个镜头视频生成完成');

    const stored = await ctx.repository.get(ctx.run.id);
    const videoTasks = taskByStage(stored, 'video', 'shot');
    const videoArtifacts = stored.artifacts.filter(artifact => artifact.kind === 'video');
    assert.equal(videoArtifacts.length, 2);
    assert.equal(ctx.video.adapter.submits(), 2, '每个镜头只提交一次商业适配器请求');
    assert.equal(ctx.observation.videoJobs.length, 2);

    for (const job of ctx.observation.videoJobs) {
      assert.equal(job.initialState, 'pending', 'Outbox 任务初始入队');
      assert.equal(job.claimedState, 'delivering', 'Worker 已领取任务');
      assert.equal(job.finalState, 'delivered', 'Outbox 任务完成投递');
      assert.equal(job.completion, 'delivered');
      assert.equal(job.consumers.length, 1);
      assert.equal(job.consumers[0].result.sha256, job.result.sha256);
      assertHex64(job.result.sha256, '视频产物哈希');
      assert.ok(job.result.sizeBytes > 0);
      assert.match(job.result.providerTaskId, /^cgt-e2e-/u);
    }

    for (const task of videoTasks) {
      const artifact = artifactByKey(stored, task, 'shot-video');
      assert.ok(artifact);
      assert.equal(artifact.kind, 'video');
      assertHex64(artifact.sha256, '视频 artifact sha256');
      assert.equal(artifact.metadata.ratio, '9:16');
      assert.equal(artifact.metadata.durationSeconds, 5);
      assert.equal(artifact.metadata.resolution, '1080p');
      assert.equal(artifact.metadata.outboxFinalState, 'delivered');
      assert.match(artifact.metadata.providerTaskId, /^cgt-e2e-/u);
    }

    const finishedEvents = stored.outbox.filter(event => event.type === 'production.task.finished');
    for (const task of videoTasks) {
      assert.ok(finishedEvents.some(event => event.payload.taskId === task.id),
        `视频任务 ${task.id} 必须留下 task.finished 事件`);
    }
  });

  await t.test('阶段 5｜角色对白 TTS 与时间轴对齐', async () => {
    await ctx.tickUntil(stored => taskByStage(stored, 'compose', 'episode')[0]?.status === 'succeeded',
      '音频与字幕合成完成');
    const composition = ctx.observation.composition;
    assert.ok(composition, 'compose 执行器必须产出合成上下文');
    assert.equal(composition.track.schemaVersion, shared.AUDIO_PRODUCTION_SCHEMA_VERSION);
    assert.equal(composition.track.cues.length, 2);
    assert.equal(composition.ttsCalls, 2, '每条对白恰好发起一次 TTS');
    assert.equal(composition.track.cues[0].timing.expectedStartMs, 300);
    assert.equal(composition.track.cues[0].timing.expectedEndMs, 2800);
    assert.equal(composition.track.cues[1].timing.expectedStartMs, 5300);
    assert.equal(composition.track.cues[1].timing.expectedEndMs, 7800);
    assert.equal(composition.track.cues[0].emotion, '克制');
    assert.equal(composition.track.cues[1].emotion, '迟疑');

    for (const take of composition.takes) {
      assert.equal(take.status, 'adopted');
      assert.equal(take.provider, 'stub-tts');
      assert.equal(take.alignment.kind, 'estimated');
      assert.ok(take.durationMs >= 1200);
      assert.ok(take.voiceProfileVersionId.startsWith('voice_'));
      assert.equal(composition.track.cues.find(cue => cue.cueId === take.dialogueCueId)
        .adoptedVoiceTakeVersionId, take.id);
    }

    const stored = await ctx.repository.get(ctx.run.id);
    const composeTask = taskByStage(stored, 'compose', 'episode')[0];
    const audioArtifact = artifactByKey(stored, composeTask, 'audio-mix');
    assert.equal(audioArtifact.metadata.dialogueTrackId, composition.track.id);
    assert.equal(audioArtifact.metadata.dialogueCues, 2);
    assert.equal(audioArtifact.metadata.voiceTakes, 2);
  });

  await t.test('阶段 6｜-6dB 侧链压限 BGM 自动避让', async () => {
    const composition = ctx.observation.composition;
    const filter = composition.mixPlan.filterComplex;
    assert.match(filter, /\[dialogue\]asplit=2\[dsidesrc\]\[dmix\]/u,
      '对白总线必须 split 出一路作为侧链键，另一路保留在最终混音');
    assert.match(filter,
      /\[musicraw\]\[dsidesrc\]sidechaincompress=threshold=0\.05:ratio=4:attack=20:release=300:makeup=1\[musicduck\]/u,
      '-6dB 侧链压限参数必须原样进入 ffmpeg 滤镜图');
    assert.match(filter, /amix=inputs=2:normalize=0:dropout_transition=0\[dialogue\]/u,
      '两段对白必须先汇成对白总线');
    assert.match(filter, /amix=inputs=3:normalize=0:dropout_transition=0,alimiter=limit=0\.95\[aout\]/u,
      '对白、BGM、SFX 三路必须进入最终 amix');
    assert.equal(composition.mixPlan.warnings.length, 0);
    assert.ok(composition.mixPlan.args.includes('-filter_complex'));
    assert.ok(composition.mixPlan.args.join(' ').includes('/tmp/lyra-e2e/master.mp4'));

    const stored = await ctx.repository.get(ctx.run.id);
    const composeTask = taskByStage(stored, 'compose', 'episode')[0];
    const audioArtifact = artifactByKey(stored, composeTask, 'audio-mix');
    assert.equal(audioArtifact.metadata.ducking.threshold, 0.05);
    assert.equal(audioArtifact.metadata.ducking.ratio, 4);
    assert.equal(audioArtifact.metadata.ducking.attackMs, 20);
    assert.equal(audioArtifact.metadata.ducking.releaseMs, 300);
    assert.match(audioArtifact.metadata.filterComplex, /sidechaincompress/u);
  });

  await t.test('阶段 7｜字幕同源烧录与 SRT 交付', async () => {
    const composition = ctx.observation.composition;
    const subtitle = composition.subtitle;
    assert.equal(subtitle.schemaVersion, shared.SUBTITLE_SCHEMA_VERSION);
    assert.equal(subtitle.checks.verdict, 'pass');
    assert.equal(subtitle.checks.coverage, 1);
    assert.deepEqual(subtitle.checks.readingSpeedFailures, []);
    assert.deepEqual(subtitle.checks.lineLengthFailures, []);
    assert.deepEqual(subtitle.checks.overlapCueIds, []);
    assert.deepEqual(subtitle.checks.duplicateCueIds, []);
    assert.ok(subtitle.cues.every(cue => cue.lines.length <= 2));
    assert.ok(subtitle.cues.every(cue => cue.lines.every(line => [...line].length <= 18)));

    const srt = composition.srt;
    assert.match(srt, /^1\n00:00:00,300 --> 00:00:01,620\n你终于来了。\n\n2\n00:00:05,300 --> 00:00:07,060\n我以为你不会来。\n$/u);
    assert.equal(composition.mixPlan.subtitleSrt, srt, '烧录与 sidecar 必须同源于同一个 SubtitleVersion');
    assert.equal(composition.mixPlan.subtitlePath, '/tmp/lyra-e2e/master.srt');
    assert.match(composition.mixPlan.filterComplex,
      /subtitles=filename='\/tmp\/lyra-e2e\/master\.srt'/u, 'burn-in 必须引用同源 SRT');

    const stored = await ctx.repository.get(ctx.run.id);
    const composeTask = taskByStage(stored, 'compose', 'episode')[0];
    const subtitleArtifact = artifactByKey(stored, composeTask, 'subtitles');
    assert.equal(subtitleArtifact.metadata.verdict, 'pass');
    assert.equal(subtitleArtifact.metadata.srt, srt);
    assert.equal(subtitleArtifact.metadata.subtitleVersionId, subtitle.id);
    assert.equal(subtitleArtifact.metadata.burnInFilterPresent, true);
    assert.deepEqual(subtitleArtifact.metadata.readingSpeedFailures, []);
    assert.deepEqual(subtitleArtifact.metadata.lineLengthFailures, []);
  });

  await t.test('阶段 8｜终态交付与 Outbox DataEvent 生产血缘', async () => {
    await ctx.tickUntil(stored => stored.status === 'completed', 'ProductionRun 到达 completed');
    const stored = await ctx.repository.get(ctx.run.id);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.delivery.status, 'ready');
    assert.equal(stored.delivery.spec.ratio, '9:16');
    assert.equal(stored.delivery.spec.durationSec, 10);
    assert.ok(stored.delivery.verifiedAt);
    const deliveryArtifact = stored.artifacts.find(artifact => artifact.id === stored.delivery.artifactId);
    assert.ok(deliveryArtifact);
    assert.equal(deliveryArtifact.kind, 'delivery');
    assert.match(deliveryArtifact.uri, /^\/api\/production-media\//u);
    assertHex64(deliveryArtifact.sha256, '成片 SHA-256');

    const view = await ctx.service.get(ctx.run.id);
    assert.equal(view.status, 'completed');
    assert.equal(view.delivery.status, 'ready');
    assert.equal(view.summary.shots.completed, 2);

    // Outbox 行 -> DataEventV2 投影，证明生产事实与事件在同一事务语义下可重放。
    assert.ok(stored.outbox.length >= 12);
    assert.equal(stored.outbox.every((event, index) => event.sequence === index + 1), true);
    const dataEvents = stored.outbox.map(event => productionOutboxDataEvent(stored, event));
    assert.equal(dataEvents.length, stored.outbox.length);
    assert.equal(new Set(dataEvents.map(event => event.eventId)).size, dataEvents.length);
    assert.equal(new Set(dataEvents.map(event => event.idempotencyKey)).size, dataEvents.length);
    for (const [index, event] of dataEvents.entries()) {
      assert.equal(event.schemaVersion, 'lyra.data.event/v2');
      assert.equal(event.workspaceId, h.TENANT.workspaceId);
      assert.equal(event.aggregateType, 'production_run');
      assert.equal(event.aggregateId, stored.id);
      assert.equal(event.aggregateVersion, index + 1);
      assert.equal(event.eventType, stored.outbox[index].type);
      assert.equal(event.correlationId, `production:${stored.id}`);
      assert.equal(event.authoritativeRef.kind, 'production_outbox_event');
      assertHex64(event.authoritativeRef.digest, 'DataEvent 权威引用摘要');
    }

    const created = dataEvents.find(event => event.eventType === 'production.run.created');
    assert.ok(created);
    assert.equal(created.payload.snapshotId, ctx.fixture.input.snapshot.id);
    assert.equal(created.payload.snapshotDigest, ctx.fixture.input.snapshot.snapshotDigest);

    const finished = dataEvents.filter(event => event.eventType === 'production.task.finished');
    const finishedTaskIds = new Set(finished.map(event => event.payload.taskId));
    const storyboardTask = taskByStage(stored, 'storyboard', 'episode')[0];
    const composeTask = taskByStage(stored, 'compose', 'episode')[0];
    const deliverTask = taskByStage(stored, 'deliver', 'episode')[0];
    for (const task of [storyboardTask, ...taskByStage(stored, 'video', 'shot'), composeTask, deliverTask]) {
      assert.ok(finishedTaskIds.has(task.id), `任务 ${task.stage}/${task.id} 必须进入 Outbox 血缘`);
    }

    // 输入快照 -> 分镜 -> 镜头视频 -> 音视频/字幕 -> 成片的完整链条。
    const storyboardArtifact = artifactByKey(stored, storyboardTask, 'storyboard');
    assert.ok(storyboardArtifact);
    assert.equal(storyboardArtifact.metadata.snapshotDigest, ctx.fixture.input.snapshot.snapshotDigest);
    assert.deepEqual(storyboardArtifact.metadata.shots.map(shot => shot.revisionId),
      ctx.fixture.input.shots.map(shot => shot.revisionId));
    const videoArtifacts = stored.artifacts.filter(artifact => artifact.kind === 'video');
    for (const artifact of videoArtifacts) {
      assert.equal(artifact.metadata.snapshotDigest, ctx.fixture.input.snapshot.snapshotDigest);
      assert.ok(ctx.fixture.input.shots.some(shot => shot.shotId === artifact.metadata.shotId
        && shot.revisionId === artifact.metadata.shotRevisionId));
    }
    const audioArtifact = artifactByKey(stored, composeTask, 'audio-mix');
    const subtitleArtifact = artifactByKey(stored, composeTask, 'subtitles');
    assert.equal(audioArtifact.metadata.dialogueTrackId, ctx.observation.composition.track.id);
    assert.equal(audioArtifact.metadata.subtitleVersionId, subtitleArtifact.metadata.subtitleVersionId);
    assert.equal(deliveryArtifact.metadata.dialogueTrackId, audioArtifact.metadata.dialogueTrackId);
    assert.equal(deliveryArtifact.metadata.subtitleVersionId, subtitleArtifact.metadata.subtitleVersionId);
    assert.equal(stored.tasks.filter(task => task.status === 'failed').length, 0);
    assert.equal(stored.issues.filter(issue => issue.status === 'open').length, 0);
  });
});
