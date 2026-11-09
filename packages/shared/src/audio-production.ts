/**
 * Browser-safe versioned contracts for the independent voice/subtitle graph.
 * These DTOs carry stable IDs, object versions and digests only; credentials,
 * signed URLs, raw consent documents and local working paths stay server-side.
 */
import type { InputVersionRef } from './shot-spec';

export const AUDIO_PRODUCTION_SCHEMA_VERSION = 'lyra-audio-production/1' as const;
export const SUBTITLE_SCHEMA_VERSION = 'lyra-subtitle/1' as const;
export const DELIVERY_MEDIA_SCHEMA_VERSION = 'lyra-delivery-media/1' as const;

export type DialogueReviewStatus = 'pending' | 'approved' | 'rejected';
export type VoiceTakeStatus = 'generated' | 'adopted' | 'rejected' | 'superseded' | 'failed';
export type AudioTrackKind = 'dialogue' | 'ambience' | 'sfx' | 'music' | 'room_tone';
export type DeliveryStatus = 'candidate' | 'adopted' | 'superseded';

export interface DialogueCue {
  cueId: string;
  shotId: string;
  speakerEntityId: string | null;
  text: string;
  language: string;
  emotion: string | null;
  pace: 'slow' | 'normal' | 'fast' | null;
  pauseAfterMs: number;
  pronunciationHints: string[];
  sourceScriptVersionId: string;
  shotSpecVersionId: string;
  sourceRange: { start: number; end: number; quote: string };
  sourceDigest: string;
  timing: {
    expectedStartMs: number;
    expectedEndMs: number;
    toleranceMs: number;
    contextBeforeCueId: string | null;
    contextAfterCueId: string | null;
  };
  adoptedVoiceTakeVersionId: string | null;
  waiver: { granted: boolean; reason: string | null; actor: string | null } | null;
  reviewStatus: DialogueReviewStatus;
}

export interface DialogueTrackVersion {
  schemaVersion: typeof AUDIO_PRODUCTION_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  projectId: string;
  episodeId: string;
  scriptVersionId: string;
  productionInputSnapshotId: string;
  productionInputSnapshotDigest: string;
  cues: DialogueCue[];
  baseVersionId: string | null;
  contentDigest: string;
  createdAt: string;
  createdBy: string;
  adoptedAt: string | null;
}

export interface VoiceAuthorization {
  subject: string;
  type: 'synthetic' | 'licensed_real_person' | 'employee_consent' | 'unknown';
  commercialUse: boolean;
  territories: string[];
  channels: string[];
  validFrom: string;
  validUntil: string | null;
  consentRecordRef: string | null;
  revokedAt: string | null;
  /** Real-person cloning is never implicitly permitted. */
  cloningConsent: boolean;
}

export interface VoiceProfileVersion {
  schemaVersion: typeof AUDIO_PRODUCTION_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  projectId: string;
  displayName: string;
  provider: string;
  model: string;
  modelRevision: string;
  /** Opaque workspace-scoped reference, never a provider secret or raw voice sample. */
  voiceReference: string;
  language: string;
  attributes: { gender: string | null; age: string | null; style: string[] };
  previewArtifactId: string | null;
  authorization: VoiceAuthorization;
  scope: { workspaceWide: boolean; projectIds: string[] };
  reviewStatus: DialogueReviewStatus;
  contentDigest: string;
  createdAt: string;
}

export interface VoiceTakeVersion {
  schemaVersion: typeof AUDIO_PRODUCTION_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  projectId: string;
  dialogueCueVersionId: string;
  dialogueCueId: string;
  voiceProfileVersionId: string;
  provider: string;
  modelRevision: string;
  inputDigest: string;
  operationKey: string;
  attemptId: string;
  audioArtifactId: string | null;
  objectVersionId: string | null;
  checksum: string | null;
  durationMs: number | null;
  sampleRate: number | null;
  channels: number | null;
  codec: string | null;
  alignment: {
    kind: 'provider' | 'estimated' | 'manual';
    phonemeMapObjectVersionId: string | null;
    offsetMs: number;
  } | null;
  costMicros: number | null;
  status: VoiceTakeStatus;
  quality: {
    decoded: boolean;
    textCoverage: number | null;
    silenceRatio: number | null;
    clippingRatio: number | null;
    verdict: 'pass' | 'fail' | 'inconclusive';
    evidenceRefs: string[];
  };
  createdAt: string;
}

export interface LipSyncCandidateVersion {
  schemaVersion: typeof AUDIO_PRODUCTION_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  projectId: string;
  shotId: string;
  sourceVideoArtifactId: string;
  sourceVideoChecksum: string;
  voiceTakeVersionId: string;
  voiceTakeChecksum: string | null;
  modelRevision: string;
  paramsDigest: string;
  operationKey: string;
  face: {
    visible: boolean;
    speakerConfidence: number | null;
    faceCount: number;
  };
  outputVideoArtifactId: string | null;
  outputChecksum: string | null;
  sync: { offsetMs: number | null; driftMs: number | null };
  costMicros: number | null;
  status: 'prepared' | 'blocked' | 'completed' | 'failed' | 'unknown' | 'adopted' | 'superseded';
  evidenceRefs: string[];
  createdAt: string;
}

