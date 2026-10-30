import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, ArrowUpRight, Check, CircleDot, Gavel, LoaderCircle, RefreshCw, ShieldCheck,
  Sparkles, TrendingUp, Wrench,
} from 'lucide-react';
import {
  mergeProductionRuns, parseProductionRuns, parseProjectOptions, productionApi, type ProjectOption, type ProductionRun,
} from './production-automation';
import { buildEvolutionSummary, evolutionRuleKind, evolutionStatusNote, type EvolutionIssueGroup, type EvolutionStep } from './evolution';
import type { Page } from './model';
import './evolution.css';

const statusLabels: Record<string, string> = { queued: '准备中', running: '制作中', waitingHuman: '等待处理', paused: '已暂停', pausedBudget: '预算已暂停', reconciling: '正在对账', completed: '已完成', partial: '部分完成', failed: '未完成', cancelled: '已取消' };
const statusTones: Record<string, string> = { running: 'live', waitingHuman: 'attention', paused: 'attention', pausedBudget: 'attention', reconciling: 'live', completed: 'done', partial: 'done', queued: 'idle', failed: 'idle', cancelled: 'idle' };
const severityLabels: Record<string, string> = { error: '阻断', warning: '注意', info: '提示' };
const severityTones: Record<string, string> = { error: 'block', warning: 'warn', info: 'note' };

