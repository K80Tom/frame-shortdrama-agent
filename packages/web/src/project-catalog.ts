import { useEffect, useState } from 'react';
import type { Draft } from './model';

export type ProjectSummary = {
  id: string; title: string; createdAt: string;
  currentScriptVersionId: string | null;
  activePlanRevisionId: string | null;
  activeStoryboardRevisionId: string | null;
};
export type NovelSummary = { id: string; title: string; createdAt: string; chapterCount: number };
export type ProjectEntry = {
  id: string; title: string; kind: 'project' | 'novel' | 'practice'; date: string | null; status: string;
};
type CollectionState<T> = { items: T[]; status: 'loading' | 'ready' | 'error'; error: string };
export type ProjectCatalogCollection<T> = CollectionState<T> & { retry: () => void };
export type ProjectCatalog = {
  entries: ProjectEntry[];
  projects: ProjectCatalogCollection<ProjectSummary>;
  novels: ProjectCatalogCollection<NovelSummary>;
};

export const projectKindLabels = { project: '剧本项目', novel: '小说原文', practice: '本地练习' };
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function nullableId(value: unknown) { return value === null || typeof value === 'string'; }
function summary(value: unknown): value is Record<string, unknown> & { id: string; title: string; createdAt: string } {
  return record(value) && typeof value.id === 'string' && typeof value.title === 'string'
    && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt));
}
function isProject(value: unknown): value is ProjectSummary {
  return summary(value) && record(value) && nullableId(value.currentScriptVersionId)
    && nullableId(value.activePlanRevisionId) && nullableId(value.activeStoryboardRevisionId);
}
function isNovel(value: unknown): value is NovelSummary {
  return summary(value) && record(value) && Number.isInteger(value.chapterCount)
    && typeof value.chapterCount === 'number' && value.chapterCount >= 0;
}

// Each source has its own request lifetime, error, and retry action.
// A failed source must not hide the other source or the browser's local practice.
function useCollection<T>(path: string, key: string, valid: (item: unknown) => item is T): ProjectCatalogCollection<T> {
  const [attempt, setAttempt] = useState(0);
  const [collection, setCollection] = useState<CollectionState<T>>({ items: [], status: 'loading', error: '' });
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 12_000);
    setCollection(previous => ({ ...previous, status: 'loading', error: '' }));
    void (async () => {
      try {
        const response = await fetch(path, { signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 503 ? '本地服务暂不可用，请确认后端与数据库已启动。' : `读取失败（${response.status}），请稍后重试。`);
        const data: unknown = await response.json();
        if (!record(data) || !Array.isArray(data[key]) || !data[key].every(valid)) throw new Error('目录响应格式异常，请重试或检查本地服务。');
        if (!disposed) setCollection({ items: data[key] as T[], status: 'ready', error: '' });
      } catch (error) {
        if (disposed) return;
        const message = timedOut ? '连接本地服务超时，请确认服务已启动后重试。'
          : error instanceof TypeError ? '暂时无法连接本地服务，请确认后端已启动。'
            : error instanceof Error ? error.message : '暂时无法读取目录。';
        setCollection(previous => ({ ...previous, status: 'error', error: message }));
      } finally { window.clearTimeout(timer); }
    })();
    return () => { disposed = true; window.clearTimeout(timer); controller.abort(); };
  }, [path, key, valid, attempt]);
  return { ...collection, retry: () => setAttempt(previous => previous + 1) };
}

export function formatProjectDate(value: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? dateFormatter.format(new Date(value)).replaceAll('/', '-') : '本地样例';
}

/** Read-only catalog; saved sources are newest first, with the local practice last. */
export function useProjectCatalog(draft: Draft): ProjectCatalog {
  const projects = useCollection('/api/projects', 'items', isProject);
  const novels = useCollection('/api/novels', 'novels', isNovel);
  const remoteEntries: ProjectEntry[] = [
    ...projects.items.map(project => ({
      id: project.id, title: project.title, kind: 'project' as const, date: project.createdAt,
      status: project.activeStoryboardRevisionId ? '已采用分镜' : project.activePlanRevisionId ? '已采用事实' : project.currentScriptVersionId ? '已保存原文' : '等待剧本',
    })),
    ...novels.items.map(novel => ({ id: novel.id, title: novel.title, kind: 'novel' as const, date: novel.createdAt,
      status: '已导入原文' })),
  ].sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || a.id.localeCompare(b.id));
  const practice: ProjectEntry = { id: 'local-practice', title: '赴约 · 分镜练习', kind: 'practice', date: draft.savedAt,
    status: draft.savedAt ? `草稿 V${draft.revision}` : '手写样例' };
  return { entries: [...remoteEntries, practice], projects, novels };
}
