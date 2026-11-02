import { createHash } from 'node:crypto';
import { access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ProductionMediaError, TIMELINE_MANIFEST_SCHEMA_VERSION, parseMediaId,
  type ComposeTimelineRequest, type OwnedLocalVideo, type TimelineEditPlan,
  type TimelineEditRequest, type TimelineManifest, type TimelineClipDirective,
} from './contracts';
import type { ProcessRunner } from './probe';
import type { ProductionMediaStore } from './store';

export interface TimelineComposerOptions {
  ffmpegExecutable?: string;
  maxClips?: number;
  maxTimelineDurationSeconds?: number;
  timeoutMs?: number;
  now?: () => Date;
}

const TITLE_CARD_SECONDS = 2.5;
const END_CARD_SECONDS = 2.2;
const CARD_FADE_SECONDS = 0.5;
const MIN_CLIP_SECONDS = 1;
const CARD_BACKGROUND = '0x0A0A0F';
const FONT_CANDIDATES = [
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  '/System/Library/Fonts/STHeiti Light.ttc',
  '/System/Library/Fonts/Supplemental/Songti.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
];

interface NormalizedEditRequest {
  titleCardText: string | null;
  titleCardSubtitle: string | null;
  endCardText: string | null;
  transitionSeconds: number;
  targetSeconds: number | null;
  directives: TimelineClipDirective[];
}

interface EditClip {
  label: string;
  seconds: number;
  /** 非空表示该片段需要显式裁剪到该时长（按目标总时长等比压缩或评估建议）。 */
  trimSeconds: number | null;
  /** 播放倍速，>1 表示该片段压缩播放（评估建议加速）。 */
  speedFactor: number;
}

interface EditBuild {
  plan: TimelineEditPlan;
  clips: EditClip[];
  expectedDurationSeconds: number;
  crossfade: boolean;
}

export class TimelineComposer {
  private readonly ffmpegExecutable: string;
  private readonly maxClips: number;
  private readonly maxTimelineDurationSeconds: number;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly active = new Map<string, Promise<TimelineManifest>>();
  private drawtextSupport: Promise<boolean> | null = null;

  constructor(private readonly store: ProductionMediaStore, private readonly runner: ProcessRunner,
    options: TimelineComposerOptions = {}) {
    this.ffmpegExecutable = options.ffmpegExecutable ?? 'ffmpeg';
    this.maxClips = options.maxClips ?? 200;
    this.maxTimelineDurationSeconds = options.maxTimelineDurationSeconds ?? Math.min(15 * 60, store.limits.maxDurationSeconds);
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
    this.now = options.now ?? (() => new Date());
  }

  async compose(value: ComposeTimelineRequest): Promise<TimelineManifest> {
    const request = this.parse(value);
    const digestPayload = request.edit
      ? { version: 2, videoIds: request.videoIds, title: request.title, edit: request.edit }
      : { version: 1, videoIds: request.videoIds, title: request.title };
    const inputDigest = createHash('sha256').update(JSON.stringify(digestPayload)).digest('hex');
    const id = `timeline_${inputDigest}`;
    const saved = await this.store.readManifest<TimelineManifest>(id);
    if (saved) return this.validateSaved(saved, id, inputDigest, request);
    const running = this.active.get(id);
    if (running) return running;
    const operation = this.composeOnce(id, inputDigest, request);
    this.active.set(id, operation);
    try { return await operation; }
    finally { this.active.delete(id); }
  }

