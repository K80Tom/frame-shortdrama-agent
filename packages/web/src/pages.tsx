import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { ArrowDown, ArrowDownToLine, ArrowRight, ArrowUpRight, AudioLines, Box, Camera, Check, CheckCheck, ChevronLeft, ChevronRight, Clapperboard, Clock3, FileText, Film, FolderOpen, Image, Info, Layers3, LockKeyhole, Plus, Save, ScanLine, Settings2, Sparkles, Upload, Users, WandSparkles } from 'lucide-react';
import { ArrowButton, Card, Modal, Notice, PageHeading, Tag, WhitePreview } from './components';
import { exportDraft, initialShots, originalScript, plan, sampleImage, type Draft, type Page, type ShotDraft } from './model';
import { stages } from './stages';
import { ModelConnectionSummary } from './ModelConnections';

type Common = { go: (page: Page, step?: number) => void; notify: (text: string) => void };
type Editing = Common & { draft: Draft; setDraft: Dispatch<SetStateAction<Draft>>; save: (next?: Draft) => void };
const stageIcons = [FileText, ScanLine, Clapperboard, Users, Box, Image, Film, AudioLines, CheckCheck];

export function ScriptPage({ draft, setDraft, save, go, notify }: Editing) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const isSample = draft.script === originalScript;
  async function readFile(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.txt') || file.size > 1_000_000) { notify('请选择 1 MB 以内的 UTF-8 TXT 剧本。'); return; }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (!text.trim()) { notify('这份文件是空的，请换一份剧本。'); return; }
      setDraft(d => ({ ...d, script: text })); notify(`已读入 ${file.name}，点击保存剧本保留草稿。`);
    } catch { notify('无法读取，请将文件另存为 UTF-8 TXT 后重试。'); }
  }
  return <>
    <PageHeading eyebrow="01 / SCRIPT ROOM" title="每个好镜头，先有一个好故事。" description="保留你的原文，梳理人物与场次，再开始设计镜头。"><button className="button secondary" onClick={() => setReplaceOpen(true)}><FolderOpen size={16} />载入练习剧本</button><button className="button primary" onClick={() => save()}><Save size={16} />保存剧本</button></PageHeading>
    <div className="script-layout"><section className="panel script-panel"><div className="panel-heading"><h2><FileText size={18} />剧本原文</h2><Tag>{isSample ? '赴约 · 练习版' : '你的剧本草稿'}</Tag></div>
      <button className={`upload-zone ${dragging ? 'dragging' : ''}`} onClick={() => input.current?.click()} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); void readFile(e.dataTransfer.files[0]); }}><span className="upload-icon"><Upload size={20} /></span><span><strong>拖入剧本，或点击上传</strong><small>TXT · UTF-8 · 最大 1 MB，也可以直接在下方粘贴</small></span><Plus size={18} /></button>
      <input ref={input} type="file" accept=".txt,text/plain" hidden onChange={e => { void readFile(e.target.files?.[0]); e.target.value = ''; }} />
      <label className="sr-only" htmlFor="script-text">剧本原文</label><textarea id="script-text" className="script-editor" maxLength={1_000_000} value={draft.script} onChange={e => setDraft(d => ({ ...d, script: e.target.value }))} spellCheck={false} placeholder="场景：在哪里，什么时间。&#10;人物做了什么，说了什么……" />
      <div className="editor-footer"><span>{Array.from(draft.script).length} 字符 <span className="separator">/</span> {draft.script.split('\n').length} 行</span><span>原文不会被自动改写</span></div>
    </section>
    <aside className="script-summary"><Card className="summary-card"><div className="row-between"><span className="round-icon"><ScanLine size={21} /></span><Tag tone="orange">{isSample ? '手写参考拆解' : '等待拆解'}</Tag></div><h2>{isSample ? '故事里的每个细节' : '新的故事，新的起点'}</h2><p className="muted">{isSample ? '萧炎与纳兰嫣然在云岚宗空地对峙，交谈后准备交手，尚未出招。' : '保存你的剧本后，等待接入 Agent 来整理人物、场次和分镜。示例拆解不会套用到新剧本上。'}</p>
      {isSample && <><div className="entity-stat-row"><div><strong>02</strong><span>人物</span></div><div><strong>01</strong><span>场次</span></div><div><strong>02</strong><span>道具</span></div></div><div className="fact-group"><h3>出场人物</h3><div className="character-chips"><span><i className="avatar-crop left" />萧炎</span><span><i className="avatar-crop right" />纳兰嫣然</span></div></div><div className="fact-group"><h3>地点与道具</h3><div className="tags"><Tag>云岚宗空地</Tag><Tag>剑</Tag><Tag>重尺</Tag></div></div><button className="button secondary full-width" onClick={() => go('storyboard')}>查看参考分镜 <ArrowRight size={16} /></button></>}
      <Notice>此练习页不调用 AI。当前可编辑、保存本地草稿，并浏览参考结果；真实项目与小说页使用后端拆解。</Notice>
    </Card><div className="small-tip"><Sparkles size={16} /><p>对白和动作来自原文；景别、运镜和时长是可以修改的设计。</p></div></aside></div>
    <Modal open={replaceOpen} onClose={() => setReplaceOpen(false)} title="载入练习剧本"><p className="muted">当前编辑区将替换为“赴约”练习原文。已保存的草稿在你再次点击保存前保持不变。</p><div className="modal-actions"><button className="button secondary" onClick={() => setReplaceOpen(false)}>保留当前内容</button><button className="button primary" onClick={() => { setDraft(d => ({ ...d, script: originalScript })); setReplaceOpen(false); notify('已载入练习原文。'); }}>载入练习</button></div></Modal>
  </>;
}

