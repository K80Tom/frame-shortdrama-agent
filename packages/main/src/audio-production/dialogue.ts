import {
  AUDIO_PRODUCTION_SCHEMA_VERSION,
  canonicalDigest,
  type DialogueCue,
  type DialogueTrackVersion,
  type ShotSpecV2,
} from '@lyra/shared';

export interface BuildDialogueTrackInput {
  id: string;
  workspaceId: string;
  projectId: string;
  episodeId: string;
  scriptVersionId: string;
  productionInputSnapshotId: string;
  productionInputSnapshotDigest: string;
  shots: ReadonlyArray<Readonly<ShotSpecV2>>;
  createdBy: string;
  createdAt: string;
  baseVersionId?: string | null;
}

function clean(value: string, max: number, field: string): string {
  if (!value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) {
    throw new Error(`Dialogue ${field} is blank, too long or contains control characters.`);
  }
  return value.trim();
}

/**
 * Build an immutable dialogue track from a frozen ShotSpec bundle. Timings are
 * absolute on the episode timeline, derived from shot order and shot duration,
 * never from today's mutable storyboard.
 */
export function buildDialogueTrack(input: BuildDialogueTrackInput): DialogueTrackVersion {
  if (!input.shots.length) throw new Error('A frozen ShotSpec bundle is required.');
  if (new Set(input.shots.map(shot => shot.shotId)).size !== input.shots.length) {
    throw new Error('Frozen ShotSpec bundle contains duplicate shots.');
  }
  const shots = [...input.shots].sort((a, b) => a.order - b.order);
  let shotStartMs = 0;
  const cues: DialogueCue[] = [];
  const seen = new Set<string>();
  for (const shot of shots) {
    if (shot.workspaceId !== input.workspaceId || shot.projectId !== input.projectId || shot.episodeId !== input.episodeId) {
      throw new Error('ShotSpec belongs to another workspace/project/episode.');
    }
    if (shot.scriptVersionId !== input.scriptVersionId) throw new Error('ShotSpec script version does not match the frozen script.');
    const dialogue = new Map(shot.dialogue.map(item => [item.id, item]));
    for (const item of shot.timeline.filter(entry => entry.kind === 'dialogue')) {
      if (seen.has(item.id)) throw new Error(`Duplicate dialogue cue id: ${item.id}`);
      seen.add(item.id);
      if (item.startMs < 0 || item.endMs <= item.startMs || item.endMs > shot.durationMs) {
        throw new Error(`Dialogue cue ${item.id} has invalid timing.`);
      }
      const line = dialogue.get(item.dialogueId ?? '');
      const speaker = line?.speakerEntityId ?? item.entityId;
      const text = clean(item.text, 2_000, 'text');
      const start = shotStartMs + item.startMs;
      const end = shotStartMs + item.endMs;
      cues.push({
        cueId: item.id, shotId: shot.shotId, speakerEntityId: speaker, text,
        language: 'zh-CN', emotion: line?.tone ?? null, pace: null, pauseAfterMs: 0,
        pronunciationHints: [], sourceScriptVersionId: input.scriptVersionId,
        shotSpecVersionId: shot.revisionId, sourceRange: line?.sourceRef
          ? { start: line.sourceRef.start, end: line.sourceRef.end, quote: line.sourceRef.quote }
          : { start: item.startMs, end: item.endMs, quote: item.text },
        sourceDigest: canonicalDigest({ shotId: shot.shotId, revisionId: shot.revisionId, cueId: item.id,
          text: item.text, startMs: item.startMs, endMs: item.endMs, speaker }),
        timing: { expectedStartMs: start, expectedEndMs: end, toleranceMs: 450,
          contextBeforeCueId: null, contextAfterCueId: null },
        adoptedVoiceTakeVersionId: null, waiver: null, reviewStatus: 'pending',
      });
    }
    shotStartMs += shot.durationMs;
  }
  cues.sort((a, b) => a.timing.expectedStartMs - b.timing.expectedStartMs || a.cueId.localeCompare(b.cueId));
  cues.forEach((cue, index) => {
    cue.timing.contextBeforeCueId = cues[index - 1]?.cueId ?? null;
    cue.timing.contextAfterCueId = cues[index + 1]?.cueId ?? null;
  });
  const body = { workspaceId: input.workspaceId, projectId: input.projectId, episodeId: input.episodeId,
    scriptVersionId: input.scriptVersionId, snapshotId: input.productionInputSnapshotId,
    snapshotDigest: input.productionInputSnapshotDigest, cues };
  return {
    schemaVersion: AUDIO_PRODUCTION_SCHEMA_VERSION, id: input.id,
    workspaceId: input.workspaceId, projectId: input.projectId, episodeId: input.episodeId,
    scriptVersionId: input.scriptVersionId, productionInputSnapshotId: input.productionInputSnapshotId,
    productionInputSnapshotDigest: input.productionInputSnapshotDigest,
    cues, baseVersionId: input.baseVersionId ?? null, contentDigest: canonicalDigest(body),
    createdAt: input.createdAt, createdBy: input.createdBy, adoptedAt: null,
  };
}