export interface AudioAssetVersion {
  schemaVersion: typeof AUDIO_PRODUCTION_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  projectId: string | null;
  kind: Exclude<AudioTrackKind, 'dialogue'>;
  objectVersionId: string;
  checksum: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
  codec: string;
  source: { provider: string; author: string | null; sourceUrlRef: string | null };
  license: {
    kind: 'owned' | 'licensed' | 'public_domain' | 'unknown';
    commercialUse: boolean;
    validUntil: string | null;
    evidenceRef: string | null;
  };
  reviewStatus: DialogueReviewStatus;
  contentDigest: string;
  createdAt: string;
}

export interface CueSheetCue {
  id: string;
  track: AudioTrackKind;
  startMs: number;
  endMs: number;
  artifactVersionId: string | null;
  dialogueCueId: string | null;
  gainDb: number;
  pan: number;
  fadeInMs: number;
  fadeOutMs: number;
  loop: boolean;
  ducking: { target: 'dialogue'; amountDb: number } | null;
  shotId: string | null;
  sceneId: string | null;
}

export interface CueSheetVersion {
  schemaVersion: typeof AUDIO_PRODUCTION_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  projectId: string;
  timelineId: string;
  cues: CueSheetCue[];
  baseVersionId: string | null;
  contentDigest: string;
  adoptedAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface MixVersion {
  schemaVersion: typeof AUDIO_PRODUCTION_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  projectId: string;
  cueSheetVersionId: string;
  inputManifest: Array<{ artifactVersionId: string; checksum: string; role: string }>;
  inputManifestDigest: string;
  composer: { engine: 'ffmpeg'; version: string; commandTemplateVersion: string };
  masterArtifactId: string | null;
  masterChecksum: string | null;
  stems: Array<{ track: AudioTrackKind; artifactId: string; checksum: string }>;
  loudness: { targetLufs: number; measuredLufs: number | null; truePeakDbfs: number | null };
  technical: { durationMs: number; sampleRate: number; channels: number } | null;
  quality: { verdict: 'pass' | 'fail' | 'inconclusive'; issues: string[]; evidenceRefs: string[] };
  costMicros: number;
  status: 'candidate' | 'adopted' | 'superseded' | 'failed';
  createdAt: string;
}

export interface SubtitleCue {
  id: string;
  dialogueCueId: string;
  speakerEntityId: string | null;
  text: string;
  startMs: number;
  endMs: number;
  lines: string[];
  styleTokens: string[];
  sourceTakeVersionId: string | null;
  manualRevision: { actor: string; at: string; reason: string } | null;
}

export interface SubtitleVersion {
  schemaVersion: typeof SUBTITLE_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  projectId: string;
  dialogueTrackVersionId: string;
  mixVersionId: string | null;
  language: string;
  locale: string;
  cues: SubtitleCue[];
  style: { safeArea: string; maxLines: number; maxCharsPerLine: number; fontFamilyRef: string | null };
  checks: {
    coverage: number;
    duplicateCueIds: string[];
    overlapCueIds: string[];
    readingSpeedFailures: string[];
    lineLengthFailures: string[];
    verdict: 'pass' | 'fail' | 'inconclusive';
  };
  sidecarArtifactId: string | null;
  burnInArtifactId: string | null;
  contentDigest: string;
  status: 'candidate' | 'adopted' | 'archived';
  createdAt: string;
}

export interface DeliveryMediaManifest {
  schemaVersion: typeof DELIVERY_MEDIA_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  projectId: string;
  timelineVersionId: string;
  videoArtifactVersionId: string;
  mixVersionId: string;
  subtitleVersionId: string | null;
  subtitleMode: 'sidecar' | 'burn_in' | 'none';
  output: { width: number; height: number; fps: number; audioCodec: string; loudnessTargetLufs: number };
  artifacts: Array<{ role: string; artifactId: string; objectVersionId: string; checksum: string }>;
  rights: { voiceAuthorizations: string[]; audioLicenses: string[]; warnings: string[] };
  composer: { build: string; commandTemplateVersion: string };
  manifestDigest: string;
  status: DeliveryStatus;
  createdAt: string;
}

export class AudioProductionContractError extends Error {
  readonly status = 400;
  readonly code = 'AUDIO_PRODUCTION_INVALID';
  constructor(message = '声音生产契约无效。') { super(message); this.name = 'AudioProductionContractError'; }
}

/** Stable public error codes consumed by API/UI. */
export const AUDIO_PRODUCTION_ERRORS = ['unauthorized_voice', 'license_expired', 'alignment_unavailable',
  'face_not_visible', 'speaker_ambiguous', 'input_stale', 'budget_exceeded', 'provider_unknown',
  'mix_quality_failed', 'subtitle_invalid', 'delivery_manifest_stale'] as const;
export type AudioProductionErrorCode = typeof AUDIO_PRODUCTION_ERRORS[number];

/**
 * Dependency edges are explicit so a single cue edit cannot silently invalidate
 * unrelated shots. The backend computes these edges from persisted versions; the
 * browser only renders the resulting explanation.
 */
export interface DependencyInvalidation {
  source: { kind: 'dialogue_cue' | 'voice_profile' | 'music_gain' | 'subtitle_style' | 'video_candidate'; id: string };
  reason: string;
  affected: Array<{
    kind: 'voice_take' | 'lip_sync' | 'subtitle_cue' | 'mix' | 'delivery_manifest';
    id: string;
    action: 'stale' | 'recompute' | 'rerender' | 'rebuild';
  }>;
  preserved: Array<{ kind: string; id: string }>;
  computedAt: string;
}
