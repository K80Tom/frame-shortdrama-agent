const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

if (!process.env.DATABASE_URL) {
  test('PostgreSQL P0.2 integration requires DATABASE_URL', { skip: 'Set DATABASE_URL (or use node --env-file=.env) before test:db.' }, () => {});
} else {
  const { readConfig } = require('../dist/config');
  const { readDatabaseConfig } = require('../dist/db/config');
  const { PostgresDatabase } = require('../dist/db/client');
  const { PostgresBreakdownRepository } = require('../dist/breakdown/repository');
  const { BreakdownService } = require('../dist/breakdown/service');
  const { ExtractFactsStageRunner, SingleModelCallExtractFactsExecutor } = require('../dist/breakdown/execution');
  const { StoryboardService } = require('../dist/breakdown/storyboard');
  const { reconstructSource } = require('../dist/breakdown/source-index');
  const modelConfig = readConfig({ LLM_BASE_URL: 'https://model.test/openai', LLM_API_KEY: 'test-only-api-key' });

  test('PostgreSQL persists fact checks, entity edits, adoption, storyboard revisions, and the execution ledger', async () => {
    const database = new PostgresDatabase(readDatabaseConfig());
    let projectId;
    try {
      await database.verifyConnection();
      assert.equal(await database.hasMigrations(['001', '002', '003', '004', '005', '006', '007', '017']), true, 'Run npm run db:migrate before test:db. Extract-facts ledger persistence requires migration 017.');
      const repository = new PostgresBreakdownRepository(database);
      const service = new BreakdownService(repository, modelConfig);
      const source = { url: 'https://www.qidian.com/chapter/1049358005/906767983/' };
      const project = await service.createProject({ title: `db-test-${randomUUID()}`, source });
      projectId = project.id;
      assert.deepEqual((await service.getProject(project.id)).source, source);
      const script = await service.createScriptVersion(project.id, {
        rawText: '第1场 走廊 夜 内\n林晚：你终于来了。\n顾沉：我知道。',
      });
      assert.equal(reconstructSource(script.sourceIndex), script.rawText);
      const run = await service.createDraftRun(project.id, {
        maxModelCalls: 1, maxOutputTokens: 4096, requirements: { language: '中文' },
      });
      const reread = await service.getRun(run.id);
      assert.equal(reread.status, 'draft');
      assert.equal(reread.task.type, 'extractFacts');
      assert.equal(reread.task.inputManifest.entries[0].digest, script.contentSha256);
      const fullLine = ref(script.id, script.rawText, '林晚：你终于来了。');
      const otherLine = ref(script.id, script.rawText, '顾沉：我知道。');
      const headingLine = ref(script.id, script.rawText, '第1场 走廊 夜 内');
      const candidate = {
        synopsis: sourced('林晚与顾沉在走廊交谈。', [fullLine, otherLine]),
        characters: [
          { tempId: 'tmp_lin', name: sourced('林晚', [fullLine]), aliases: [], description: null, sourceRefs: [fullLine] },
          { tempId: 'tmp_gu', name: sourced('顾沉', [otherLine]), aliases: [], description: null, sourceRefs: [otherLine] },
        ],
        locations: [], props: [],
        scenes: [{
          tempId: 'tmp_scene', order: 1, title: sourced('走廊交谈', [fullLine, otherLine]),
          locationTempId: null, characterTempIds: ['tmp_lin', 'tmp_gu'],
          sourceRefs: [headingLine, fullLine, otherLine], timeOfDay: null,
        }],
        dialogues: [
          { tempId: 'tmp_d1', sceneTempId: 'tmp_scene', speakerTempId: 'tmp_lin', speakerSourceRefs: [fullLine], speakerAnswerIds: [], sourceRef: ref(script.id, script.rawText, '你终于来了。') },
          { tempId: 'tmp_d2', sceneTempId: 'tmp_scene', speakerTempId: 'tmp_gu', speakerSourceRefs: [otherLine], speakerAnswerIds: [], sourceRef: ref(script.id, script.rawText, '我知道。') },
        ],
      };
      const plan = await service.createExtractFactsCandidate(run.id, candidate);
      assert.equal(plan.status, 'candidate');
      assert.equal((await service.getPlanRevision(plan.id)).content.dialogues[1].sourceRef.quote, '我知道。');
      assert.equal((await service.listPlanRevisions(run.id)).length, 1);
      const storedProject = await database.query('SELECT active_plan_revision_id FROM projects WHERE id = $1', [project.id]);
      assert.equal(storedProject.rows[0].active_plan_revision_id, null);
      const inspected = await service.checkPlan(plan.id);
      assert.equal(inspected.check.result, 'passed', inspected.issues.map(issue => issue.code).join(','));
      assert.equal(inspected.issues.length, 0);
      const adopted = await service.adoptPlan(project.id, {
        planRevisionId: plan.id, checkId: inspected.check.id, expectedActivePlanRevisionId: null,
      });
      assert.equal(adopted.toRevisionId, plan.id);
      assert.equal((await service.getProject(project.id)).activePlanRevisionId, plan.id);

      const storyboard = new StoryboardService(database, service, modelConfig, async (url, request) => {
        const submitted = JSON.parse(request.body);
        assert.equal(url, 'https://model.test/openai/chat/completions');
        assert.equal(request.headers['api-key'], 'test-only-api-key');
        assert.equal(submitted.model, 'deepseek-v4.1-flash-1017');
        assert.equal(submitted.stream, false);
        assert.equal(Object.hasOwn(submitted, 'reasoning_effort'), false);
        return new Response(JSON.stringify({
          id: 'db-storyboard-fake', model: submitted.model, finish_reason: 'stop',
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ shots: [
            { sceneId: plan.content.scenes[0].id, order: 1, visualDescription: '走廊双人中景',
              shotSize: '中景', cameraMovement: '固定', durationMs: 3500,
              sourceRefs: [fullLine], dialogueIds: [plan.content.dialogues[0].id] },
            { sceneId: plan.content.scenes[0].id, order: 2, visualDescription: '切向顾沉',
              shotSize: '近景', cameraMovement: '切镜', durationMs: 2800,
              sourceRefs: [otherLine], dialogueIds: [plan.content.dialogues[1].id] },
          ] }) } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }), { headers: { 'Content-Type': 'application/json' } });
      });
      const board = await storyboard.generate(project.id);
      assert.equal(board.shots.length, 2);
      assert.equal(board.shots[0].design.origin, 'designSuggestion');
      assert.equal((await storyboard.list(project.id))[0].id, board.id);
      await storyboard.adopt(project.id, board.id, null);
      assert.equal((await service.getProject(project.id)).activeStoryboardRevisionId, board.id);

      // Historical snapshots are retained, not rewritten to look like MAAS calls.
      const legacyModelConfig = { provider: 'local-proxy', model: 'gpt-5.6-terra', reasoningEffort: 'medium' };
      await database.query('UPDATE breakdown_runs SET model_config_json = $2::jsonb WHERE id = $1', [run.id, JSON.stringify(legacyModelConfig)]);
      assert.deepEqual((await service.getRun(run.id)).modelConfig, legacyModelConfig);
      let legacyCalls = 0;
      const legacyRunner = new ExtractFactsStageRunner(repository, service, new SingleModelCallExtractFactsExecutor(), {
        async call() { legacyCalls++; throw new Error('historical provider must never run'); },
      });
      await assert.rejects(legacyRunner.run(run.id), error => error.status === 409 && error.code === 'MODEL_CONFIGURATION_CHANGED');
      const legacyAttempts = await database.query('SELECT COUNT(*)::int AS count FROM breakdown_attempts WHERE task_id = $1', [run.task.id]);
      assert.equal(legacyAttempts.rows[0].count, 0);
      assert.equal(legacyCalls, 0);

      const originalPlan = structuredClone(await service.getPlanRevision(plan.id));
      const editRequest = (name) => ({
        expectedActivePlanRevisionId: plan.id,
        edits: [{
          kind: 'character', entityId: plan.content.characters[0].id,
          name, aliases: ['小晚'], description: '人工确认的人物说明。',
        }],
      });
      const edits = await Promise.allSettled([
        service.createEntityEditCandidate(plan.id, editRequest('林晚（人工校对）')),
        service.createEntityEditCandidate(plan.id, editRequest('另一个页面的校对')),
      ]);
      assert.equal(edits.filter((result) => result.status === 'fulfilled').length, 1, 'the project lock must reject a stale concurrent save');
      assert.equal(edits.find((result) => result.status === 'rejected').reason.status, 409);
      const manualPlan = edits.find((result) => result.status === 'fulfilled').value;
      const refreshedService = new BreakdownService(new PostgresBreakdownRepository(database), modelConfig);
      const persistedManual = await refreshedService.getPlanRevision(manualPlan.id);
      assert.deepEqual(persistedManual, manualPlan);
      assert.equal(persistedManual.createdBy, 'user');
      assert.equal(persistedManual.reason, 'manualEdit');
      assert.equal(persistedManual.parentRevisionId, plan.id);
      assert.equal(persistedManual.content.characters[0].id, plan.content.characters[0].id);
      assert.equal(persistedManual.content.characters[0].name.origin, 'user');
      assert.deepEqual(persistedManual.content.characters[0].sourceRefs, plan.content.characters[0].sourceRefs);
      assert.deepEqual(persistedManual.content.dialogues, plan.content.dialogues);
      assert.deepEqual(persistedManual.content.scenes, plan.content.scenes);
      assert.ok(persistedManual.content.manualLocks.some((lock) => lock.targetId === plan.content.characters[0].id && lock.introducedInRevisionId === manualPlan.id));
      assert.deepEqual(await refreshedService.getPlanRevision(plan.id), originalPlan);
      assert.deepEqual(await refreshedService.listPlanChecks(manualPlan.id), []);
      assert.equal((await refreshedService.getProject(project.id)).activePlanRevisionId, plan.id, 'saving a manual candidate does not adopt it');
      assert.equal((await refreshedService.listProjectPlanRevisions(project.id)).at(-1).id, manualPlan.id);
      await assert.rejects(refreshedService.adoptPlan(project.id, {
        planRevisionId: plan.id, checkId: inspected.check.id, expectedActivePlanRevisionId: plan.id,
      }), (error) => error.status === 409, 'old snapshots cannot overwrite newer manual work');
      await assert.rejects(refreshedService.adoptPlan(project.id, {
        planRevisionId: manualPlan.id, checkId: inspected.check.id, expectedActivePlanRevisionId: plan.id,
      }), (error) => error.status === 409, 'a previous revision check is not reusable');
      const manualCheck = await refreshedService.checkPlan(manualPlan.id);
      assert.equal(manualCheck.check.result, 'passed');
      await refreshedService.adoptPlan(project.id, {
        planRevisionId: manualPlan.id, checkId: manualCheck.check.id, expectedActivePlanRevisionId: plan.id,
      });
      const manuallyAdopted = await refreshedService.getProject(project.id);
      assert.equal(manuallyAdopted.activePlanRevisionId, manualPlan.id);
      assert.equal(manuallyAdopted.activeStoryboardRevisionId, null, 'the adopted board is based on the previous fact revision');

      const executionRun = await service.createDraftRun(project.id, {
        maxModelCalls: 1, maxOutputTokens: 4096, requirements: { language: '中文' },
      });
      const runner = new ExtractFactsStageRunner(
        repository,
        service,
        new SingleModelCallExtractFactsExecutor(),
        {
          async call() {
            return {
              providerRequestId: 'db-fake-request',
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              output: { synopsis: null, characters: [], locations: [], props: [], scenes: [], dialogues: [] },
            };
          },
        },
      );
      const executed = await runner.run(executionRun.id);
      assert.equal(executed.execution.attempt.status, 'succeeded');
      assert.equal(executed.execution.modelCalls[0].status, 'succeeded');
      assert.equal(executed.plan.attemptId, executed.execution.attempt.id);
      const ledger = await database.query('SELECT response_json FROM model_calls WHERE attempt_id = $1', [executed.execution.attempt.id]);
      assert.equal(ledger.rowCount, 1);
      assert.deepEqual(ledger.rows[0].response_json, {
        synopsis: null, characters: [], locations: [], props: [], scenes: [], dialogues: [],
      });
      const waiting = await service.getRun(executionRun.id);
      assert.equal(waiting.status, 'waiting');
      assert.equal(waiting.task.state, 'waitingHuman');
    } finally {
      if (projectId) await database.query('DELETE FROM projects WHERE id = $1', [projectId]);
      await database.close();
    }
  });

  test('PostgreSQL adopts a failed-check candidate only after explicit user warning acknowledgement', async () => {
    const database = new PostgresDatabase(readDatabaseConfig());
    let projectId;
    try {
      const service = new BreakdownService(new PostgresBreakdownRepository(database), modelConfig);
      const project = await service.createProject({ title: `db-warning-adoption-${randomUUID()}` });
      projectId = project.id;
      const script = await service.createScriptVersion(project.id, { rawText: '第1场 走廊 夜 内\n林晚：你终于来了。' });
      const run = await service.createDraftRun(project.id, {
        maxModelCalls: 1, maxOutputTokens: 4096, requirements: { language: '中文' },
      });
      const heading = ref(script.id, script.rawText, '第1场 走廊 夜 内');
      const dialogue = ref(script.id, script.rawText, '林晚：你终于来了。');
      const plan = await service.createExtractFactsCandidate(run.id, {
        synopsis: sourced('林晚在走廊说话。', [dialogue]),
        characters: [{ tempId: 'tmp_lin', name: sourced('林晚', [dialogue]), aliases: [], description: null, sourceRefs: [dialogue] }],
        locations: [], props: [],
        scenes: [{ tempId: 'tmp_scene', order: 1, title: sourced('走廊', [heading, dialogue]),
          locationTempId: null, characterTempIds: ['tmp_lin'], sourceRefs: [heading, dialogue], timeOfDay: null }],
        dialogues: [],
      });
      const failed = await service.checkPlan(plan.id);
      assert.equal(failed.check.result, 'failed');
      await assert.rejects(service.adoptPlan(project.id, {
        planRevisionId: plan.id, checkId: failed.check.id, expectedActivePlanRevisionId: null,
      }), error => error.code === 'PLAN_NOT_ADOPTABLE');
      await assert.rejects(service.adoptPlan(project.id, {
        planRevisionId: plan.id, checkId: failed.check.id, expectedActivePlanRevisionId: null,
        allowCheckWarnings: true, actor: 'agent',
      }), error => error.code === 'PLAN_NOT_ADOPTABLE');
      const adopted = await service.adoptPlan(project.id, {
        planRevisionId: plan.id, checkId: failed.check.id, expectedActivePlanRevisionId: null,
        allowCheckWarnings: true, actor: 'user',
      });
      assert.equal(adopted.checkId, failed.check.id);
      assert.equal((await service.getProject(project.id)).activePlanRevisionId, plan.id);
      assert.ok((await service.listPlanIssues(failed.check.id)).length > 0, 'warning acknowledgement must not rewrite the audit issues');
    } finally {
      if (projectId) await database.query('DELETE FROM projects WHERE id = $1', [projectId]);
      await database.close();
    }
  });
}

function ref(scriptVersionId, rawText, quote) {
  const source = Array.from(rawText);
  const target = Array.from(quote);
  let start = -1;
  for (let index = 0; index <= source.length - target.length; index += 1) {
    if (target.every((point, offset) => source[index + offset] === point)) { start = index; break; }
  }
  assert.notEqual(start, -1);
  return { scriptVersionId, start, end: start + target.length, quote };
}

function sourced(value, sourceRefs) {
  return { value, origin: 'source', sourceRefs, answerIds: [] };
}
