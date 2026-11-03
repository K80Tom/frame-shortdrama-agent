const { randomUUID } = require('node:crypto');
const { readConfig } = require('../../dist/config');
const { readDatabaseConfig } = require('../../dist/db/config');
const { PostgresDatabase } = require('../../dist/db/client');
const { PostgresBreakdownRepository } = require('../../dist/breakdown/repository');
const { BreakdownService } = require('../../dist/breakdown/service');
const { PostgresProductionRepository } = require('../../dist/production/repository');
const { ProductionService } = require('../../dist/production/service');

/** One fixed epoch so every run in the matrix replays with identical timestamps. */
const FIXED_EPOCH_MS = Date.UTC(2026, 10, 3, 12, 0, 0);

function deterministicClock(offsetSeconds = 0) {
  let step = 0;
  return () => new Date(FIXED_EPOCH_MS + (offsetSeconds + step++) * 1000);
}

/**
 * A stub executor that never calls a model or media supplier.
 * `spec.execute` receives (context, callNumber) so a stage can fail once and then recover.
 */
function stubExecutor(stage, spec = {}) {
  const counts = { prepares: 0, executes: 0, reconciles: 0 };
  const executor = {
    stage,
    counts: () => ({ ...counts }),
    async prepare({ task }) {
      counts.prepares += 1;
      return {
        executor: spec.executor ?? `stub-${stage}/1`,
        inputDigest: task.inputManifest[0].digest,
        estimateCostMicros: spec.estimateCostMicros ?? 0,
        requiresPaid: spec.requiresPaid ?? false,
        provider: spec.requiresPaid ? (spec.provider ?? 'stub-provider') : null,
        ...(spec.billingBasis ? { billingBasis: spec.billingBasis } : {}),
      };
    },
    async execute(context) {
      counts.executes += 1;
      if (typeof spec.execute === 'function') return spec.execute(context, counts.executes);
      return structuredClone(spec.outcome ?? { state: 'succeeded' });
    },
  };
  if (spec.reconcile) {
    executor.reconcile = async (context, operation) => {
      counts.reconciles += 1;
      return spec.reconcile(context, operation, counts.reconciles);
    };
  }
  return executor;
}

/** Two episodes' worth of shot children, wired in the same shape the real storyboard stage emits. */
function shotTasks(shots = ['S01-01', 'S01-02']) {
  const stages = ['assets', 'director', 'video', 'candidates', 'review'];
  return shots.flatMap(shot => stages.map((stage, index) => ({
    key: `${shot}-${stage}`,
    stage,
    label: `${shot} ${stage}`,
    scope: { kind: 'shot', id: shot },
    ...(index === 0 ? {} : { dependsOn: [`${shot}-${stages[index - 1]}`] }),
  })));
}

function deliveryOutcome(task) {
  return {
    state: 'succeeded',
    artifacts: [{ key: 'master', kind: 'delivery', title: '成片 MP4',
      uri: `/api/production-media/${task.id}`, sha256: 'a'.repeat(64) }],
    qualityChecks: [{ level: 'episode', result: 'pass', ruleVersion: 'e2e/1', summary: '规格与必需质量门已通过' }],
    delivery: { artifactKey: 'master', durationSec: 90, container: 'mp4', verified: true },
  };
}

/** The offline full chain. `overrides` replaces a stage without touching the rest. */
function fullChainExecutors(overrides = {}) {
  const storyboard = stubExecutor('storyboard', {
    execute: ({ task }) => task.scope.kind === 'episode'
      ? { state: 'succeeded', artifacts: [{ key: 'board', kind: 'text', title: '分镜版本' }], spawnTasks: shotTasks() }
      : { state: 'succeeded' },
  });
  const deliver = stubExecutor('deliver', { execute: ({ task }) => deliveryOutcome(task) });
  const defaults = ['breakdown', 'assets', 'director', 'video', 'candidates', 'review', 'compose']
    .map(stage => stubExecutor(stage, { outcome: { state: 'succeeded' } }));
  return [...defaults, storyboard, deliver]
    .map(executor => overrides[executor.stage] ?? executor);
}

async function openHarness({ title, executors }) {
  const database = new PostgresDatabase(readDatabaseConfig());
  await database.verifyConnection();
  if (!(await database.hasMigrations(['015', '016', '017']))) {
    throw new Error('Run npm run db:migrate before the production e2e matrix.');
  }
  const breakdown = new BreakdownService(new PostgresBreakdownRepository(database),
    readConfig({ LLM_BASE_URL: 'https://model.test/openai', LLM_API_KEY: 'test-only-api-key' }));
  const project = await breakdown.createProject({ title: `${title}-${randomUUID()}` });
  const script = await breakdown.createScriptVersion(project.id, { rawText: '第1场 室内 夜\n林晚：开始。' });
  const repository = new PostgresProductionRepository(database);
  const makeService = (serviceExecutors, clock = deterministicClock()) => new ProductionService(repository, {
    now: clock, pollIntervalMs: 60_000, executors: serviceExecutors,
  });
  const baseInput = {
    projectId: project.id, scriptVersionId: script.id, ratio: '9:16', targetDurationSec: 90,
    visualStyle: '离线端到端矩阵', qualityPreset: 'balanced', automationMode: 'auto',
    candidatePolicy: 'gacha', candidateLimit: 2, directorPolicy: 'auto',
    budgetMicros: 50_000_000, currency: 'CNY', allowPaid: true, clientRequestId: `e2e-${randomUUID()}`,
  };
  return {
    database, projectId: project.id, scriptVersionId: script.id, repository,
    service: makeService(executors),
    makeService,
    input: (changes = {}) => ({ ...baseInput, ...changes }),
    baseInput: () => ({ ...baseInput }),
    async close() {
      await database.query('DELETE FROM production_runs WHERE project_id=$1', [project.id]);
      await database.query('DELETE FROM projects WHERE id=$1', [project.id]);
      await database.close();
    },
  };
}

const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);

/** Tick one run until a predicate holds, a human checkpoint is approved, or the run is terminal. */
async function driveUntil(service, runId, predicate, { maxTicks = 80, approveCheckpoints = false } = {}) {
  let run = await service.get(runId);
  for (let index = 0; index < maxTicks; index++) {
    if (TERMINAL.has(run.status) || (predicate && predicate(run))) return run;
    if (approveCheckpoints) {
      const waiting = run.tasks.filter(task => task.status === 'waitingHuman'
        && task.blockingReason?.code === 'CHECKPOINT_REVIEW_REQUIRED');
      for (const task of waiting) {
        run = await service.review(run.id, { taskId: task.id, decision: 'approve',
          candidateId: null, issueId: null, feedback: '离线夹具自动确认' });
      }
      if (waiting.length) continue;
    }
    await service.tick(runId);
    run = await service.get(runId);
  }
  return run;
}

async function outboxStats(database, runId) {
  const result = await database.query(`SELECT COUNT(*)::int AS count, MIN(sequence)::int AS min,
    MAX(sequence)::int AS max, COUNT(DISTINCT sequence)::int AS distinct_sequences
    FROM production_outbox_events WHERE run_id=$1`, [runId]);
  return result.rows[0];
}

async function runRow(database, runId) {
  const result = await database.query('SELECT version,status FROM production_runs WHERE id=$1', [runId]);
  return result.rows[0];
}

module.exports = {
  FIXED_EPOCH_MS, deterministicClock, stubExecutor, shotTasks, deliveryOutcome, fullChainExecutors,
  openHarness, driveUntil, outboxStats, runRow, TERMINAL,
};
