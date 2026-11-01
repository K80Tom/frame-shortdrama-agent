import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, Loader2, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import {
  fetchPromptPackContent,
  fetchPromptPacks,
  PromptPackApiError,
  setPromptPackState,
  stageLabel,
  type PromptPackContent,
  type PromptPackItem,
} from './prompt-packs';
import './prompt-packs.css';

const STAGE_ORDER = ['topic', 'adaptation', 'character', 'episode-outline', 'script', 'script-review', 'storyboard', 'video-prompt', 'production'];

type Props = { notify: (text: string) => void };

type DetailState = { id: string; name: string; license: string; content: string } | null;

export default function PromptPacksPage({ notify }: Props) {
  const [packs, setPacks] = useState<PromptPackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState('all');
  const [detail, setDetail] = useState<DetailState>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [saving, setSaving] = useState<string[]>([]);
  const detailRequest = useRef(0);
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError('');
    try {
      const data = await fetchPromptPacks(controller.signal);
      setPacks(data.packs);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof PromptPackApiError && cause.status === 404) {
        setError('方法包接口未启用：请先在 packages/main 执行 npm run db:migrate（020 迁移）。');
      } else {
        setError(cause instanceof Error ? cause.message : '方法包列表读取失败。');
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => abort.current?.abort();
  }, [load]);

  const enabledCount = packs.filter((pack) => pack.enabled).length;
  const stagesPresent = useMemo(() => {
    const present = new Set(packs.flatMap((pack) => pack.stages));
    return STAGE_ORDER.filter((key) => present.has(key)).concat(
      [...present].filter((key) => !STAGE_ORDER.includes(key)),
    );
  }, [packs]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return packs.filter((pack) => {
      if (stage !== 'all' && !pack.stages.includes(stage)) return false;
      if (!keyword) return true;
      return `${pack.name} ${pack.summary} ${pack.id} ${pack.source}`.toLowerCase().includes(keyword);
    });
  }, [packs, query, stage]);

  const groups = useMemo(() => {
    const byStage = new Map<string, PromptPackItem[]>();
    for (const pack of filtered) {
      const key = pack.stages[0] ?? 'other';
      const bucket = byStage.get(key) ?? [];
      bucket.push(pack);
      byStage.set(key, bucket);
    }
    return [...byStage.entries()].sort(([a], [b]) => {
      const indexA = STAGE_ORDER.indexOf(a);
      const indexB = STAGE_ORDER.indexOf(b);
      return (indexA < 0 ? 99 : indexA) - (indexB < 0 ? 99 : indexB);
    });
  }, [filtered]);

  async function toggle(pack: PromptPackItem) {
    if (saving.includes(pack.id)) return;
    const next = !pack.enabled;
    setSaving((current) => [...current, pack.id]);
    setPacks((current) => current.map((item) => (item.id === pack.id ? { ...item, enabled: next } : item)));
    try {
      await setPromptPackState(pack.id, next);
      notify(next ? `已启用「${pack.name}」` : `已停用「${pack.name}」`);
    } catch (cause) {
      setPacks((current) => current.map((item) => (item.id === pack.id ? { ...item, enabled: !next } : item)));
      notify(cause instanceof Error ? cause.message : '启用状态保存失败。');
    } finally {
      setSaving((current) => current.filter((id) => id !== pack.id));
    }
  }

  async function openDetail(pack: PromptPackItem) {
    const ticket = detailRequest.current + 1;
    detailRequest.current = ticket;
    setDetail({ id: pack.id, name: pack.name, license: pack.license, content: '' });
    setDetailLoading(true);
    setDetailError('');
    try {
      const data: PromptPackContent = await fetchPromptPackContent(pack.id);
      if (detailRequest.current !== ticket) return;
      setDetail({ id: data.id, name: pack.name, license: data.license, content: data.content });
    } catch (cause) {
      if (detailRequest.current !== ticket) return;
      setDetailError(cause instanceof Error ? cause.message : '正文读取失败。');
    } finally {
      if (detailRequest.current === ticket) setDetailLoading(false);
    }
  }

  function closeDetail() {
    detailRequest.current += 1;
    setDetail(null);
    setDetailLoading(false);
    setDetailError('');
  }

  return <div className="methods-page">
    <header className="methods-head">
      <div>
        <span className="methods-kicker">METHOD LIBRARY</span>
        <h1>方法包</h1>
        <p>第三方短剧方法论文本，按阶段注册；默认全部关闭，只在审稿等阶段显式启用后才进入提示词。</p>
      </div>
      <div className="methods-head-actions">
        <span className="methods-stat"><strong>{packs.length}</strong> 个包 · <strong>{enabledCount}</strong> 已启用</span>
        <button className="methods-refresh" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 size={13} className="methods-spin" /> : <RefreshCw size={13} />} 刷新
        </button>
      </div>
    </header>

    {error && <div className="methods-error"><ShieldCheck size={15} /><p>{error}</p><button onClick={() => void load()}>重试</button></div>}

    <div className="methods-toolbar">
      <div className="methods-search">
        <Search size={15} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、来源或摘要…" aria-label="搜索方法包" />
        {query && <button onClick={() => setQuery('')} aria-label="清空搜索"><X size={13} /></button>}
      </div>
      <div className="methods-stages" role="group" aria-label="按阶段筛选">
        <button aria-pressed={stage === 'all'} onClick={() => setStage('all')}>全部<span>{packs.length}</span></button>
        {stagesPresent.map((key) => <button key={key} aria-pressed={stage === key} onClick={() => setStage(key)}>
          {stageLabel(key)}<span>{packs.filter((pack) => pack.stages.includes(key)).length}</span>
        </button>)}
      </div>
    </div>

    {loading && packs.length === 0 && <div className="methods-loading"><Loader2 size={18} className="methods-spin" /> 正在读取注册表…</div>}
    {!loading && !error && filtered.length === 0 && <div className="methods-empty">
      <BookOpen size={22} /><h3>没有匹配的方法包</h3><p>换个关键词，或切回“全部”阶段。</p>
    </div>}

    <div className={`methods-body ${detail ? 'with-detail' : ''}`}>
      <div className="methods-groups">
        {groups.map(([key, items]) => <section className="methods-group" key={key}>
          <div className="methods-group-head">
            <h2>{stageLabel(key)}</h2><span>{items.length}</span>
          </div>
          <div className="methods-grid">
            {items.map((pack) => <article key={pack.id} className={`methods-card ${pack.enabled ? 'enabled' : ''}`}>
              <button className="methods-card-main" onClick={() => void openDetail(pack)}>
                <div className="methods-card-title">
                  <h3>{pack.name}</h3>
                  {pack.enabled && <span className="methods-on"><Check size={11} /> 启用中</span>}
                </div>
                <p>{pack.summary || '（来源仓库未提供摘要）'}</p>
                <div className="methods-card-meta">
                  <span className="methods-license">{pack.license || '未声明'}</span>
                  <span className={`methods-quality ${pack.quality === 'evaluated' ? 'evaluated' : ''}`}>
                    {pack.quality === 'evaluated' ? '已评测' : '未评测'}
                  </span>
                  {pack.stages.slice(1).map((extra) => <span key={extra} className="methods-stage-tag">{stageLabel(extra)}</span>)}
                  {pack.source && <span className="methods-source" title={pack.source}>{pack.source}</span>}
                </div>
              </button>
              <button
                className={`methods-switch ${pack.enabled ? 'on' : ''}`}
                role="switch"
                aria-checked={pack.enabled}
                aria-label={`${pack.enabled ? '停用' : '启用'} ${pack.name}`}
                disabled={saving.includes(pack.id)}
                onClick={() => void toggle(pack)}
              ><i /></button>
            </article>)}
          </div>
        </section>)}
      </div>

      {detail && <aside className="methods-detail" aria-label="方法包详情">
        <div className="methods-detail-head">
          <div>
            <span className="methods-kicker">SKILL.md</span>
            <h2>{detail.name}</h2>
          </div>
          <button className="methods-close" onClick={closeDetail} aria-label="关闭详情"><X size={16} /></button>
        </div>
        <div className="methods-detail-meta">
          <span className="methods-license">{detail.license || '未声明'}</span>
          <span>{detail.id}</span>
        </div>
        {detailLoading && <div className="methods-detail-loading"><Loader2 size={15} className="methods-spin" /> 正在按需加载正文…</div>}
        {detailError && <div className="methods-detail-error">{detailError}</div>}
        {!detailLoading && !detailError && <pre className="methods-content">{detail.content}</pre>}
      </aside>}
    </div>
  </div>;
}
