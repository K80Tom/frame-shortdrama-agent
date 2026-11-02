import { productionStageLabels } from './blueprint';
import { productionStageOrder, type ProductionStage, type ProductionTask, type StoredProductionRun } from '@lyra/shared';

const done = (task: ProductionTask) => task.status === 'succeeded' || task.status === 'skipped';
const attention = (task: ProductionTask) => ['waitingHuman', 'failed', 'reconciling'].includes(task.status);
const active = (task: ProductionTask) => ['running', 'waitingExternal', 'validating', 'retryWait'].includes(task.status);

function stageState(tasks: ProductionTask[]): 'pending' | 'running' | 'needsAttention' | 'succeeded' | 'skipped' {
  if (tasks.length && tasks.every(task => task.status === 'skipped')) return 'skipped';
  if (tasks.length && tasks.every(done)) return 'succeeded';
  if (tasks.some(attention)) return 'needsAttention';
  if (tasks.some(active)) return 'running';
  return 'pending';
}

export function publicProductionRun(input: StoredProductionRun) {
  const run = structuredClone(input);
  const relevantTasks = run.tasks.filter(task => task.status !== 'superseded');
  const openIssues = run.issues.filter(issue => issue.status === 'open');
  const shotIds = [...new Set(relevantTasks.filter(task => task.scope.kind === 'shot').map(task => task.scope.id))].sort();
  const shotMatrix = shotIds.map(shotId => {
    const tasks = relevantTasks.filter(task => task.scope.kind === 'shot' && task.scope.id === shotId);
    return { shotId, completed: tasks.length > 0 && tasks.every(done), stages: Object.fromEntries(productionStageOrder.map(stage => {
      const task = tasks.find(item => item.stage === stage);
      return [stage, task?.status ?? null];
    })) as Record<ProductionStage, ProductionTask['status'] | null> };
  });
  const reservedMicros = Math.max(0, run.budgetLedger.reduce((sum, entry) => sum
    + (entry.kind === 'reserve' ? entry.amountMicros : 0)
    - (entry.kind === 'charge' || entry.kind === 'release' ? entry.amountMicros : 0), 0));
  const spentMicros = run.budgetLedger.filter(entry => entry.kind === 'charge').reduce((sum, entry) => sum + entry.amountMicros, 0);
  const frameAssessmentEstimateMicros = run.budgetLedger.filter(entry => entry.kind === 'charge' && entry.basis === 'frameAssessmentCeiling')
    .reduce((sum, entry) => sum + entry.amountMicros, 0);
  const completedTasks = relevantTasks.filter(done).length;
  const stages = productionStageOrder.map(key => {
    const tasks = relevantTasks.filter(task => task.stage === key);
    return { key, label: productionStageLabels[key], state: stageState(tasks),
      completed: tasks.filter(done).length, total: tasks.length, needsAttention: tasks.filter(attention).length };
  });
  const { methodPacks, ...publicRun } = run;
  return { ...publicRun,
    ...(methodPacks ? { methodPacks: methodPacks.map(({ id, digest, nodes }) => ({ id, digest, nodes })) } : {}),
    summary: {
      tasks: { completed: completedTasks, total: relevantTasks.length,
        running: relevantTasks.filter(active).length, waitingHuman: relevantTasks.filter(task => task.status === 'waitingHuman').length,
        failed: relevantTasks.filter(task => task.status === 'failed').length },
      shots: { completed: shotMatrix.filter(shot => shot.completed).length, total: shotMatrix.length },
      issues: { open: openIssues.length, total: run.issues.length },
      budget: { limitMicros: run.budgetMicros, reservedMicros, spentMicros, frameAssessmentEstimateMicros, currency: run.currency },
    }, stages, shotMatrix, inbox: openIssues,
  };
}
