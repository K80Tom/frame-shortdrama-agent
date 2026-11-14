import { randomUUID } from 'node:crypto';
import { canonicalDigest, sanitizeStoryboardVoiceBinding, sanitizeStoryboardVoiceObjectReference } from '@lyra/shared';
import type { AssetRecord, CharacterVoiceAsset, StoryboardVoiceBinding, StoryboardVoiceObjectReference } from '@lyra/shared';
import type { VoiceReferenceRepository } from './repository';
import { evaluateVoiceAuthorization } from '../audio-production/authorization';
import type { ObjectStorage } from '../infrastructure/object-storage';
import type { AudioAssetStore } from '../production-media/audio/audio-store';
import { tenantExecutionScope } from '../tenancy/scope';
import { LEGACY_WORKSPACE_ID } from '../tenancy/context';

export class VoiceReferenceError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
function invalid(message = '音色样本、授权信息或角色绑定无效。'): never {
  throw new VoiceReferenceError(400, 'VOICE_REFERENCE_INVALID', message);
}
function workspaceId(): string {
  const current = tenantExecutionScope.current();
  return current?.kind === 'tenant' ? current.tenant.workspaceId : LEGACY_WORKSPACE_ID;
}

/** Uploads immutable voice samples and signs them only at the paid-submit boundary. */
export class VoiceReferenceService {
  private voices?: VoiceReferenceRepository;
  private assets?: { get(id: string): Promise<AssetRecord | null> };
  constructor(private readonly store: AudioAssetStore, private readonly objects: ObjectStorage,
    private readonly now: () => Date = () => new Date()) {}

  configureAssets(voices: VoiceReferenceRepository, assets: { get(id: string): Promise<AssetRecord | null> }): void {
    this.voices = voices; this.assets = assets;
  }

  async list(projectId: string): Promise<CharacterVoiceAsset[]> {
    if (!this.voices || !/^project_[a-f0-9]{32}$/u.test(projectId)) return [];
    return this.voices.list(projectId, workspaceId());
  }

