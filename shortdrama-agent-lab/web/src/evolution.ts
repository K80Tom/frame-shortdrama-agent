import type { ProductionRun, ProductionIssue, ProductionStage, ProjectOption } from './production-automation';
import { runTitle } from './production-automation';

/**
 * 自进化数据层：把跨运行的真实记录（问题、裁决、质量检查、规则版本、任务推进）
 * 聚合成“发现问题 → 处置 → 升级 → 下一次走得更远”的进化台账。
 * 只使用后端返回的运行数据，不虚构任何条目。
 */

export type EvolutionStep = {
  runId: string; index: number; title: string; createdAt: string; status: string;
  tasksCompleted: number; tasksTotal: number; progressPct: number;
  furthestStageKey: string; furthestStageLabel: string; furthestStageState: string;
  issuesTotal: number; issuesOpen: number; qualityChecks: number; reviews: number;
  breakthrough: boolean; ruleVersions: string[];
};

export type EvolutionIssueGroup = {
  code: string; title: string; count: number; openCount: number; resolvedCount: number; severity: string;
  latestMessage: string; latestAt: string; latestRunId: string; runCount: number; stages: string[];
};

export type EvolutionRule = { version: string; occurrences: number; runCount: number; sampleStage: string };

export type EvolutionLoopStats = {
  discovered: number; adjudicated: number; resolved: number; furthestTasks: number; furthestTotal: number;
};

export type EvolutionSummary = {
  steps: EvolutionStep[];
  issueGroups: EvolutionIssueGroup[];
  rules: EvolutionRule[];
  loop: EvolutionLoopStats;
  runsTotal: number;
  issuesOpen: number;
  issuesTotal: number;
  resolvedRate: number;
  qualityChecksTotal: number;
  qualityPassRate: number;
  activeRunId: string | null;
};

const severityRank: Record<string, number> = { error: 3, warning: 2, info: 1 };

function severityOf(issue: ProductionIssue): string { return issue.severity || 'warning'; }

function recordedRuleVersion(value: unknown): string {
  return typeof value === 'string' && value.length <= 80 && /^[A-Za-z0-9_./:+-]+$/u.test(value) ? value : '';
}

/**
 * Quality checks are the canonical rule record (storyboard, assets, media,
 * delivery). Artifact metadata is only a fallback for records that never
 * wrote a matching quality check, such as a skipped 3D shot. Counting both
 * for the same version would double a director decision.
 */
function recordedRuleHits(run: ProductionRun): Array<{ version: string; sample: string }> {
  const fromChecks = run.qualityChecks.flatMap(check => {
    const version = recordedRuleVersion(check.ruleVersion);
    if (!version) return [];
    const task = run.tasks.find(item => item.id === check.taskId);
    return [{ version, sample: task?.label || check.label || '质量检查' }];
  });
  const checkVersions = new Set(fromChecks.map(item => item.version));
  const fromArtifacts = run.artifacts.flatMap(artifact => {
    const version = recordedRuleVersion(artifact.metadata?.ruleVersion);
    if (!version || checkVersions.has(version)) return [];
    return [{ version, sample: artifact.label || '制作产物' }];
  });
  return [...fromChecks, ...fromArtifacts];
}

/** 运行走到的最深阶段：取已完成任务数 > 0 的最靠后阶段，否则看 needsAttention。 */
function furthestStage(run: ProductionRun): { stage: ProductionStage | null; state: string } {
  let furthest: ProductionStage | null = null;
  for (const stage of run.stages) {
    if (stage.completed > 0) furthest = stage;
  }
  const attention = run.stages.find(stage => stage.state === 'needsAttention') ?? null;
  const state = attention ? 'needsAttention' : furthest ? 'succeeded' : 'pending';
  return { stage: attention ?? furthest, state };
}

