import { createHash } from 'node:crypto';
import type { VoiceProfileVersion } from '@lyra/shared';
import { evaluateVoiceAuthorization, VoiceAuthorizationError } from '../../audio-production/authorization';
import {
  assertPaidGenerationReservation,
  PaidGenerationError,
  type PaidGenerationInterceptor,
  type PaidGenerationReservation,
} from '../../budget/paid-generation';

export type TtsAudioFormat = 'mp3' | 'wav' | 'opus';

export interface TtsProviderConfig {
  provider: string;
  endpoint: string;
  model: string;
  authType: 'bearer' | 'api-key';
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  maxBytes?: number;
}

export interface TtsSynthesisRequest {
  workspaceId: string;
  projectId: string;
  operationKey: string;
  clientRequestId: string;
  runId?: string | null;
  taskId?: string | null;
  text: string;
  language: string;
  voice: VoiceProfileVersion;
  commercialUse: boolean;
  format?: TtsAudioFormat;
  speed?: number;
  estimateMicros: number;
  budgetLimitMicros: number;
  currency: string;
  /** Optional decoder probe; production supplies ffprobe, tests can omit it. */
  probe?: (bytes: Buffer, mimeType: string) => Promise<{ durationMs: number; sampleRate: number; channels: number; codec: string }>;
}

export interface TtsSynthesisResult {
  provider: string;
  model: string;
  operationKey: string;
  reservationId: string;
  bytes: Buffer;
  sha256: string;
  mimeType: 'audio/mpeg' | 'audio/wav' | 'audio/ogg';
  durationMs: number;
  sampleRate: number | null;
  channels: number | null;
  codec: string | null;
}

export class TtsError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'TtsError';
  }
}

const MAX_TEXT = 2000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const VOICE_REF = /^[A-Za-z0-9_.:/+-]{1,200}$/u;
const OPERATION = /^[A-Za-z0-9_.:-]{1,160}$/u;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,100}$/u;
const WORKSPACE = /^ws_[a-f0-9]{32}$/u;
const PROJECT = /^[A-Za-z0-9_.:-]{1,160}$/u;

function invalid(message: string): never {
  throw new TtsError(400, 'TTS_REQUEST_INVALID', message);
}

function checkedConfig(config: TtsProviderConfig): void {
  if (!config || typeof config !== 'object') invalid('TTS 供应商配置缺失。');
  if (typeof config.provider !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/u.test(config.provider)) invalid('TTS 供应商标识无效。');
  let url: URL;
  try { url = new URL(config.endpoint); } catch { invalid('TTS endpoint 无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    invalid('TTS endpoint 必须是无查询参数、无凭据的 HTTPS 地址。');
  }
  if (config.authType !== 'bearer' && config.authType !== 'api-key') invalid('TTS 鉴权方式无效。');
  if (!config.model || config.model.length > 200) invalid('TTS 模型标识无效。');
  if (!config.apiKey || config.apiKey.length > 4096) invalid('TTS 密钥缺失。');
  if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 600_000)) {
    invalid('TTS 超时配置无效。');
  }
  if (config.maxBytes !== undefined && (!Number.isSafeInteger(config.maxBytes) || config.maxBytes < 1024
    || config.maxBytes > 128 * 1024 * 1024)) invalid('TTS 响应上限无效。');
}

function parseRequest(config: TtsProviderConfig, raw: TtsSynthesisRequest): TtsSynthesisRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('TTS 合成请求格式无效。');
  if (typeof raw.workspaceId !== 'string' || !WORKSPACE.test(raw.workspaceId)) invalid('TTS 请求缺少有效工作区。');
  if (typeof raw.projectId !== 'string' || !PROJECT.test(raw.projectId)) invalid('TTS 请求缺少有效项目。');
  if (typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > MAX_TEXT
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(raw.text)) invalid('TTS 文本必须为 1–2000 字且不含控制字符。');
  if (typeof raw.language !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/u.test(raw.language)) invalid('TTS 语言标识无效。');
  if (typeof raw.operationKey !== 'string' || !OPERATION.test(raw.operationKey)) invalid('TTS operationKey 无效。');
  if (typeof raw.clientRequestId !== 'string' || !REQUEST_ID.test(raw.clientRequestId)) invalid('TTS 请求标识无效。');
  if (raw.format !== undefined && !['mp3', 'wav', 'opus'].includes(raw.format)) invalid('TTS 音频格式无效。');
  if (raw.speed !== undefined && (!Number.isFinite(raw.speed) || raw.speed < 0.5 || raw.speed > 2)) invalid('TTS 语速无效。');
  if (!Number.isSafeInteger(raw.estimateMicros) || raw.estimateMicros <= 0
    || !Number.isSafeInteger(raw.budgetLimitMicros) || raw.budgetLimitMicros < raw.estimateMicros) {
    invalid('TTS 必须提供正数预算估价且不超过已授权上限。');
  }
  if (typeof raw.currency !== 'string' || !/^[A-Z]{3}$/u.test(raw.currency)) invalid('TTS 预算币种无效。');
  if (typeof raw.commercialUse !== 'boolean') invalid('TTS 商业用途标识无效。');
  const voice = raw.voice;
  if (!voice || typeof voice !== 'object' || typeof voice.voiceReference !== 'string' || !VOICE_REF.test(voice.voiceReference)) {
    invalid('TTS 声线引用无效。');
  }
  if (voice.workspaceId !== raw.workspaceId) invalid('TTS 声线不属于当前工作区。');
  if (voice.provider !== config.provider) invalid('TTS 声线与当前供应商不一致。');
  if (voice.reviewStatus !== 'approved') invalid('TTS 声线尚未通过审核，不能进入生产。');
  return raw;
}