  private async composeOnce(id: string, inputDigest: string, request: ParsedComposeRequest): Promise<TimelineManifest> {
    const inputs: OwnedLocalVideo[] = [];
    for (const mediaId of request.videoIds) inputs.push(await this.store.getVideo(mediaId));
    const withAudio = inputs.filter(input => input.object.probe.hasAudio).length;
    if (withAudio !== 0 && withAudio !== inputs.length) {
      throw new ProductionMediaError(409, 'TIMELINE_AUDIO_INCOMPATIBLE', '时间线不能混合有声和无声镜头；请先完成统一声音处理。');
    }
    const first = inputs[0]!;
    const width = even(first.object.probe.width);
    const height = even(first.object.probe.height);
    if (width > this.store.limits.maxWidth || height > this.store.limits.maxHeight
      || width * height > this.store.limits.maxPixels) {
      throw new ProductionMediaError(413, 'TIMELINE_RESOLUTION_INVALID', '时间线目标分辨率超过本地媒体限制。');
    }
    const audio = withAudio === inputs.length;
    const build = request.edit
      ? await this.buildEdit(request.edit, inputs, width, height, audio)
      : null;
    const expectedDuration = build ? build.expectedDurationSeconds
      : inputs.reduce((sum, video) => sum + video.object.probe.durationSeconds, 0);
    if (!Number.isFinite(expectedDuration) || expectedDuration <= 0 || expectedDuration > this.maxTimelineDurationSeconds) {
      throw new ProductionMediaError(413, 'TIMELINE_DURATION_INVALID', '时间线总时长为空或超过本地合成限制。');
    }
    const work = await this.store.createWorkDirectory('compose');
    const outputPath = join(work, 'output.mp4');
    try {
      const args = this.ffmpegArgs(inputs, outputPath, width, height, audio, build);
      await this.runner.run(this.ffmpegExecutable, args, { cwd: work, timeoutMs: this.timeoutMs,
        maxOutputBytes: 4 * 1024 * 1024 });
      const output = await this.store.importOwnedVideo(outputPath, 'composition');
      const tolerance = Math.max(2, expectedDuration * 0.05);
      if (output.probe.width !== width || output.probe.height !== height
        || Math.abs(output.probe.durationSeconds - expectedDuration) > tolerance
        || output.probe.hasAudio !== audio) {
        throw new ProductionMediaError(422, 'TIMELINE_OUTPUT_MISMATCH', '合成结果的时长、分辨率或音轨与时间线不一致，未登记交付。');
      }
      const manifest: TimelineManifest = {
        schemaVersion: TIMELINE_MANIFEST_SCHEMA_VERSION, id, inputDigest, title: request.title,
        createdAt: this.timestamp(),
        inputs: inputs.map((input, index) => ({ order: index + 1, mediaId: input.object.id,
          sha256: input.object.sha256, durationSeconds: input.object.probe.durationSeconds,
          width: input.object.probe.width, height: input.object.probe.height,
          hasAudio: input.object.probe.hasAudio })),
        output,
        composition: { strategy: build ? 'ffmpeg-auto-edit' : 'ffmpeg-concat-filter', videoCodec: 'libx264',
          audioCodec: audio ? 'aac' : null, width, height,
          expectedDurationSeconds: expectedDuration, ...(build ? { edit: build.plan } : {}) },
      };
      await this.store.writeManifest(id, manifest);
      return (await this.store.readManifest<TimelineManifest>(id)) ?? manifest;
    } finally {
      await unlink(outputPath).catch(() => undefined);
      // Only remove the service-created empty work directory. A surprising file
      // makes cleanup fail closed and leaves evidence for manual inspection.
      const { rmdir } = await import('node:fs/promises');
      await rmdir(work).catch(() => undefined);
    }
  }

