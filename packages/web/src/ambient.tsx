import {
  createContext, useContext, useEffect, useRef, useState,
  type CSSProperties, type ReactNode,
} from 'react';
import type { WorkspaceRoute } from './navigation';

export type BackdropVariant = 'landing' | 'auth' | 'workspace' | 'focus';

type LyraRuntimeConfig = { backdropVideoUrl?: string; backdropPosterUrl?: string };
declare global { interface Window { __LYRA_RUNTIME_CONFIG__?: LyraRuntimeConfig } }

function configuredAsset(runtimeKey: keyof LyraRuntimeConfig, developmentValue: string | undefined): string {
  const runtimeValue = typeof window === 'undefined' ? '' : window.__LYRA_RUNTIME_CONFIG__?.[runtimeKey];
  return runtimeValue?.trim() || developmentValue?.trim() || '';
}

const DEFAULT_VIDEO_URL = configuredAsset('backdropVideoUrl', import.meta.env.VITE_LYRA_BACKDROP_VIDEO_URL as string | undefined);
const DEFAULT_POSTER_URL = configuredAsset('backdropPosterUrl', import.meta.env.VITE_LYRA_BACKDROP_POSTER_URL as string | undefined);
const SCRUB_SENSITIVITY = 0.8;
export const WORKSPACE_PLAYBACK_RATE = 0.2;
const FOCUS_PROJECT_SECTIONS = new Set(['source', 'screenplay', 'storyboard', 'director', 'production']);
const WORKSPACE_PAGES = new Set(['studio', 'projects', 'assets', 'methods', 'evolution']);

type NetworkInformationLike = EventTarget & { saveData?: boolean };
type NavigatorWithConnection = Navigator & { connection?: NetworkInformationLike };

export function backdropVariantForRoute(route: Pick<WorkspaceRoute, 'page' | 'projectSection'>): 'workspace' | 'focus' {
  if (route.projectSection && FOCUS_PROJECT_SECTIONS.has(route.projectSection)) return 'focus';
  return WORKSPACE_PAGES.has(route.page) ? 'workspace' : 'focus';
}

export function nextScrubTime(current: number, deltaX: number, viewportWidth: number, duration: number,
  sensitivity = SCRUB_SENSITIVITY): number {
  if (![current, deltaX, viewportWidth, duration, sensitivity].every(Number.isFinite)
    || viewportWidth <= 0 || duration <= 0) return current;
  return Math.min(duration, Math.max(0, current + (deltaX / viewportWidth) * sensitivity * duration));
}

const BackdropContext = createContext<(variant: BackdropVariant) => void>(() => undefined);

export function BackdropMode({ variant }: { variant: BackdropVariant }) {
  const setVariant = useContext(BackdropContext);
  useEffect(() => { setVariant(variant); }, [setVariant, variant]);
  return null;
}

export function BackdropProvider({ children }: { children: ReactNode }) {
  const [variant, setVariant] = useState<BackdropVariant>('landing');
  return <BackdropContext.Provider value={setVariant}>
    <LyraBackdrop variant={variant} />
    <div className="lyra-experience-content">{children}</div>
  </BackdropContext.Provider>;
}