export function StoryboardPage({ draft, setDraft, save, notify, go }: Editing) {
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState<'all' | 'edited'>('all');
  const [sourceOpen, setSourceOpen] = useState(false);
  const shot = draft.shots[selected];
  const isSample = draft.script === originalScript;
  const total = draft.shots.reduce((n, s) => n + s.seconds, 0);
  function update(fields: Partial<ShotDraft>) {
    setDraft(d => ({ ...d, shots: d.shots.map((s, i) => {
      if (i !== selected) return s;
      const next = { ...s, ...fields };
      const original = initialShots[i];
      next.edited = next.description !== original.description || next.size !== original.size || next.camera !== original.camera || next.seconds !== original.seconds;
      return next;
    }) }));
  }
  return <>
    <PageHeading eyebrow="02 / STORYBOARD" title="赴约，交手之前" description="一行一个连续镜头，让故事的节奏逐渐清晰。"><button className="button secondary" onClick={() => { exportDraft(draft); notify('已导出前端编辑草稿 JSON。'); }}><ArrowDownToLine size={16} />导出草稿</button><button className="button primary" onClick={() => save()}><Save size={16} />保存分镜</button></PageHeading>
    {!isSample && <Notice>你的剧本已改变。下方仍是“赴约”练习的独立参考，尚未为新剧本生成分镜。<button className="inline-link" onClick={() => go('script')}>返回剧本</button></Notice>}
    <div className="board-toolbar"><div className="segmented"><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部镜头 <span>4</span></button><button aria-pressed={filter === 'edited'} onClick={() => setFilter('edited')}>我的修改 <span>{draft.shots.filter(s => s.edited).length}</span></button></div><div className="board-meta"><span><Layers3 size={14} />1 场戏</span><span><Clock3 size={14} />预计 {total} 秒</span><Tag tone="orange">设计草稿</Tag></div></div>
    <div className="board-layout"><section className="shot-stack" aria-label="镜头列表">
      <div className="scene-bar"><span className="scene-icon"><Clapperboard size={17} /></span><div><strong>云岚宗空地 · 对峙</strong><span>场次 01 / 三句对白，出招之前</span></div><span className="scene-line" /></div>
      {draft.shots.map((s, i) => filter === 'edited' && !s.edited ? null : <button className={`shot-card ${selected === i ? 'selected' : ''}`} key={s.id} onClick={() => setSelected(i)} aria-pressed={selected === i} aria-label={`选择镜头 ${i + 1} ${s.title}`}><div className={`shot-thumbnail crop-${i}`}><img src={sampleImage} alt={`示意图裁切：${s.size}`} /><span>{String(i + 1).padStart(2, '0')}</span><small>{s.seconds}s</small></div><div className="shot-card-info"><div className="row-between"><h3>{s.title}</h3>{s.edited ? <span className="edited-mark"><LockKeyhole size={11} />人工修改</span> : <span className="design-mark">设计建议</span>}</div><p className="shot-dialogue">{s.dialogue ? `“${s.dialogue}”` : '两人目光相对，谁也没有先动。'}</p><div className="shot-properties"><span><ScanLine size={12} />{s.size}</span><span><Camera size={12} />{s.camera}</span></div></div><ChevronRight className="shot-chevron" size={16} /></button>)}
      {filter === 'edited' && !draft.shots.some(s => s.edited) && <div className="empty-state"><Clapperboard size={30} /><h3>还没有人工修改</h3><p>选一个镜头，在右侧调整设计。</p><button className="button secondary" onClick={() => setFilter('all')}>查看全部镜头</button></div>}
      <Notice>画面来自同一张示意图的裁切，展示取景差异；尚未生成独立镜头图片或视频。</Notice>
    </section><aside className="inspector panel"><div className="panel-heading"><h2>镜头 {String(selected + 1).padStart(2, '0')}</h2><Tag>{shot.edited ? '人工修改' : '设计建议'}</Tag></div><div className={`inspector-preview crop-${selected}`}><img src={sampleImage} alt="选中镜头的构图裁切示意" /><span className="frame-bracket one" /><span className="frame-bracket two" /><span className="screen-pill">构图参考</span></div><div className="inspector-body"><div className="field-label"><h3>画面设计</h3><span>{shot.edited ? '你的修改' : 'AI 设计示例'}</span></div><label className="sr-only" htmlFor="shot-description">画面设计</label><textarea id="shot-description" value={shot.description} maxLength={4000} onChange={e => update({ description: e.target.value })} /><div className="two-fields"><label>景别<select value={shot.size} onChange={e => update({ size: e.target.value })}>{['双人中景', '近景', '全景', '中景', '特写', '远景'].map(size => <option key={size}>{size}</option>)}</select></label><label>运镜<select value={shot.camera} onChange={e => update({ camera: e.target.value })}>{['固定机位', '缓慢推进', '缓慢拉远', '横向移动', '跟随人物'].map(camera => <option key={camera}>{camera}</option>)}</select></label></div><label className="duration-field"><span>预计时长 <strong>{shot.seconds} 秒</strong></span><input aria-label="镜头预计时长" type="range" min="1" max="20" step="1" value={shot.seconds} onChange={e => update({ seconds: Number(e.target.value) })} /></label><button className="source-button" onClick={() => setSourceOpen(true)}><FileText size={15} /><span>对照原文与对白</span><ArrowUpRight size={15} /></button><p className="inspector-note"><LockKeyhole size={12} />修改只影响本镜头，原文对白保持完整。</p></div></aside></div>
    <Modal open={sourceOpen} title={`镜头 ${selected + 1} · 原文依据`} onClose={() => setSourceOpen(false)}><Tag tone="green">原文事实</Tag><div className="source-quotes">{shot.original.map((text, i) => <p key={i}>{text}</p>)}</div>{shot.dialogue && <div className="dialogue-highlight"><span>{shot.speaker}</span><p>{shot.dialogue}</p></div>}<Notice>引用来自不可变的练习剧本。右侧景别、运镜和时长属于设计，不是原文事实。</Notice></Modal>
  </>;
}

