import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, FileUp, Loader2, RefreshCw, Search, ShieldCheck, Upload, X } from 'lucide-react';
import {
  fetchPromptPackContent,
  fetchPromptPacks,
  importPromptPack,
  PROMPT_PACK_STAGE_LABELS,
  PromptPackApiError,
  setPromptPackState,
  stageLabel,
  type PromptPackContent,
  type PromptPackItem,
} from './prompt-packs';
import './prompt-packs.css';
import type { MethodNode } from '@lyra/shared';

const STAGE_ORDER = ['topic', 'adaptation', 'character', 'episode-outline', 'script', 'script-review', 'storyboard', 'video-prompt', 'production'];
const MAX_CONTENT_BYTES = 512 * 1024;
const NODE_LABELS: Record<MethodNode, string> = {
  breakdown: '事实拆解', 'character-image': '角色生图', storyboard: '分镜生成', video: '镜头视频',
};

type Props = { notify: (text: string) => void };

type DetailState = { id: string; name: string; license: string; content: string } | null;

type ImportForm = { name: string; summary: string; license: string; content: string; stages: string[] };

const EMPTY_IMPORT: ImportForm = { name: '', summary: '', license: '', content: '', stages: [] };

function bytesOf(value: string): number {
  return new TextEncoder().encode(value).length;
}

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
  const [importOpen, setImportOpen] = useState(false);
  const [importForm, setImportForm] = useState<ImportForm>(EMPTY_IMPORT);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const detailRequest = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

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
        setError('方法包接口未启用：请先在 packages/main 执行 npm run db:migrate（020–021 迁移）。');
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

  function openImport() {
    setImportError('');
    setImportOpen(true);
  }

  function closeImport() {
    if (importing) return;
    setImportOpen(false);
    setImportForm(EMPTY_IMPORT);
    setImportError('');
  }

  function toggleStage(key: string) {
    setImportForm((form) => ({
      ...form,
      stages: form.stages.includes(key) ? form.stages.filter((item) => item !== key) : [...form.stages, key],
    }));
  }

  async function onPickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_CONTENT_BYTES) {
      setImportError('文件超过 512KB 上限，请精简后再导入。');
      return;
    }
    try {
      const content = await file.text();
      setImportForm((form) => ({
        ...form,
        content,
        name: form.name || file.name.replace(/\.(md|markdown|txt)$/iu, '').slice(0, 80),
      }));
      setImportError('');
    } catch {
      setImportError('文件读取失败，请重试或直接粘贴正文。');
    }
  }

  async function submitImport() {
    if (importing) return;
    const name = importForm.name.trim();
    if (!name) {
      setImportError('请填写方法名称。');
      return;
    }
    if (importForm.stages.length === 0) {
      setImportError('请至少选择一个适用阶段。');
      return;
    }
    if (!importForm.content.trim()) {
      setImportError('请粘贴正文，或选择一个 .md / .txt 文件。');
      return;
    }
    if (bytesOf(importForm.content) > MAX_CONTENT_BYTES) {
      setImportError('正文超过 512KB 上限，请精简后再导入。');
      return;
    }
    setImporting(true);
    setImportError('');
    try {
      const result = await importPromptPack({
        name,
        stages: importForm.stages,
        summary: importForm.summary,
        license: importForm.license,
        content: importForm.content,
      });
      notify(`已导入「${result.name}」，默认关闭`);
      setImportOpen(false);
      setImportForm(EMPTY_IMPORT);
      await load();
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : '导入失败，请重试。');
    } finally {
      setImporting(false);
    }
  }

  const importBytes = bytesOf(importForm.content);

  return <div className="methods-page">
    <header className="methods-head">
      <div>
        <span className="methods-kicker">METHOD LIBRARY</span>
        <h1>方法包</h1>
        <p>新建制片时锁定已启用的方法。仅在对应节点发起模型请求时附上参考节选；手动拆解和生成分镜采用当次设置。</p>
      </div>
      <div className="methods-head-actions">
        <span className="methods-stat"><strong>{packs.length}</strong> 个包 · <strong>{enabledCount}</strong> 已启用</span>
        <button className="methods-import" onClick={openImport}><Upload size={13} /> 导入方法</button>
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
      <BookOpen size={22} /><h3>没有匹配的方法包</h3><p>换个关键词、切回“全部”阶段，或者导入一个自己的方法。</p>
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
                  {pack.origin === 'imported' && <span className="methods-self">自导入</span>}
                </div>
                <p>{pack.summary || '（来源仓库未提供摘要）'}</p>
                <p>{pack.runtimeNodes?.length
                  ? `生效节点 · ${pack.runtimeNodes.map(node => NODE_LABELS[node]).join('、')}${pack.stages.includes('adaptation') ? '（改编标签仅用于小说改编项目的事实核对）' : ''}`
                  : '仅供查阅 · 当前没有匹配的生成节点或可注入正文'}</p>
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
                disabled={saving.includes(pack.id) || (!pack.enabled && !pack.runtimeNodes?.length)}
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

    {importOpen && <div
      className="methods-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) closeImport(); }}
    >
      <div className="methods-modal" role="dialog" aria-modal="true" aria-labelledby="methods-import-title">
        <div className="methods-modal-head">
          <div>
            <span className="methods-kicker">IMPORT</span>
            <h2 id="methods-import-title">导入方法</h2>
          </div>
          <button className="methods-close" onClick={closeImport} aria-label="关闭导入"><X size={16} /></button>
        </div>
        <p className="methods-modal-hint">导入后默认关闭。启用时，匹配的生成节点会把正文开头最多 4000 字的节选发送给已配置的模型。每个节点最多 8 个包，多包平分参考长度。选题标签目前仅供查阅。</p>
        <div className="methods-modal-body">
          <label className="methods-field">
            <span>名称 <i>必填</i></span>
            <input value={importForm.name} maxLength={80} placeholder="例如：我的三幕反转法" onChange={(event) => setImportForm((form) => ({ ...form, name: event.target.value }))} />
          </label>
          <div className="methods-field">
            <span>适用阶段 <i>至少一个</i></span>
            <div className="methods-stage-picker">
              {Object.entries(PROMPT_PACK_STAGE_LABELS).map(([key, label]) => <button
                key={key}
                type="button"
                aria-pressed={importForm.stages.includes(key)}
                onClick={() => toggleStage(key)}
              >{label}</button>)}
            </div>
          </div>
          <div className="methods-field-row">
            <label className="methods-field">
              <span>摘要 <i>选填</i></span>
              <input value={importForm.summary} maxLength={200} placeholder="一句话说明它能解决什么" onChange={(event) => setImportForm((form) => ({ ...form, summary: event.target.value }))} />
            </label>
            <label className="methods-field">
              <span>许可 <i>选填</i></span>
              <input value={importForm.license} maxLength={60} placeholder="自建（未声明许可）" onChange={(event) => setImportForm((form) => ({ ...form, license: event.target.value }))} />
            </label>
          </div>
          <div className="methods-field">
            <span>正文 <i>必填</i><em>{Math.round(importBytes / 1024)} / 512KB</em></span>
            <textarea
              className="methods-content-input"
              rows={12}
              value={importForm.content}
              placeholder="粘贴 SKILL.md 或方法论正文…"
              onChange={(event) => setImportForm((form) => ({ ...form, content: event.target.value }))}
            />
            <div className="methods-file-row">
              <button type="button" onClick={() => fileInput.current?.click()}><FileUp size={13} /> 选择 .md / .txt 文件</button>
              <input ref={fileInput} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={(event) => void onPickFile(event)} />
              <span>导入内容只存本机数据库，不写进仓库目录。</span>
            </div>
          </div>
          {importError && <div className="methods-modal-error">{importError}</div>}
        </div>
        <div className="methods-modal-actions">
          <button className="methods-cancel" onClick={closeImport} disabled={importing}>取消</button>
          <button className="methods-submit" onClick={() => void submitImport()} disabled={importing}>
            {importing ? <Loader2 size={13} className="methods-spin" /> : <Upload size={13} />} 导入并关闭
          </button>
        </div>
      </div>
    </div>}
  </div>;
}
