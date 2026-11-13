import { useEffect, useMemo, useState } from 'react';
import { fetchProjectAssetRequirements } from './project-workspace-api';
import { assetApi } from './asset-library';
import { autoRegisterCandidates, placeholderPngBase64, requirementAssetInput, type AssetRequirement } from './asset-auto-register';
import type { ProjectAssetRequirementsResponse, AssetRecord } from '@lyra/shared';
import './project-workspace.css';

const kindLabels = { character: '人物', location: '地点', prop: '道具' } as const;

export default function ProjectAssetsWorkspace({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ProjectAssetRequirementsResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customized, setCustomized] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let alive = true;
    setCustomized(false);
    fetchProjectAssetRequirements(projectId)
      .then(value => { if (alive) setData(value); })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : '读取资产需求失败。'); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [projectId]);

  const candidates = useMemo(() => autoRegisterCandidates(data?.requirements ?? []), [data]);
  useEffect(() => {
    if (!customized) setSelected(new Set(candidates.map(item => item.requirementId)));
  }, [candidates, customized]);

  if (busy) return <div className="project-flow-view"><p className="muted">正在读取资产需求…</p></div>;
  if (error) return <div className="project-flow-view"><p className="production-message" role="status">{error}</p></div>;
  if (!data) return null;

  function toggle(id: string) {
    setCustomized(true);
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function refresh() {
    const value = await fetchProjectAssetRequirements(projectId);
    setData(value);
  }

  /** 不再跳手动表单：按需求自动生成占位资产并写入资产库，服务端按名称自动匹配绑定。 */
  async function register(items: AssetRequirement[]) {
    if (registering || !items.length) return;
    setRegistering(true); setMessage(''); setError('');
    const failed: string[] = [];
    let saved = 0;
    for (const item of items) {
      try {
        await assetApi<AssetRecord>('/api/assets/import', {
          ...requirementAssetInput(item), contentBase64: placeholderPngBase64(item),
        });
        saved += 1;
      } catch (reason) {
        failed.push(`${item.name}（${reason instanceof Error ? reason.message : '写入失败'}）`);
      }
    }
    try { await refresh(); } catch { /* 列表稍后手动刷新 */ }
    setRegistering(false);
    setMessage(`已把 ${saved} 项需求写入资产库并自动匹配${failed.length ? `；${failed.length} 项失败：${failed.join('、')}` : '。占位图可在资产库随时替换为正式素材。'}`);
  }

  const chosen = candidates.filter(item => selected.has(item.requirementId));

  return <div className="project-flow-view">
    <div className="project-flow-hero">
      <span className="project-kicker">ASSETS</span>
      <h2>资产需求</h2>
      <p>这里只展示已采用事实提出的资产需求与匹配结果；匹配规则在服务端执行，前端不打分、不猜选。勾选需求即可一键进入资产库，无需逐项手动填表。</p>
    </div>

    <section className="project-overview-stats" aria-label="资产匹配摘要">
      <article><span>需求总数</span><strong>{data.summary.total}</strong><small>来自已采用事实</small></article>
      <article><span>已绑定</span><strong>{data.summary.matched}</strong><small>{data.ruleVersion}</small></article>
      <article><span>缺失</span><strong>{data.summary.missing}</strong><small>未匹配到资产</small></article>
      <article><span>歧义</span><strong>{data.summary.ambiguous}</strong><small>同优先级候选，需人工选择</small></article>
    </section>

    {!data.planRevisionId && <section className="project-flow-card">
      <p className="muted">当前还没有已采用的事实拆解。先在「剧本与事实」中采用一版拆解，这里会列出人物、地点与道具需求。</p>
    </section>}

    {data.planRevisionId && <section className="project-flow-card">
      <div className="project-flow-card-heading">
        <h3>需求清单</h3>
        {candidates.length > 0 && <div className="project-actions" data-testid="asset-register-actions">
          <button className="button-secondary" type="button" disabled={registering}
            onClick={() => { setCustomized(true); setSelected(new Set(candidates.map(item => item.requirementId))); }}>全选</button>
          <button className="button-secondary" type="button" disabled={registering}
            onClick={() => { setCustomized(true); setSelected(new Set()); }}>全消</button>
          <button className="button-primary" type="button" disabled={registering || !chosen.length}
            onClick={() => void register(chosen)}>
            {registering ? '正在写入资产库…' : `勾选进入资产库（${chosen.length}）`}
          </button>
        </div>}
      </div>
      {message && <p className="muted" role="status" data-testid="asset-register-message">{message}</p>}
      <table className="project-assets-table">
        <thead><tr><th aria-label="选择" /><th>类型</th><th>名称</th><th>出现场次</th><th>匹配</th><th>操作</th></tr></thead>
        <tbody>
          {data.requirements.map(item => {
            const selectable = candidates.some(candidate => candidate.requirementId === item.requirementId);
            return <tr key={item.requirementId}>
              <td>{selectable && <input type="checkbox" checked={selected.has(item.requirementId)} disabled={registering}
                aria-label={`选择${kindLabels[item.kind]} ${item.name}`} onChange={() => toggle(item.requirementId)} />}</td>
              <td>{kindLabels[item.kind]}</td>
              <td><strong>{item.name}</strong></td>
              <td><small>{item.sceneIds.length} 场</small></td>
              <td>{item.match.assetId
                ? <span className="asset-tag ok">已绑定 · {item.match.matchedBy}</span>
                : item.match.ambiguous
                  ? <span className="asset-tag warn">{item.match.alternatives.length} 个同优先级候选</span>
                  : <span className="asset-tag missing">未匹配</span>}</td>
              <td>{item.match.assetId
                ? <a className="text-button" href="#/assets">查看资产库</a>
                : item.action.kind === 'choose'
                  ? <a className="text-button" href="#/assets">在候选中选择</a>
                  : <button className="text-button" type="button" disabled={registering}
                    onClick={() => void register([item])}>加入资产库</button>}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </section>}
  </div>;
}
