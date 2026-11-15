import type { VoiceAuthorization, VoiceProfileVersion } from './audio-production';

/** Immutable, provider-independent reference to an authorized voice sample. */
export interface StoryboardVoiceObjectReference {
  artifactId: string;
  provider: 'local' | 'minio' | 's3' | 'oss' | 'cos';
  bucket: string;
  key: string;
  versionId: string | null;
  sha256: string;
  sizeBytes: number;
  contentType: 'audio/wav' | 'audio/mpeg';
}

export interface StoryboardVoiceBinding {
  speakerEntityId: string;
  profile: VoiceProfileVersion;
  reference: StoryboardVoiceObjectReference;
}

/** One project-scoped voice saved on a character image asset. */
export interface CharacterVoiceAsset {
  assetId: string;
  binding: StoryboardVoiceBinding;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.trim() && value.trim().length <= max && !/[\x00-\x1f\x7f]/u.test(value)
    ? value.trim() : null;
}
function bool(value: unknown): value is boolean { return typeof value === 'boolean'; }
function strings(value: unknown, max = 32): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const result = value.map(item => text(item, 200));
  return result.every((item): item is string => Boolean(item)) ? result as string[] : null;
}
function date(value: unknown, nullable = false): string | null | undefined {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}
function authorization(value: unknown): VoiceAuthorization | null {
  const root = record(value); if (!root) return null;
  const subject = text(root.subject); const validFrom = date(root.validFrom); const validUntil = date(root.validUntil, true);
  const revokedAt = date(root.revokedAt, true); const territories = strings(root.territories); const channels = strings(root.channels);
  if (!subject || !['synthetic', 'licensed_real_person', 'employee_consent', 'unknown'].includes(root.type as string)
    || !bool(root.commercialUse) || !territories || !channels || validFrom === undefined || validUntil === undefined
    || revokedAt === undefined || !bool(root.cloningConsent)
    || !(root.consentRecordRef === null || text(root.consentRecordRef))) return null;
  return { subject, type: root.type as VoiceAuthorization['type'], commercialUse: root.commercialUse,
    territories, channels, validFrom: validFrom!, validUntil: validUntil!, consentRecordRef: root.consentRecordRef === null ? null : text(root.consentRecordRef),
    revokedAt: revokedAt!, cloningConsent: root.cloningConsent };
}

export function sanitizeStoryboardVoiceObjectReference(value: unknown): StoryboardVoiceObjectReference | null {
  const raw = record(value); if (!raw) return null;
  const artifactId = text(raw.artifactId, 100); const provider = text(raw.provider, 20);
  const bucket = text(raw.bucket, 200); const key = text(raw.key, 1024); const sha256 = text(raw.sha256, 64);
  const contentType = text(raw.contentType, 40);
  if (!artifactId || !/^audio_[a-f0-9]{64}$/u.test(artifactId) || !provider || !['local', 'minio', 's3', 'oss', 'cos'].includes(provider)
    || !bucket || !key || !key.startsWith('voice-references/') || !sha256 || !/^[a-f0-9]{64}$/u.test(sha256)
    || artifactId !== `audio_${sha256}` || !Number.isSafeInteger(raw.sizeBytes)
    || Number(raw.sizeBytes) < 1 || Number(raw.sizeBytes) > 16 * 1024 * 1024
    || (contentType !== 'audio/wav' && contentType !== 'audio/mpeg')
    || !(raw.versionId === null || text(raw.versionId, 300))) return null;
  return { artifactId, provider: provider as StoryboardVoiceObjectReference['provider'], bucket, key,
    versionId: raw.versionId === null ? null : text(raw.versionId, 300), sha256,
    sizeBytes: Number(raw.sizeBytes), contentType };
}

/** Validate and clone the complete persisted voice snapshot; never trusts extra input fields. */
export function sanitizeStoryboardVoiceBinding(value: unknown): StoryboardVoiceBinding | null {
  const root = record(value); const speakerEntityId = text(root?.speakerEntityId, 128);
  const rawProfile = record(root?.profile); const rawReference = record(root?.reference);
  if (!speakerEntityId || !rawProfile || !rawReference) return null;
  const artifactId = text(rawReference.artifactId, 100); const provider = text(rawReference.provider, 20);
  const bucket = text(rawReference.bucket, 200); const key = text(rawReference.key, 1024);
  const sha256 = text(rawReference.sha256, 64); const contentType = text(rawReference.contentType, 40);
  if (!artifactId || !/^audio_[a-f0-9]{64}$/u.test(artifactId) || !provider || !['local', 'minio', 's3', 'oss', 'cos'].includes(provider)
    || !bucket || !key || !key.startsWith('voice-references/') || !sha256 || !/^[a-f0-9]{64}$/u.test(sha256)
    || artifactId !== `audio_${sha256}` || !Number.isSafeInteger(rawReference.sizeBytes)
    || Number(rawReference.sizeBytes) < 1 || Number(rawReference.sizeBytes) > 16 * 1024 * 1024
    || (contentType !== 'audio/wav' && contentType !== 'audio/mpeg')
    || !(rawReference.versionId === null || text(rawReference.versionId, 300))) return null;
  const auth = authorization(rawProfile.authorization); const scope = record(rawProfile.scope);
  const attributes = record(rawProfile.attributes); const projectIds = strings(scope?.projectIds);
  const style = strings(attributes?.style); const createdAt = date(rawProfile.createdAt);
  const profileId = text(rawProfile.id, 100); const workspaceId = text(rawProfile.workspaceId, 128);
  const projectId = text(rawProfile.projectId, 100); const displayName = text(rawProfile.displayName);
  const providerName = text(rawProfile.provider, 100); const model = text(rawProfile.model, 100);
  const modelRevision = text(rawProfile.modelRevision, 100); const language = text(rawProfile.language, 40);
  const digest = text(rawProfile.contentDigest, 64);
  if (!auth || !projectIds || !style || createdAt === undefined || !profileId || !workspaceId || !projectId || !displayName
    || !providerName || !model || !modelRevision || !language || !digest || !/^[a-f0-9]{64}$/u.test(digest)
    || rawProfile.voiceReference !== artifactId || rawProfile.previewArtifactId !== artifactId
    || rawProfile.reviewStatus !== 'approved' || scope?.workspaceWide !== false
    || !projectIds.includes(projectId) || !text(rawProfile.schemaVersion, 100) || !createdAt
    || !(attributes?.gender === null || text(attributes?.gender, 40))
    || !(attributes?.age === null || text(attributes?.age, 40))) return null;
  return { speakerEntityId,
    profile: { schemaVersion: 'lyra-audio-production/1', id: profileId, workspaceId, projectId, displayName,
      provider: providerName, model, modelRevision, voiceReference: artifactId, language,
      attributes: { gender: attributes?.gender === null ? null : text(attributes?.gender, 40),
        age: attributes?.age === null ? null : text(attributes?.age, 40), style },
      previewArtifactId: artifactId, authorization: auth,
      scope: { workspaceWide: false, projectIds: [...projectIds] }, reviewStatus: 'approved', contentDigest: digest, createdAt },
    reference: { artifactId, provider: provider as StoryboardVoiceObjectReference['provider'], bucket, key,
      versionId: rawReference.versionId === null ? null : text(rawReference.versionId, 300), sha256,
      sizeBytes: Number(rawReference.sizeBytes), contentType } };
}
