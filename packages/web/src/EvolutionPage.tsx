import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, ArrowUpRight, Check, CircleDot, Database, Gavel, GitBranch, LoaderCircle, Play,
  RefreshCw, RotateCcw, ShieldCheck, Sparkles, TrendingUp, Wrench,
} from 'lucide-react';
import type { AssetEvolutionSummary } from '@lyra/shared';
import {
  mergeProductionRuns, parseProductionRuns, parseProjectOptions, productionApi, type ProjectOption, type ProductionRun,
} from './production-automation';
import { buildEvolutionSummary, evolutionRuleKind, evolutionStatusNote } from './evolution';
import { canRollbackAssetRegistry, latestAssetProbe, parseAssetEvolutionSummary, shortDigest } from './asset-evolution';
import type { Page } from './model';
import './evolution.css';

const statusLabels: Record<string, string> = { queued: '准备中', running: '制作中', waitingHuman: '等待处理', paused: '已暂停', pausedBudget: '预算已暂停', reconciling: '正在对账', completed: '已完成', partial: '部分完成', failed: '未完成', cancelled: '已取消' };
const statusTones: Record<string, string> = { running: 'live', waitingHuman: 'attention', paused: 'attention', pausedBudget: 'attention', reconciling: 'live', completed: 'done', partial: 'done', queued: 'idle', failed: 'idle', cancelled: 'idle' };
const severityLabels: Record<string, string> = { error: '阻断', warning: '注意', info: '提示' };
const severityTones: Record<string, string> = { error: 'block', warning: 'warn', info: 'note' };
const terminalRuns = new Set(['completed', 'partial', 'failed', 'cancelled']);
const candidateStatusLabels: Record<string, string> = { draft: '待回放', probed: '回放通过', failed: '回放未通过', adopted: '已采用', rolledBack: '已退出' };
const proposalKindLabels: Record<string, string> = { asset_retrieval_policy: '检索策略', asset_metadata: '资产元数据', media_runtime: '媒体运行时', budget_operations: '预算运营', story_contract: '剧本契约', manual_review: '人工复核' };

