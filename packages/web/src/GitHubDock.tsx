import type { SVGProps } from 'react';
import './github-dock.css';

const repositoryUrl = 'https://github.com/K80Tom/frame-shortdrama-agent';

function GitHubMark({ width = 18, height = 18, ...props }: SVGProps<SVGSVGElement>) {
  return <svg width={width} height={height} viewBox="0 0 24 24" fill="currentColor" role="img" {...props}>
    <path d="M12 .7A11.3 11.3 0 0 0 8.43 22.72c.57.11.78-.25.78-.55V20c-3.19.69-3.86-1.35-3.86-1.35-.52-1.33-1.27-1.68-1.27-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.25 3.34.95.1-.74.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.47.11-3.06 0 0 .96-.31 3.12 1.18a10.8 10.8 0 0 1 5.68 0c2.17-1.49 3.12-1.18 3.12-1.18.62 1.59.23 2.77.11 3.06.73.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .3.21.66.79.55A11.3 11.3 0 0 0 12 .7Z" />
  </svg>;
}

export type GitHubDockLink = {
  id: string;
  label: string;
  ariaLabel: string;
  href: string;
  emoji: string;
};

export const githubDockLinks: GitHubDockLink[] = [
  { id: 'follow', label: '关注', ariaLabel: '前往 GitHub 关注作者 K80Tom', href: 'https://github.com/K80Tom', emoji: '👋' },
  { id: 'star', label: 'Star', ariaLabel: '前往 GitHub 为 Lyra 添加 Star', href: repositoryUrl, emoji: '⭐️' },
  { id: 'fork', label: 'Fork', ariaLabel: '前往 GitHub Fork Lyra', href: `${repositoryUrl}/fork`, emoji: '🍴' },
  { id: 'watch', label: 'Watch', ariaLabel: '前往 GitHub 设置 Lyra Watch', href: `${repositoryUrl}/subscription`, emoji: '👀' },
  { id: 'run', label: '运行', ariaLabel: '在 GitHub Codespaces 中运行 Lyra', href: 'https://codespaces.new/K80Tom/frame-shortdrama-agent?quickstart=1', emoji: '🚀' },
];

export default function GitHubDock() {
  return <section className="github-dock" aria-label="GitHub 开源项目">
    <a className="github-dock-heading" href={repositoryUrl} target="_blank" rel="noopener noreferrer" aria-label="在 GitHub 查看 Lyra 仓库">
      <span className="github-dock-mark"><GitHubMark width={15} height={15} aria-hidden="true" /></span>
      <span><strong>GitHub</strong><small>开源项目</small></span>
      <span className="github-dock-hint">仓库 ↗</span>
    </a>
    <nav className="github-dock-actions" aria-label="GitHub 项目操作">
      {githubDockLinks.map(link => <a
        key={link.id}
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={link.ariaLabel}
        title={link.ariaLabel}
        data-tooltip={link.label}
      >
        <span className="github-dock-emoji" aria-hidden="true">{link.emoji}</span>
      </a>)}
    </nav>
  </section>;
}
