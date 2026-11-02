import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { ModelError } from '@lyra/shared';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProductionMediaStore } from './store';
import type { OwnedLocalVideo } from './contracts';
import { ProductionMediaError } from './contracts';
import type { ProcessRunner } from './probe';

/** 一次评估需要的镜头上下文：媒体报道 + 分镜描述，用于让模型带着目的看画面。 */
export interface FrameAssessmentInput {
  shotId: string;
  mediaId: string;
  label: string;
  /** 分镜设计摘要（画面内容、构图、动作），帮助模型判断“该镜头本来要拍什么”。 */
  hint: string;
}

export type FrameVerdict = 'pass' | 'weak' | 'reject';
export type FrameAction = 'keep' | 'trim' | 'speedup' | 'drop';

export interface FrameShotAdvice {
  action: FrameAction;
  /** 建议倍速，1 表示原速；speedup 时一般 1.2–1.5。 */
  speedFactor: number;
  /** action 为 trim 时建议保留的秒数。 */
  trimSeconds: number | null;
  reason: string;
}

export interface FrameShotAssessment {
  shotId: string;
  verdict: FrameVerdict;
  /** 四个维度 0–5 分，5 为最好。 */
  scores: { identity: number; anatomy: number; action: number; quality: number };
  issues: string[];
  advice: FrameShotAdvice;
}

export interface FrameAssessmentReport {
  shots: FrameShotAssessment[];
  summary: {
    pass: number; weak: number; reject: number;
    recommendedTrim: number; recommendedSpeedup: number; recommendedDrop: number;
  };
}

export type FrameAssessmentResult =
  | { submission: 'notSubmitted' | 'unknown' }
  | { submission: 'answered'; assessment: FrameShotAssessment | null };

export interface FrameAssessorOptions {
  /** 每个镜头抽帧数，默认 3（首段/中段/尾段）。 */
  framesPerShot?: number;
  /** 抽帧缩放宽，默认 640。 */
  frameWidth?: number;
  /** 评估调用超时，默认 120 秒。 */
  timeoutMs?: number;
}

/** 模型通道最小接口：只要一个能返回 JSON 文本的 call，便于测试注入假实现。 */
export interface FrameJudgeModel {
  call(input: unknown): Promise<{ text: string }>;
}

const VERDICTS: readonly FrameVerdict[] = ['pass', 'weak', 'reject'];
const ACTIONS: readonly FrameAction[] = ['keep', 'trim', 'speedup', 'drop'];

const SYSTEM_PROMPT = `你是短剧剪辑师兼画面质检员。你会收到某个镜头的分镜设计摘要和按时间顺序抽取的若干帧截图。
请逐帧检查画面，按以下维度打分（0-5，5 为最好）：
- identity 人物外貌一致性：人脸、发型、服装、体型是否自然稳定，有无畸变、换脸感、多指多手
- anatomy 形体合理性：肢体结构、比例、姿态是否合理，有无穿模、断裂、漂浮、比例失调
- action 动作完成度：动作是否有清晰起止与方向，有无粘滞、跳变、重复
- quality 画面质量：清晰度、伪影、文字乱码、构图是否可用
判定：每个维度 >=4 为良好，<=2 为不合格；任一维度 <=2 记 weak，两个及以上 <=2 或严重畸形记 reject。
剪辑建议从以下四种里选一个：
- keep：画面与动作都合格，保留完整时长
- trim：首段或尾段存在无效/静滞画面，需要裁短，给出建议保留秒数 trimSeconds（不能超过原片长）
- speedup：内容有效但动作拖沓，建议 1.2-1.5 倍速
- drop：严重不合格（畸形、破面、完全不合理），应剔除
只输出一个 JSON 对象，不要代码块、不要解释。格式：
{"verdict":"pass|weak|reject","scores":{"identity":0-5,"anatomy":0-5,"action":0-5,"quality":0-5},"issues":["具体问题，中文，最多5条"],"advice":{"action":"keep|trim|speedup|drop","speedFactor":1-2,"trimSeconds":null或秒数,"reason":"一句话理由"}}`;

