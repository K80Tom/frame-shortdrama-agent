import { useEffect, useState } from 'react';
import { fetchProjectAssetRequirements } from './project-workspace-api';
import type { ProjectAssetRequirementsResponse } from '@lyra/shared';
import './project-workspace.css';

const kindLabels = { character: '人物', location: '地点', prop: '道具' } as const;

export default function ProjectAssetsWorkspace({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ProjectAssetRequirementsResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let alive = true;
    fetchProjectAssetRequirements(projectId)
      .then(value => { if (alive) setData(value); })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : '读取资产需求失败。'); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [projectId]);

  if (busy) return <div className="project-flow-view"><p className="muted">正在读取资产需求…</p></div>;
  if (error) return <div className="project-flow-view"><p className="production-message" role="status">{error}</p></div>;
  if (!data) return null;

  return <div className="project-flow-view">
    <div className="project-flow-hero">
      <span className="project-kicker">ASSETS</span>
      <h2>资产需求</h2>
      <p>这里只展示已采用事实提出的资产需求与匹配结果；匹配规则在服务端执行，前端不打分、不猜选。写资产请进入资产库。</p>
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
      <h3>需求清单</h3>
      <table className="project-assets-table">
        <thead><tr><th>类型</th><th>名称</th><th>出现场次</th><th>匹配</th><th>操作</th></tr></thead>
        <tbody>
          {data.requirements.map(item => <tr key={item.requirementId}>
            <td>{kindLabels[item.kind]}</td>
            <td><strong>{item.name}</strong></td>
            <td><small>{item.sceneIds.length} 场</small></td>
            <td>{item.match.assetId
              ? <span className="asset-tag ok">已绑定 · {item.match.matchedBy}</span>
              : item.match.ambiguous
                ? <span className="asset-tag warn">{item.match.alternatives.length} 个同优先级候选</span>
                : <span className="asset-tag missing">未匹配</span>}</td>
            <td>{item.action.kind === 'none'
              ? <a className="text-button" href="#/assets">查看资产库</a>
              : item.action.kind === 'choose'
                ? <a className="text-button" href="#/assets">在候选中选择</a>
                : <a className="text-button" href="#/assets">新建资产</a>}</td>
          </tr>)}
        </tbody>
      </table>
    </section>}
  </div>;
}
