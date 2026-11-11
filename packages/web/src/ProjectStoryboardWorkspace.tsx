import { useEffect, useRef, useState } from 'react';
import { ArrowRight, PencilLine, Play } from 'lucide-react';
import { workspaceFetch } from './deployment';
import { projectFlowHash } from './project-flow';
import './project-workspace.css';

type Project = { id: string; currentScriptVersionId: string | null; activePlanRevisionId: string | null; activeStoryboardRevisionId: string | null };
type Ref = { scriptVersionId: string; quote: string };
type StoryboardShot = { id: string; sceneId: string; order: number;
  design: { visualDescription: string; shotSize: string; cameraMovement: string; durationMs: number }; sourceRefs: Ref[] };
type Storyboard = { id: string; projectId: string; scriptVersionId: string; sourcePlanRevisionId: string; shots: StoryboardShot[]; createdAt: string };
type ModelCatalog = { configured: boolean; defaultModel: string; connectionRevision?: string };

/** 版本分类纯逻辑：已采用/候选/来自旧事实。 */
export function classifyStoryboards(boards: Storyboard[], activeStoryboardRevisionId: string | null, activePlanRevisionId: string | null) {
  return boards.map(board => ({
    board,
    adopted: board.id === activeStoryboardRevisionId,
    stale: board.id !== activeStoryboardRevisionId && activePlanRevisionId !== null && board.sourcePlanRevisionId !== activePlanRevisionId,
  }));
}

/** 采用冲突（409）纯判定：由 api() 打上 status 标记。 */
export function isConflictError(reason: unknown): boolean {
  return Boolean(reason && typeof reason === 'object' && (reason as { status?: number }).status === 409);
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await workspaceFetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${data?.error?.message ?? `请求失败（${response.status}）`}${response.status === 409 ? ' 版本已变化，请刷新后核对。' : ''}`);
    (error as { status?: number }).status = response.status;
    throw error;
  }
  return data as T;
}

export default function ProjectStoryboardWorkspace({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [boards, setBoards] = useState<Storyboard[]>([]);
  const [board, setBoard] = useState<Storyboard | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [allowPaid, setAllowPaid] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const epoch = useRef(0);

  async function reload() {
    const [selected, listed] = await Promise.all([
      api<Project>(`/api/projects/${projectId}`),
      api<{ items: Storyboard[] }>(`/api/projects/${projectId}/storyboards`),
    ]);
    setProject(selected);
    setBoards(listed.items);
    setBoard(current => current && listed.items.some(item => item.id === current.id) ? current : listed.items[0] ?? null);
  }

  useEffect(() => {
    epoch.current += 1;
    const my = epoch.current;
    setBusy('读取');
    void (async () => {
      try {
        await Promise.all([api<ModelCatalog>('/api/models?role=general').then(setCatalog), reload()]);
      } catch (reason) {
        if (epoch.current === my) setMessage(reason instanceof Error ? reason.message : '读取分镜失败。');
      } finally {
        if (epoch.current === my) setBusy('');
      }
    })();
    return () => { epoch.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function mutate(name: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(name); setMessage('');
    try { await work(); }
    catch (reason) {
      // 冲突只刷新服务端真值，不覆盖他人选择。
      if (isConflictError(reason)) { try { await reload(); } catch { /* 刷新失败只保留提示 */ } }
      setMessage(reason instanceof Error ? reason.message : '操作失败。');
    }
    finally { setBusy(''); }
  }

  const rows = classifyStoryboards(boards, project?.activeStoryboardRevisionId ?? null, project?.activePlanRevisionId ?? null);
  const adopted = Boolean(project && board && project.activeStoryboardRevisionId === board.id);
  const boardStale = Boolean(project && board && board.sourcePlanRevisionId !== project.activePlanRevisionId);

  return <div className="project-flow-view">
    <div className="project-flow-hero">
      <span className="project-kicker">STORYBOARD</span>
      <h2>正式分镜</h2>
      <p>候选只从已采用事实生成；生成与采用都需要人工确认。旧事实产生的候选不能直接采用。</p>
    </div>

    <section className="project-flow-card">
      <h3>生成候选</h3>
      <p className="muted">{catalog?.configured ? `通用模型：${catalog.defaultModel}` : '通用模型未配置，暂不能生成；现有候选仍可查看核对。'}</p>
      <label className="production-consent"><input type="checkbox" checked={allowPaid} disabled={!!busy || !catalog?.configured}
        onChange={event => setAllowPaid(event.target.checked)} />我确认此次分镜生成调用通用模型，可能产生费用</label>
      <button className="production-primary" disabled={!!busy || !catalog?.configured || !allowPaid || !project?.activePlanRevisionId}
        onClick={() => void mutate('生成分镜', async () => {
          const generated = await api<Storyboard>(`/api/projects/${projectId}/storyboards`,
            { allowPaid: true, expectedModelConnectionRevision: catalog?.connectionRevision });
          setAllowPaid(false);
          await reload();
          setBoard(generated);
          setMessage('候选已生成，请核对镜头与原文证据。');
        })}><Play size={14} />{busy === '生成分镜' ? '正在生成…' : '生成候选分镜'}</button>
    </section>

    <section className="project-flow-card">
      <div className="project-flow-head"><h3>候选版本</h3>
        <a className="text-button" href="#/storyboard">本地练习页</a></div>
      {boards.length === 0 && <p className="muted">还没有候选分镜。生成后会先在这里核对，再决定是否采用。</p>}
      {boards.length > 0 && <select aria-label="分镜版本" value={board?.id ?? ''} disabled={!!busy}
        onChange={event => setBoard(boards.find(item => item.id === event.target.value) ?? null)}>
        {rows.map(({ board: item, adopted: isAdopted, stale }) => <option key={item.id} value={item.id}>
          {isAdopted ? '已采用' : stale ? '候选 · 来自旧事实' : '候选'} · {new Date(item.createdAt).toLocaleString('zh-CN')} · {item.id.slice(-8)}
        </option>)}
      </select>}
      {board && <>
        <p className="project-flow-status">{adopted ? '已采用' : '候选版本'} · {board.shots.length} 个连续镜头
          {boardStale ? ' · 来自旧拆解，不能作为当前版本采用' : ''}</p>
        <div className="production-shot-list">
          {board.shots.map(shot => <article key={shot.id}>
            <div><strong>镜头 {shot.order}</strong><small>景别 {shot.design.shotSize} · 运镜 {shot.design.cameraMovement} · {(shot.design.durationMs / 1000).toFixed(1)} 秒</small></div>
            <p>{shot.design.visualDescription}</p>
            <blockquote>原文：{shot.sourceRefs.map(ref => ref.quote).join(' / ')}</blockquote>
          </article>)}
        </div>
        <div className="project-flow-row">
          <button className="production-primary" disabled={!!busy || adopted || boardStale}
            onClick={() => void mutate('采用分镜', async () => {
              await api(`/api/projects/${projectId}/storyboards/${board.id}/adoptions`,
                { expectedActiveStoryboardRevisionId: project!.activeStoryboardRevisionId });
              await reload();
              setMessage('已采用这版分镜。');
            })}>核对后采用分镜</button>
          <span className="project-next-hint"><PencilLine size={14} />逐镜编辑入口将在正式编辑链路接入后开放（#184），阶段 1 只做候选与采用。</span>
        </div>
      </>}
    </section>
    <p className="production-message" role="status">{message}</p>
    <a className="text-button" href={projectFlowHash(projectId, 'production')}>下一步：进入制作<ArrowRight size={13} /></a>
  </div>;
}