export function LyraBackdrop({ variant, videoUrl = DEFAULT_VIDEO_URL, posterUrl = DEFAULT_POSTER_URL }: {
  variant: BackdropVariant;
  videoUrl?: string;
  posterUrl?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const clickLayer = useRef<HTMLDivElement | null>(null);
  const targetTime = useRef(0);
  const [mediaEnabled, setMediaEnabled] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const precisePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    const connection = (navigator as NavigatorWithConnection).connection;
    const update = () => setMediaEnabled(!reduced.matches && precisePointer.matches && !connection?.saveData);
    update();
    reduced.addEventListener('change', update);
    precisePointer.addEventListener('change', update);
    connection?.addEventListener('change', update);
    return () => {
      reduced.removeEventListener('change', update);
      precisePointer.removeEventListener('change', update);
      connection?.removeEventListener('change', update);
    };
  }, []);

  useEffect(() => { setVideoFailed(false); }, [videoUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = WORKSPACE_PLAYBACK_RATE;
    const syncPlayback = () => {
      if (variant === 'workspace' && mediaEnabled && !document.hidden) void video.play().catch(() => undefined);
      else {
        video.pause();
        targetTime.current = video.currentTime;
      }
    };
    syncPlayback();
    document.addEventListener('visibilitychange', syncPlayback);
    return () => document.removeEventListener('visibilitychange', syncPlayback);
  }, [mediaEnabled, variant, videoUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || variant !== 'landing' || !mediaEnabled) return;
    let previousX: number | null = null;
    let animationFrame = 0;

    const commitSeek = () => {
      animationFrame = 0;
      if (!Number.isFinite(video.duration) || video.duration <= 0 || video.seeking) return;
      if (Math.abs(video.currentTime - targetTime.current) > 0.015) video.currentTime = targetTime.current;
    };
    const scheduleSeek = () => {
      if (!animationFrame) animationFrame = window.requestAnimationFrame(commitSeek);
    };
    const move = (event: MouseEvent) => {
      if (previousX === null) { previousX = event.clientX; return; }
      const deltaX = event.clientX - previousX;
      previousX = event.clientX;
      const base = Number.isFinite(targetTime.current) ? targetTime.current : video.currentTime;
      targetTime.current = nextScrubTime(base, deltaX, window.innerWidth, video.duration);
      scheduleSeek();
    };
    const seeked = () => {
      if (Math.abs(video.currentTime - targetTime.current) > 0.015) scheduleSeek();
    };
    const reset = () => { previousX = null; };
    window.addEventListener('mousemove', move, { passive: true });
    window.addEventListener('blur', reset);
    video.addEventListener('seeked', seeked);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('blur', reset);
      video.removeEventListener('seeked', seeked);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
    };
  }, [mediaEnabled, variant, videoUrl]);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const spawn = (event: PointerEvent) => {
      if (reduced.matches || variant === 'focus') return;
      const layer = clickLayer.current;
      if (!layer || layer.childElementCount > 24) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const ripple = document.createElement('span');
      ripple.className = 'ambient-ripple';
      ripple.style.left = `${event.clientX}px`;
      ripple.style.top = `${event.clientY}px`;
      layer.appendChild(ripple);
      window.setTimeout(() => { ripple.remove(); }, 700);
    };
    window.addEventListener('pointerdown', spawn);
    return () => window.removeEventListener('pointerdown', spawn);
  }, [variant]);

  const hasVideo = Boolean(videoUrl && mediaEnabled && !videoFailed);
  const mediaStyle = posterUrl ? { '--lyra-backdrop-poster': `url(${JSON.stringify(posterUrl)})` } as CSSProperties : undefined;
  return <>
    <div className="ambient-backdrop lyra-backdrop" data-backdrop-variant={variant}
      data-video-configured={videoUrl ? 'true' : 'false'} data-video-active={hasVideo ? 'true' : 'false'} aria-hidden="true">
      <div className="ambient-media" style={mediaStyle}>
        {hasVideo && <video ref={videoRef} className="ambient-video" src={videoUrl} muted playsInline loop
          preload="auto" tabIndex={-1} onLoadedMetadata={event => {
            const video = event.currentTarget;
            const initialTime = video.currentTime === 0 && Number.isFinite(video.duration) ? video.duration * 0.35 : video.currentTime;
            targetTime.current = initialTime;
            if (Math.abs(video.currentTime - initialTime) > 0.015) video.currentTime = initialTime;
            if (variant === 'workspace' && !document.hidden) void video.play().catch(() => undefined);
          }} onError={() => setVideoFailed(true)} />}
      </div>
      <span className="ambient-aurora a1" />
      <span className="ambient-aurora a2" />
      <span className="ambient-aurora a3" />
      <span className="ambient-grain" />
      <span className="ambient-wash" />
      <span className="ambient-vignette" />
      {hasVideo && variant === 'landing' && <span className="ambient-scrub-hint"><i />移动光标 · 推动场景</span>}
    </div>
    <div className="ambient-clickfx" ref={clickLayer} aria-hidden="true" />
  </>;
}
