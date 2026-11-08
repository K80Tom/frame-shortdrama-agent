import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AlertCircle, ArrowRight, LoaderCircle, LockKeyhole, LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import { AmbientFX } from './ambient';
import { AuthApiError, fetchAuthSession, loginWithPassword, logoutAuthSession, validateLoginInput, type AuthSession } from './auth';
import { clearActiveWorkspaceId, writeActiveWorkspaceId } from './deployment';
import './auth.css';

type AuthContextValue = {
  mode: 'authenticated' | 'legacy';
  session: AuthSession | null;
  legacyMessage: string;
  loggingOut: boolean;
  logoutError: string;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthBoundary.');
  return value;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function AuthMark() {
  return <div className="auth-brand" aria-label="Lyra Story Studio"><span aria-hidden="true">✦</span><strong>LYRA<small>STORY STUDIO</small></strong></div>;
}

function AuthFrame({ children }: { children: ReactNode }) {
  return <main className="auth-shell"><AmbientFX /><section className="auth-card"><AuthMark />{children}<footer>Session 模式由服务端 HttpOnly Cookie 保护；密码不会保存在浏览器草稿中。</footer></section></main>;
}

export function LoginView({ busy, error, onLogin }: {
  busy: boolean; error: string; onLogin: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateLoginInput(email, password);
    if (validation) { setLocalError(validation); return; }
    setLocalError('');
    await onLogin(email, password);
  }
  const visibleError = localError || error;
  return <AuthFrame><div className="auth-heading"><span>SECURE WORKSPACE</span><h1>登录到创作工作台</h1><p>登录后只能访问你已获授权的 workspace。</p></div>
    <form className="auth-form" onSubmit={event => { void submit(event); }} aria-busy={busy}>
      <label htmlFor="auth-email">邮箱<input id="auth-email" type="email" autoComplete="email" inputMode="email" maxLength={254} required value={email} disabled={busy} onChange={event => { setEmail(event.target.value); setLocalError(''); }} placeholder="you@example.com" /></label>
      <label htmlFor="auth-password">密码<input id="auth-password" type="password" autoComplete="current-password" maxLength={1024} required value={password} disabled={busy} onChange={event => { setPassword(event.target.value); setLocalError(''); }} placeholder="输入密码" /></label>
      {visibleError && <div className="auth-error" role="alert"><AlertCircle size={16} /><p>{visibleError}</p></div>}
      <button className="auth-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle size={16} className="deployment-spin" /> : <LockKeyhole size={16} />}{busy ? '正在验证…' : '登录'}{!busy && <ArrowRight size={15} />}</button>
    </form>
    <div className="auth-policy"><ShieldCheck size={16} /><p>Workspace 成员资格以后端会话为准，前端不会伪造身份或越过登录。</p></div>
  </AuthFrame>;
}

export function SessionControlView({ mode, session, busy, error, legacyMessage = '', onLogout }: {
  mode: 'authenticated' | 'legacy'; session: AuthSession | null; busy: boolean; error: string; legacyMessage?: string; onLogout: () => void;
}) {
  if (mode === 'legacy') return <span className="legacy-session" title={legacyMessage || '后端明确未配置登录；未建立用户会话。'}><AlertCircle size={13} />Legacy · 未登录</span>;
  const name = session?.user.displayName ?? '未知用户';
  return <div className="session-control"><span className="session-avatar" aria-hidden="true">{Array.from(name)[0]?.toUpperCase() ?? 'U'}</span><span className="session-copy"><small>已登录</small><strong>{name}</strong></span><button onClick={onLogout} disabled={busy} aria-label={`退出 ${name}`} title="退出登录">{busy ? <LoaderCircle size={14} className="deployment-spin" /> : <LogOut size={14} />}</button>{error && <span className="session-error" role="alert">{error}</span>}</div>;
}

export function SessionControl() {
  const auth = useAuth();
  return <SessionControlView mode={auth.mode} session={auth.session} busy={auth.loggingOut} error={auth.logoutError} legacyMessage={auth.legacyMessage} onLogout={() => { void auth.logout(); }} />;
}

export default function AuthBoundary({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<'checking' | 'anonymous' | 'authenticated' | 'legacy' | 'error'>('checking');
  const [session, setSession] = useState<AuthSession | null>(null);
  const [checkError, setCheckError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [legacyMessage, setLegacyMessage] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [revision, setRevision] = useState(0);

  const acceptSession = useCallback((value: AuthSession) => {
    try { writeActiveWorkspaceId(value.currentWorkspaceId); } catch { /* Session still provides the server default. */ }
    setSession(value); setPhase('authenticated'); setCheckError(''); setLoginError('');
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setPhase('checking'); setCheckError('');
    const restore = async () => {
      try { return await fetchAuthSession(controller.signal); }
      catch (error) {
        // A previous selection can disappear after membership is revoked, or
        // contain the old Legacy sentinel after auth is enabled. Recover from
        // the server-side default instead of trapping the user in a retry loop.
        if (error instanceof AuthApiError
          && (error.code === 'RESOURCE_NOT_FOUND' || error.code === 'AUTH_WORKSPACE_INVALID')) {
          clearActiveWorkspaceId();
          return fetchAuthSession(controller.signal, false);
        }
        throw error;
      }
    };
    void restore().then(value => {
      if (!controller.signal.aborted) acceptSession(value);
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (error instanceof AuthApiError && error.kind === 'unauthenticated') {
        clearActiveWorkspaceId(); setSession(null); setPhase('anonymous'); return;
      }
      if (error instanceof AuthApiError && error.kind === 'not-configured') {
        clearActiveWorkspaceId(); setSession(null); setLegacyMessage(error.message); setPhase('legacy'); return;
      }
      setCheckError(message(error, '无法确认当前会话。')); setPhase('error');
    });
    return () => controller.abort();
  }, [revision, acceptSession]);

  async function login(email: string, password: string) {
    if (loginBusy) return;
    setLoginBusy(true); setLoginError('');
    try { acceptSession(await loginWithPassword(email, password)); }
    catch (error) {
      if (error instanceof AuthApiError && error.kind === 'not-configured') {
        clearActiveWorkspaceId(); setSession(null); setLegacyMessage(error.message); setPhase('legacy');
      } else setLoginError(message(error, '登录失败，请重试。'));
    } finally { setLoginBusy(false); }
  }

  const logout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true); setLogoutError('');
    try {
      await logoutAuthSession();
      clearActiveWorkspaceId(); setSession(null); setPhase('anonymous');
    } catch (error) {
      if (error instanceof AuthApiError && error.kind === 'unauthenticated') {
        clearActiveWorkspaceId(); setSession(null); setPhase('anonymous');
      } else if (error instanceof AuthApiError && error.kind === 'not-configured') {
        clearActiveWorkspaceId(); setSession(null); setLegacyMessage(error.message); setPhase('legacy');
      } else setLogoutError(message(error, '退出失败，会话仍保持。'));
    } finally { setLoggingOut(false); }
  }, [loggingOut]);

  if (phase === 'checking' || phase === 'error') return <AuthFrame><div className="auth-check" aria-busy={phase === 'checking'}>{phase === 'checking' ? <LoaderCircle size={24} className="deployment-spin" /> : <AlertCircle size={24} />}<h1>{phase === 'checking' ? '正在确认会话' : '无法确认会话'}</h1><p>{phase === 'checking' ? '从服务端读取用户与 workspace 权限…' : checkError}</p>{phase === 'error' && <button onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} />重试</button>}</div></AuthFrame>;
  if (phase === 'anonymous') return <LoginView busy={loginBusy} error={loginError} onLogin={login} />;

  const context: AuthContextValue = { mode: phase === 'legacy' ? 'legacy' : 'authenticated', session, legacyMessage, loggingOut, logoutError, logout };
  return <AuthContext.Provider value={context}>{children}</AuthContext.Provider>;
}