async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new TtsError(502, 'TTS_RESPONSE_EMPTY', 'TTS 供应商返回空响应。');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new TtsError(502, 'TTS_RESPONSE_TOO_LARGE', 'TTS 音频响应超过 32 MiB。');
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof TtsError) throw error;
    throw new TtsError(502, 'TTS_RESPONSE_INVALID', '无法完整读取 TTS 音频响应。');
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

function parseBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(32 * 1024 * 1024 / 3) * 4
    || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new TtsError(502, 'TTS_RESPONSE_INVALID', 'TTS 供应商返回了无效音频数据。');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new TtsError(502, 'TTS_RESPONSE_INVALID', 'TTS 供应商返回了无效音频数据。');
  return bytes;
}

function audioShape(bytes: Buffer, requested: TtsAudioFormat): { mimeType: TtsSynthesisResult['mimeType']; codec: string } {
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString('latin1') === 'ID3') {
    return { mimeType: 'audio/mpeg', codec: 'mp3' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    return { mimeType: 'audio/mpeg', codec: 'mp3' };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF'
    && bytes.subarray(8, 12).toString('latin1') === 'WAVE') {
    return { mimeType: 'audio/wav', codec: 'pcm_s16le' };
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'OggS') {
    return { mimeType: 'audio/ogg', codec: 'opus' };
  }
  throw new TtsError(502, 'TTS_AUDIO_FORMAT_INVALID', `TTS 返回的音频不是受支持的 ${requested}。`);
}

/**
 * Independent TTS driver. It refuses a voice before any budget reservation or
 * network call when the persisted authorization is missing, expired or lacks
 * commercial scope. The actual provider call is always behind a Lyra budget
 * reservation.
 */
export class TtsSynthesisAdapter {
  private readonly config: TtsProviderConfig;
  private readonly budget: PaidGenerationInterceptor;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(config: TtsProviderConfig, budget: PaidGenerationInterceptor) {
    checkedConfig(config);
    this.config = config;
    this.budget = budget;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
    this.timeoutMs = config.timeoutMs ?? 120_000;
  }

  private authorization(raw: TtsSynthesisRequest): void {
    try {
      const decision = evaluateVoiceAuthorization(raw.voice, {
        now: new Date().toISOString(), workspaceId: raw.workspaceId, projectId: raw.projectId,
        purpose: 'generate', commercialUse: raw.commercialUse,
      });
      if (!decision.allowed) {
        throw new TtsError(403, decision.code === 'license_expired' ? 'license_expired' : 'unauthorized_voice', decision.message);
      }
    } catch (error) {
      if (error instanceof TtsError) throw error;
      if (error instanceof VoiceAuthorizationError) {
        throw new TtsError(403, error.code === 'license_expired' ? 'license_expired' : 'unauthorized_voice', error.message);
      }
      throw new TtsError(403, 'unauthorized_voice', '声线授权记录无法核验，默认拒绝生成。');
    }
  }

  private body(raw: TtsSynthesisRequest): Record<string, unknown> {
    return {
      model: raw.voice.model || this.config.model,
      input: raw.text,
      voice: raw.voice.voiceReference,
      response_format: raw.format ?? 'mp3',
      ...(raw.speed !== undefined ? { speed: raw.speed } : {}),
    };
  }

