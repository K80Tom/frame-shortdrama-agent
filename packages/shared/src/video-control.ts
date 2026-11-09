/**
 * Browser-safe versioned contracts for controlled video generation.
 *
 * These DTOs deliberately reference immutable object versions and digests, never
 * signed URLs, provider credentials or local paths. A provider URL is minted by
 * the Worker immediately before submission and is not part of this contract.
 */
import type { InputVersionRef } from './shot-spec';

export const VIDEO_CONTROL_SCHEMA_VERSION = 'lyra-video-control/1' as const;
export const VIDEO_CANDIDATE_SCHEMA_VERSION = 'lyra-video-candidate/1' as const;
export const VIDEO_REPAIR_SCHEMA_VERSION = 'lyra-video-repair/1' as const;
export const VIDEO_CAPABILITY_SCHEMA_VERSION = 'lyra-provider-capability/1' as const;

export type ControlFrameKind = 'first' | 'last' | 'reference';
export type ControlRequirementKind = 'first_frame' | 'last_frame' | 'reference_image'
  | 'pose' | 'depth' | 'mask' | 'edge' | 'camera' | 'director_scene';
export type ControlDecision = 'applied' | 'transformed' | 'unsupported' | 'omitted_by_policy' | 'blocked';
export type VideoAudioKind = 'none' | 'provider_scratch';
export type VideoCandidateStatus = 'prepared' | 'submitted' | 'completed' | 'failed' | 'unknown'
  | 'adopted' | 'rejected' | 'superseded';
export type VideoIssueSeverity = 'info' | 'warning' | 'error';
export type RepairAction = 'regenerate_control_frame' | 'adjust_named_constraint'
  | 'regenerate_candidate' | 'reevaluate' | 'reassign_neighbor_candidate' | 'manual_review';

export interface ControlFrameVersion {
  schemaVersion: typeof VIDEO_CONTROL_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  projectId: string;
  shotId: string;
  kind: ControlFrameKind;
  sourceShotSpecVersionId: string;
  sourceShotSpecDigest: string;
  objectVersionId: string;
  checksum: string;
  width: number;
  height: number;
  ratio: '9:16' | '16:9';
  assetPackVersion: InputVersionRef | null;
  directorSceneVersion: InputVersionRef | null;
  methodPackVersion: InputVersionRef | null;
  promptRevision: string | null;
  modelRevision: string | null;
  provenance: {
    kind: 'generated' | 'imported' | 'extracted_from_video';
    providerTaskId: string | null;
    sourceCandidateId: string | null;
    timeMs: number | null;
    actor: string;
  };
  review: {
    status: 'pending' | 'pass' | 'fail' | 'inconclusive';
    reviewer: string | null;
    reviewedAt: string | null;
    technicalSummary: string[];
    semanticSummary: string[];
  };
  qualitySummary: string | null;
  adoptedAt: string | null;
  /** Never equal for two different frame versions with the same business identity. */
  contentDigest: string;
}

export interface DirectorControlArtifact {
  schemaVersion: typeof VIDEO_CONTROL_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  projectId: string;
  shotId: string;
  kind: 'composition' | 'depth' | 'pose' | 'mask' | 'edge' | 'normal' | 'camera' | 'transforms';
  objectVersionId: string;
  checksum: string;
  width: number;
  height: number;
  coordinateSystem: 'image_pixels' | 'normalized_device' | 'world_right_handed_y_up';
  directorSceneVersion: InputVersionRef;
  cameraRevisionId: string;
  exporterVersion: string;
  /** The capability revision this exporter validated against; null means unverified. */
  providerCapabilityRevisionId: string | null;
  createdAt: string;
  contentDigest: string;
}

export interface ProviderCapabilityRevision {
  schemaVersion: typeof VIDEO_CAPABILITY_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  provider: string;
  model: string;
  revision: string;
  textToVideo: boolean;
  imageToVideo: boolean;
  controls: {
    firstFrame: boolean;
    lastFrame: boolean;
    referenceImages: { max: number; roles: Array<'style' | 'character' | 'location' | 'prop'> };
    pose: boolean;
    depth: boolean;
    mask: boolean;
    edge: boolean;
    camera: boolean;
  };
  limits: {
    durationSeconds: { min: number; max: number };
    ratios: Array<'9:16' | '16:9'>;
    resolutions: Array<'720p' | '1080p'>;
    maxInputBytes: number;
    signedUrlTtlSeconds: number;
  };
  seed: boolean;
  negativePrompt: boolean;
  audioGeneration: boolean;
  async: {
    query: boolean;
    cancel: boolean;
    idempotency: boolean;
    reconciliationFields: string[];
  };
  createdAt: string;
}

export interface VideoControlRequirement {
  kind: ControlRequirementKind;
  /** A hard requirement blocks paid submission when the provider cannot apply it. */
  required: boolean;
  artifact: InputVersionRef | null;
  /** A frame whose ratio differs may be explicitly fitted; never silently stretched. */
  ratioTransform: 'none' | 'fit_letterbox' | 'fit_crop' | 'blocked';
}

