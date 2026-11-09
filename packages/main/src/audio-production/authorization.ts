import type { VoiceAuthorization, VoiceProfileVersion } from '@lyra/shared';

export type VoiceAuthorizationErrorCode = 'unauthorized_voice' | 'license_expired' | 'license_scope_mismatch';

export class VoiceAuthorizationError extends Error {
  readonly status = 403;
  constructor(readonly code: VoiceAuthorizationErrorCode, message: string) {
    super(message); this.name = 'VoiceAuthorizationError';
  }
}

export interface VoiceAuthorizationContext {
  now: string;
  workspaceId: string;
  projectId: string;
  purpose: 'generate' | 'deliver';
  commercialUse: boolean;
}

export interface VoiceAuthorizationDecision {
  allowed: boolean;
  code: VoiceAuthorizationErrorCode | null;
  message: string;
  expiresAt: string | null;
}

function moment(value: string, label: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new VoiceAuthorizationError('unauthorized_voice', `授权${label}时间无效。`);
  return time;
}

/** Real-person cloning is denied by default and requires explicit, verifiable consent. */
export function evaluateVoiceAuthorization(profile: VoiceProfileVersion,
  context: VoiceAuthorizationContext): VoiceAuthorizationDecision {
  const authorization = profile.authorization;
  if (!authorization) return { allowed: false, code: 'unauthorized_voice', message: '声线没有授权记录。', expiresAt: null };
  if (profile.workspaceId !== context.workspaceId) {
    return { allowed: false, code: 'license_scope_mismatch', message: '声线不属于当前工作区。', expiresAt: null };
  }
  if (!profile.scope.projectIds.includes(context.projectId) && !profile.scope.workspaceWide) {
    return { allowed: false, code: 'license_scope_mismatch', message: '声线授权不覆盖当前项目。', expiresAt: null };
  }
  const now = moment(context.now, '当前');
  const validFrom = moment(authorization.validFrom, '起始');
  if (now < validFrom) return { allowed: false, code: 'unauthorized_voice', message: '声线授权尚未生效。', expiresAt: authorization.validUntil };
  if (authorization.revokedAt) {
    return { allowed: false, code: 'license_expired', message: '声线授权已撤销，不能继续生成或交付。', expiresAt: authorization.validUntil };
  }
  if (authorization.validUntil !== null) {
    const validUntil = moment(authorization.validUntil, '结束');
    if (now >= validUntil) {
      return { allowed: false, code: 'license_expired', message: '声线授权已过期，不能继续生成或交付。', expiresAt: authorization.validUntil };
    }
  }
  if (authorization.type === 'unknown') {
    return { allowed: false, code: 'unauthorized_voice', message: '声线授权类型不明，不能进入正式生产。', expiresAt: authorization.validUntil };
  }
  if (authorization.type === 'licensed_real_person' && !authorization.cloningConsent) {
    return { allowed: false, code: 'unauthorized_voice', message: '真人声音克隆缺少明确同意记录，默认禁止。', expiresAt: authorization.validUntil };
  }
  if (context.commercialUse && !authorization.commercialUse) {
    return { allowed: false, code: 'unauthorized_voice', message: '声线授权不包含商业用途。', expiresAt: authorization.validUntil };
  }
  if (authorization.consentRecordRef === null && authorization.type === 'licensed_real_person') {
    return { allowed: false, code: 'unauthorized_voice', message: '真人声音授权缺少可核验的同意记录。', expiresAt: authorization.validUntil };
  }
  return { allowed: true, code: null, message: '声线授权有效。', expiresAt: authorization.validUntil };
}

/** Used before delivery to keep an already generated take from shipping after expiry. */
export function assertVoiceAuthorization(profile: VoiceProfileVersion, context: VoiceAuthorizationContext): void {
  const decision = evaluateVoiceAuthorization(profile, context);
  if (!decision.allowed) throw new VoiceAuthorizationError(decision.code ?? 'unauthorized_voice', decision.message);
}

export function voiceAuthorizationSummary(authorization: VoiceAuthorization) {
  return {
    type: authorization.type,
    commercialUse: authorization.commercialUse,
    territories: [...authorization.territories],
    channels: [...authorization.channels],
    validFrom: authorization.validFrom,
    validUntil: authorization.validUntil,
    revoked: authorization.revokedAt !== null,
    hasConsentRecord: authorization.consentRecordRef !== null,
  };
}
