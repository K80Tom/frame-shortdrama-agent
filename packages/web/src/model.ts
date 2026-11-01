import reference from '../../main/examples/斗破苍穹-数据结构-v0.1.json';

export const originalScript = reference.scriptVersions[0].rawText;
export const plan = reference.planRevisions[0];
export const sampleImage = '/assets/duel.png';
export type Page = 'studio' | 'projects' | 'plugins' | 'automation' | 'evolution' | 'production' | 'novel' | 'script' | 'storyboard' | 'assets' | 'director' | 'flow' | 'settings';
export type ShotDraft = {
  id: string; title: string; description: string; size: string;
  camera: string; seconds: number; dialogue: string; speaker: string;
  original: string[]; edited: boolean;
};
export const initialShots: ShotDraft[] = plan.scenes[0].shots.map((shot, index) => {
  const dialogue = plan.dialogues.find(d => d.id === shot.dialogueBindings[0]?.dialogueId);
  return {
    id: shot.id, title: ['赴约，面对旧事', '一句质问', '正视眼前的人', '出招之前'][index],
    description: shot.design.visualDescription.value,
    size: shot.design.shotSize.value, camera: shot.design.cameraMovement.value,
    seconds: shot.design.durationMs.value / 1000,
    dialogue: dialogue?.sourceRef.quote ?? '',
    speaker: plan.characters.find(c => c.id === dialogue?.speakerId)?.name.value ?? '',
    original: shot.sourceRefs.map(ref => ref.quote), edited: false,
  };
});
export type Draft = { script: string; shots: ShotDraft[]; savedAt: string | null; revision: number };
export const defaultDraft: Draft = { script: originalScript, shots: initialShots, savedAt: null, revision: 0 };
export const storageKey = 'frame:ui-draft:v1';
export function isDraft(value: unknown): value is Draft {
  if (!value || typeof value !== 'object') return false;
  const d = value as Draft;
  return typeof d.script === 'string' && d.script.length <= 1_000_000 &&
    Number.isInteger(d.revision) && d.revision >= 0 &&
    (d.savedAt === null || typeof d.savedAt === 'string') &&
    Array.isArray(d.shots) && d.shots.length === initialShots.length && d.shots.every((s, i) =>
      s && s.id === initialShots[i].id && typeof s.title === 'string' &&
      typeof s.description === 'string' && typeof s.size === 'string' && typeof s.camera === 'string' &&
      Number.isFinite(s.seconds) && s.seconds > 0 && s.seconds <= 60 && typeof s.edited === 'boolean' &&
      s.dialogue === initialShots[i].dialogue && s.speaker === initialShots[i].speaker &&
      JSON.stringify(s.original) === JSON.stringify(initialShots[i].original));
}
export function readDraft(): { draft: Draft; error: boolean } {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { draft: structuredClone(defaultDraft), error: false };
    const value: unknown = JSON.parse(raw);
    if (isDraft(value)) return { draft: value, error: false };
  } catch { /* Keep malformed or unavailable storage untouched. */ }
  return { draft: structuredClone(defaultDraft), error: true };
}
export function saveDraft(draft: Draft): Draft {
  const saved = { ...draft, savedAt: new Date().toISOString(), revision: draft.revision + 1 };
  if (!isDraft(saved)) throw new Error('草稿格式不完整');
  const previous = localStorage.getItem(storageKey);
  if (previous) localStorage.setItem(`${storageKey}:previous`, previous);
  localStorage.setItem(storageKey, JSON.stringify(saved));
  return saved;
}
export function exportDraft(draft: Draft) {
  const file = { schemaVersion: 'shortdrama-ui-draft/1', notice: '浏览器编辑草稿；并非 Agent 运行或已采用的生产计划。', draft };
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = '赴约-前端编辑草稿.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