export interface VideoGenerationSpec {
  schemaVersion: typeof VIDEO_CONTROL_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  projectId: string;
  shotId: string;
  productionInputSnapshotId: string;
  productionInputSnapshotDigest: string;
  shotSpecRevisionId: string;
  shotSpecDigest: string;
  assetPackVersions: InputVersionRef[];
  directorSceneVersions: InputVersionRef[];
  controlFrameVersionIds: string[];
  controls: VideoControlRequirement[];
  prompt: string;
  negativePrompt: string | null;
  methodPackVersions: InputVersionRef[];
  promptRevision: string | null;
  modelRevision: string;
  providerCapabilityRevisionId: string;
  candidate: {
    index: number;
    policy: 'direct' | 'sequential' | 'parallel_bounded' | 'human_first';
  };
  params: {
    durationSeconds: number;
    ratio: '9:16' | '16:9';
    resolution: '720p' | '1080p';
    seed: number | null;
  };
  audioPolicy: 'none' | 'provider_scratch';
  contentDigest: string;
}

export interface ProviderCapabilityDecision {
  requirement: ControlRequirementKind;
  decision: ControlDecision;
  /** Field actually sent to the provider, e.g. content[].role=first_frame. */
  actualField: string | null;
  reason: string;
  evidenceRefs: string[];
}

export interface VideoGenerationPlan {
  specId: string;
  operationKey: string;
  decisions: ProviderCapabilityDecision[];
  blockers: Array<{ code: string; message: string; requirement: ControlRequirementKind }>;
  actualControls: ControlRequirementKind[];
  audioKind: VideoAudioKind;
  /** Only stable control object references; a Worker mints short-lived URLs later. */
  providerControls: {
    firstFrameObjectVersionId: string | null;
    lastFrameObjectVersionId: string | null;
    referenceObjectVersionIds: string[];
  };
}

export interface VideoCandidateVersion {
  schemaVersion: typeof VIDEO_CANDIDATE_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  projectId: string;
  shotId: string;
  productionInputSnapshotId: string;
  productionInputSnapshotDigest: string;
  controlFrameVersionIds: string[];
  controlFrameDigests: string[];
  directorControlArtifactIds: string[];
  provider: string;
  model: string;
  modelConnectionRevision: string;
  providerCapabilityRevisionId: string;
  methodPackVersions: InputVersionRef[];
  promptRevision: string | null;
  negativePromptRevision: string | null;
  durationSeconds: number;
  ratio: '9:16' | '16:9';
  resolution: '720p' | '1080p';
  seed: number | null;
  operationKey: string;
  providerTaskId: string | null;
  attemptId: string;
  objectVersionId: string;
  checksum: string;
  probe: {
    width: number;
    height: number;
    durationSeconds: number;
    videoCodec: string;
    audioCodec: string | null;
  };
  actualControls: ControlRequirementKind[];
  capabilityDecisions: ProviderCapabilityDecision[];
  audioKind: VideoAudioKind;
  costMicros: number;
  status: VideoCandidateStatus;
  evidenceRefs: string[];
  decision: {
    adopted: boolean;
    actor: string | null;
    at: string | null;
    reason: string | null;
  };
  createdAt: string;
}

export interface VideoIssue {
  schemaVersion: typeof VIDEO_REPAIR_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  projectId: string;
  shotId: string;
  neighborShotId: string | null;
  category: 'upstream_input' | 'current_shot_generation' | 'neighbor_choice' | 'inconclusive';
  code: string;
  severity: VideoIssueSeverity;
  blocking: boolean;
  timeRange: { startMs: number; endMs: number } | null;
  frameRefs: Array<{ objectVersionId: string; checksum: string; timeMs: number }>;
  evidenceRefs: string[];
  expected: string;
  actual: string;
  suggestedRepairScope: {
    shotIds: string[];
    actions: RepairAction[];
    regenerateControlFrame: boolean;
    regenerateCandidateIndexes: number[];
    reassignNeighborCandidate: boolean;
    manualOnly: boolean;
  };
}

export interface VideoRepairPlan {
  schemaVersion: typeof VIDEO_REPAIR_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  projectId: string;
  shotId: string;
  issueIds: string[];
  actions: RepairAction[];
  /** Explicit candidate indexes; null means no paid regeneration is authorized. */
  regenerateCandidateIndexes: number[] | null;
  reassignNeighborShotId: string | null;
  manualReason: string | null;
  operator: string;
  createdAt: string;
  contentDigest: string;
}

export class VideoControlContractError extends Error {
  readonly status = 400;
  readonly code = 'VIDEO_CONTROL_INVALID';
  constructor(message = '视频控制契约无效。') { super(message); this.name = 'VideoControlContractError'; }
}