  /** 组装自动剪辑方案：片头/片尾卡 + 转场时长 + 期望总时长；转场时长按最短片段钳制，避免 xfade 越界。 */
  private planEdit(edit: NormalizedEditRequest, inputs: OwnedLocalVideo[]): EditBuild {
    const directiveMap = new Map(edit.directives.map(item => [item.videoId, item]));
    const kept = inputs.filter(input => directiveMap.get(input.object.id)?.action !== 'drop');
    if (kept.length === 0 && inputs.length > 0) {
      throw new ProductionMediaError(422, 'TIMELINE_ALL_CLIPS_DROPPED', '按抽帧评估结果所有镜头都被剔除，无法成片。');
    }
    const probed = kept.map(input => input.object.probe.durationSeconds);
    const planned = this.planClipDurations(edit, kept, directiveMap, probed);
    const clips: EditClip[] = [];
    if (edit.titleCardText) clips.push({ label: 'vtitle', seconds: TITLE_CARD_SECONDS, trimSeconds: null, speedFactor: 1 });
    for (let index = 0; index < kept.length; index++) clips.push({ label: `v${index}`, seconds: planned.durations[index]!,
      trimSeconds: planned.trimSeconds[index]!, speedFactor: planned.speedFactors[index]! });
    if (edit.endCardText) clips.push({ label: 'vend', seconds: END_CARD_SECONDS, trimSeconds: null, speedFactor: 1 });
    const shortest = clips.length ? Math.min(...clips.map(clip => clip.seconds)) : 0;
    const transitionSeconds = Math.min(edit.transitionSeconds, shortest * 0.5);
    const plan: TimelineEditPlan = {
      titleCardText: edit.titleCardText,
      titleCardSubtitle: edit.titleCardSubtitle,
      endCardText: edit.endCardText,
      transitionSeconds,
      titleCardSeconds: edit.titleCardText ? TITLE_CARD_SECONDS : null,
      endCardSeconds: edit.endCardText ? END_CARD_SECONDS : null,
    };
    const crossfade = transitionSeconds > 0 && clips.length >= 2;
    const overlaps = crossfade ? (clips.length - 1) * transitionSeconds : 0;
    const total = clips.reduce((sum, clip) => sum + clip.seconds, 0) - overlaps;
    if (!Number.isFinite(total) || total <= 0) {
      throw new ProductionMediaError(409, 'TIMELINE_EDIT_INVALID', '自动剪辑方案的总时长无效。');
    }
    return { plan, clips, expectedDurationSeconds: total, crossfade };
  }

  /**
   * 汇总逐镜头剪辑指令（剔除/裁短/加速）与目标时长：
   * 1) 先应用评估建议，被调整的镜头不再按目标等比压缩；
   * 2) 剩余镜头按目标总时长等比压缩兜底；
   * 3) 若仅靠压缩剩余镜头无法落到目标，则按已调整后的播放时长统一压缩，
   *    并把压缩后的源时长写回 trim，保留已有倍速，使 FFmpeg 与计划时长一致。
   */
  private planClipDurations(edit: NormalizedEditRequest, kept: readonly OwnedLocalVideo[],
    directiveMap: ReadonlyMap<string, TimelineClipDirective>, probed: readonly number[]):
    { durations: number[]; trimSeconds: Array<number | null>; speedFactors: number[] } {
    const trimSeconds: Array<number | null> = probed.map(() => null);
    const speedFactors = probed.map(() => 1);
    const adjusted = probed.map(() => false);
    const durations = probed.map(value => value);
    kept.forEach((input, index) => {
      const directive = directiveMap.get(input.object.id);
      if (!directive) return;
      if (directive.action === 'trim' && directive.trimSeconds !== undefined) {
        const value = Math.min(directive.trimSeconds, probed[index]!);
        if (value >= MIN_CLIP_SECONDS) { durations[index] = value; trimSeconds[index] = value; adjusted[index] = true; }
      } else if (directive.action === 'speedup' && directive.speedFactor !== undefined && directive.speedFactor > 1) {
        durations[index] = probed[index]! / directive.speedFactor;
        speedFactors[index] = directive.speedFactor;
        adjusted[index] = true;
      }
    });
    if (edit.targetSeconds === null) return { durations, trimSeconds, speedFactors };
    const target = edit.targetSeconds;
    const cards = (edit.titleCardText ? TITLE_CARD_SECONDS : 0) + (edit.endCardText ? END_CARD_SECONDS : 0);
    const pieces = kept.length + (edit.titleCardText ? 1 : 0) + (edit.endCardText ? 1 : 0);
    const transitions = Math.max(0, pieces - 1);
    const overlap = transitions * edit.transitionSeconds;
    const sumAdjusted = durations.filter((_, index) => adjusted[index]).reduce((total, value) => total + value, 0);
    const sumFree = probed.filter((_, index) => !adjusted[index]).reduce((total, value) => total + value, 0);
    const needFree = target - cards + overlap - sumAdjusted;
    let scale = sumFree > 0 ? needFree / sumFree : 1;
    scale = Math.min(1, scale);
    if (scale <= 0 || (sumFree * Math.min(1, scale) > 0 && probed.some((value, index) => !adjusted[index] && value * Math.min(1, scale) < MIN_CLIP_SECONDS))) {
      const all = durations.reduce((total, value) => total + value, 0);
      // Scale the playback durations that already include trim/speedup. Multiplying
      // the original probe by a factor computed from the shortened total overshoots
      // the target, and clearing trim/speed leaves FFmpeg playing the full clips.
      const raw = all > 0 ? (target - cards + overlap) / all : 0;
      const fallback = Math.min(1, raw);
      if (fallback <= 0 || durations.some(value => value * fallback < MIN_CLIP_SECONDS)) {
        throw new ProductionMediaError(422, 'TIMELINE_TARGET_TOO_SHORT',
          '目标时长过短：按比例压缩后单个镜头不足 1 秒，无法保持转场稳定。');
      }
      const nextDurations = durations.map(value => value * fallback);
      return {
        durations: nextDurations,
        trimSeconds: nextDurations.map((playback, index) => {
          const sourceSeconds = playback * speedFactors[index]!;
          return sourceSeconds < probed[index]! - 0.0005 ? sourceSeconds : null;
        }),
        speedFactors,
      };
    }
    if (scale < 1) {
      for (let index = 0; index < probed.length; index++) {
        if (!adjusted[index]) {
          durations[index] = probed[index]! * scale;
          trimSeconds[index] = durations[index]!;
        }
      }
    }
    return { durations, trimSeconds, speedFactors };
  }

