import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AlertCircle, ArrowRight, LoaderCircle, LockKeyhole, LogOut, RefreshCw, ShieldCheck, UserPlus, X } from 'lucide-react';
import { BackdropMode } from './ambient';
import {
  AuthApiError, fetchAuthConfig, fetchAuthSession, loginWithPassword, logoutAuthSession,
  registerWorkspace, validateLoginInput, validateWorkspaceRegistration,
  type AuthConfig, type AuthSession, type WorkspaceRegistrationInput,
} from './auth';
import { clearActiveWorkspaceId, writeActiveWorkspaceId } from './deployment';
import { BrandMark } from './components';
import HoloCard from './HoloCard';
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
  return <div className="auth-brand brand" aria-label="Lyra Story Studio"><BrandMark /></div>;
}

function AuthLanding({ onEnter }: { onEnter: () => void }) {
  return <main className="auth-landing" data-backdrop-variant="landing"><BackdropMode variant="landing" />
    <header><AuthMark /></header>
    <section className="auth-landing-copy">
      <h1 className="auth-visually-hidden">Lyra Story Studio</h1>
      <button type="button" onClick={onEnter}><span>登录</span><ArrowRight size={15} /></button>
    </section>
  </main>;
}

function AuthFrame({ children, onClose, wide = false }: { children: ReactNode; onClose?: () => void; wide?: boolean }) {
  return <main className="auth-shell" data-backdrop-variant="auth"><BackdropMode variant="auth" /><HoloCard
    className={`auth-project-card auth-dialog${wide ? ' auth-dialog-wide' : ''}`}
    image="/assets/duel.png" alt="" preset="gold" foilColor="#e8c878" intensity={0.72}
    edgeSparkle={0.82} frame={7} glare={0.32} tiltMax={4.5} hoverScale={1.008}
    radius={20} width={wide ? 560 : 390} idle={false} shadow
  >
    <header><AuthMark />{onClose && <button type="button" onClick={onClose} aria-label="返回欢迎页" title="返回欢迎页"><X size={17} /></button>}</header>
    <section className="auth-entry-panel">{children}</section>
  </HoloCard></main>;
}

