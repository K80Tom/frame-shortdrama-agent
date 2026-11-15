import { useEffect, useMemo, useState } from 'react';
import {
  adoptFactPlan, checkFactPlan, fetchProjectAssetRequirements, fetchProjectWorkspaceOverview, removeFactPlanEntities,
} from './project-workspace-api';
import { assetApi } from './asset-library';
import { autoRegisterCandidates, placeholderPngBase64, requirementAssetInput, unboundAssetRequirements, type AssetRequirement } from './asset-auto-register';
import type { ProjectAssetRequirementsResponse, AssetRecord } from '@lyra/shared';
import { assetProductionCreateBody, defaultProductionForm } from './production-automation';
import { fetchMediaModelConnections, MediaGenerationDialog, MediaRunNotice, useMediaProductionRun, type MediaModelConnections } from './media-generation';
import './project-workspace.css';

const kindLabels = { character: '人物', location: '地点', prop: '道具' } as const;

export default function ProjectAssetsWorkspace({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ProjectAssetRequirementsResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customized, setCustomized] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [message, setMessage] = useState('');
  const [scriptVersionId, setScriptVersionId] = useState('');
  const [models, setModels] = useState<MediaModelConnections | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const media = useMediaProductionRun(projectId, 'image');

  useEffect(() => {
    let alive = true;
    setCustomized(false);
    fetchProjectAssetRequirements(projectId)
      .then(value => { if (alive) setData(value); })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : '读取资产需求失败。'); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    void fetchProjectWorkspaceOverview(projectId).then(value => { if (alive) setScriptVersionId(value.facts?.scriptVersionId ?? ''); }).catch(() => undefined);
    void fetchMediaModelConnections().then(value => { if (alive) setModels(value); }).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId]);

  const generatedImageCount = media.run?.artifacts.filter(item => item.kind === 'image').length ?? 0;
  const generationStatus = media.run?.status ?? '';
  useEffect(() => {
    if (!media.run || (!generatedImageCount && generationStatus !== 'completed')) return;
    void fetchProjectAssetRequirements(projectId).then(setData).catch(() => undefined);
  }, [projectId, generatedImageCount, generationStatus]);

  const visibleRequirements = useMemo(() => unboundAssetRequirements(data?.requirements ?? []), [data]);
  const candidates = useMemo(() => autoRegisterCandidates(visibleRequirements), [visibleRequirements]);
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

  async function startGeneration(budgetYuan: number) {
    if (!scriptVersionId || !data?.planRevisionId || !candidates.length || data.summary.ambiguous > 0) return;
    const created = await media.start(clientRequestId => assetProductionCreateBody({
      ...defaultProductionForm, projectId, scriptVersionId, budgetYuan,
    }, clientRequestId));
    if (created) setGenerateOpen(false);
  }

  /** 保留原有占位登记作为无模型时的替代操作；真实图片统一走上方生产运行。 */
  async function register(items: AssetRequirement[]) {
    if (registering || removing || !items.length) return;
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

  async function removeRequirements(items: AssetRequirement[]) {
    const planRevisionId = data?.planRevisionId;
    if (removing || registering || !planRevisionId || !items.length) return;
    const names = items.map(item => item.name);
    const preview = names.slice(0, 8).join('、') + (names.length > 8 ? ` 等 ${names.length} 项` : '');
    if (!window.confirm(`将从新事实版本中移除 ${items.length} 项资产需求：${preview}。\n不会删除资产库记录，原事实版本也会保留。是否继续？`)) return;
    setRemoving(true); setMessage(''); setError('');
    let candidateCreated = false;
    try {
      const candidate = await removeFactPlanEntities(planRevisionId, planRevisionId,
        items.map(item => ({ kind: item.kind, entityId: item.requirementId })));
      candidateCreated = true;
      const { check, issues } = await checkFactPlan(candidate.id);
      if (check.result === 'failed' && !window.confirm(
        `移除后的新候选仍有 ${issues.length} 项完整性警告。只有接受这些警告才会替换当前正式需求；取消会保留候选和当前清单。是否接受并采用？`,
      )) {
        setMessage('移除候选已保存，但警告未确认，当前资产需求未改变。');
        return;
      }
      await adoptFactPlan(projectId, {
        planRevisionId: candidate.id, checkId: check.id, expectedActivePlanRevisionId: planRevisionId,
        allowCheckWarnings: check.result === 'failed',
      });
      await refresh();
      setCustomized(true); setSelected(new Set());
      setMessage(`已移除 ${items.length} 项资产需求。资产库记录和旧事实版本均未删除。`);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : '操作失败';
      setMessage(candidateCreated
        ? `移除候选已生成，但校验、采用或刷新失败：${detail}。当前正式清单可能尚未改变，请刷新核对，勿重复提交。`
        : `移除失败：${detail}`);
    } finally {
      setRemoving(false);
    }
  }

  const chosen = candidates.filter(item => selected.has(item.requirementId));
  const removalChosen = visibleRequirements.filter(item => selected.has(item.requirementId));

  return <div className="project-flow-view">
    <div className="project-flow-hero">
      <span className="project-kicker">ASSETS</span>
      <h2>资产需求</h2>
      <p>缺失的人物、地点与道具可直接 AI 生成，真实图片入库后会自动绑定到当前事实和后续分镜。旧自动占位图会作为待生成项原 ID 替换；已上传或已生成的正式图片不会覆盖。歧义候选仍需人工选择。</p>
    </div>

    <section className="project-overview-stats" aria-label="资产匹配摘要">
      <article><span>需求总数</span><strong>{data.summary.total}</strong><small>来自已采用事实</small></article>
      <article><span>已绑定</span><strong>{data.summary.matched}</strong><small>{data.ruleVersion}</small></article>
      <article><span>缺失</span><strong>{data.summary.missing}</strong><small>未匹配到资产</small></article>
      <article><span>歧义</span><strong>{data.summary.ambiguous}</strong><small>同优先级候选，需人工选择</small></article>
    </section>

    {media.run && <MediaRunNotice run={media.run} projectId={projectId}
      successText={`已生成并入库 ${generatedImageCount} 张图片；资产需求与分镜引用已刷新。`} />}
    {media.error && <p className="production-message" role="alert">{media.error}</p>}

    {!data.planRevisionId && <section className="project-flow-card">
      <p className="muted">当前还没有已采用的事实拆解。先在「剧本与事实」中采用一版拆解，这里会列出人物、地点与道具需求。</p>
    </section>}

    {data.planRevisionId && <section className="project-flow-card">
      <div className="project-flow-card-heading">
        <h3>需求清单</h3>
        {visibleRequirements.length > 0 && <div className="project-actions" data-testid="asset-register-actions">
          {candidates.length > 0 && <button className="button-primary" type="button" data-testid="asset-ai-generate"
            disabled={media.creating || data.summary.ambiguous > 0 || !scriptVersionId}
            onClick={() => setGenerateOpen(true)}>{media.creating ? '正在创建生成任务…' : `AI 生成缺失图片（${candidates.length}）`}</button>}
          <button className="button-secondary" type="button" disabled={registering || removing}
            onClick={() => { setCustomized(true); setSelected(new Set(visibleRequirements.map(item => item.requirementId))); }}>全选</button>
          <button className="button-secondary" type="button" disabled={registering || removing}
            onClick={() => { setCustomized(true); setSelected(new Set()); }}>全消</button>
          {candidates.length > 0 && <button className="button-secondary" type="button" disabled={registering || removing || !chosen.length}
            onClick={() => void register(chosen)}>
            {registering ? '正在写入资产库…' : `占位登记（${chosen.length}）`}
          </button>}
          <button className="button-secondary" type="button" data-testid="asset-requirement-remove"
            disabled={registering || removing || !removalChosen.length} onClick={() => void removeRequirements(removalChosen)}>
            {removing ? '正在生成移除版本…' : `删除勾选需求（${removalChosen.length}）`}
          </button>
        </div>}
      </div>
      {message && <p className="muted" role="status" data-testid="asset-register-message">{message}</p>}
      {!visibleRequirements.length && <p className="muted" role="status">当前没有未绑定资产的需求；已绑定资产不会显示在这里。</p>}
      {visibleRequirements.length > 0 && <table className="project-assets-table">
        <thead><tr><th aria-label="选择" /><th>类型</th><th>名称</th><th>出现场次</th><th>匹配</th><th>操作</th></tr></thead>
        <tbody>
          {visibleRequirements.map(item => {
            return <tr key={item.requirementId}>
              <td><input type="checkbox" checked={selected.has(item.requirementId)} disabled={registering || removing}
                aria-label={`选择${kindLabels[item.kind]} ${item.name}`} onChange={() => toggle(item.requirementId)} /></td>
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
                  : <button className="text-button" type="button" disabled={registering || removing}
                    onClick={() => void register([item])}>占位登记</button>}</td>
            </tr>;
          })}
        </tbody>
      </table>}
    </section>}

    <MediaGenerationDialog open={generateOpen} kind="image" title="生成缺失资产图片"
      description="按当前已采用事实逐项生成真实图片，完成后自动进入资产库并绑定；不会重新拆解剧本、生成分镜或启动视频。"
      facts={[{ label: '本次范围', value: `${candidates.length} 项无歧义缺失资产` },
        { label: '已有资产', value: '自动复用，不重复生成' },
        { label: '当前模型', value: models?.image.configured ? models.image.model : '尚未配置' }]}
      model={models?.image ?? null} busy={media.creating} onClose={() => setGenerateOpen(false)} onConfirm={budgetYuan => void startGeneration(budgetYuan)} />
  </div>;
}