function invalid(message?: string): never { throw new VideoControlContractError(message); }
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const out = value as Record<string, unknown>;
  if (Object.keys(out).length !== fields.length || fields.some(key => !Object.hasOwn(out, key))) invalid();
  return out;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) invalid();
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z][A-Za-z0-9_.:-]*$/u.test(value)) invalid();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) invalid();
  return value;
}
function positiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) invalid();
  return value as number;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}
function enumerated<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) invalid();
  return value as T;
}

/** Validate a capability matrix at the persistence/API boundary. */
export function parseProviderCapabilityRevision(value: unknown): ProviderCapabilityRevision {
  const root = record(value, ['schemaVersion', 'id', 'workspaceId', 'provider', 'model', 'revision', 'textToVideo',
    'imageToVideo', 'controls', 'limits', 'seed', 'negativePrompt', 'audioGeneration', 'async', 'createdAt']);
  if (root.schemaVersion !== VIDEO_CAPABILITY_SCHEMA_VERSION) invalid();
  const controls = record(root.controls, ['firstFrame', 'lastFrame', 'referenceImages', 'pose', 'depth', 'mask', 'edge', 'camera']);
  const referenceImages = record(controls.referenceImages, ['max', 'roles']);
  if (!Array.isArray(referenceImages.roles) || referenceImages.roles.length > 4
    || new Set(referenceImages.roles).size !== referenceImages.roles.length) invalid();
  const referenceRoles = referenceImages.roles.map(role => enumerated(role, ['style', 'character', 'location', 'prop'] as const));
  const limits = record(root.limits, ['durationSeconds', 'ratios', 'resolutions', 'maxInputBytes', 'signedUrlTtlSeconds']);
  const durations = record(limits.durationSeconds, ['min', 'max']);
  if (!Array.isArray(limits.ratios) || !Array.isArray(limits.resolutions)
    || !limits.ratios.length || !limits.resolutions.length) invalid();
  const ratios = limits.ratios.map(ratio => enumerated(ratio, ['9:16', '16:9'] as const));
  const resolutions = limits.resolutions.map(resolution => enumerated(resolution, ['720p', '1080p'] as const));
  const asyncFields = record(root.async, ['query', 'cancel', 'idempotency', 'reconciliationFields']);
  if (!Array.isArray(asyncFields.reconciliationFields) || asyncFields.reconciliationFields.length > 20) invalid();
  return {
    schemaVersion: VIDEO_CAPABILITY_SCHEMA_VERSION,
    id: identifier(root.id), workspaceId: identifier(root.workspaceId), provider: text(root.provider, 80),
    model: text(root.model, 120), revision: identifier(root.revision),
    textToVideo: boolean(root.textToVideo), imageToVideo: boolean(root.imageToVideo),
    controls: {
      firstFrame: boolean(controls.firstFrame), lastFrame: boolean(controls.lastFrame),
      referenceImages: { max: positiveInteger(referenceImages.max, 30), roles: referenceRoles },
      pose: boolean(controls.pose), depth: boolean(controls.depth), mask: boolean(controls.mask),
      edge: boolean(controls.edge), camera: boolean(controls.camera),
    },
    limits: {
      durationSeconds: { min: positiveInteger(durations.min, 60), max: positiveInteger(durations.max, 60) },
      ratios, resolutions, maxInputBytes: positiveInteger(limits.maxInputBytes),
      signedUrlTtlSeconds: positiveInteger(limits.signedUrlTtlSeconds, 86_400),
    },
    seed: boolean(root.seed), negativePrompt: boolean(root.negativePrompt), audioGeneration: boolean(root.audioGeneration),
    async: {
      query: boolean(asyncFields.query), cancel: boolean(asyncFields.cancel), idempotency: boolean(asyncFields.idempotency),
      reconciliationFields: asyncFields.reconciliationFields.map(field => text(field, 80)),
    },
    createdAt: text(root.createdAt, 64),
  };
}

/** Verify the immutable identity of an adopted frame before it can gate a paid request. */
export function verifyAdoptedControlFrame(value: unknown): ControlFrameVersion {
  const frame = value as ControlFrameVersion;
  if (!frame || typeof frame !== 'object' || frame.schemaVersion !== VIDEO_CONTROL_SCHEMA_VERSION) invalid();
  if (!identifier(frame.id) || !identifier(frame.workspaceId) || !identifier(frame.projectId)
    || !identifier(frame.shotId) || !enumerated(frame.kind, ['first', 'last', 'reference'] as const)
    || !identifier(frame.sourceShotSpecVersionId) || !digest(frame.sourceShotSpecDigest)
    || !identifier(frame.objectVersionId) || !digest(frame.checksum)
    || !digest(frame.contentDigest)) invalid();
  if (!frame.review || frame.review.status !== 'pass' || !frame.adoptedAt) {
    invalid('控制帧尚未通过审核并采用，不能用于付费视频提交。');
  }
  if (frame.provenance?.kind === 'extracted_from_video'
    && (!frame.provenance.sourceCandidateId || frame.provenance.timeMs === null)) {
    invalid('从前镜抽取的控制帧必须保存来源候选与 timecode。');
  }
  return frame;
}