export interface DialogueDependencyGraph {
  voiceTakes: Array<{ id: string; dialogueCueId: string; voiceProfileVersionId: string; shotId: string }>;
  lipSyncCandidates: Array<{ id: string; shotId: string; voiceTakeVersionId: string }>;
  subtitleVersion: { id: string; dialogueTrackVersionId: string;
    cues: Array<{ id: string; dialogueCueId: string; shotId: string; startMs: number; endMs: number }> } | null;
  cueSheets: Array<{ id: string; cues: Array<{ id: string; dialogueCueId: string | null; shotId: string | null;
    startMs: number; endMs: number; track: string }> }>;
  mixes: Array<{ id: string; cueSheetVersionId: string }>;
  deliveryManifests: Array<{ id: string; mixVersionId: string; subtitleVersionId: string | null;
    timelineVersionId: string; shotIds: string[] }>;
}

export type ProductionChange =
  | { kind: 'dialogue_cue'; track: DialogueTrackVersion; cueIds: string[]; reason: string }
  | { kind: 'voice_profile'; track: DialogueTrackVersion; voiceProfileVersionId: string; cueIds: string[]; reason: string }
  | { kind: 'music_gain'; track: DialogueTrackVersion; cueSheetVersionId: string; cueId: string; reason: string }
  | { kind: 'subtitle_style'; track: DialogueTrackVersion; subtitleVersionId: string; reason: string }
  | { kind: 'video_candidate'; track: DialogueTrackVersion; shotId: string; reason: string };

export interface InvalidationResult {
  change: ProductionChange['kind'];
  sourceIds: string[];
  affected: Array<{ kind: 'voice_take' | 'lip_sync' | 'subtitle_cue' | 'subtitle_version' | 'mix' | 'delivery_manifest';
    id: string; action: 'stale' | 'recompute' | 'rerender' | 'rebuild' }>;
  preserved: Array<{ kind: string; id: string }>;
  reason: string;
  computedAt: string;
}

/**
 * Compute exact downstream impact. Unrelated shots, takes, subtitle cues and mixes
 * are explicitly preserved. This is pure so the same graph can be recomputed after
 * Worker recovery without calling a provider or reading current project state.
 */