export function buildEvolutionSummary(runs: ProductionRun[], projects: ProjectOption[] = []): EvolutionSummary {
  const ordered = [...runs].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id));
  const steps: EvolutionStep[] = [];
  const ruleOccurrences = new Map<string, { occurrences: number; runIds: Set<string>; sampleStage: string }>();
  let deepestTasks = 0;

  ordered.forEach((run, position) => {
    const { stage, state } = furthestStage(run);
    const tasksTotal = run.summary.tasks.total;
    const tasksCompleted = run.summary.tasks.completed;
    const progressPct = tasksTotal > 0 ? Math.round((tasksCompleted / tasksTotal) * 100) : 0;
    const breakthrough = position > 0 && tasksCompleted > deepestTasks && tasksTotal > 0;
    if (tasksCompleted > deepestTasks) deepestTasks = tasksCompleted;
    const hits = recordedRuleHits(run);
    for (const hit of hits) {
      const entry = ruleOccurrences.get(hit.version) ?? { occurrences: 0, runIds: new Set<string>(), sampleStage: hit.sample };
      entry.occurrences += 1; entry.runIds.add(run.id); ruleOccurrences.set(hit.version, entry);
    }
    steps.push({
      runId: run.id, index: position + 1, title: runTitle(run, projects), createdAt: run.createdAt, status: run.status,
      tasksCompleted, tasksTotal, progressPct,
      furthestStageKey: stage?.key ?? '', furthestStageLabel: stage?.label ?? '尚未推进', furthestStageState: state,
      issuesTotal: run.summary.issues.total, issuesOpen: run.summary.issues.open,
      qualityChecks: run.qualityChecks.length, reviews: run.reviews.length,
      breakthrough, ruleVersions: [...new Set(hits.map(hit => hit.version))],
    });
  });

  const issuesByCode = new Map<string, EvolutionIssueGroup>();
  const issueRunIds = new Map<string, Set<string>>();
  let issuesTotal = 0; let issuesOpen = 0; let qualityPass = 0; let qualityChecksTotal = 0; let reviewsTotal = 0;
  for (const run of ordered) {
    issuesTotal += run.issues.length; issuesOpen += run.summary.issues.open;
    reviewsTotal += run.reviews.length;
    qualityChecksTotal += run.qualityChecks.length;
    qualityPass += run.qualityChecks.filter(check => check.result === 'pass').length;
    for (const issue of run.issues) {
      const existing = issuesByCode.get(issue.code);
      if (!existing) {
        issuesByCode.set(issue.code, {
          code: issue.code, title: issue.title || issue.code, count: 1,
          openCount: issue.status === 'open' ? 1 : 0, resolvedCount: issue.status === 'resolved' ? 1 : 0,
          severity: severityOf(issue), latestMessage: issue.message, latestAt: run.updatedAt || run.createdAt,
          latestRunId: run.id, runCount: 1, stages: issue.stage ? [issue.stage] : [],
        });
        issueRunIds.set(issue.code, new Set([run.id]));
      } else {
        existing.count += 1; issueRunIds.get(issue.code)?.add(run.id);
        if (issue.stage && !existing.stages.includes(issue.stage)) existing.stages.push(issue.stage);
        if (issue.status === 'open') existing.openCount += 1; else existing.resolvedCount += 1;
        if (severityRank[severityOf(issue)] > severityRank[existing.severity]) existing.severity = severityOf(issue);
        const at = run.updatedAt || run.createdAt;
        if (at >= existing.latestAt) { existing.latestAt = at; existing.latestMessage = issue.message; existing.latestRunId = run.id; }
      }
    }
  }

  const issueGroups = [...issuesByCode.values()].map(group => ({
    ...group, runCount: issueRunIds.get(group.code)?.size ?? group.runCount,
  })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const rules: EvolutionRule[] = [...ruleOccurrences.entries()]
    .map(([version, entry]) => ({ version, occurrences: entry.occurrences, runCount: entry.runIds.size, sampleStage: entry.sampleStage }))
    .sort((a, b) => b.occurrences - a.occurrences || a.version.localeCompare(b.version));

  const last = steps.at(-1);
  return {
    steps, issueGroups, rules,
    loop: {
      discovered: issuesTotal, adjudicated: reviewsTotal, resolved: issuesTotal - issuesOpen,
      furthestTasks: last?.tasksCompleted ?? 0, furthestTotal: last?.tasksTotal ?? 0,
    },
    runsTotal: steps.length, issuesOpen, issuesTotal,
    resolvedRate: issuesTotal > 0 ? Math.round(((issuesTotal - issuesOpen) / issuesTotal) * 100) : 0,
    qualityChecksTotal, qualityPassRate: qualityChecksTotal > 0 ? Math.round((qualityPass / qualityChecksTotal) * 100) : 0,
    activeRunId: [...ordered].reverse().find(run => ['queued', 'running', 'waitingHuman', 'paused', 'pausedBudget', 'reconciling'].includes(run.status))?.id ?? null,
  };
}

/** 运行状态在自进化语境下的推进语义标签。 */
export function evolutionStatusNote(status: string): string {
  const notes: Record<string, string> = {
    queued: '等待推进', running: '正在推进', waitingHuman: '停在人工检查点',
    paused: '人工暂停', pausedBudget: '停在预算检查点', reconciling: '正在对账外部任务',
    completed: '已完成', partial: '部分完成', failed: '未完成', cancelled: '已取消',
  };
  return notes[status] ?? status;
}

export function evolutionRuleKind(version: string): string {
  if (version.includes('director')) return '3D 导演台规则';
  if (version.includes('storyboard')) return '分镜规则';
  if (version.includes('asset')) return '资产规则';
  if (version.includes('shot-media') || version.includes('timeline') || version.includes('delivery')) return '成片技术规则';
  if (version.includes('extract-facts') || version.includes('completeness')) return '拆解检查规则';
  if (version.includes('qc') || version.includes('quality')) return '质量检查规则';
  return '制作规则';
}
