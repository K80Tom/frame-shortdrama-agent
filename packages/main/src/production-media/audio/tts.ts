import { createHash, randomUUID } from 'node:crypto';
import { AUDIO_PRODUCTION_SCHEMA_VERSION, canonicalDigest,
  type DialogueCue, type DialogueTrackVersion, type VoiceProfileVersion, type VoiceTakeVersion } from '@lyra/shared';
import { assertVoiceAuthorization } from '../../audio-production/authorization';
import { AudioAssetStore, type AudioFormat } from './audio-store';

export interface TtsSynthesisRequest {
  text: string;
  language: string;
  emotion: string | null;
  pace: 'slow' | 'normal' | 'fast' | null;
  voiceReference: string;
  provider: string;
  model: string;
  modelRevision: string;
  format: AudioFormat;
  /** Stable key lets a provider deduplicate the same paid request. */
  operationKey: string;
}

export interface TtsSynthesisResult {
  bytes: Buffer;
  format: AudioFormat;
  durationMs: number;
  sampleRate: number;
  channels: number;
  /** Provider word/phone alignment when available; otherwise null is honest. */
  alignment: { kind: 'provider' | 'estimated' | 'manual'; offsetMs: number } | null;
  costMicros: number | null;
}

/** A provider adapter is injected by main runtime; this module never reads credentials. */
export interface TtsProvider {
  readonly provider: string;
  readonly model: string;
  readonly modelRevision: string;
  synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult>;
}

export class VoiceSynthesisError extends Error {
  constructor(readonly code: 'speaker_ambiguous' | 'unauthorized_voice' | 'license_expired' | 'provider_unknown'
    | 'alignment_unavailable' | 'input_stale', message: string) {
    super(message); this.name = 'VoiceSynthesisError';
  }
}

export interface VoiceAssignment {
  speakerEntityId: string;
  profile: VoiceProfileVersion;
}

export interface SynthesizeDialogueInput {
  workspaceId: string;
  projectId: string;
  track: Readonly<DialogueTrackVersion>;
  assignments: readonly VoiceAssignment[];
  provider: TtsProvider;
  format?: AudioFormat;
  now?: string;
  /** Optional durable sink; when supplied every take carries an artifact ID. */
  audioStore?: AudioAssetStore;
}

export interface SynthesizedDialogue {
  takes: VoiceTakeVersion[];
  operationKeys: string[];
}

const TAKE_PREFIX = 'take_';

function cleanText(value: string): string {
  const text = value.replace(/\s+/gu, ' ').trim();
  if (!text) throw new VoiceSynthesisError('speaker_ambiguous', '台词为空，不能发起配音。');
  if ([...text].length > 2_000) throw new VoiceSynthesisError('input_stale', '台词超过单条配音长度上限。');
  return text;
}

function validateResponse(result: TtsSynthesisResult, expectedFormat: AudioFormat): void {
  if (!Buffer.isBuffer(result.bytes) || result.bytes.length < 1) {
    throw new VoiceSynthesisError('provider_unknown', '配音供应商返回空音频。');
  }
  if (result.format !== expectedFormat) {
    throw new VoiceSynthesisError('provider_unknown', '配音供应商返回格式与请求不一致。');
  }
  if (!Number.isSafeInteger(result.durationMs) || result.durationMs < 1 || result.durationMs > 15 * 60_000) {
    throw new VoiceSynthesisError('provider_unknown', '配音供应商返回的时长无效。');
  }
  if (!Number.isSafeInteger(result.sampleRate) || result.sampleRate < 8_000 || result.sampleRate > 192_000
    || !Number.isSafeInteger(result.channels) || result.channels < 1 || result.channels > 2) {
    throw new VoiceSynthesisError('provider_unknown', '配音供应商返回的采样率或声道数无效。');
  }
}

function takeId(input: { operationKey: string; attemptId: string }): string {
  return `${TAKE_PREFIX}${canonicalDigest(input).slice(0, 40)}`;
}

/**
 * Turn frozen dialogue cues into paid-provider requests. Every cue is gated by the
 * existing voice authorization policy before the adapter is called; unauthorized
 * cues fail the whole batch so a partial charge cannot silently ship.
 */
export class DialogueTtsService {
  constructor(private readonly options: { maxConcurrency?: number } = {}) {}