  async create(value: unknown): Promise<StoryboardVoiceBinding> {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
    const keys = ['speakerEntityId', 'projectId', 'displayName', 'language', 'format', 'durationMs', 'audioBase64', 'authorization', 'attributes', 'assetId'];
    if (Object.keys(input).some(key => !keys.includes(key)) || keys.slice(0, 7).some(key => !Object.hasOwn(input, key))) invalid();
    if (typeof input.speakerEntityId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.speakerEntityId)
      || typeof input.projectId !== 'string' || !/^project_[a-f0-9]{32}$/u.test(input.projectId)
      || typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.trim().length > 120
      || typeof input.language !== 'string' || !/^[A-Za-z0-9-]{2,40}$/u.test(input.language)
      || (input.format !== 'wav' && input.format !== 'mp3')
      || !Number.isSafeInteger(input.durationMs) || Number(input.durationMs) < 1 || Number(input.durationMs) > 300_000
      || typeof input.audioBase64 !== 'string' || !input.audioBase64 || input.audioBase64.length > 24_000_000) invalid();
    if (input.assetId !== undefined && (typeof input.assetId !== 'string' || !/^asset_[a-f0-9]{32}$/u.test(input.assetId))) invalid();
    const authorization = input.authorization ?? {
      subject: input.displayName, type: 'synthetic', commercialUse: true, territories: ['CN'], channels: ['online-video'],
      validFrom: this.now().toISOString(), validUntil: null, consentRecordRef: null, revokedAt: null, cloningConsent: false,
    };
    let bytes: Buffer;
    try {
      bytes = Buffer.from(input.audioBase64 as string, 'base64');
      if (!bytes.length || bytes.length > 16 * 1024 * 1024 || bytes.toString('base64') !== input.audioBase64) invalid();
    } catch { return invalid(); }
    let stored: Awaited<ReturnType<AudioAssetStore['put']>>;
    try { stored = await this.store.put({ bytes, format: input.format, durationMs: Number(input.durationMs) }); }
    catch (error) { throw new VoiceReferenceError(422, 'VOICE_SAMPLE_INVALID', error instanceof Error ? error.message : '音频样本无效。'); }
    const key = `voice-references/${input.projectId}/${stored.checksum}.${input.format}`;
    const scope = { workspaceId: workspaceId() };
    const descriptor = await this.objects.put({ scope, key, body: bytes,
      contentType: stored.mimeType, expectedSha256: stored.checksum });
    const raw = { speakerEntityId: input.speakerEntityId,
      profile: { schemaVersion: 'lyra-audio-production/1', id: `voice_${randomUUID().replaceAll('-', '')}`,
        workspaceId: scope.workspaceId, projectId: input.projectId, displayName: input.displayName,
        provider: 'seedance-reference', model: 'reference-audio', modelRevision: '1', voiceReference: stored.artifactId,
        language: input.language, attributes: input.attributes ?? { gender: null, age: null, style: [] },
        previewArtifactId: stored.artifactId, authorization,
        scope: { workspaceWide: false, projectIds: [input.projectId] }, reviewStatus: 'approved',
        contentDigest: '0'.repeat(64), createdAt: this.now().toISOString() },
      reference: { artifactId: stored.artifactId, provider: descriptor.provider, bucket: descriptor.bucket,
        key: descriptor.key, versionId: descriptor.versionId, sha256: descriptor.sha256,
        sizeBytes: descriptor.size, contentType: stored.mimeType } };
    const binding = sanitizeStoryboardVoiceBinding(raw);
    if (!binding) invalid();
    binding.profile.contentDigest = canonicalDigest({ artifactId: stored.artifactId, displayName: binding.profile.displayName,
      language: binding.profile.language, authorization: binding.profile.authorization, projectId: binding.profile.projectId,
      workspaceId: binding.profile.workspaceId });
    const decision = evaluateVoiceAuthorization(binding.profile, { workspaceId: scope.workspaceId,
      projectId: input.projectId, purpose: 'generate', commercialUse: true, now: this.now().toISOString() });
    if (!decision.allowed) throw new VoiceReferenceError(422, decision.code ?? 'unauthorized_voice', '音色授权不允许当前项目的商业视频生成。');
    if (input.assetId) {
      if (!this.voices || !this.assets) throw new VoiceReferenceError(503, 'VOICE_ASSET_STORE_UNAVAILABLE', '人物音色存储尚未完成数据库迁移。');
      const asset = await this.assets.get(input.assetId as string);
      if (!asset) throw new VoiceReferenceError(404, 'VOICE_ASSET_NOT_FOUND', '找不到要保存音色的人物资产。');
      if (asset.kind !== 'character') throw new VoiceReferenceError(400, 'VOICE_ASSET_KIND_INVALID', '音色只能保存到人物资产。');
      await this.voices.save(input.assetId as string, binding);
    }
    return binding;
  }

  authorize(binding: StoryboardVoiceBinding, projectId: string): void {
    const sanitized = sanitizeStoryboardVoiceBinding(binding);
    if (!sanitized || sanitized.profile.projectId !== projectId || sanitized.profile.workspaceId !== workspaceId()) {
      throw new VoiceReferenceError(422, 'VOICE_SCOPE_MISMATCH', '音色不属于当前项目或工作区。');
    }
    const decision = evaluateVoiceAuthorization(sanitized.profile, { workspaceId: workspaceId(), projectId,
      purpose: 'generate', commercialUse: true, now: this.now().toISOString() });
    if (!decision.allowed) throw new VoiceReferenceError(422, decision.code ?? 'unauthorized_voice', '音色授权已失效、撤销或不适用于商业视频生成。');
  }

  async sign(value: StoryboardVoiceObjectReference): Promise<string> {
    const reference = sanitizeStoryboardVoiceObjectReference(value);
    if (!reference || reference.provider !== this.objects.provider || reference.bucket !== this.objects.bucket) {
      throw new VoiceReferenceError(409, 'VOICE_OBJECT_MISMATCH', '音色对象存储已变化，无法安全读取原样本。');
    }
    if (!this.objects.createPresignedGet) {
      throw new VoiceReferenceError(503, 'VOICE_SIGNING_UNAVAILABLE', '当前对象存储不支持公网签名下载；请配置 MinIO、S3、OSS 或 COS 后再使用模型参考音色。');
    }
    const current = await this.objects.head({ workspaceId: workspaceId() }, reference.key,
      reference.versionId ? { providerVersionId: reference.versionId } : {});
    if (!current || current.sha256 !== reference.sha256 || current.size !== reference.sizeBytes) {
      throw new VoiceReferenceError(409, 'VOICE_OBJECT_CHANGED', '音色样本已变化或不可读取，未调用模型。');
    }
    const access = await this.objects.createPresignedGet({ scope: { workspaceId: workspaceId() }, key: reference.key,
      expectedSha256: reference.sha256, expiresInSeconds: 900,
      ...(reference.versionId ? { providerVersionId: reference.versionId } : {}) });
    return access.url;
  }
}