function dateText(value: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未记录';
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
const stageLabelMap: Record<string, string> = { prepare: '生产预检', breakdown: '剧本拆解', assets: '资产准备', storyboard: '分镜设计', director: '3D 预演', video: '镜头视频生成', candidates: '候选选择', review: '技术复核', compose: '成片合成', deliver: '最终出片', plan: '拆解方案' };
function stageLabel(stage: string) { return stageLabelMap[stage] ?? stage; }
function errorText(error: unknown) { return error instanceof Error && error.name !== 'AbortError' ? error.message : '本地后端连接超时，请稍后重试。'; }

export default function EvolutionPage({ go }: { go: (page: Page, step?: number) => void }) {
  const [runs, setRuns] = useState<ProductionRun[] | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError('');
    try {
      const [runsData, projectsData] = await Promise.all([
        productionApi('/api/production-runs', undefined, signal),
        productionApi('/api/projects', undefined, signal).catch(() => null),
      ]);
      const parsed = parseProductionRuns(runsData);
      setRuns(previous => (previous ? mergeProductionRuns(previous, parsed) : parsed));
      if (projectsData) setProjects(parseProjectOptions(projectsData));
    } catch (cause) { setError(errorText(cause)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const summary = useMemo(() => (runs ? buildEvolutionSummary(runs, projects) : null), [runs, projects]);

  return <div className="ev-page">
    <header className="ev-page-head">
      <div>
        <span className="ev-kicker">SYSTEM EVOLUTION</span>
        <h1>自进化</h1>
        <p>生产系统从每一次运行中积累经验：发现的问题、人工裁决、修复与规则升级，都会让下一次运行走得更远。</p>
      </div>
      <button className="ev-refresh" onClick={() => load()} disabled={loading}>
        {loading ? <LoaderCircle size={14} className="ev-spin" /> : <RefreshCw size={14} />}
        <span>刷新数据</span>
      </button>
    </header>

    {error && <section className="ev-error" role="alert"><AlertCircle size={16} /><p>{error}</p><button onClick={() => load()}>重试</button></section>}
    {!summary && !error && <section className="ev-empty"><LoaderCircle size={18} className="ev-spin" /><p>正在读取本地运行记录…</p></section>}
    {summary && <>
      <section className="ev-loop" aria-label="自进化闭环">
        <div className="ev-loop-node">
          <span className="ev-loop-icon"><CircleDot size={15} /></span>
          <div><strong>运行发现问题</strong><small>问题被记录并进入待办</small></div>
          <b>{summary.loop.discovered}</b>
        </div>
        <span className="ev-loop-arrow" />
        <div className="ev-loop-node">
          <span className="ev-loop-icon"><Gavel size={15} /></span>
          <div><strong>人工裁决</strong><small>检查点由你拍板，其余自动处置</small></div>
          <b>{summary.loop.adjudicated}</b>
        </div>
        <span className="ev-loop-arrow" />
        <div className="ev-loop-node">
          <span className="ev-loop-icon"><Wrench size={15} /></span>
          <div><strong>修复与升级</strong><small>缺陷修复后规则契约升级</small></div>
          <b>{summary.loop.resolved}</b>
        </div>
        <span className="ev-loop-arrow" />
        <div className="ev-loop-node is-goal">
          <span className="ev-loop-icon"><TrendingUp size={15} /></span>
          <div><strong>下一次走得更远</strong><small>最深推进 {summary.loop.furthestTasks}/{summary.loop.furthestTotal} 个节点</small></div>
          <b>{summary.loop.furthestTotal > 0 ? Math.round((summary.loop.furthestTasks / summary.loop.furthestTotal) * 100) : 0}%</b>
        </div>
      </section>

      <section className="ev-stats" aria-label="进化总览">
        <div className="ev-stat"><span>PRODUCTION RUNS</span><strong>{summary.runsTotal}</strong><small>累计制作运行</small></div>
        <div className="ev-stat"><span>ISSUES SEEN</span><strong>{summary.issuesTotal}</strong><small>问题累计发现 · 待处理 {summary.issuesOpen}</small></div>
        <div className="ev-stat"><span>RESOLVED</span><strong>{summary.resolvedRate}%</strong><small>问题解决率（含预算挡停处置）</small></div>
        <div className="ev-stat"><span>QUALITY GATES</span><strong>{summary.qualityChecksTotal}</strong><small>技术复核执行 · 通过 {summary.qualityPassRate}%</small></div>
        <div className="ev-stat"><span>RULES ACTIVE</span><strong>{summary.rules.length}</strong><small>运行中生效的规则版本</small></div>
      </section>

      <section className="ev-card" aria-labelledby="ev-ladder-title">
        <div className="ev-card-head"><div><span>RUN LADDER</span><h2 id="ev-ladder-title">运行阶梯</h2></div><TrendingUp size={18} /></div>
        <p className="ev-card-intro">按时间排列的每一次运行。阶梯抬高代表系统把此前的问题消化成了升级：同样的剧本，后来的运行推进得更深。</p>
        <ol className="ev-ladder">
          {summary.steps.map(step => <li key={step.runId} className={`ev-step ${step.breakthrough ? 'is-breakthrough' : ''}`}>
            <span className="ev-step-index">#{step.index}</span>
            <div className="ev-step-main">
              <div className="ev-step-top">
                <strong>{step.title}</strong>
                <span className={`ev-badge is-${statusTones[step.status] ?? 'idle'}`}>{statusLabels[step.status] ?? step.status}</span>
                {step.breakthrough && <span className="ev-badge is-up"><TrendingUp size={11} /> 推进</span>}
              </div>
              <div className="ev-step-progress"><i style={{ width: `${Math.min(100, step.progressPct)}%` }} /></div>
              <div className="ev-step-meta">
                <span>{dateText(step.createdAt)}</span>
                <span>节点 {step.tasksCompleted}/{step.tasksTotal}</span>
                <span>推进至「{step.furthestStageLabel}」</span>
                <span>{evolutionStatusNote(step.status)}</span>
              </div>
            </div>
            <div className="ev-step-side">
              <span>问题 {step.issuesTotal}{step.issuesOpen > 0 ? ` · 待处理 ${step.issuesOpen}` : ''}</span>
              {step.qualityChecks > 0 && <span>复核 {step.qualityChecks}</span>}
              {step.ruleVersions.length > 0 && <span>规则 {step.ruleVersions.length}</span>}
            </div>
          </li>)}
        </ol>
      </section>

      <section className="ev-card" aria-labelledby="ev-issues-title">
        <div className="ev-card-head"><div><span>ISSUE LEDGER</span><h2 id="ev-issues-title">问题与处置台账</h2></div><ShieldCheck size={18} /></div>
        <p className="ev-card-intro">把所有运行的问题按类型归并：每种问题出现多少次、还剩多少待处理、最近一次说了什么。已解决的类型意味着对应的规则或实现已经升级。</p>
        {summary.issueGroups.length === 0
          ? <p className="ev-quiet">还没有记录到问题。</p>
          : <div className="ev-table-wrap"><table className="ev-table">
            <thead><tr><th>问题类型</th><th>次数</th><th>处置</th><th>最近一次</th><th>关联运行</th></tr></thead>
            <tbody>{summary.issueGroups.map(group => <tr key={group.code}>
              <td>
                <div className="ev-issue-name">
                  <span className={`ev-badge is-${severityTones[group.severity] ?? 'note'}`}>{severityLabels[group.severity] ?? group.severity}</span>
                  <div><code className="ev-issue-code">{group.code}</code><small>{group.title}{group.stages.length > 0 ? ` · ${group.stages.map(stageLabel).join(' / ')}` : ''}</small></div>
                </div>
              </td>
              <td className="ev-numeric">{group.count}</td>
              <td>{group.openCount > 0 ? <span className="ev-pending">待处理 {group.openCount}</span> : <span className="ev-ok"><Check size={11} /> 已消化</span>}</td>
              <td className="ev-message">{group.latestMessage || '—'}</td>
              <td className="ev-numeric">{group.runCount} 次</td>
            </tr>)}</tbody>
          </table></div>}
      </section>

      <section className="ev-card" aria-labelledby="ev-rules-title">
        <div className="ev-card-head"><div><span>RULES IN EFFECT</span><h2 id="ev-rules-title">生效规则与契约</h2></div><Sparkles size={18} /></div>
        <p className="ev-card-intro">当前运行所携带的规则版本。每次规则升级都会写入产物溯源，同一版本跨运行复用代表系统正在稳定地按新契约工作。</p>
        {summary.rules.length === 0
          ? <p className="ev-quiet">最近的运行还没有产出携带规则版本的产物；完成分镜或导演环节后会出现在这里。</p>
          : <ul className="ev-rules">
            {summary.rules.map(rule => <li key={rule.version}>
              <div><strong>{rule.version}</strong><small>{evolutionRuleKind(rule.version)}</small></div>
              <span>{rule.sampleStage}</span>
              <b>{rule.occurrences} 个产物 · {rule.runCount} 次运行</b>
            </li>)}
          </ul>}
      </section>

      <footer className="ev-foot">
        <p>以上全部条目来自本地后端的真实运行记录；没有运行时会如实留空。</p>
        {summary.activeRunId && <button onClick={() => go('automation')}>查看当前运行<ArrowUpRight size={13} /></button>}
      </footer>
    </>}
  </div>;
}
