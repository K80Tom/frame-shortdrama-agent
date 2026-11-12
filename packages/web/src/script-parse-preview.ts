import {
  validateScriptStructure,
  type ScriptDialogueRepairPreview,
  type ScriptParseAttempt,
  type ScriptParseEntity,
  type ScriptParseResult,
  type ScriptStructure,
} from '@lyra/shared';

const STORAGE_NAMESPACE = 'lyra.script-parse-preview.v1';

export interface ScriptParsePreviewDraft {
  attemptId: string;
  scriptVersionId: string;
  structure: ScriptStructure;
  characters: ScriptParseEntity[];
  locations: ScriptParseEntity[];
  props: ScriptParseEntity[];
  repair?: ScriptDialogueRepairPreview;
  promptVersion?: string;
  updatedAt: string;
}

function storageKey(projectId: string, scriptVersionId: string): string {
  return `${STORAGE_NAMESPACE}.${projectId}.${scriptVersionId}`;
}

function validEntities(value: unknown): value is ScriptParseEntity[] {
  return Array.isArray(value) && value.every(item => item && typeof item === 'object'
    && typeof (item as ScriptParseEntity).name === 'string'
    && Array.isArray((item as ScriptParseEntity).aliases));
}

function validRepair(value: unknown): value is ScriptDialogueRepairPreview | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const repair = value as ScriptDialogueRepairPreview;
  return (repair.kind === 'append' || repair.kind === 'exclude')
    && typeof repair.issueId === 'string' && typeof repair.reason === 'string'
    && Array.isArray(repair.addedDialogues) && Array.isArray(repair.exclusions);
}

export function readScriptParsePreview(storage: Storage, projectId: string, scriptVersionId: string): ScriptParsePreviewDraft | null {
  try {
    const raw = storage.getItem(storageKey(projectId, scriptVersionId));
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<ScriptParsePreviewDraft>;
    if (draft.scriptVersionId !== scriptVersionId || typeof draft.attemptId !== 'string'
      || !draft.structure || !validEntities(draft.characters)
      || !validEntities(draft.locations) || !validEntities(draft.props) || !validRepair(draft.repair)) return null;
    validateScriptStructure(draft.structure);
    return draft as ScriptParsePreviewDraft;
  } catch {
    return null;
  }
}

export function writeScriptParsePreview(storage: Storage, projectId: string,
  draft: Omit<ScriptParsePreviewDraft, 'updatedAt'>): boolean {
  try {
    const value: ScriptParsePreviewDraft = { ...draft, updatedAt: new Date().toISOString() };
    storage.setItem(storageKey(projectId, draft.scriptVersionId), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function clearScriptParsePreview(storage: Storage, projectId: string, scriptVersionId: string): void {
  try { storage.removeItem(storageKey(projectId, scriptVersionId)); } catch { /* 清除失败不阻断页面操作。 */ }
}

export function draftFromParseAttempt(attempt: ScriptParseAttempt): Omit<ScriptParsePreviewDraft, 'updatedAt'> | null {
  if (attempt.status !== 'succeeded' || !attempt.output) return null;
  const output = attempt.output;
  return {
    attemptId: attempt.id,
    scriptVersionId: attempt.scriptVersionId,
    structure: output.structure,
    characters: output.characters ?? [],
    locations: output.locations ?? [],
    props: output.props ?? [],
    ...(output.repair ? { repair: output.repair } : {}),
    promptVersion: attempt.promptVersion,
  };
}

export function parseResultFromDraft(draft: ScriptParsePreviewDraft): ScriptParseResult {
  return {
    structure: draft.structure,
    characters: draft.characters,
    locations: draft.locations,
    props: draft.props,
    ...(draft.repair ? { repair: draft.repair } : {}),
  };
}
