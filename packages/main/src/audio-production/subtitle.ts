import {
  SUBTITLE_SCHEMA_VERSION,
  canonicalDigest,
  type DialogueTrackVersion,
  type SubtitleCue,
  type SubtitleVersion,
  type VoiceTakeVersion,
} from '@lyra/shared';

export interface SubtitleStyleProfile {
  safeArea: string;
  maxLines: number;
  maxCharsPerLine: number;
  fontFamilyRef: string | null;
}

export interface BuildSubtitleVersionInput {
  id: string;
  workspaceId: string;
  projectId: string;
  track: Readonly<DialogueTrackVersion>;
  takes: ReadonlyArray<Readonly<VoiceTakeVersion>>;
  mixVersionId?: string | null;
  language: string;
  locale: string;
  style: SubtitleStyleProfile;
  createdAt: string;
}

function sanitize(value: string): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, ' ')
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/-->/gu, '→');
}

function breakLines(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const clean = text.replace(/\s+/gu, ' ').trim();
  if (!clean) return [''];
  const lines: string[] = [];
  let rest = clean;
  while (rest.length > maxCharsPerLine && lines.length < maxLines) {
    let at = maxCharsPerLine;
    const space = rest.lastIndexOf(' ', maxCharsPerLine);
    if (space > Math.floor(maxCharsPerLine / 2)) at = space;
    lines.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  lines.push(rest);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines - 1);
    kept.push(lines.slice(maxLines - 1).join(' '));
    return kept;
  }
  return lines;
}

function adoptedTake(track: Readonly<DialogueTrackVersion>, cueId: string,
  takes: ReadonlyArray<Readonly<VoiceTakeVersion>>): VoiceTakeVersion | null {
  const cue = track.cues.find(item => item.cueId === cueId);
  if (!cue?.adoptedVoiceTakeVersionId) return null;
  const take = takes.find(item => item.id === cue.adoptedVoiceTakeVersionId && item.status === 'adopted') ?? null;
  if (!take) throw new Error(`Dialogue cue ${cueId} references a missing or non-adopted voice take.`);
  return take;
}

/**
 * A SubtitleVersion is derived from the adopted dialogue/alignment graph, not from
 * a burned-in video. Burn-in is a later Delivery Artifact of this same version.
 */
export function buildSubtitleVersion(input: BuildSubtitleVersionInput): SubtitleVersion {
  if (input.track.workspaceId !== input.workspaceId || input.track.projectId !== input.projectId) {
    throw new Error('Dialogue track belongs to another workspace/project.');
  }
  if (input.style.maxLines < 1 || input.style.maxLines > 2 || input.style.maxCharsPerLine < 1 || input.style.maxCharsPerLine > 60) {
    throw new Error('Subtitle style profile is outside supported bounds.');
  }
  const cues: SubtitleCue[] = input.track.cues.map((cue, index) => {
    const take = adoptedTake(input.track, cue.cueId, input.takes);
    const offset = take?.alignment?.offsetMs ?? 0;
    const start = Math.max(0, cue.timing.expectedStartMs + offset);
    const end = take?.durationMs != null ? start + take.durationMs : cue.timing.expectedEndMs;
    return {
      id: `subcue_${canonicalDigest({ track: input.track.contentDigest, cue: cue.cueId, index }).slice(0, 32)}`,
      dialogueCueId: cue.cueId, speakerEntityId: cue.speakerEntityId,
      text: cue.text.trim(), startMs: start, endMs: end,
      lines: breakLines(cue.text, input.style.maxCharsPerLine, input.style.maxLines),
      styleTokens: [], sourceTakeVersionId: take?.id ?? null,
      manualRevision: null,
    };
  }).sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));

  const checks = validateSubtitleCues(cues, input.track, input.style);
  const body = { track: input.track.contentDigest, mix: input.mixVersionId ?? null, language: input.language,
    locale: input.locale, style: input.style, cues };
  return {
    schemaVersion: SUBTITLE_SCHEMA_VERSION, id: input.id,
    workspaceId: input.workspaceId, projectId: input.projectId,
    dialogueTrackVersionId: input.track.id, mixVersionId: input.mixVersionId ?? null,
    language: input.language, locale: input.locale, cues,
    style: input.style, checks, sidecarArtifactId: null, burnInArtifactId: null,
    contentDigest: canonicalDigest(body), status: 'candidate', createdAt: input.createdAt,
  };
}

export function validateSubtitleCues(cues: readonly SubtitleCue[], track: Readonly<DialogueTrackVersion>,
  style: SubtitleStyleProfile): SubtitleVersion['checks'] {
  const required = new Set(track.cues.map(cue => cue.cueId));
  const seenIds = new Set<string>();
  const duplicateCueIds: string[] = [];
  const overlapCueIds: string[] = [];
  const readingSpeedFailures: string[] = [];
  const lineLengthFailures: string[] = [];
  let covered = 0;
  let previous: SubtitleCue | null = null;
  for (const cue of cues) {
    if (seenIds.has(cue.dialogueCueId)) duplicateCueIds.push(cue.dialogueCueId);
    seenIds.add(cue.dialogueCueId);
    if (cue.text.trim()) covered += 1;
    if (!required.has(cue.dialogueCueId)) duplicateCueIds.push(cue.dialogueCueId);
    if (cue.startMs < 0 || cue.endMs <= cue.startMs) overlapCueIds.push(cue.dialogueCueId);
    const seconds = Math.max(0.001, (cue.endMs - cue.startMs) / 1000);
    const chars = [...cue.text].length;
    if (chars / seconds > 9) readingSpeedFailures.push(cue.dialogueCueId);
    if (cue.lines.some(line => [...line].length > style.maxCharsPerLine) || cue.lines.length > style.maxLines) {
      lineLengthFailures.push(cue.dialogueCueId);
    }
    if (previous && cue.startMs < previous.endMs) overlapCueIds.push(cue.dialogueCueId);
    previous = cue;
  }
  for (const cue of track.cues) {
    if (!seenIds.has(cue.cueId) && !(cue.waiver?.granted)) duplicateCueIds.push(cue.cueId);
  }
  const coverage = track.cues.length ? covered / track.cues.length : 0;
  const verdict = duplicateCueIds.length || overlapCueIds.length || readingSpeedFailures.length || lineLengthFailures.length
    || coverage < 1 ? 'fail' : 'pass';
  return { coverage, duplicateCueIds, overlapCueIds, readingSpeedFailures, lineLengthFailures, verdict };
}

function timestamp(milliseconds: number, comma: boolean): string {
  const total = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor(total / 60_000) % 60;
  const seconds = Math.floor(total / 1_000) % 60;
  const millis = total % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${comma ? ',' : '.'}${String(millis).padStart(3, '0')}`;
}

/** SRT and WebVTT must be rendered from the same immutable SubtitleVersion. */
export function renderSubtitle(version: Readonly<SubtitleVersion>, format: 'srt' | 'vtt'): string {
  if (version.checks.verdict === 'fail') throw new Error('Subtitle version has unresolved timing or coverage failures.');
  const cues = [...version.cues].sort((a, b) => a.startMs - b.startMs);
  if (format === 'srt') {
    return cues.map((cue, index) => `${index + 1}\n${timestamp(cue.startMs, true)} --> ${timestamp(cue.endMs, true)}\n${sanitize(cue.lines.join('\n'))}`).join('\n\n') + '\n';
  }
  return `WEBVTT\n\n${cues.map(cue => `${timestamp(cue.startMs, false)} --> ${timestamp(cue.endMs, false)}\n${sanitize(cue.lines.join('\n'))}`).join('\n\n')}\n`;
}
