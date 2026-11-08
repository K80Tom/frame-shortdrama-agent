import { lazy, Suspense, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Check, Info, X } from 'lucide-react';
import SpotlightCard from './vendor/SpotlightCard';

export function BrandWordmark() {
  return <strong className="brand-lockup">
    <span className="brand-wordmark" data-wordmark="Lyra">Lyra</span>
    <span className="brand-subtitle">STORY STUDIO</span>
  </strong>;
}

export function Brand() {
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const [originOpen, setOriginOpen] = useState(false);
  const [originHover, setOriginHover] = useState(false);
  const [originPos, setOriginPos] = useState({ top: 0, left: 0 });
  const originId = useId();

  function showOrigin() {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) {
      // 卡片 portal 到 body：桌面弹到侧栏右侧，移动端落在 Brand 下方，避免被侧栏裁剪或遮住导航。
      const compact = window.innerWidth <= 720;
      setOriginPos(compact
        ? { top: rect.bottom + 10, left: Math.max(12, rect.left) }
        : { top: Math.max(12, rect.top - 4), left: rect.right + 22 });
    }
    setOriginHover(true);
  }

  const visible = originHover || originOpen;

  return <>
    <a
      ref={anchorRef}
      className={`brand${originOpen ? ' lyra-open' : ''}`}
      href="#/studio"
      aria-label="Lyra 创作首页"
      aria-describedby={originId}
      aria-expanded={visible}
      onMouseEnter={showOrigin}
      onMouseLeave={() => setOriginHover(false)}
      onFocus={showOrigin}
      onBlur={() => { setOriginHover(false); setOriginOpen(false); }}
      onClick={event => {
        // 触屏没有 hover：第一次点按只展开命名由来，第二次才进入首页。
        if (window.matchMedia('(hover: none)').matches && !originOpen) {
          event.preventDefault();
          showOrigin();
          setOriginOpen(true);
        }
      }}
    >
      <span className="brand-symbol" aria-hidden="true">
        <svg className="lyra-mark" viewBox="0 0 64 64" width="30" height="30">
          <line className="lyra-link" x1="16" y1="28" x2="32" y2="22" />
          <line className="lyra-link" x1="32" y1="22" x2="42" y2="34" />
          <line className="lyra-link" x1="42" y1="34" x2="24" y2="42" />
          <line className="lyra-link" x1="24" y1="42" x2="16" y2="28" />
          <line className="lyra-gold-link" x1="32" y1="22" x2="44" y2="16.5" />
          <circle className="lyra-star" style={{ '--i': 0 } as CSSProperties} cx="16" cy="28" r="2.4" />
          <circle className="lyra-star" style={{ '--i': 1 } as CSSProperties} cx="32" cy="22" r="2.4" />
          <circle className="lyra-star" style={{ '--i': 2 } as CSSProperties} cx="42" cy="34" r="2.4" />
          <circle className="lyra-star" style={{ '--i': 3 } as CSSProperties} cx="24" cy="42" r="2.4" />
          <g className="lyra-vega">
            <circle className="lyra-vega-halo" cx="46" cy="15" r="6" />
            <path className="lyra-vega-star" d="M46 8 L47.6 13.4 L53 15 L47.6 16.6 L46 22 L44.4 16.6 L39 15 L44.4 13.4 Z" />
          </g>
        </svg>
      </span>
      <BrandWordmark />
    </a>
    {createPortal(
      <span
        className={`brand-origin${visible ? ' visible' : ''}`}
        id={originId}
        role="note"
        style={originPos}
        aria-hidden={!visible}
      >
        <strong>皓辰是星，Lyra 是座。</strong>
        <span>皓 = 天琴座最亮的织女星 Vega；辰 = 星辰。</span>
        <span>天琴座是俄耳甫斯之琴，讲故事的乐器。</span>
        <span className="brand-origin-tagline">Lyra · 皓辰的造剧星座——每一集短剧，都是一颗新星。</span>
      </span>,
      document.body,
    )}
  </>;
}
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <SpotlightCard className={className} spotlightColor="rgba(244, 131, 84, 0.13)">{children}</SpotlightCard>;
}
export function ArrowButton({ children, onClick, secondary = false }: { children: ReactNode; onClick: () => void; secondary?: boolean }) {
  return <button className={`button ${secondary ? 'secondary' : 'primary'} arrow-button`} onClick={onClick}>{children}<ArrowUpRight size={17} /></button>;
}
export function Tag({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`tag ${tone}`}>{children}</span>;
}
export function PageHeading({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="muted">{description}</p></div><div className="heading-actions">{children}</div></div>;
}
export function Notice({ children }: { children: ReactNode }) {
  return <p className="notice"><Info size={15} aria-hidden="true" /><span>{children}</span></p>;
}
export function Modal({ open, title, onClose, children, className = '' }: { open: boolean; title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className={`modal ${className}`} aria-label={title} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button></div>{children}
  </dialog>;
}
const DirectorPreview = lazy(() => import('./director/DirectorPreview'));
export function WhitePreview() {
  return <Suspense fallback={<p className="notice">正在准备白模画布…</p>}><DirectorPreview /></Suspense>;
}
export function Toast({ text }: { text: string }) {
  return <div className={`toast ${text ? 'show' : ''}`} role="status" aria-live="polite"><Check size={16} /><span>{text}</span></div>;
}