/**
 * 抽帧质量评估：把镜头视频均匀抽帧后交给视觉模型逐镜头打分，产出
 * 合格判定、问题清单与剪辑建议（保留/裁短/加速/剔除）。不改变媒体文件本身。
 */
export class FrameAssessor {
  private readonly framesPerShot: number;
  private readonly frameWidth: number;
  private readonly timeoutMs: number;

  constructor(private readonly store: Pick<ProductionMediaStore, 'getVideo'>,
    private readonly runner: ProcessRunner,
    private readonly judge: FrameJudgeModel,
    private readonly command = 'ffmpeg',
    options: FrameAssessorOptions = {}) {
    this.framesPerShot = options.framesPerShot ?? 3;
    this.frameWidth = options.frameWidth ?? 640;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async assess(inputs: readonly FrameAssessmentInput[]): Promise<FrameAssessmentReport> {
    if (inputs.length === 0) throw new ProductionMediaError(400, 'FRAME_ASSESSMENT_EMPTY', '没有可评估的镜头。');
    const shots: FrameShotAssessment[] = [];
    for (const input of inputs) {
      const result = await this.assessOne(input);
      if (result.submission !== 'answered' || !result.assessment) {
        throw new ProductionMediaError(502, 'FRAME_ASSESSMENT_UNAVAILABLE', '镜头评估未生成有效结论。');
      }
      shots.push(result.assessment);
    }
    return { shots, summary: summarizeAssessments(shots) };
  }

  /** Exactly one upstream call can follow local extraction; billing and usable advice are independent. */
  async assessOne(input: FrameAssessmentInput): Promise<FrameAssessmentResult> {
    let frames: Buffer[];
    let duration: number;
    try {
      const video = await this.store.getVideo(input.mediaId);
      duration = video.object.probe.durationSeconds;
      frames = await this.extractFrames(video);
    } catch { return { submission: 'notSubmitted' }; }
    let answer: string;
    try { answer = await this.judgeShot(input, frames, duration); }
    catch (error) {
      // ModelClient attaches callId to errors after dispatch. These codes are local preflight failures.
      if (error instanceof ModelError && ['INVALID_REQUEST', 'INPUT_TOO_LARGE', 'MODEL_NOT_CONFIGURED',
        'UNKNOWN_MODEL', 'EFFORT_UNSUPPORTED', 'LOCAL_BUSY'].includes(error.code) && !error.details.callId) {
        return { submission: 'notSubmitted' };
      }
      return { submission: 'unknown' };
    }
    try { return { submission: 'answered', assessment: parseAssessment(answer, input.shotId, duration) }; }
    catch { return { submission: 'answered', assessment: null }; }
  }

  /** 均匀抽 framesPerShot 帧（取 15%/50%/85% 位置），编码为 JPEG Buffer。 */
  private async extractFrames(video: OwnedLocalVideo): Promise<Buffer[]> {
    const duration = video.object.probe.durationSeconds;
    const dir = await mkdtemp(join(tmpdir(), 'frame-assess-'));
    try {
      const frames: Buffer[] = [];
      for (let index = 0; index < this.framesPerShot; index++) {
        const ratio = this.framesPerShot === 1 ? 0.5 : 0.15 + (0.7 * index) / (this.framesPerShot - 1);
        const at = Math.min(Math.max(duration * ratio, 0), Math.max(0, duration - 0.05));
        const target = join(dir, `frame-${index}.jpg`);
        const result = await this.runner.run(this.command, ['-hide_banner', '-loglevel', 'error', '-y',
          '-ss', at.toFixed(3), '-i', video.absolutePath, '-frames:v', '1',
          '-vf', `scale=${this.frameWidth}:-2`, '-q:v', '4', target]);
        if (result.stderr && result.stderr.length > 0) {
          const text = result.stderr.toString('utf8').slice(0, 300);
          if (!text.trim()) continue;
        }
        try { frames.push(await readFile(target)); } catch { /* 该时间点无帧则跳过 */ }
      }
      if (frames.length === 0) throw new ProductionMediaError(422, 'FRAME_EXTRACTION_EMPTY', '镜头视频抽帧失败，无法评估画面。');
      return frames;
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
  }

  private async judgeShot(input: FrameAssessmentInput, frames: Buffer[], durationSeconds: number): Promise<string> {
    const content: Array<Record<string, unknown>> = [{
      type: 'text',
      text: `镜头：${input.label}\n分镜设计：${input.hint || '（无设计描述）'}\n原片时长：${durationSeconds.toFixed(2)} 秒\n下面是该镜头按时间顺序抽取的 ${frames.length} 帧。`,
    }];
    for (const frame of frames) content.push({ type: 'image', mediaType: 'image/jpeg', dataBase64: frame.toString('base64') });
    const answer = await this.judge.call({ messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ], jsonOutput: true, allowPaid: true, maxOutputTokens: 1024 });
    return answer.text;
  }
}

/** 严格解析模型 JSON：只接受白名单字段，越界分数夹紧，建议不允许超过原片。 */
export function parseAssessment(text: string, shotId: string, durationSeconds: number): FrameShotAssessment {
    const start = text.indexOf('{'); const end = text.lastIndexOf('}');
    let raw: unknown;
    try { raw = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : null; }
    catch { throw new ProductionMediaError(502, 'FRAME_ASSESSMENT_INVALID', '画面评估返回的不是有效 JSON。'); }
    const source = record(raw);
    if (!source) throw new ProductionMediaError(502, 'FRAME_ASSESSMENT_INVALID', '画面评估返回的不是 JSON 对象。');
    if (Object.keys(source).some(key => !['verdict', 'scores', 'issues', 'advice'].includes(key))) {
      throw new ProductionMediaError(502, 'FRAME_ASSESSMENT_INVALID', '画面评估出现了未知字段。');
    }
    const verdict = VERDICTS.includes(source.verdict as FrameVerdict) ? source.verdict as FrameVerdict : 'weak';
    const scoresSource = record(source.scores) ?? {};
    const scores = {
      identity: score(scoresSource.identity), anatomy: score(scoresSource.anatomy),
      action: score(scoresSource.action), quality: score(scoresSource.quality),
    };
    const issues = Array.isArray(source.issues) ? source.issues.filter((item): item is string => typeof item === 'string')
      .map(item => item.slice(0, 80)).slice(0, 5) : [];
    const adviceSource = record(source.advice) ?? {};
    const action = ACTIONS.includes(adviceSource.action as FrameAction) ? adviceSource.action as FrameAction : 'keep';
    const speedFactor = clampNumber(adviceSource.speedFactor, 1, 2, 1);
    const trimRaw = adviceSource.trimSeconds;
    const trimSeconds = action === 'trim' && typeof trimRaw === 'number' && Number.isFinite(trimRaw)
      ? Math.min(Math.max(trimRaw, 0.5), Math.max(0.5, durationSeconds)) : null;
    const reason = typeof adviceSource.reason === 'string' ? adviceSource.reason.slice(0, 120) : '';
    const normalized: FrameShotAssessment = { shotId, verdict, scores, issues,
      advice: { action: action === 'trim' && trimSeconds === null ? 'keep' : action, speedFactor, trimSeconds, reason } };
    if (normalized.advice.action !== 'trim') normalized.advice.trimSeconds = null;
    if (normalized.advice.action !== 'speedup') normalized.advice.speedFactor = 1;
    return normalized;
}

export function summarizeAssessments(shots: readonly FrameShotAssessment[]): FrameAssessmentReport['summary'] {
  return {
    pass: shots.filter(shot => shot.verdict === 'pass').length,
    weak: shots.filter(shot => shot.verdict === 'weak').length,
    reject: shots.filter(shot => shot.verdict === 'reject').length,
    recommendedTrim: shots.filter(shot => shot.advice.action === 'trim').length,
    recommendedSpeedup: shots.filter(shot => shot.advice.action === 'speedup').length,
    recommendedDrop: shots.filter(shot => shot.advice.action === 'drop').length,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function score(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(5, Math.max(0, Math.round(value)));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