function FlowVisual({ step, go }: { step: number; go: Common['go'] }) {
  if (step === 5) return <WhitePreview />;
  if (step === 1) return <div className="flow-document"><div className="paper-top"><span>SCREENPLAY / 001</span><FileText size={20} /></div><h3>赴约，交手之前</h3><p className="paper-scene">云岚宗 · 一处空地</p><p>萧炎与纳兰嫣然相对而立。</p><div className="paper-dialogue"><b>萧炎</b><p>我来了。今天，把这桩旧事了结。</p><b>纳兰嫣然</b><p>你想靠这一战，让我收回当年的决定？</p><b>萧炎</b><p>我要的，是你正视站在这里的人。</p></div><button className="text-button orange-text" onClick={() => go('script')}>打开剧本工作区 <ArrowUpRight size={15} /></button></div>;
  if (step === 2) return <div className="flow-facts"><span className="mini-label">STORY BREAKDOWN</span><h3>故事中的人、景、物。</h3><div className="flow-fact-grid">{[{ label: '人物', value: '萧炎 / 纳兰嫣然', icon: Users }, { label: '地点', value: '云岚宗空地', icon: Image }, { label: '道具', value: '剑 / 重尺', icon: Box }, { label: '场次', value: '一场对峙', icon: Clapperboard }].map(item => <div key={item.label}><item.icon size={19} /><small>{item.label}</small><strong>{item.value}</strong><span>可追溯原文 <Check size={11} /></span></div>)}</div></div>;
  if (step === 3) return <div className="flow-shots"><div className="flow-shots-head"><span className="mini-label">SHOT LIST</span><span>4 个连续镜头</span></div>{initialShots.map((shot, i) => <button key={shot.id} onClick={() => go('storyboard')}><span>{String(i + 1).padStart(2, '0')}</span><div><h4>{shot.size} · {shot.title}</h4><p>{shot.dialogue || '纳兰嫣然拔剑，萧炎握紧重尺。'}</p></div><small>{shot.seconds}s</small></button>)}</div>;
  if (step === 4) return <div className="flow-actors"><figure className="actor-left"><img src={sampleImage} alt="黑衣男子造型示意" /><figcaption><span>CHARACTER 01</span>萧炎</figcaption></figure><figure className="actor-right"><img src={sampleImage} alt="白衣女子造型示意" /><figcaption><span>CHARACTER 02</span>纳兰嫣然</figcaption></figure></div>;
  if (step === 6 || step === 7) return <div className="flow-image"><img src={sampleImage} alt="静态镜头画面示意" /><span className="screen-pill">{step === 6 ? '静态构图示意' : '视频制作目标 · 当前为静态参考'}</span><div><Clapperboard size={20} /><h3>出招之前的，最后一秒。</h3><p>{step === 6 ? '将人物、场景与机位变成具体画面。' : '让拔剑、握尺与目光在时间中发生。'}</p></div></div>;
  if (step === 8) return <div className="flow-timeline"><span className="mini-label">EDITING ROOM / 顺序示意</span><div className="timeline-ruler"><span>起点</span><span>对话</span><span>准备交手</span></div>{[{ name: '画面', blocks: ['对峙', '纳兰', '萧炎', '拔剑'] }, { name: '对白', blocks: ['我来了…', '你想靠…', '我要的…', '停顿'] }, { name: '声音', blocks: ['环境声', '拔剑声'] }, { name: '字幕', blocks: ['与原文对白对应'] }].map((track, i) => <div className={`timeline-track track-${i}`} key={track.name}><span>{track.name}</span><div>{track.blocks.map(block => <span key={block}>{block}</span>)}</div></div>)}<Notice>色块宽度只表示排列，不代表真实媒体时长。</Notice></div>;
  return <div className="flow-review"><div className="review-icon"><CheckCheck size={35} strokeWidth={1.3} /></div><h3>最后一次，认真看一遍。</h3><p>检查通过，才是一份完整交付。</p>{['剧情、动作与对白完整', '人物、服装与道具连续', '镜头、视线与空间合理', '声音、口型与字幕对齐'].map((text, i) => <div className="review-item" key={text}><span>{String(i + 1).padStart(2, '0')}</span>{text}<span className="review-pending">检查项</span></div>)}</div>;
}