  /** 字体仅影响卡片文字绘制，不参与清单等值校验；drawtext 不可用时降级为无文字纯色卡。 */
  private async buildEdit(edit: NormalizedEditRequest, inputs: OwnedLocalVideo[], width: number, height: number,
    audio: boolean): Promise<EditBuild & { fontFile: string | null }> {
    const base = this.planEdit(edit, inputs);
    const fontFile = (await this.detectDrawtext()) ? await this.detectFont() : null;
    return { ...base, fontFile };
  }

  /** 本机 ffmpeg 可能未编译 freetype（无 drawtext 滤镜）；探测失败时卡片降级为纯色淡入淡出。 */
  private detectDrawtext(): Promise<boolean> {
    return this.drawtextSupport ??= (async () => {
      try {
        const result = await this.runner.run(this.ffmpegExecutable, ['-hide_banner', '-filters'],
          { timeoutMs: 30_000 });
        return /^\s*\S+\s+drawtext\s/m.test(result.stdout.toString('utf-8'));
      } catch {
        return false;
      }
    })();
  }

  private async detectFont(): Promise<string | null> {
    for (const candidate of FONT_CANDIDATES) {
      if (await access(candidate).then(() => true, () => false)) return candidate;
    }
    return null;
  }

  private ffmpegArgs(inputs: OwnedLocalVideo[], outputPath: string, width: number, height: number, audio: boolean,
    build: (EditBuild & { fontFile: string | null }) | null): string[] {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n'];
    for (const input of inputs) args.push('-i', input.absolutePath);
    const filters: string[] = [];
    const titleOffset = build?.plan.titleCardText ? 1 : 0;
    for (let index = 0; index < inputs.length; index++) {
      const clip = build ? build.clips[titleOffset + index]! : null;
      const trim = clip?.trimSeconds ?? null;
      const speed = clip?.speedFactor ?? 1;
      const trimVideo = trim === null ? '' : `trim=duration=${trim.toFixed(3)},`;
      const trimAudio = trim === null ? '' : `atrim=duration=${trim.toFixed(3)},`;
      const speedVideo = speed > 1 ? `setpts=PTS/${speed},` : '';
      const speedAudio = speed > 1 ? `atempo=${speed},` : '';
      filters.push(`[${index}:v:0]${trimVideo}${speedVideo}setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,`+
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p`+
        `${build ? ',settb=AVTB' : ''}[v${index}]`);
      if (audio) filters.push(`[${index}:a:0]${trimAudio}${speedAudio}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,`+
        `asetpts=PTS-STARTPTS[a${index}]`);
    }
    if (!build) {
      const inputsList = inputs.map((_, index) => audio ? `[v${index}][a${index}]` : `[v${index}]`).join('');
      filters.push(`${inputsList}concat=n=${inputs.length}:v=1:a=${audio ? 1 : 0}[vout]${audio ? '[aout]' : ''}`);
      args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
      if (audio) args.push('-map', '[aout]');
      args.push('-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn', '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
      if (audio) args.push('-c:a', 'aac');
      else args.push('-an');
      args.push('-movflags', '+faststart', '-f', 'mp4', outputPath);
      return args;
    }
    const edit = build.plan;
    let nextIndex = inputs.length;
    const videoLabels: string[] = [];
    const audioLabels: string[] = [];
    if (edit.titleCardText) {
      const videoIndex = nextIndex;
      args.push('-f', 'lavfi', '-t', String(TITLE_CARD_SECONDS), '-i',
        `color=c=${CARD_BACKGROUND}:s=${width}x${height}:r=30`);
      nextIndex += 1;
      let audioIndex: number | null = null;
      if (audio) {
        audioIndex = nextIndex;
        args.push('-f', 'lavfi', '-t', String(TITLE_CARD_SECONDS), '-i',
          'anullsrc=channel_layout=stereo:sample_rate=48000');
        nextIndex += 1;
      }
      filters.push(this.cardVideoFilter(videoIndex, 'vtitle', TITLE_CARD_SECONDS, build.fontFile, [
        { text: edit.titleCardText, fontSize: Math.max(28, Math.round(width / 12)), y: 'h*0.40' },
        ...(edit.titleCardSubtitle ? [{ text: edit.titleCardSubtitle,
          fontSize: Math.max(18, Math.round(width / 26)), y: `h*0.40+${Math.round(width / 6)}` }] : []),
      ]));
      if (audioIndex !== null) filters.push(`[${audioIndex}:a:0]aresample=48000,`+
        `aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[atitle]`);
      videoLabels.push('vtitle');
      if (audio) audioLabels.push('atitle');
    }
    for (let index = 0; index < inputs.length; index++) {
      videoLabels.push(`v${index}`);
      if (audio) audioLabels.push(`a${index}`);
    }
    if (edit.endCardText) {
      const videoIndex = nextIndex;
      args.push('-f', 'lavfi', '-t', String(END_CARD_SECONDS), '-i',
        `color=c=${CARD_BACKGROUND}:s=${width}x${height}:r=30`);
      nextIndex += 1;
      let audioIndex: number | null = null;
      if (audio) {
        audioIndex = nextIndex;
        args.push('-f', 'lavfi', '-t', String(END_CARD_SECONDS), '-i',
          'anullsrc=channel_layout=stereo:sample_rate=48000');
        nextIndex += 1;
      }
      filters.push(this.cardVideoFilter(videoIndex, 'vend', END_CARD_SECONDS, build.fontFile, [
        { text: edit.endCardText, fontSize: Math.max(20, Math.round(width / 24)), y: 'h*0.46' },
      ]));
      if (audioIndex !== null) filters.push(`[${audioIndex}:a:0]aresample=48000,`+
        `aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[aend]`);
      videoLabels.push('vend');
      if (audio) audioLabels.push('aend');
    }
    if (build.crossfade && videoLabels.length >= 2) {
      const fade = edit.transitionSeconds;
      let accumulated = 0;
      let previous = videoLabels[0]!;
      for (let index = 1; index < videoLabels.length; index++) {
        accumulated += build.clips[index - 1]!.seconds;
        const offset = Math.max(0, accumulated - index * fade);
        const label = index === videoLabels.length - 1 ? 'vout' : `xv${index}`;
        filters.push(`[${previous}][${videoLabels[index]!}]xfade=transition=fade:duration=${fade.toFixed(3)}:`+
          `offset=${offset.toFixed(3)}[${label}]`);
        previous = label;
      }
      if (audio && audioLabels.length >= 2) {
        let previousAudio = audioLabels[0]!;
        for (let index = 1; index < audioLabels.length; index++) {
          const label = index === audioLabels.length - 1 ? 'aout' : `xa${index}`;
          filters.push(`[${previousAudio}][${audioLabels[index]!}]acrossfade=d=${fade.toFixed(3)}[${label}]`);
          previousAudio = label;
        }
      }
    } else {
      const inputsList = audio
        ? videoLabels.map((label, index) => `[${label}][${audioLabels[index]}]`).join('')
        : videoLabels.map(label => `[${label}]`).join('');
      filters.push(`${inputsList}concat=n=${videoLabels.length}:v=1:a=${audio ? 1 : 0}[vout]`+
        `${audio ? '[aout]' : ''}`);
    }
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
    if (audio) args.push('-map', '[aout]');
    args.push('-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn', '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
    if (audio) args.push('-c:a', 'aac');
    else args.push('-an');
    args.push('-movflags', '+faststart', '-f', 'mp4', outputPath);
    return args;
  }

  private cardVideoFilter(inputIndex: number, label: string, seconds: number, fontFile: string | null,
    lines: ReadonlyArray<{ text: string; fontSize: number; y: string }>): string {
    const parts = [`[${inputIndex}:v:0]fps=30,setsar=1,format=yuv420p,settb=AVTB`];
    for (const line of lines) {
      if (!fontFile) break;
      parts.push(`drawtext=fontfile='${fontFile}':text='${line.text}':fontcolor=white:`+
        `fontsize=${line.fontSize}:x=(w-text_w)/2:y=${line.y}:shadowcolor=black@0.6:shadowx=2:shadowy=2`);
    }
    parts.push(`fade=t=in:st=0:d=${CARD_FADE_SECONDS}`);
    parts.push(`fade=t=out:st=${(seconds - CARD_FADE_SECONDS).toFixed(2)}:d=${CARD_FADE_SECONDS}`);
    return `${parts.join(',')}[${label}]`;
  }

  private parse(value: ComposeTimelineRequest): ParsedComposeRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['videoIds', 'title', 'edit'].includes(key)) || !Array.isArray(value.videoIds)) {
      throw new ProductionMediaError(400, 'TIMELINE_REQUEST_INVALID', '时间线合成请求格式无效。');
    }
    if (value.videoIds.length === 0) {
      throw new ProductionMediaError(409, 'LOCAL_VIDEO_REQUIRED', '没有已入库并通过校验的本地视频，不能合成或标记出片。');
    }
    if (value.videoIds.length > this.maxClips) {
      throw new ProductionMediaError(413, 'TIMELINE_CLIP_LIMIT', '镜头数量超过本地时间线限制。');
    }
    const title = value.title === undefined ? '' : cleanTitle(value.title);
    const edit = value.edit === undefined ? null : parseEdit(value.edit);
    let videoIds = value.videoIds.map(parseMediaId);
    if (edit) videoIds = videoIds.filter(id => !edit.directives.some(item => item.videoId === id && item.action === 'drop'));
    if (videoIds.length === 0) {
      throw new ProductionMediaError(422, 'TIMELINE_ALL_CLIPS_DROPPED', '按抽帧评估结果所有镜头都被剔除，无法成片。');
    }
    return { videoIds, title, edit };
  }

  private async validateSaved(value: TimelineManifest, id: string, digest: string,
    request: ParsedComposeRequest): Promise<TimelineManifest> {
    if (!value || value.schemaVersion !== TIMELINE_MANIFEST_SCHEMA_VERSION || value.id !== id
      || value.inputDigest !== digest || !Array.isArray(value.inputs) || !value.output
      || value.inputs.length !== request.videoIds.length || value.title !== request.title
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
      || new Date(value.createdAt).toISOString() !== value.createdAt
      || value.composition?.strategy !== (request.edit ? 'ffmpeg-auto-edit' : 'ffmpeg-concat-filter')) {
      throw new ProductionMediaError(409, 'TIMELINE_MANIFEST_INVALID', '已保存的时间线清单与本次输入不一致。');
    }
    if (request.edit) {
      const expectedEdit = this.planEdit(request.edit, []).plan;
      const savedEdit = value.composition.edit;
      if (!savedEdit || savedEdit.titleCardText !== expectedEdit.titleCardText
        || savedEdit.titleCardSubtitle !== expectedEdit.titleCardSubtitle
        || savedEdit.endCardText !== expectedEdit.endCardText
        || savedEdit.titleCardSeconds !== expectedEdit.titleCardSeconds
        || savedEdit.endCardSeconds !== expectedEdit.endCardSeconds) {
        throw new ProductionMediaError(409, 'TIMELINE_MANIFEST_INVALID', '已保存的自动剪辑方案与本次请求不一致。');
      }
    } else if (value.composition.edit !== undefined) {
      throw new ProductionMediaError(409, 'TIMELINE_MANIFEST_INVALID', '已保存的时间线清单与本次输入不一致。');
    }
    const inputs: OwnedLocalVideo[] = [];
    for (let index = 0; index < request.videoIds.length; index++) {
      const claimed = value.inputs[index];
      const expectedId = request.videoIds[index]!;
      if (!claimed || claimed.order !== index + 1 || claimed.mediaId !== expectedId) {
        throw new ProductionMediaError(409, 'TIMELINE_MANIFEST_INVALID', '时间线输入顺序与本次请求不一致。');
      }
      const actual = await this.store.getVideo(expectedId);
      if (claimed.sha256 !== actual.object.sha256 || claimed.durationSeconds !== actual.object.probe.durationSeconds
        || claimed.width !== actual.object.probe.width || claimed.height !== actual.object.probe.height
        || claimed.hasAudio !== actual.object.probe.hasAudio) {
        throw new ProductionMediaError(409, 'TIMELINE_MANIFEST_INVALID', '时间线清单引用的镜头与本地内容不一致。');
      }
      inputs.push(actual);
    }
    const withAudio = inputs.filter(input => input.object.probe.hasAudio).length;
    const width = even(inputs[0]!.object.probe.width);
    const height = even(inputs[0]!.object.probe.height);
    const expectedAudio = withAudio === inputs.length;
    const expectedDuration = request.edit
      ? this.planEdit(request.edit, inputs).expectedDurationSeconds
      : inputs.reduce((sum, input) => sum + input.object.probe.durationSeconds, 0);
    if ((withAudio !== 0 && !expectedAudio) || value.composition.videoCodec !== 'libx264'
      || value.composition.audioCodec !== (expectedAudio ? 'aac' : null)
      || value.composition.width !== width || value.composition.height !== height
      || value.composition.expectedDurationSeconds !== expectedDuration) {
      throw new ProductionMediaError(409, 'TIMELINE_MANIFEST_INVALID', '时间线合成参数与本地镜头不一致。');
    }
    const output = await this.store.getVideo(value.output.id);
    if (!sameLocalVideo(output.object, value.output)) {
      throw new ProductionMediaError(409, 'TIMELINE_MANIFEST_INVALID', '时间线清单引用的本地成片与实际内容不一致。');
    }
    const tolerance = Math.max(2, expectedDuration * 0.05);
    if (output.object.probe.width !== width || output.object.probe.height !== height
      || output.object.probe.hasAudio !== expectedAudio
      || Math.abs(output.object.probe.durationSeconds - expectedDuration) > tolerance) {
      throw new ProductionMediaError(409, 'TIMELINE_MANIFEST_INVALID', '时间线成片与已保存的合成参数不一致。');
    }
    return structuredClone(value);
  }

  private timestamp(): string {
    const date = this.now();
    if (!Number.isFinite(date.valueOf())) throw new ProductionMediaError(500, 'MEDIA_CLOCK_INVALID', '本地媒体时间源无效。');
    return date.toISOString();
  }
}

interface ParsedComposeRequest {
  videoIds: string[];
  title: string;
  edit: NormalizedEditRequest | null;
}

function even(value: number): number { return value % 2 === 0 ? value : value + 1; }

function parseEdit(value: TimelineEditRequest): NormalizedEditRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['titleCardText', 'titleCardSubtitle', 'endCardText',
      'transitionSeconds', 'targetSeconds', 'clipDirectives'].includes(key))) {
    throw new ProductionMediaError(400, 'TIMELINE_REQUEST_INVALID', '自动剪辑请求格式无效。');
  }
  const transitionSeconds = value.transitionSeconds === undefined ? 0.4 : value.transitionSeconds;
  if (typeof transitionSeconds !== 'number' || !Number.isFinite(transitionSeconds)
    || transitionSeconds < 0 || transitionSeconds > 1.5) {
    throw new ProductionMediaError(400, 'TIMELINE_REQUEST_INVALID', '叠化时长必须在 0 到 1.5 秒之间。');
  }
  const targetSeconds = value.targetSeconds === undefined ? null : value.targetSeconds;
  if (targetSeconds !== null && (typeof targetSeconds !== 'number' || !Number.isFinite(targetSeconds)
    || targetSeconds < 5 || targetSeconds > 900)) {
    throw new ProductionMediaError(400, 'TIMELINE_REQUEST_INVALID', '目标总时长必须在 5 到 900 秒之间。');
  }
  return {
    titleCardText: cleanCardText(value.titleCardText, 24),
    titleCardSubtitle: cleanCardText(value.titleCardSubtitle, 40),
    endCardText: cleanCardText(value.endCardText, 40),
    transitionSeconds,
    targetSeconds,
    directives: parseDirectives(value.clipDirectives),
  };
}

/** 逐镜头剪辑指令只接受白名单字段，防止任意 ffmpeg 参数注入。 */
function parseDirectives(value: unknown): TimelineClipDirective[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) {
    throw new ProductionMediaError(400, 'TIMELINE_REQUEST_INVALID', '镜头剪辑指令格式无效。');
  }
  return value.map(item => {
    const source = typeof item === 'object' && item !== null && !Array.isArray(item) ? item as Record<string, unknown> : {};
    if (Object.keys(source).some(key => !['videoId', 'action', 'trimSeconds', 'speedFactor'].includes(key)) ||
      typeof source.videoId !== 'string' || !/^media_[0-9a-f]{64}$/.test(source.videoId) ||
      !['keep', 'trim', 'speedup', 'drop'].includes(source.action as string)) {
      throw new ProductionMediaError(400, 'TIMELINE_REQUEST_INVALID', '镜头剪辑指令格式无效。');
    }
    const action = source.action as TimelineClipDirective['action'];
    let trimSeconds: number | undefined;
    let speedFactor: number | undefined;
    if (action === 'trim') {
      if (typeof source.trimSeconds !== 'number' || !Number.isFinite(source.trimSeconds)
        || source.trimSeconds < 0.5 || source.trimSeconds > 900) {
        throw new ProductionMediaError(400, 'TIMELINE_REQUEST_INVALID', '裁短时长必须在 0.5 到 900 秒之间。');
      }
      trimSeconds = source.trimSeconds;
    }
    if (action === 'speedup') {
      if (typeof source.speedFactor !== 'number' || !Number.isFinite(source.speedFactor)
        || source.speedFactor < 1.1 || source.speedFactor > 2) {
        throw new ProductionMediaError(400, 'TIMELINE_REQUEST_INVALID', '加速倍速必须在 1.1 到 2 之间。');
      }
      speedFactor = source.speedFactor;
    }
    return { videoId: source.videoId, action, trimSeconds, speedFactor };
  });
}

/** 卡片文字只保留安全字符，避免进入 ffmpeg 滤镜转义歧义；过短文本视为无卡。 */
function cleanCardText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ProductionMediaError(400, 'TIMELINE_REQUEST_INVALID', '卡片文字无效。');
  const cleaned = value.replace(/[\u0000-\u001f'":;,()%[\]\\]/gu, '').replace(/\s+/gu, ' ').trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, maxLength).join('');
}
function sameLocalVideo(left: TimelineManifest['output'], right: TimelineManifest['output']): boolean {
  return left.schemaVersion === right.schemaVersion && left.id === right.id && left.sha256 === right.sha256
    && left.bytes === right.bytes && left.mimeType === right.mimeType && left.relativePath === right.relativePath
    && left.sourceKind === right.sourceKind && left.createdAt === right.createdAt
    && left.probe.container === right.probe.container && left.probe.durationSeconds === right.probe.durationSeconds
    && left.probe.width === right.probe.width && left.probe.height === right.probe.height
    && left.probe.videoCodec === right.probe.videoCodec && left.probe.hasAudio === right.probe.hasAudio
    && left.probe.audioCodec === right.probe.audioCodec;
}
function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') throw new ProductionMediaError(400, 'TIMELINE_REQUEST_INVALID', '时间线标题无效。');
  const title = value.trim();
  if (Array.from(title).length > 160 || title.includes('\0') || /[\uD800-\uDFFF]/u.test(title)) {
    throw new ProductionMediaError(400, 'TIMELINE_REQUEST_INVALID', '时间线标题无效。');
  }
  return title;
}