function dateText(value: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未记录';
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
const stageLabelMap: Record<string, string> = { prepare: '生产预检', breakdown: '剧本拆解', assets: '资产准备', storyboard: '分镜设计', director: '3D 预演', video: '镜头视频生成', candidates: '候选选择', review: '技术复核', compose: '成片合成', deliver: '最终出片', plan: '拆解方案' };
function stageLabel(stage: string) { return stageLabelMap[stage] ?? stage; }
function errorText(error: unknown) { return error instanceof Error && error.name !== 'AbortError' ? error.message : '本地后端连接超时，请稍后重试。'; }
function delta(value: number) { return value > 0 ? `+${value}` : `${value}`; }

export default function EvolutionPage({ go }: { go: (page: Page, step?: number) => void }) {
  const [runs, setRuns] = useState<ProductionRun[] | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [assetEvolution, setAssetEvolution] = useState<AssetEvolutionSummary | null>(null);
  const [error, setError] = useState('');
  const [governanceError, setGovernanceError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [reason, setReason] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError(''); setGovernanceError('');
    try {
      const [runsData, projectsData] = await Promise.all([
        productionApi('/api/production-runs', undefined, signal),
        productionApi('/api/projects', undefined, signal).catch(() => null),
        productionApi('/api/evolution/assets', undefined, signal)
          .then(data => setAssetEvolution(parseAssetEvolutionSummary(data)))
          .catch(cause => { if (!signal?.aborted) setGovernanceError(errorText(cause)); }),
      ]);
      const parsed = parseProductionRuns(runsData);
      setRuns(previous => (previous ? mergeProductionRuns(previous, parsed) : parsed));
      if (projectsData) setProjects(parseProjectOptions(projectsData));
    } catch (cause) { setError(errorText(cause)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController(); load(controller.signal); return () => controller.abort();
  }, [load]);

  const summary = useMemo(() => (runs ? buildEvolutionSummary(runs, projects) : null), [runs, projects]);
  const evidenceRunIds = useMemo(() => new Set(assetEvolution?.evidence.map(item => item.runId) ?? []), [assetEvolution]);

  async function operate(key: string, path: string, body: unknown = {}) {
    setPending(key); setGovernanceError('');
    try { await productionApi(path, body); await load(); }
    catch (cause) { setGovernanceError(errorText(cause)); }
    finally { setPending(''); }
  }
  function adopt(candidateId: string) {
    if (!assetEvolution || !reason.trim()) { setGovernanceError('采用前请填写人工原因。'); return; }
    void operate(`adopt:${candidateId}`, `/api/evolution/assets/candidates/${candidateId}/adopt`,
      { expectedPolicyDigest: assetEvolution.registry.policy.policyDigest, reason: reason.trim() });
  }
  function rollback() {
    if (!assetEvolution || !reason.trim()) { setGovernanceError('回滚前请填写人工原因。'); return; }
    void operate('rollback', '/api/evolution/assets/registry/rollback',
      { expectedPolicyDigest: assetEvolution.registry.policy.policyDigest, reason: reason.trim() });
  }

  return <div className="ev-page">
    <header className="ev-page-head">
      <div>
        <span className="ev-kicker">SYSTEM EVOLUTION</span>
        <h1>自进化</h1>
        <p>从真实运行形成证据，经确定性提案、固定离线回放和人工采用，让下一次运行使用经过验证的新策略。</p>
      </div>
      <button className="ev-refresh" onClick={() => load()} disabled={loading}>
        {loading ? <LoaderCircle size={14} className="ev-spin" /> : <RefreshCw size={14} />}<span>刷新数据</span>
      </button>
    </header>

    {error && <section className="ev-error" role="alert"><AlertCircle size={16} /><p>{error}</p><button onClick={() => load()}>重试</button></section>}
    {!summary && !error && <section className="ev-empty"><LoaderCircle size={18} className="ev-spin" /><p>正在读取本地运行记录…</p></section>}
    {summary && <>
      <section className="ev-loop" aria-label="自进化闭环">
        <div className="ev-loop-node"><span className="ev-loop-icon"><CircleDot size={15} /></span><div><strong>运行发现问题</strong><small>真实问题进入台账</small></div><b>{summary.loop.discovered}</b></div><span className="ev-loop-arrow" />
        <div className="ev-loop-node"><span className="ev-loop-icon"><Gavel size={15} /></span><div><strong>人工裁决</strong><small>检查点与采用由你拍板</small></div><b>{summary.loop.adjudicated}</b></div><span className="ev-loop-arrow" />
        <div className="ev-loop-node"><span className="ev-loop-icon"><Wrench size={15} /></span><div><strong>证据与修复</strong><small>区分处置、验证和质量</small></div><b>{summary.loop.resolved}</b></div><span className="ev-loop-arrow" />
        <div className="ev-loop-node is-goal"><span className="ev-loop-icon"><TrendingUp size={15} /></span><div><strong>运行推进记录</strong><small>推进更深不等于质量提升</small></div><b>{summary.loop.furthestTotal > 0 ? Math.round((summary.loop.furthestTasks / summary.loop.furthestTotal) * 100) : 0}%</b></div>
      </section>

      <section className="ev-stats" aria-label="进化总览">
        <div className="ev-stat"><span>PRODUCTION RUNS</span><strong>{summary.runsTotal}</strong><small>累计制作运行</small></div>
        <div className="ev-stat"><span>ISSUES SEEN</span><strong>{summary.issuesTotal}</strong><small>问题累计发现 · 待处理 {summary.issuesOpen}</small></div>
        <div className="ev-stat"><span>RESOLVED</span><strong>{summary.resolvedRate}%</strong><small>问题处置率（含预算挡停）</small></div>
        <div className="ev-stat"><span>QUALITY GATES</span><strong>{summary.qualityChecksTotal}</strong><small>技术复核执行 · 通过 {summary.qualityPassRate}%</small></div>
        <div className="ev-stat"><span>RULES ACTIVE</span><strong>{summary.rules.length}</strong><small>运行中生效的规则版本</small></div>
      </section>

      <section className="ev-card ev-governance" aria-labelledby="ev-governance-title">
        <div className="ev-card-head"><div><span>ASSET RAG · P1 + P2</span><h2 id="ev-governance-title">资产检索策略治理</h2></div><GitBranch size={18} /></div>
        <p className="ev-card-intro">终态 Evidence → 确定性 Proposal → 策略候选 → 固定离线 Probe → 人工采用/回滚。全流程不调用真实模型，不修改资产目录，也不自动重建 Milvus。</p>
        {governanceError && <div className="ev-inline-error" role="alert"><AlertCircle size={14} />{governanceError}</div>}
        {!assetEvolution && !governanceError && <p className="ev-quiet">正在读取资产治理数据…</p>}
        {assetEvolution && <>
          <div className="ev-registry">
            <div><span>当前 Registry</span><strong>revision {assetEvolution.registry.revision}</strong><small>{assetEvolution.registry.policy.schemaVersion} · {shortDigest(assetEvolution.registry.policy.policyDigest)}</small></div>
            <dl><div><dt>自动复用阈值</dt><dd>{assetEvolution.registry.policy.threshold}</dd></div><div><dt>歧义 margin</dt><dd>{assetEvolution.registry.policy.ambiguityMargin}</dd></div><div><dt>语义权重</dt><dd>{assetEvolution.registry.policy.semanticWeight}</dd></div></dl>
            <div className="ev-registry-action"><label>人工原因<input value={reason} onChange={event => setReason(event.target.value)} maxLength={500} placeholder="采用或回滚前填写原因" /></label>
              <button className="ev-action" disabled={!canRollbackAssetRegistry(assetEvolution) || pending !== ''} onClick={rollback}><RotateCcw size={12} />{pending === 'rollback' ? '回滚中…' : '回滚上一采用'}</button>
            </div>
          </div>

          <div className="ev-governance-grid">
            <section><div className="ev-subhead"><h3>不可变证据</h3><span>{assetEvolution.evidence.length}</span></div>
              {assetEvolution.evidence.length === 0 ? <p className="ev-quiet">在下方终态运行点击“生成证据”。</p> : <ul className="ev-compact-list">{assetEvolution.evidence.slice(0, 6).map(item => <li key={item.id}><div><strong>{item.runId.slice(-10)}</strong><small>{dateText(item.createdAt)} · 最终开放问题 {item.openIssues.length}</small></div><span>{item.terminalStatus}</span></li>)}</ul>}
            </section>
            <section><div className="ev-subhead"><h3>确定性提案</h3><span>{assetEvolution.proposals.length}</span></div>
              {assetEvolution.proposals.length === 0 ? <p className="ev-quiet">最终开放问题会按稳定签名在这里去重。</p> : <ul className="ev-proposal-list">{assetEvolution.proposals.slice(0, 8).map(item => <li key={item.id}><span className="ev-badge is-note">{proposalKindLabels[item.kind] ?? item.kind}</span><strong>{item.title}</strong><small>{item.summary}</small><div><span>证据 {item.evidenceIds.length} · 运行 {item.sourceRunIds.length}</span>{item.candidateEnabled && <button className="ev-action" disabled={pending !== ''} onClick={() => void operate(`candidate:${item.id}`, `/api/evolution/assets/proposals/${item.id}/candidates`)}>{pending === `candidate:${item.id}` ? '创建中…' : '创建候选'}</button>}</div></li>)}</ul>}
            </section>
            <section><div className="ev-subhead"><h3>候选与离线回放</h3><span>{assetEvolution.candidates.length}</span></div>
              {assetEvolution.candidates.length === 0 ? <p className="ev-quiet">候选只版本化阈值、margin 和语义权重。</p> : <ul className="ev-candidate-list">{assetEvolution.candidates.slice(0, 8).map(item => {
                const probe = latestAssetProbe(assetEvolution, item.id); const active = assetEvolution.registry.policy.sourceCandidateId === item.id;
                const adoptable = probe?.verdict === 'pass' && item.basePolicyDigest === assetEvolution.registry.policy.policyDigest && !active;
                return <li key={item.id}><div className="ev-candidate-title"><strong>{item.id.slice(-10)}</strong><span className={`ev-badge ${active ? 'is-done' : probe?.verdict === 'fail' ? 'is-warn' : 'is-note'}`}>{active ? '当前生效' : candidateStatusLabels[item.status]}</span></div>
                  <small>阈值 {item.policy.threshold} · margin {item.policy.ambiguityMargin} · 语义 {item.policy.semanticWeight}</small>
                  {probe && <div className="ev-probe"><span>误复用 {delta(probe.gate.falseReuseDelta)} · 安全阻断 {delta(probe.gate.safetyBlockDelta)} · 正确复用 {delta(probe.gate.correctReuseDelta)}</span><span>契约失败 {probe.candidateMetrics.contractFailures} · embedding 成本 {delta(probe.gate.embeddingCostDeltaMicros)} · modelCalls 0</span><small>{probe.verdict === 'pass' ? '固定离线契约通过，不代表视觉或创作质量提升。' : '候选未通过，不允许采用。'}</small></div>}
                  <div className="ev-candidate-actions"><button className="ev-action" disabled={pending !== ''} onClick={() => void operate(`probe:${item.id}`, `/api/evolution/assets/candidates/${item.id}/probes`)}><Play size={11} />{pending === `probe:${item.id}` ? '回放中…' : '离线回放'}</button>{adoptable && <button className="ev-action is-primary" disabled={pending !== '' || !reason.trim()} onClick={() => adopt(item.id)}><Check size={11} />{pending === `adopt:${item.id}` ? '采用中…' : '人工采用'}</button>}</div>
                </li>;
              })}</ul>}
            </section>
          </div>
          {assetEvolution.registryEvents.length > 0 && <div className="ev-registry-history">{assetEvolution.registryEvents.slice(-4).reverse().map(event => <span key={event.id}>r{event.revision} · {event.action === 'adopt' ? '采用' : '回滚'} · {shortDigest(event.toPolicyDigest)} · {event.reason}</span>)}</div>}
        </>}
      </section>

      <section className="ev-card" aria-labelledby="ev-ladder-title">
        <div className="ev-card-head"><div><span>RUN LADDER</span><h2 id="ev-ladder-title">运行阶梯</h2></div><TrendingUp size={18} /></div>
        <p className="ev-card-intro">按时间记录实际推进深度；它只说明运行走到了哪里，不证明创作质量提升。终态运行可生成不可变证据。</p>
        <ol className="ev-ladder">{summary.steps.map(step => <li key={step.runId} className={`ev-step ${step.breakthrough ? 'is-breakthrough' : ''}`}>
          <span className="ev-step-index">#{step.index}</span><div className="ev-step-main"><div className="ev-step-top"><strong>{step.title}</strong><span className={`ev-badge is-${statusTones[step.status] ?? 'idle'}`}>{statusLabels[step.status] ?? step.status}</span>{step.breakthrough && <span className="ev-badge is-up"><TrendingUp size={11} /> 推进</span>}</div><div className="ev-step-progress"><i style={{ width: `${Math.min(100, step.progressPct)}%` }} /></div><div className="ev-step-meta"><span>{dateText(step.createdAt)}</span><span>节点 {step.tasksCompleted}/{step.tasksTotal}</span><span>推进至「{step.furthestStageLabel}」</span><span>{evolutionStatusNote(step.status)}</span></div></div>
          <div className="ev-step-side"><span>问题 {step.issuesTotal}{step.issuesOpen > 0 ? ` · 待处理 ${step.issuesOpen}` : ''}</span>{step.qualityChecks > 0 && <span>复核 {step.qualityChecks}</span>}{terminalRuns.has(step.status) && <button className="ev-action" disabled={pending !== '' || evidenceRunIds.has(step.runId)} onClick={() => void operate(`evidence:${step.runId}`, `/api/evolution/assets/evidence/${step.runId}`)}><Database size={11} />{pending === `evidence:${step.runId}` ? '生成中…' : evidenceRunIds.has(step.runId) ? '已生成证据' : '生成证据'}</button>}</div>
        </li>)}</ol>
      </section>

      <section className="ev-card" aria-labelledby="ev-issues-title">
        <div className="ev-card-head"><div><span>ISSUE LEDGER</span><h2 id="ev-issues-title">问题与处置台账</h2></div><ShieldCheck size={18} /></div>
        <p className="ev-card-intro">按类型归并真实问题；预算挡停、运行时失败和技术复核不混作创作质量指标。</p>
        {summary.issueGroups.length === 0 ? <p className="ev-quiet">还没有记录到问题。</p> : <div className="ev-table-wrap"><table className="ev-table"><thead><tr><th>问题类型</th><th>次数</th><th>处置</th><th>最近一次</th><th>关联运行</th></tr></thead><tbody>{summary.issueGroups.map(group => <tr key={group.code}><td><div className="ev-issue-name"><span className={`ev-badge is-${severityTones[group.severity] ?? 'note'}`}>{severityLabels[group.severity] ?? group.severity}</span><div><code className="ev-issue-code">{group.code}</code><small>{group.title}{group.stages.length > 0 ? ` · ${group.stages.map(stageLabel).join(' / ')}` : ''}</small></div></div></td><td className="ev-numeric">{group.count}</td><td>{group.openCount > 0 ? <span className="ev-pending">待处理 {group.openCount}</span> : <span className="ev-ok"><Check size={11} /> 已消化</span>}</td><td className="ev-message">{group.latestMessage || '—'}</td><td className="ev-numeric">{group.runCount}</td></tr>)}</tbody></table></div>}
      </section>

      <section className="ev-card" aria-labelledby="ev-rules-title">
        <div className="ev-card-head"><div><span>RULES IN EFFECT</span><h2 id="ev-rules-title">生效规则与契约</h2></div><Sparkles size={18} /></div>
        <p className="ev-card-intro">规则版本来自质量检查与产物溯源；资产检索当前版本由上方 Registry 单独治理。</p>
        {summary.rules.length === 0 ? <p className="ev-quiet">最近的运行还没有带规则版本的检查或产物。</p> : <ul className="ev-rules">{summary.rules.map(rule => <li key={rule.version}><div><strong>{rule.version}</strong><small>{evolutionRuleKind(rule.version)}</small></div><span>{rule.sampleStage}</span><b>{rule.occurrences} 条记录 · {rule.runCount} 次运行</b></li>)}</ul>}
      </section>

      <footer className="ev-foot"><p>数据来自本地后端；离线回放不会触发真实模型或付费生成。</p>{summary.activeRunId && <button onClick={() => go('automation')}>查看当前运行<ArrowUpRight size={13} /></button>}</footer>
    </>}
  </div>;
}