export function FlowPage({ step, go }: Common & { step: number }) {
  const stage = stages[step - 1];
  return <><PageHeading eyebrow="THE FILMMAKING PROCESS" title="从一页剧本，到完整的一集。" description="探索 9 个制作环节。点开每一步，看清输入、产出和 Agent 的工作。"><button className="button secondary" onClick={() => go('flow', 5)}><Box size={16} />白模预演</button></PageHeading>
    <div className="flow-phases"><span>01 — 文字策划</span><span>02 — 画面制作</span><span>03 — 成片交付</span></div><nav className="flow-steps" aria-label="短剧制作步骤">{stages.map((s, i) => { const Icon = stageIcons[i]; return <button key={s.id} className={step === s.id ? 'active' : ''} aria-current={step === s.id ? 'step' : undefined} onClick={() => go('flow', s.id)}><span className="step-top"><span>{String(s.id).padStart(2, '0')}</span>{s.id === 5 && <small>可选</small>}</span><Icon size={21} strokeWidth={1.5} /><strong>{s.title}</strong><span className="step-indicator" /></button>; })}</nav>
    <div className="flow-workspace"><section className="panel flow-preview"><div className="panel-heading"><h2><span className="orange-text">{String(step).padStart(2, '0')}</span>{stage.title}</h2><Tag tone="orange">{stage.badge}</Tag></div><div className="flow-screen" key={step}><FlowVisual step={step} go={go} /></div><p className="flow-caption"><Info size={14} />{stage.caption}</p></section><aside className="flow-detail"><span className="mini-label">BEHIND THE SCENE</span><h2>{stage.headline}</h2><p className="muted">{stage.description}</p><div className="flow-io"><span><ArrowDown size={15} /></span><div><h3>接收什么</h3><p>{stage.input}</p></div></div><div className="flow-io"><span className="output-icon"><ArrowUpRight size={15} /></span><div><h3>交出什么</h3><p>{stage.output}</p></div></div><div className="purpose-note"><Sparkles size={16} /><div><h3>它解决的问题</h3><p>{stage.purpose}</p></div></div><details className="agent-details"><summary>Agent 在这一步做什么 <Plus size={13} /></summary><p>{stage.agent}</p></details><div className="flow-navigation"><button className="button secondary" disabled={step === 1} onClick={() => go('flow', step - 1)}><ChevronLeft size={15} />上一步</button><button className="button primary" onClick={() => go('flow', step === 9 ? 1 : step + 1)}>{step === 9 ? '回到起点' : step === 5 ? '下一步 / 可跳过' : '下一步'}<ChevronRight size={15} /></button></div></aside></div>
    <div className="flow-footnote"><span><i className="tiny-light" />拆解剧情 + 设计分镜，是第一个开发里程碑。</span><button className="text-button" onClick={() => go('script')}>进入剧本工作区 <ArrowRight size={15} /></button></div>
  </>;
}

export function SettingsPage(_props: Common) {
  return <><PageHeading eyebrow="YOUR WORKSPACE" title="为下一次创作，准备就绪。" description="管理模型连接，了解当前工作台的保存方式。" /><div className="settings-grid"><ModelConnectionSummary /><Card className="settings-card"><span className="round-icon"><Save size={23} /></span><h2>数据与草稿</h2><Tag tone="green">按页面保存</Tag><p>小说、真实剧本项目、校对历史与资产引用由本机后端存入数据库；请点击相应页面的保存按钮。</p><p className="settings-small">剧本编辑样例与示例分镜仍是浏览器草稿，换浏览器不会同步；正式数据请备份本机数据库。</p></Card><Card className="settings-card"><span className="round-icon"><WandSparkles size={23} /></span><h2>关于这个版本</h2><Tag tone="orange">本地工作台 0.1</Tag><p>已接入小说与剧本拆解、校对保存、资产引用和分镜设计。模型连接按用途独立管理。</p><p className="settings-small">小说待补资产已接单张生图、导入和关联；「自动成片」可按描述生成独立视频片段，尚未绑定分镜与整集剪辑；角色配音未接入。3D 导演台保持现状。</p></Card></div></>;
}