export function computeInvalidation(change: ProductionChange, graph: DialogueDependencyGraph,
  computedAt: string): InvalidationResult {
  const affected = new Map<string, InvalidationResult['affected'][number]>();
  const add = (kind: InvalidationResult['affected'][number]['kind'], id: string,
    action: InvalidationResult['affected'][number]['action']) => affected.set(`${kind}:${id}`, { kind, id, action });
  const has = (kind: InvalidationResult['affected'][number]['kind'], id: string) => affected.has(`${kind}:${id}`);

  const cueIds = new Set<string>();
  const shotIds = new Set<string>();
  const windows: Array<{ startMs: number; endMs: number }> = [];
  for (const id of change.kind === 'dialogue_cue' || change.kind === 'voice_profile' ? change.cueIds : []) {
    const cue = change.track.cues.find(item => item.cueId === id);
    if (!cue) throw new Error(`Unknown dialogue cue: ${id}`);
    cueIds.add(id); shotIds.add(cue.shotId);
    windows.push({ startMs: cue.timing.expectedStartMs, endMs: cue.timing.expectedEndMs });
  }
  if (change.kind === 'video_candidate') shotIds.add(change.shotId);

  if (change.kind === 'dialogue_cue' || change.kind === 'voice_profile') {
    for (const take of graph.voiceTakes) {
      const matches = change.kind === 'dialogue_cue' ? cueIds.has(take.dialogueCueId)
        : take.voiceProfileVersionId === change.voiceProfileVersionId && (change.cueIds.length === 0 || cueIds.has(take.dialogueCueId));
      if (!matches) continue;
      add('voice_take', take.id, 'stale');
      shotIds.add(take.shotId);
      cueIds.add(take.dialogueCueId);
      const cue = change.track.cues.find(item => item.cueId === take.dialogueCueId);
      if (cue) windows.push({ startMs: cue.timing.expectedStartMs, endMs: cue.timing.expectedEndMs });
    }
    for (const candidate of graph.lipSyncCandidates) {
      if (shotIds.has(candidate.shotId)
        || [...affected.values()].some(item => item.kind === 'voice_take'
          && item.id === candidate.voiceTakeVersionId)) add('lip_sync', candidate.id, 'stale');
    }
    if (graph.subtitleVersion) {
      for (const cue of graph.subtitleVersion.cues) {
        if (cueIds.has(cue.dialogueCueId) || shotIds.has(cue.shotId)
          || windows.some(window => cue.startMs < window.endMs && cue.endMs > window.startMs)) {
          add('subtitle_cue', cue.id, 'recompute');
        }
      }
    }
  }

  if (change.kind === 'video_candidate') {
    for (const candidate of graph.lipSyncCandidates) {
      if (shotIds.has(candidate.shotId)) add('lip_sync', candidate.id, 'stale');
    }
  }

  if (change.kind === 'subtitle_style') {
    add('subtitle_version', change.subtitleVersionId, 'rerender');
  }

  const affectedSheets = new Set<string>();
  if (change.kind === 'music_gain') affectedSheets.add(change.cueSheetVersionId);
  if (change.kind === 'dialogue_cue' || change.kind === 'voice_profile') {
    for (const sheet of graph.cueSheets) {
      if (sheet.cues.some(cue => (cue.dialogueCueId !== null && cueIds.has(cue.dialogueCueId))
        || (cue.shotId !== null && shotIds.has(cue.shotId))
        || windows.some(window => cue.startMs < window.endMs && cue.endMs > window.startMs))) {
        affectedSheets.add(sheet.id);
      }
    }
  }
  for (const mix of graph.mixes) {
    if (affectedSheets.has(mix.cueSheetVersionId)) add('mix', mix.id, 'rebuild');
  }
  for (const manifest of graph.deliveryManifests) {
    if (has('mix', manifest.mixVersionId)
      || (change.kind === 'subtitle_style' && manifest.subtitleVersionId === change.subtitleVersionId)
      || (change.kind === 'video_candidate' && manifest.shotIds.includes(change.shotId))) {
      add('delivery_manifest', manifest.id, 'rebuild');
    }
  }

  const sourceIds = change.kind === 'dialogue_cue' ? change.cueIds
    : change.kind === 'voice_profile' ? [change.voiceProfileVersionId]
      : change.kind === 'music_gain' ? [change.cueSheetVersionId, change.cueId]
        : change.kind === 'subtitle_style' ? [change.subtitleVersionId]
          : [change.shotId];
  const preserved: Array<{ kind: string; id: string }> = [];
  for (const take of graph.voiceTakes) if (!has('voice_take', take.id)) preserved.push({ kind: 'voice_take', id: take.id });
  for (const candidate of graph.lipSyncCandidates) if (!has('lip_sync', candidate.id)) preserved.push({ kind: 'lip_sync', id: candidate.id });
  for (const mix of graph.mixes) if (!has('mix', mix.id)) preserved.push({ kind: 'mix', id: mix.id });
  for (const manifest of graph.deliveryManifests) if (!has('delivery_manifest', manifest.id)) preserved.push({ kind: 'delivery_manifest', id: manifest.id });

  return { change: change.kind, sourceIds, affected: [...affected.values()], preserved,
    reason: change.reason, computedAt };
}