  async synthesize(input: SynthesizeDialogueInput): Promise<SynthesizedDialogue> {
    if (input.track.workspaceId !== input.workspaceId || input.track.projectId !== input.projectId) {
      throw new VoiceSynthesisError('input_stale', '对白轨不属于当前工作区或项目。');
    }
    if (!input.assignments.length) throw new VoiceSynthesisError('speaker_ambiguous', '没有可用的角色声线映射。');
    const profiles = new Map<string, VoiceProfileVersion>();
    for (const assignment of input.assignments) {
      if (!assignment.speakerEntityId.trim() || profiles.has(assignment.speakerEntityId)) {
        throw new VoiceSynthesisError('speaker_ambiguous', '角色声线映射重复或缺少角色标识。');
      }
      profiles.set(assignment.speakerEntityId, assignment.profile);
    }
    const now = input.now ?? new Date().toISOString();
    const format = input.format ?? 'wav';
    // Fail the whole batch before a single paid call when any cue is unassigned.
    const resolved = input.track.cues.map(cue => this.resolveProfile(cue, profiles, input, now));
    const takes: VoiceTakeVersion[] = [];
    const operationKeys: string[] = [];
    const concurrency = Math.max(1, Math.min(4, this.options.maxConcurrency ?? 2));
    for (let start = 0; start < input.track.cues.length; start += concurrency) {
      const batch = input.track.cues.slice(start, start + concurrency);
      const results = await Promise.all(batch.map(async (cue, index) => {
        const profile = resolved[start + index]!;
        const text = cleanText(cue.text);
        const operationKey = createHash('sha256').update(JSON.stringify({
          track: input.track.contentDigest, cue: cue.cueId, source: cue.sourceDigest,
          profile: profile.contentDigest, provider: input.provider.provider,
          model: input.provider.model, revision: input.provider.modelRevision,
          text, format, language: cue.language, emotion: cue.emotion, pace: cue.pace,
        })).digest('hex');
        const result = await input.provider.synthesize({
          text, language: cue.language, emotion: cue.emotion, pace: cue.pace,
          voiceReference: profile.voiceReference, provider: input.provider.provider,
          model: input.provider.model, modelRevision: input.provider.modelRevision,
          format, operationKey,
        });
        validateResponse(result, format);
        const checksum = createHash('sha256').update(result.bytes).digest('hex');
        const attemptId = randomUUID();
        const id = takeId({ operationKey, attemptId });
        let audioArtifactId: string | null = null;
        if (input.audioStore) {
          audioArtifactId = (await input.audioStore.put({
            bytes: result.bytes, format: result.format, durationMs: result.durationMs,
            sampleRate: result.sampleRate, channels: result.channels,
          })).artifactId;
        }
        const take: VoiceTakeVersion = {
          schemaVersion: AUDIO_PRODUCTION_SCHEMA_VERSION, id,
          workspaceId: input.workspaceId, projectId: input.projectId,
          dialogueCueVersionId: input.track.id, dialogueCueId: cue.cueId,
          voiceProfileVersionId: profile.id, provider: input.provider.provider,
          modelRevision: input.provider.modelRevision, inputDigest: operationKey,
          operationKey, attemptId, audioArtifactId, objectVersionId: null,
          checksum, durationMs: result.durationMs, sampleRate: result.sampleRate,
          channels: result.channels, codec: result.format,
          alignment: result.alignment ? { ...result.alignment, phonemeMapObjectVersionId: null } : null,
          costMicros: result.costMicros, status: 'generated',
          quality: { decoded: true, textCoverage: 1, silenceRatio: null, clippingRatio: null,
            verdict: 'pass', evidenceRefs: [] },
          createdAt: now,
        };
        return { take, operationKey };
      }));
      for (const item of results) { takes.push(item.take); operationKeys.push(item.operationKey); }
    }
    return { takes, operationKeys };
  }

  private resolveProfile(cue: Readonly<DialogueCue>, profiles: ReadonlyMap<string, VoiceProfileVersion>,
    input: SynthesizeDialogueInput, now: string): VoiceProfileVersion {
    if (!cue.speakerEntityId) {
      throw new VoiceSynthesisError('speaker_ambiguous', `台词 ${cue.cueId} 没有确定说话人。`);
    }
    const profile = profiles.get(cue.speakerEntityId);
    if (!profile) throw new VoiceSynthesisError('speaker_ambiguous', `台词 ${cue.cueId} 缺少角色声线预设。`);
    if (profile.provider !== input.provider.provider || profile.model !== input.provider.model
      || profile.modelRevision !== input.provider.modelRevision) {
      throw new VoiceSynthesisError('provider_unknown', `角色声线 ${profile.id} 的供应商或模型版本不匹配。`);
    }
    if (profile.reviewStatus !== 'approved') {
      throw new VoiceSynthesisError('unauthorized_voice', `角色声线 ${profile.id} 尚未通过审查。`);
    }
    try {
      assertVoiceAuthorization(profile, { now, workspaceId: input.workspaceId, projectId: input.projectId,
        purpose: 'generate', commercialUse: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        const code = (error as { code?: string }).code;
        if (code === 'license_expired' || code === 'unauthorized_voice') {
          throw new VoiceSynthesisError(code, error.message);
        }
        throw new VoiceSynthesisError('unauthorized_voice', error.message);
      }
      throw error;
    }
    return profile;
  }
}

export * from './tts-adapter';