export function LoginView({ busy, error, registrationEnabled = false, registerBusy = false, registerError = '', initialMode = 'login', onLogin, onRegister }: {
  busy: boolean; error: string; registrationEnabled?: boolean; registerBusy?: boolean; registerError?: string;
  initialMode?: 'login' | 'register';
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister?: (input: WorkspaceRegistrationInput) => Promise<void>;
}) {
  const canRegister = registrationEnabled && Boolean(onRegister);
  const [mode, setMode] = useState<'login' | 'register'>(initialMode === 'register' && canRegister ? 'register' : 'login');
  const effectiveMode = canRegister ? mode : 'login';
  const [entryOpen, setEntryOpen] = useState(initialMode === 'register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [registration, setRegistration] = useState({ displayName: '', email: '', password: '', confirmPassword: '', workspaceName: '' });
  const [localError, setLocalError] = useState('');
  function switchMode(next: 'login' | 'register') { setMode(next); setLocalError(''); }
  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateLoginInput(email, password);
    if (validation) { setLocalError(validation); return; }
    setLocalError('');
    await onLogin(email, password);
  }
  async function submitRegistration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input: WorkspaceRegistrationInput = registration;
    const validation = validateWorkspaceRegistration(input, registration.confirmPassword);
    if (validation) { setLocalError(validation); return; }
    setLocalError('');
    await onRegister?.(input);
  }
  const pending = effectiveMode === 'login' ? busy : registerBusy;
  const visibleError = localError || (effectiveMode === 'login' ? error : registerError);
  if (!entryOpen) return <AuthLanding onEnter={() => setEntryOpen(true)} />;
  return <AuthFrame wide={effectiveMode === 'register'} onClose={pending ? undefined : () => { setEntryOpen(false); setLocalError(''); }}>
    <nav className="auth-mode-switch" aria-label="账号入口"><button type="button" aria-current={effectiveMode === 'login' ? 'page' : undefined} onClick={() => switchMode('login')} disabled={pending}>登录</button><button type="button" aria-current={effectiveMode === 'register' ? 'page' : undefined} aria-disabled={!canRegister} onClick={() => {
      if (canRegister) switchMode('register');
      else setLocalError('当前部署尚未开启自助注册；管理员可将 LYRA_REGISTRATION_MODE 设为 workspace。');
    }} disabled={pending}>创建工作室{!canRegister && <small>未开启</small>}</button></nav>
    <div className="auth-entry-head"><span>SECURE CREATOR ACCESS</span><h1>{effectiveMode === 'login' ? '登录工作台' : '创建工作室'}</h1><p>{effectiveMode === 'login' ? '使用你的账号继续创作。' : '创建独立 workspace，并成为它的 owner。'}</p></div>
    {effectiveMode === 'login' ? <form className="auth-form" onSubmit={event => { void submitLogin(event); }} aria-busy={busy}>
      <label htmlFor="auth-email">邮箱<input id="auth-email" type="email" autoComplete="email" inputMode="email" maxLength={254} required value={email} disabled={busy} onChange={event => { setEmail(event.target.value); setLocalError(''); }} placeholder="you@example.com" /></label>
      <label htmlFor="auth-password">密码<input id="auth-password" type="password" autoComplete="current-password" maxLength={1024} required value={password} disabled={busy} onChange={event => { setPassword(event.target.value); setLocalError(''); }} placeholder="输入密码" /></label>
      {visibleError && <div className="auth-error" role="alert"><AlertCircle size={16} /><p>{visibleError}</p></div>}
      <button className="auth-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle size={16} className="deployment-spin" /> : <LockKeyhole size={16} />}{busy ? '正在验证…' : '登录'}{!busy && <ArrowRight size={15} />}</button>
    </form> : <form className="auth-form auth-register-form" onSubmit={event => { void submitRegistration(event); }} aria-busy={registerBusy}>
      <div className="auth-field-grid"><label htmlFor="auth-display-name">你的昵称<input id="auth-display-name" autoComplete="name" maxLength={120} required value={registration.displayName} disabled={registerBusy} onChange={event => { setRegistration(value => ({ ...value, displayName: event.target.value })); setLocalError(''); }} placeholder="例如：林导演" /></label><label htmlFor="auth-workspace-name">工作室名称<input id="auth-workspace-name" autoComplete="organization" maxLength={120} required value={registration.workspaceName} disabled={registerBusy} onChange={event => { setRegistration(value => ({ ...value, workspaceName: event.target.value })); setLocalError(''); }} placeholder="例如：星河片场" /></label></div>
      <label htmlFor="auth-register-email">邮箱<input id="auth-register-email" type="email" autoComplete="email" inputMode="email" maxLength={254} required value={registration.email} disabled={registerBusy} onChange={event => { setRegistration(value => ({ ...value, email: event.target.value })); setLocalError(''); }} placeholder="you@example.com" /></label>
      <div className="auth-field-grid"><label htmlFor="auth-register-password">密码<input id="auth-register-password" type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={registration.password} disabled={registerBusy} onChange={event => { setRegistration(value => ({ ...value, password: event.target.value })); setLocalError(''); }} placeholder="至少 12 个字符" /></label><label htmlFor="auth-confirm-password">确认密码<input id="auth-confirm-password" type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={registration.confirmPassword} disabled={registerBusy} onChange={event => { setRegistration(value => ({ ...value, confirmPassword: event.target.value })); setLocalError(''); }} placeholder="再输入一次" /></label></div>
      <p className="auth-workspace-note"><ShieldCheck size={14} />租户边界（workspace ID）和角色由后端生成，不接受前端指定。</p>
      {visibleError && <div className="auth-error" role="alert"><AlertCircle size={16} /><p>{visibleError}</p></div>}
      <button className="auth-submit" type="submit" disabled={registerBusy}>{registerBusy ? <LoaderCircle size={16} className="deployment-spin" /> : <UserPlus size={16} />}{registerBusy ? '正在创建…' : '创建独立工作室'}{!registerBusy && <ArrowRight size={15} />}</button>
    </form>}
    <div className="auth-policy"><ShieldCheck size={16} /><p>{effectiveMode === 'login' ? 'Workspace 成员资格以后端会话为准，前端不会伪造身份或越过登录。' : '注册只会创建新 workspace；当前版本不支持自助加入已有 workspace，需联系管理员。'}</p></div>
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
  const [authConfig, setAuthConfig] = useState<AuthConfig>({ registrationMode: 'disabled' });
  const [checkError, setCheckError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [registerBusy, setRegisterBusy] = useState(false);
  const [registerError, setRegisterError] = useState('');
  const [legacyMessage, setLegacyMessage] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [revision, setRevision] = useState(0);

  const acceptSession = useCallback((value: AuthSession) => {
    try { writeActiveWorkspaceId(value.currentWorkspaceId); } catch { /* Session still provides the server default. */ }
    setSession(value); setPhase('authenticated'); setCheckError(''); setLoginError(''); setRegisterError('');
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setPhase('checking'); setCheckError('');
    // Registration is fail-closed: a missing, unreachable or malformed config
    // never makes the public registration form appear.
    void fetchAuthConfig(controller.signal).then(value => {
      if (!controller.signal.aborted) setAuthConfig(value);
    }).catch(() => {
      if (!controller.signal.aborted) setAuthConfig({ registrationMode: 'disabled' });
    });
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

  async function register(input: WorkspaceRegistrationInput) {
    if (registerBusy || authConfig.registrationMode !== 'workspace') return;
    setRegisterBusy(true); setRegisterError('');
    try { acceptSession(await registerWorkspace(input)); }
    catch (error) {
      if (error instanceof AuthApiError
        && (error.kind === 'not-configured' || error.code === 'AUTH_REGISTRATION_DISABLED')) {
        setAuthConfig({ registrationMode: 'disabled' });
        setRegisterError('');
        setLoginError('当前部署已关闭自助注册，请联系管理员。');
      } else setRegisterError(message(error, '创建工作室失败，请重试。'));
    } finally { setRegisterBusy(false); }
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
  if (phase === 'anonymous') return <LoginView busy={loginBusy} error={loginError}
    registrationEnabled={authConfig.registrationMode === 'workspace'} registerBusy={registerBusy} registerError={registerError}
    onLogin={login} onRegister={register} />;

  const context: AuthContextValue = { mode: phase === 'legacy' ? 'legacy' : 'authenticated', session, legacyMessage, loggingOut, logoutError, logout };
  return <AuthContext.Provider value={context}>{children}</AuthContext.Provider>;
}
