import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive, Bot, Check, CircleAlert, LoaderCircle, Receipt, SendHorizonal, Timer, Wrench, X,
} from 'lucide-react';
import {
  assistantHistory, createAssistantSession, listAssistantSessions, resumeAssistantSession,
  streamAssistantMessage, submitAssistantQuote, updateAssistantSession,
  type AssistantContext, type AssistantMessage, type AssistantQuote, type AssistantSession,
} from './api';

const TOOL_LABELS: Record<string, string> = {
  list_projects: '查询项目清单',
  list_production_runs: '查询制片运行',
  get_production_run: '查看运行详情',
  list_assets: '查询资产目录',
  generation_quote: '生成估价确认卡',
  submit_quote: '提交制片运行',
};

function contextKeyOf(context: AssistantContext): string {
  return [context.projectId, context.runId].filter(Boolean).join(':') || 'global';
}

function yuan(micros: number): string {
  return `¥${(micros / 1_000_000).toFixed(2)}`;
}

function newLocalId(): string {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function estimateText(quote: AssistantQuote): string {
  const range = quote.estimateRangeMicros;
  return range
    ? `${yuan(quote.estimateCostMicros)}（区间 ${yuan(range.lowMicros)}–${yuan(range.highMicros)}）`
    : yuan(quote.estimateCostMicros);
}

/** 只展示服务端给出的预计耗时；旧估价卡没有该字段时不猜测。 */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

export default function AssistantPanel({ open, onClose, context, notify }: {
  open: boolean;
  onClose: () => void;
  context: AssistantContext;
  notify: (text: string) => void;
}) {
  const contextKey = contextKeyOf(context);
  const storageKey = `ohao_assistant_session:${contextKey}`;
  const cursorKey = `ohao_assistant_cursor:${contextKey}`;
  const [sessionId, setSessionId] = useState('');
  const [sessionTitle, setSessionTitle] = useState('');
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [quotes, setQuotes] = useState<AssistantQuote[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lastInput, setLastInput] = useState('');
  const [resumedNote, setResumedNote] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef('');
  const cursorRef = useRef(0);

  const rememberCursor = useCallback((cursor: number) => {
    cursorRef.current = cursor;
    window.sessionStorage.setItem(cursorKey, String(cursor));
  }, [cursorKey]);

  const loadSession = useCallback(async (id: string, active: () => boolean) => {
    const result = await assistantHistory(id);
    if (!active()) return;
    setSessionId(result.session.id);
    sessionRef.current = result.session.id;
    setSessionTitle(result.session.title);
    setMessages(result.items);
    setQuotes(result.quotes);
    const lastCursor = result.turns.reduce((max, turn) => Math.max(max, turn.cursor), 0);
    // 断线恢复：只回放已落库的 turn，未完成的内容不会被伪造。
    if (lastCursor > 0 && cursorRef.current < lastCursor) {
      try {
        const resumed = await resumeAssistantSession(result.session.id, cursorRef.current);
        if (!active()) return;
        if (resumed.events.length) {
          const restored = resumed.turns.map(turn => ({
            id: turn.id, sessionId: id, seq: turn.cursor, role: 'user' as const,
            content: turn.userContent, thinking: '', status: 'complete' as const, createdAt: turn.startedAt,
          }));
          setMessages(current => current.length ? current : restored);
          setResumedNote(`已从断点恢复 ${resumed.turns.length} 轮对话`);
        }
        rememberCursor(resumed.cursor);
      } catch { /* 恢复失败不阻断当前会话 */ }
    } else {
      rememberCursor(lastCursor);
    }
  }, [rememberCursor]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const stored = window.sessionStorage.getItem(storageKey) ?? '';
    cursorRef.current = Number(window.sessionStorage.getItem(cursorKey) ?? 0) || 0;
    setSessionId(stored);
    sessionRef.current = stored;
    setMessages([]);
    setQuotes([]);
    setError('');
    setResumedNote('');
    listAssistantSessions().then(list => { if (active) setSessions(list); }).catch(() => { /* 列表失败不影响当前会话 */ });
    if (stored) {
      loadSession(stored, () => active).catch(() => {
        window.sessionStorage.removeItem(storageKey);
        setSessionId('');
        sessionRef.current = '';
      });
    }
    return () => { active = false; };
  }, [open, storageKey, loadSession]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, quotes, busy]);

  const patchMessage = useCallback((id: string, patch: (message: AssistantMessage) => AssistantMessage) => {
    setMessages(current => current.map(message => message.id === id ? patch(message) : message));
  }, []);

  const send = useCallback(async (raw?: string) => {
    const content = (raw ?? input).trim();
    if (!content || busy) return;
    setBusy(true);
    setError('');
    setLastInput(content);
    setInput('');
    const userMessage: AssistantMessage = {
      id: newLocalId(), sessionId: sessionRef.current, seq: 0, role: 'user', content,
      thinking: '', status: 'complete', createdAt: new Date().toISOString(),
    };
    const assistantId = newLocalId();
    setMessages(current => [...current, userMessage, {
      id: assistantId, sessionId: sessionRef.current, seq: 0, role: 'assistant',
      content: '', thinking: '', status: 'streaming', createdAt: new Date().toISOString(),
    }]);
    try {
      let activeSession = sessionRef.current;
      let sawModelDelta = false;
      if (!activeSession) {
        const created = await createAssistantSession(context);
        activeSession = created.id;
        sessionRef.current = activeSession;
        setSessionId(activeSession);
        setSessionTitle(created.title);
        window.sessionStorage.setItem(storageKey, activeSession);
        setSessions(current => [created, ...current]);
      }
      await streamAssistantMessage(activeSession, content, event => {
        if (event.type === 'model.delta') {
          sawModelDelta = true;
          patchMessage(assistantId, message => ({ ...message, content: message.content + event.delta }));
          return;
        }
        // 兼容旧事件名：与 model.delta 同时到达时忽略，避免文本重复拼接。
        if (event.type === 'text_delta') {
          if (!sawModelDelta) patchMessage(assistantId, message => ({ ...message, content: message.content + event.delta }));
          return;
        }
        if (event.type === 'thinking_delta') {
          patchMessage(assistantId, message => ({ ...message, thinking: message.thinking + event.delta }));
          return;
        }
        if (event.type === 'turn.started') {
          const facts = event.context;
          if (facts.projectTitle || facts.storyboardRevisionId) {
            setResumedNote(`后端上下文：${facts.projectTitle ?? facts.projectId ?? ''}`);
          }
          return;
        }
        if (event.type === 'tool.proposed' || event.type === 'tool_start') {
          const toolName = event.toolName;
          const callId = 'callId' in event ? event.callId : undefined;
          setMessages(current => [...current, {
            id: callId ? `tool_${callId}` : newLocalId(), sessionId: activeSession, seq: 0, role: 'tool',
            content: '准备查询…', thinking: '', status: 'streaming', toolName, createdAt: new Date().toISOString(),
          }]);
          return;
        }
        if (event.type === 'tool_end') {
          setMessages(current => {
            const index = [...current].reverse().findIndex(message =>
              message.role === 'tool' && message.toolName === event.toolName && message.status === 'streaming');
            if (index < 0) return current;
            const target = current.length - 1 - index;
            return current.map((message, position) => position === target
              ? { ...message, content: event.summary, status: 'complete', payload: { isError: event.isError } }
              : message);
          });
          return;
        }
        if (event.type === 'generation_quote' || event.type === 'confirmation.required') {
          setQuotes(current => [...current.filter(quote => quote.id !== event.quote.id), event.quote]);
          return;
        }
        if (event.type === 'turn.failed') {
          setError(event.message);
          patchMessage(assistantId, message => ({ ...message, status: 'failed' }));
          return;
        }
        if (event.type === 'error') {
          setError(event.message);
          patchMessage(assistantId, message => ({ ...message, status: 'failed' }));
          return;
        }
        if (event.type === 'done') {
          patchMessage(assistantId, () => ({ ...event.message, id: assistantId }));
          if (event.cursor) rememberCursor(event.cursor);
        }
      }, undefined, cursorRef.current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '助手这会儿没应答，请重试');
      patchMessage(assistantId, message => ({ ...message, status: 'failed' }));
    } finally {
      setBusy(false);
    }
  }, [busy, context, input, patchMessage, storageKey, rememberCursor]);

  const submit = useCallback(async (quote: AssistantQuote) => {
    if (busy || !sessionRef.current) return;
    setBusy(true);
    setError('');
    try {
      const result = await submitAssistantQuote(sessionRef.current, quote.id);
      setQuotes(current => current.map(item => item.id === quote.id ? result.quote : item));
      notify(`已提交自动制片运行 ${result.runId}，可在自动制片页查看进度`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '提交失败，请重试');
      if (reason instanceof Error && (reason as Error & { code?: string }).code === 'ASSISTANT_QUOTE_EXPIRED') {
        setQuotes(current => current.map(item => item.id === quote.id ? { ...item, status: 'expired' } : item));
      }
    } finally {
      setBusy(false);
    }
  }, [busy, notify]);

  const rename = useCallback(async (title: string) => {
    const trimmed = title.trim();
    if (!sessionRef.current || !trimmed) return;
    try {
      const updated = await updateAssistantSession(sessionRef.current, { title: trimmed });
      setSessionTitle(updated.title);
      setSessions(current => current.map(item => item.id === updated.id ? updated : item));
    } catch { /* 重命名失败保留原名 */ }
  }, []);

  const archive = useCallback(async () => {
    if (!sessionRef.current) return;
    try {
      await updateAssistantSession(sessionRef.current, { archived: true });
      window.sessionStorage.removeItem(storageKey);
      window.sessionStorage.removeItem(cursorKey);
      setSessions(current => current.filter(item => item.id !== sessionRef.current));
      setSessionId(''); sessionRef.current = ''; setSessionTitle('');
      setMessages([]); setQuotes([]); rememberCursor(0);
      notify('当前会话已归档，下次发送会创建新会话。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '归档失败，请重试');
    }
  }, [cursorKey, notify, rememberCursor, storageKey]);

  if (!open) return null;
  const pendingQuotes = quotes.filter(quote => quote.status === 'pending');
  const suggestions = context.projectId
    ? ['这个项目的资产准备得怎么样了？', '最近的制片运行跑到哪一步？', '帮我为当前项目创建 60 秒成片的估价卡']
    : ['我有哪些项目？', '最近的制片运行状态如何？', '怎么开始一部新短剧？'];

  return <aside className="assistant-panel" aria-label="AI 工作区">
    <header className="assistant-head">
      <span className="assistant-title"><Bot size={18} /><strong>AI 工作区</strong></span>
      <button className="icon-button" onClick={onClose} aria-label="收起 AI 工作区" title="收起（⌘J / Ctrl+J）"><X size={17} /></button>
    </header>
    <div className="assistant-context"><span>{context.label}</span><span className="assistant-context-key">{contextKey === 'global' ? '全局' : '已关联当前页面'}</span></div>

    <div className="assistant-session-bar">
      <input value={sessionTitle} placeholder="未命名会话"
        onBlur={event => void rename(event.target.value)} aria-label="会话标题" />
      {sessions.length > 0 && <select aria-label="切换会话" value={sessionId}
        onChange={event => {
          const next = event.target.value;
          if (!next) return;
          window.sessionStorage.setItem(storageKey, next);
          rememberCursor(0);
          loadSession(next, () => true).catch(() => setError('会话读取失败'));
        }}>
        <option value="">新会话</option>
        {sessions.map(item => <option key={item.id} value={item.id}>{item.title || item.createdAt.slice(0, 16)}</option>)}
      </select>}
      {sessionId && <button className="assistant-archive" onClick={() => void archive()} aria-label="归档当前会话"><Archive size={14} /></button>}
    </div>
    {resumedNote && <p className="assistant-resume-note">{resumedNote}</p>}

    <div className="assistant-messages" ref={scrollRef}>
      {!messages.length && <div className="assistant-empty">
        <Bot size={30} strokeWidth={1.4} />
        <p>我可以查询你本机的项目、制片运行与资产，也能在你确认后发起生产。</p>
        <div className="assistant-suggestions">
          {suggestions.map(text => <button key={text} disabled={busy} onClick={() => void send(text)}>{text}</button>)}
        </div>
      </div>}
      {messages.map(message => {
        if (message.role === 'user') {
          return <div key={message.id} className="assistant-row user"><div className="assistant-bubble user">{message.content}</div></div>;
        }
        if (message.role === 'tool') {
          const failed = message.payload?.isError === true;
          return <div key={message.id} className={`assistant-tool ${failed ? 'failed' : ''}`}>
            {message.status === 'streaming' ? <LoaderCircle size={14} className="spin" /> : <Wrench size={14} />}
            <span className="assistant-tool-name">{TOOL_LABELS[message.toolName ?? ''] ?? message.toolName}</span>
            <span className="assistant-tool-summary">{message.content}</span>
          </div>;
        }
        return <div key={message.id} className="assistant-row">
          <div className={`assistant-bubble ${message.status === 'failed' ? 'failed' : ''}`}>
            {message.thinking && <details className="assistant-thinking"><summary>思考过程</summary><p>{message.thinking}</p></details>}
            {message.content
              ? <p>{message.content}</p>
              : message.status === 'streaming' ? <span className="assistant-waiting"><LoaderCircle size={14} className="spin" />正在处理…</span> : null}
            {message.status === 'failed' && <span className="assistant-failed-tag"><CircleAlert size={13} />本次回答未完成</span>}
          </div>
        </div>;
      })}

      {pendingQuotes.map(quote => <div key={quote.id} className="assistant-quote">
        <div className="assistant-quote-head"><Receipt size={15} /><strong>生成估价确认</strong><span>预计 {estimateText(quote)}</span></div>
        <p>{quote.summary}</p>
        {quote.estimatedDurationSec !== undefined && <div className="assistant-quote-duration">
          <Timer size={13} />预计耗时 {formatDuration(quote.estimatedDurationSec)}
        </div>}
        {quote.costBreakdown?.length ? <ul className="assistant-quote-breakdown">
          {quote.costBreakdown.map(item => <li key={item.label}>
            <span>{item.label}{item.note ? <em>{item.note}</em> : null}</span>
            <strong>{yuan(item.amountMicros)}</strong>
          </li>)}
          <li className="total"><span>合计（系统估价）</span><strong>{yuan(quote.estimateCostMicros)}</strong></li>
        </ul> : null}
        <div className="assistant-quote-meta">
          预算上限 {quote.budgetMicros === undefined ? '未设置' : yuan(quote.budgetMicros)}
          {quote.priceRevision ? ` · 价格版本 ${quote.priceRevision}` : ''}
          {' · '}{new Date(quote.expiresAt).toLocaleTimeString()} 前有效
        </div>
        {quote.assumptions?.length ? <ul className="assistant-quote-assumptions">
          {quote.assumptions.map(item => <li key={item}>{item}</li>)}
        </ul> : null}
        <button className="assistant-quote-submit" disabled={busy || Date.now() > new Date(quote.expiresAt).getTime()}
          onClick={() => void submit(quote)}><Check size={15} />确认并提交生产</button>
      </div>)}
      {quotes.filter(quote => quote.status === 'submitted').map(quote => <div key={quote.id} className="assistant-quote submitted">
        <Check size={14} />已提交运行 {quote.submittedRunId}
      </div>)}
    </div>

    {error && <div className="assistant-error"><CircleAlert size={14} /><span>{error}</span>
      {lastInput && <button disabled={busy} onClick={() => void send(lastInput)}>重试</button>}</div>}

    <div className="assistant-input">
      <textarea
        value={input}
        rows={2}
        placeholder="问点什么，或描述你想生成的内容…"
        aria-label="向 AI 工作区发送消息"
        onChange={event => setInput(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
        }}
      />
      <button className="assistant-send" disabled={busy || !input.trim()} onClick={() => void send()} aria-label="发送">
        <SendHorizonal size={16} />
      </button>
    </div>
    <footer className="assistant-footnote">助手不会自行扣费；付费生产必须你在估价卡上确认。预计花费与预算上限分开显示。</footer>
  </aside>;
}
