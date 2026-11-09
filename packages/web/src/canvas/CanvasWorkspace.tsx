import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, BadgeCheck, CircleDollarSign, GitBranch, LoaderCircle, Network, RefreshCcw, ShieldCheck,
} from 'lucide-react';
import type {
  CanvasCommand, CanvasDocument, CanvasQuote, CanvasRevision, CanvasRuntimeView,
} from '@lyra/shared';
import {
  adoptCanvas, canvasRuntimeView, confirmBudgetAndCreateRun, createCanvas, getCanvas, listCanvases,
  requestCanvasQuote, submitCanvasCommands, validateCanvas,
} from './api';
import { layoutCanvas, summarizeDependencies, type CanvasNodeBox } from './view';
import './canvas.css';

function yuan(micros: number): string {
  return `¥${(micros / 1_000_000).toFixed(2)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}

export default function CanvasWorkspace({ projectId, notify, onOpenAssistant }: {
  projectId: string;
  notify: (text: string) => void;
  onOpenAssistant?: () => void;
}) {
  const [documents, setDocuments] = useState<CanvasDocument[]>([]);
  const [canvasId, setCanvasId] = useState('');
  const [document, setDocument] = useState<CanvasDocument | null>(null);
  const [revision, setRevision] = useState<CanvasRevision | null>(null);
  const [revisions, setRevisions] = useState<CanvasRevision[]>([]);
  const [runtime, setRuntime] = useState<CanvasRuntimeView | null>(null);
  const [quote, setQuote] = useState<CanvasQuote | null>(null);
  const [budgetMicros, setBudgetMicros] = useState('30');
  const [validation, setValidation] = useState<{ valid: boolean; errors: Array<{ code: string; message: string }> } | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const alive = useRef(true);

  // 前端不判断权限，只用后端返回的 403 告知；这里保留按钮以免隐藏“需要审批”的事实。
  const canApprove = true;

  const loadCanvas = useCallback(async (id: string) => {
    const loaded = await getCanvas(id);
    if (!alive.current) return;
    setDocument(loaded.document);
    setRevisions(loaded.revisions);
    setRevision(loaded.latest);
    setRuntime(null);
    setQuote(null);
    setValidation(null);
    if (loaded.latest) {
      const view = await canvasRuntimeView(id, loaded.latest.revision).catch(() => null);
      if (alive.current) setRuntime(view);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    (async () => {
      try {
        const list = await listCanvases(projectId);
        if (!alive.current) return;
        setDocuments(list);
        const first = list[0];
        if (first) { setCanvasId(first.id); await loadCanvas(first.id); }
      } catch (error) {
        if (alive.current) setMessage(errorText(error));
      }
    })();
    return () => { alive.current = false; };
  }, [projectId, loadCanvas]);

  useEffect(() => {
    if (!canvasId || !revision) return;
    const timer = setInterval(() => {
      canvasRuntimeView(canvasId, revision.revision).then(view => { if (alive.current) setRuntime(view); })
        .catch(() => { /* 运行覆盖失败不覆盖既有状态，也不伪造成功 */ });
    }, 12_000);
    return () => clearInterval(timer);
  }, [canvasId, revision]);

  const layout = useMemo(() => revision ? layoutCanvas(revision.graph, runtime) : null, [revision, runtime]);
  const selectedNode = layout?.nodes.find(node => node.id === selected) ?? null;
  const dependencies = useMemo(
    () => revision && selected ? summarizeDependencies(revision.graph, selected) : { upstream: [], downstream: [] },
    [revision, selected],
  );

  async function run<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
    setBusy(label); setMessage('');
    try { return await work(); }
    catch (error) { setMessage(errorText(error)); notify(errorText(error)); return undefined; }
    finally { if (alive.current) setBusy(''); }
  }

  async function createFromStoryboard() {
    const created = await run('create', async () => {
      const doc = await createCanvas(projectId, { from: 'storyboard', title: '主生产画布' });
      return doc;
    });
    if (!created) return;
    setDocuments(list => [created, ...list.filter(item => item.id !== created.id)]);
    setCanvasId(created.id); await loadCanvas(created.id);
    notify('已从已采用的分镜版本生成画布 Revision 1。');
  }

  async function moveNode(node: CanvasNodeBox, dx: number, dy: number) {
    if (!revision || busy) return;
    const command: CanvasCommand = {
      type: 'moveNodes', commandId: `cmd_${Date.now().toString(36)}`,
      positions: [{ nodeId: node.id, x: Math.max(0, node.x + dx), y: Math.max(0, node.y + dy) }],
    };
    const result = await run('move', () => submitCanvasCommands(canvasId, revision.revision,
      `canvas-move-${revision.revision}-${Date.now().toString(36)}`, [command]));
    if (result) { setRevision(result.revision); notify(`布局已提交为 Revision ${result.revision.revision}。`); }
  }

  async function validateNow() {
    if (!revision) return;
    const result = await run('validate', () => validateCanvas(canvasId, String(revision.revision)));
    if (result) setValidation(result);
  }

  async function adoptNow() {
    if (!revision) return;
    if (!window.confirm(`采用 Revision ${revision.revision}？采用后生产运行会以该版本为事实。`)) return;
    const adopted = await run('adopt', () => adoptCanvas(canvasId, revision.revision, revision.revision));
    if (adopted) { setRevision(adopted); setRevisions(list => [adopted, ...list.filter(item => item.id !== adopted.id)]);
      notify(`已采用 Revision ${adopted.revision}。`); }
  }

  async function quoteNow() {
    if (!revision) return;
    const yuanValue = Number(budgetMicros);
    if (!Number.isFinite(yuanValue) || yuanValue <= 0) { notify('请填写大于 0 的预算上限。'); return; }
    const created = await run('quote', () => requestCanvasQuote(canvasId, revision.revision,
      { budgetMicros: Math.round(yuanValue * 1_000_000), candidatePolicy: 'direct', candidateLimit: 1 }));
    if (created) { setQuote(created); notify(`已生成估价卡：系统预计 ${yuan(created.estimateCostMicros)}，预算上限 ${yuan(created.budgetMicros)}。`); }
  }

  async function confirmAndRun() {
    if (!revision || !quote) return;
    if (!canApprove) { notify('只有 owner 或 admin 可以确认付费生产。'); return; }
    if (!window.confirm(`确认按预算 ${yuan(quote.budgetMicros)} 提交生产？系统预计 ${yuan(quote.estimateCostMicros)}（区间 ${yuan(quote.estimateRange.lowMicros)}–${yuan(quote.estimateRange.highMicros)}）。`)) return;
    const created = await run('run', () => confirmBudgetAndCreateRun(canvasId, revision.revision, {
      quoteId: quote.id, clientRequestId: `canvas-run-${revision.revision}-${Date.now().toString(36)}`,
    }));
    if (created) { setQuote({ ...quote, status: 'confirmed' }); notify(`已创建生产运行 ${created.id}，状态将从后端运行事实同步。`); }
  }

  if (!documents.length) {
    return <section className="canvas-page canvas-empty">
      <div className="canvas-empty-card">
        <Network size={28} />
        <h2>生产画布</h2>
        <p>把已采用的分镜版本展开为镜头依赖图。画布只引用正式版本，布局与领域事实分开保存。</p>
        <button className="canvas-primary" onClick={createFromStoryboard} disabled={busy === 'create'}>
          {busy === 'create' ? <LoaderCircle size={16} className="spin" /> : <GitBranch size={16} />}
          从已采用分镜生成画布
        </button>
        <p className="canvas-hint">当前项目还没有生产画布。若分镜尚未采用，请先在分镜工作台完成采用。</p>
      </div>
      {message && <p className="canvas-alert"><AlertTriangle size={14} />{message}</p>}
    </section>;
  }

  return <section className="canvas-page">
    <header className="canvas-head">
      <div>
        <p className="canvas-eyebrow">PRODUCTION CANVAS</p>
        <h2>{document?.title ?? '生产画布'}</h2>
        <p className="canvas-sub">
          事实来自后端不可变 Revision{revision ? ` #${revision.revision}` : ''}；
          语义摘要 <code>{revision?.semanticGraphDigest.slice(0, 18)}…</code>；
          {revision?.status === 'adopted' ? ' 已采用' : ' 草稿'}。
        </p>
      </div>
      <div className="canvas-head-actions">
        <select aria-label="切换画布" value={canvasId} onChange={async event => {
          setCanvasId(event.target.value); await loadCanvas(event.target.value);
        }}>
          {documents.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <button onClick={() => revision && loadCanvas(canvasId)} disabled={!revision || Boolean(busy)}>
          <RefreshCcw size={15} />刷新
        </button>
        <button onClick={validateNow} disabled={!revision || Boolean(busy)}>
          <ShieldCheck size={15} />校验
        </button>
        {canApprove && <button onClick={adoptNow} disabled={!revision || Boolean(busy) || revision.status === 'adopted'}>
          <BadgeCheck size={15} />采用
        </button>}
        {onOpenAssistant && <button onClick={onOpenAssistant}><GitBranch size={15} />AI 侧栏（⌘J）</button>}
      </div>
    </header>

    {message && <p className="canvas-alert"><AlertTriangle size={14} />{message}</p>}
    {validation && <div className={`canvas-validation ${validation.valid ? 'ok' : 'bad'}`}>
      {validation.valid ? '校验通过' : `校验未通过（${validation.errors.length} 项）`}
      {validation.errors.slice(0, 3).map(issue => <span key={`${issue.code}-${issue.message}`}>{issue.code}: {issue.message}</span>)}
    </div>}

    <div className="canvas-body">
      <div className="canvas-stage" role="region" aria-label="镜头依赖画布">
        {layout && <svg viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height}>
          {layout.groups.map(group => <g key={group.id}>
            <rect x={group.x} y={group.y} width={group.width} height={group.height} rx={16} className="canvas-group" />
            <text x={group.x + 14} y={group.y + 22} className="canvas-group-label">{group.title}</text>
          </g>)}
          {layout.edges.map(edge => <g key={edge.id} className={`canvas-edge canvas-edge-${edge.edgeType}`}>
            <path d={`M ${edge.x1} ${edge.y1} C ${edge.x1 + 40} ${edge.y1}, ${edge.x2 - 40} ${edge.y2}, ${edge.x2} ${edge.y2}`} />
          </g>)}
          {layout.nodes.map(node => <g key={node.id}
            className={`canvas-node canvas-tone-${node.tone}${selected === node.id ? ' selected' : ''}`}
            transform={`translate(${node.x} ${node.y})`}
            role="button" tabIndex={0}
            onClick={() => setSelected(node.id)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(node.id); } }}
            aria-label={`${node.title}，${node.kindLabel}，${node.stateLabel}，按方向键微调布局`}>
            <rect width={node.width} height={node.height} rx={12} />
            <text x={14} y={24} className="canvas-node-kind">{node.kindLabel}</text>
            <text x={14} y={48} className="canvas-node-title">{node.title.length > 13 ? `${node.title.slice(0, 13)}…` : node.title}</text>
            <text x={14} y={68} className="canvas-node-sub">{node.subtitle}</text>
            <circle cx={node.width - 14} cy={14} r={5} className="canvas-state-dot" />
          </g>)}
        </svg>}
      </div>

      <aside className="canvas-inspector">
        <h3>节点与依赖</h3>
        {selectedNode ? <>
          <p className="canvas-selected-title">{selectedNode.title}</p>
          <dl>
            <dt>状态</dt><dd>{selectedNode.stateLabel}</dd>
            <dt>类型</dt><dd>{selectedNode.kindLabel}</dd>
            <dt>引用</dt><dd>{selectedNode.resourceType ?? '无'}</dd>
            <dt>上游</dt><dd>{dependencies.upstream.join('、') || '无'}</dd>
            <dt>下游</dt><dd>{dependencies.downstream.join('、') || '无'}</dd>
          </dl>
          <div className="canvas-move">
            <button onClick={() => moveNode(selectedNode, -24, 0)} disabled={Boolean(busy)}>←</button>
            <button onClick={() => moveNode(selectedNode, 0, -24)} disabled={Boolean(busy)}>↑</button>
            <button onClick={() => moveNode(selectedNode, 0, 24)} disabled={Boolean(busy)}>↓</button>
            <button onClick={() => moveNode(selectedNode, 24, 0)} disabled={Boolean(busy)}>→</button>
          </div>
          <p className="canvas-hint">移动会提交为后端新 Revision，不写本地 localStorage。</p>
        </> : <p className="canvas-hint">选择任一镜头节点查看依赖与运行状态。</p>}

        <div className="canvas-quote">
          <h3><CircleDollarSign size={16} />生成报价</h3>
          <p className="canvas-hint">预算上限由你填写；系统估价来自冻结价格表，两者分开显示。</p>
          <label>预算上限（元）
            <input value={budgetMicros} onChange={event => setBudgetMicros(event.target.value)} inputMode="decimal" />
          </label>
          <button onClick={quoteNow} disabled={!revision || Boolean(busy)}>生成估价卡</button>
          {quote && <div className="canvas-quote-card">
            <div className="quote-row"><span>系统预计</span><strong>{yuan(quote.estimateCostMicros)}</strong></div>
            <div className="quote-row"><span>区间</span><span>{yuan(quote.estimateRange.lowMicros)} – {yuan(quote.estimateRange.highMicros)}</span></div>
            <div className="quote-row"><span>预算上限</span><strong>{yuan(quote.budgetMicros)}</strong></div>
            <div className="quote-row"><span>价格版本</span><code>{quote.priceRevision}</code></div>
            <ul className="quote-assumptions">{quote.assumptions.map(item => <li key={item}>{item}</li>)}</ul>
            <button className="canvas-primary" onClick={confirmAndRun}
              disabled={quote.status !== 'pending' || Boolean(busy) || !canApprove}>
              {quote.status === 'pending' ? '确认预算并创建运行' : quote.status === 'confirmed' ? '已提交' : '估价已失效'}
            </button>
            <p className="canvas-hint">提交调用 POST /budget/confirm，后端会重新核验摘要、过期与预算。</p>
          </div>}
        </div>

        <div className="canvas-revisions">
          <h3>版本历史</h3>
          {revisions.slice(0, 6).map(item => <button key={item.id} className={item.id === revision?.id ? 'active' : ''}
            onClick={() => { setRevision(item); setQuote(null); setValidation(null); }}>
            #{item.revision} · {item.status} · {new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}
          </button>)}
        </div>
      </aside>
    </div>
    {busy && <p className="canvas-busy"><LoaderCircle size={14} className="spin" />{busy}…</p>}
  </section>;
}