  async synthesize(rawRequest: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
    const request = parseRequest(this.config, rawRequest);
    this.authorization(request);
    const body = this.body(request);
    let reservation: PaidGenerationReservation;
    try {
      reservation = await this.budget.reserve({
        workspaceId: request.workspaceId, operationKey: request.operationKey, provider: this.config.provider,
        model: request.voice.model || this.config.model, estimateMicros: request.estimateMicros,
        budgetLimitMicros: request.budgetLimitMicros, currency: request.currency,
        runId: request.runId ?? null, taskId: request.taskId ?? null,
      });
    } catch (error) {
      if (error instanceof PaidGenerationError) throw error;
      throw new TtsError(503, 'TTS_BUDGET_UNAVAILABLE', 'TTS 预算拦截器不可用；未调用付费语音。');
    }
    try {
      assertPaidGenerationReservation(this.budget, reservation, {
        workspaceId: request.workspaceId, operationKey: request.operationKey, provider: this.config.provider,
        model: request.voice.model || this.config.model, estimateMicros: request.estimateMicros, currency: request.currency,
      });
    } catch (error) {
      await this.releaseSafely(reservation, '预算凭证与 TTS 请求不一致，未调用供应商。');
      throw error;
    }

    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.endpoint, {
        method: 'POST',
        headers: {
          authorization: `${this.config.authType === 'bearer' ? 'Bearer' : 'Api-Key'} ${this.config.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json, audio/*',
        },
        body: JSON.stringify(body),
        redirect: 'error', signal,
      });
    } catch {
      await this.unknownSafely(reservation, 'TTS 网络结果不明，保留预算预留等待对账。');
      throw new TtsError(502, 'TTS_SUBMISSION_UNCERTAIN', 'TTS 提交结果不明；不会自动重发。');
    }

    if (!response.ok) {
      await response.body?.cancel();
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        await this.releaseSafely(reservation, 'TTS 供应商明确拒绝请求，释放预算预留。');
        throw new TtsError(502, 'TTS_PROVIDER_REJECTED', 'TTS 供应商明确拒绝了请求；未重试、未扣费。');
      }
      await this.unknownSafely(reservation, 'TTS 供应商返回错误状态，结果不明。');
      throw new TtsError(502, 'TTS_SUBMISSION_UNCERTAIN', 'TTS 提交结果不明；保留预算预留。');
    }

    let bytes: Buffer | null = null;
    let durationMs: number | null = null;
    try {
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (contentType.includes('json')) {
        const rawText = (await readBounded(response, Math.min(this.maxBytes, 4 * 1024 * 1024))).toString('utf8');
        let parsed: unknown;
        try { parsed = JSON.parse(rawText); } catch { throw new TtsError(502, 'TTS_RESPONSE_INVALID', 'TTS JSON 响应无效。'); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TtsError(502, 'TTS_RESPONSE_INVALID', 'TTS JSON 响应格式无效。');
        const record = parsed as Record<string, unknown>;
        const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
          ? record.data as Record<string, unknown> : {};
        const base64 = record.audio ?? data.audio;
        bytes = parseBase64(base64);
        const value = record.duration_ms ?? data.duration_ms;
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 3_600_000) durationMs = Math.round(value);
      } else {
        bytes = await readBounded(response, this.maxBytes);
      }
    } catch (error) {
      if (error instanceof TtsError) {
        // The provider may still have billed a 2xx call. Keep the hold.
        await this.unknownSafely(reservation, 'TTS 返回 2xx 但音频无法解析，结果不明。');
      }
      throw error;
    }
    if (!bytes.length) {
      await this.unknownSafely(reservation, 'TTS 返回 2xx 但音频为空。');
      throw new TtsError(502, 'TTS_AUDIO_EMPTY', 'TTS 返回了空音频；保留预算预留。');
    }
    const shape = audioShape(bytes, request.format ?? 'mp3');
    let probed: { durationMs: number; sampleRate: number; channels: number; codec: string } | null = null;
    if (request.probe) {
      try { probed = await request.probe(bytes, shape.mimeType); }
      catch {
        // The provider already produced audio; keep the hold for reconciliation.
        await this.unknownSafely(reservation, 'TTS 音频已返回但本地解码失败，结果不明。');
        throw new TtsError(502, 'TTS_AUDIO_PROBE_FAILED', 'TTS 音频无法通过本地解码校验；保留预算预留。');
      }
    }
    if (durationMs === null && probed) durationMs = probed.durationMs;
    try { await this.budget.commit(reservation, request.estimateMicros); }
    catch { throw new TtsError(503, 'TTS_SETTLEMENT_FAILED', 'TTS 已生成音频但预算结算失败；需要人工对账，不能重提。'); }
    return {
      provider: this.config.provider,
      model: request.voice.model || this.config.model,
      operationKey: request.operationKey,
      reservationId: reservation.id,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mimeType: shape.mimeType,
      durationMs: durationMs ?? 0,
      sampleRate: probed?.sampleRate ?? null,
      channels: probed?.channels ?? null,
      codec: probed?.codec ?? shape.codec,
    };
  }

  private async releaseSafely(reservation: PaidGenerationReservation, reason: string): Promise<void> {
    try { await this.budget.release(reservation, reason); } catch { /* preserve original */ }
  }

  private async unknownSafely(reservation: PaidGenerationReservation, reason: string): Promise<void> {
    try { await this.budget.markUnknown(reservation, reason); } catch { /* never resubmit */ }
  }
}
