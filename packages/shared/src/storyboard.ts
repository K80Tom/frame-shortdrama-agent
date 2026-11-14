import type { AssetKind } from './assets';
import type { StoryboardVoiceBinding } from './voice-references';
import type { ShotSourceRef } from './shot-spec';

/** 分镜候选的公共读取/编辑契约；镜头只引用已登记资产 ID，不包含临时媒体 URL。 */
export interface StoryboardAssetRef { entityId: string; assetId: string; kind: AssetKind }
export interface StoryboardNarrativeBeat {
  id: string;
  sceneId: string;
  kind: 'narration' | 'action';
  text: string;
  sourceRef: ShotSourceRef;
}

/** Extract evidence-backed narrative beats without changing the adopted fact plan. */
export function storyboardNarrativeBeats(scenes: ReadonlyArray<{ id: string; sourceRefs: ShotSourceRef[] }>): StoryboardNarrativeBeat[] {
  const beats = new Map<string, StoryboardNarrativeBeat>();
  for (const scene of scenes) {
    for (const ref of scene.sourceRefs) {
      let offset = 0;
      for (const line of ref.quote.split('\n')) {
        const match = /^【(旁白|动作)】/u.exec(line);
        if (match) {
          const sourceRef = { ...ref, start: ref.start + offset, end: ref.start + offset + line.length, quote: line };
          const id = `beat_${scene.id}_${sourceRef.start}_${sourceRef.end}`;
          beats.set(id, { id, sceneId: scene.id, kind: match[1] === '旁白' ? 'narration' : 'action',
            text: line.slice(match[0].length).trim().replace(/^旁白\s*[:：]\s*/u, ''), sourceRef });
        }
        offset += line.length + 1;
      }
    }
  }
  return [...beats.values()].sort((left, right) => left.sourceRef.start - right.sourceRef.start || left.id.localeCompare(right.id));
}

export interface StoryboardVideoReference {
  assetId: string;
  /** One image may represent several confirmed entities. */
  names: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const SPOKEN_TOKEN = /[A-Za-z]+(?:['’-][A-Za-z]+)*|[^\s\p{P}\p{S}]/gu;
const SPOKEN_UNITS_PER_SECOND = 4;

function spokenTokens(value: string) {
  return [...value.matchAll(SPOKEN_TOKEN)];
}

function spokenUnitCount(value: string): number {
  return spokenTokens(value).length;
}

function secondsLabel(durationMs: number): string {
  return String(Math.round(durationMs / 100) / 10);
}

/** 轻量语速校验只用于提示和付费前阻断，不改写已采用的对白或分镜时长。 */
export function storyboardDialogueTimingIssue(durationMs: number,
  dialogues: ReadonlyArray<{ quote: string }>): string | null {
  const units = dialogues.reduce((total, line) => total + spokenUnitCount(line.quote), 0);
  const requiredMs = units * (1000 / SPOKEN_UNITS_PER_SECOND);
  if (!units || durationMs >= requiredMs) return null;
  return `当前镜头 ${secondsLabel(durationMs)} 秒，按每秒约 ${SPOKEN_UNITS_PER_SECOND} 个口语字估算，对白至少需要 ${secondsLabel(requiredMs)} 秒。请增加镜头时长或拆分到其他镜头，避免对白被截断。`;
}

function takeSpokenPrefix(value: string, maxUnits: number): string {
  const tokens = spokenTokens(value);
  if (tokens.length <= maxUnits) return value;
  const token = tokens[Math.max(0, maxUnits - 1)]!;
  let cut = (token.index ?? 0) + token[0].length;
  const prefix = value.slice(0, cut);
  const punctuation = [...prefix.matchAll(/[，。！？；,.!?;]/gu)].at(-1);
  if (punctuation?.index !== undefined && punctuation.index >= Math.floor(cut / 2)) cut = punctuation.index + 1;
  const trailing = /^[\s，。！？；：,.!?;:]+/u.exec(value.slice(cut));
  if (trailing) cut += trailing[0].length;
  return value.slice(0, cut);
}

const CAMERA_MOVEMENTS: Record<string, string> = {
  推: '镜头推近', 缓推: '镜头缓慢推近', 拉: '镜头拉远', 摇: '水平摇移', 移: '平移跟随',
  跟: '跟随主体', 跟拍: '跟随主体', 升: '镜头升起', 降: '镜头降落', 环绕: '环绕旋转',
  甩: '快速甩动', 固定: '固定镜头', 固定镜头: '固定镜头', 不动: '固定镜头',
};

function sentence(value: string): string {
  const text = value.trim().replace(/[，；、\s]+$/u, '');
  return /[。！？!?]$/u.test(text) ? text : `${text}。`;
}

function visualKey(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
}

function uniqueVisualParts(parts: string[]): string[] {
  const result: string[] = [];
  for (const part of parts.map(value => value.trim()).filter(Boolean)) {
    const key = visualKey(part);
    if (!key) continue;
    const duplicate = result.findIndex(existing => {
      const current = visualKey(existing);
      return current === key || Math.min(current.length, key.length) >= 6
        && (current.includes(key) || key.includes(current));
    });
    if (duplicate >= 0) {
      if (key.length > visualKey(result[duplicate]!).length) result[duplicate] = part;
    } else result.push(part);
  }
  return result;
}

function splitVisualDescription(value: string, narrativeExclusions: string[] = []): string[] {
  const excluded = narrativeExclusions.map(visualKey).filter(Boolean);
  return (value.match(/[^，。！？!?]+[，。！？!?]?/gu)?.map(part => part.trim()).filter(Boolean) ?? [])
    .filter(part => {
      const key = visualKey(part);
      return key.length < 6 || !excluded.some(narrative => narrative.includes(key));
    });
}

function visibleActionText(value: string): string {
  const visible = value.trim().replace(/^每当[^。！？]*?时[，,]/u, '').replace(/不知怎的|不知怎么回事/gu, '');
  return splitVisualDescription(visible)
    .filter(part => !/忽然意识到|意识到|心想|想起|觉得|明白|内心|心中/u.test(part)).join('');
}

function hasVisualOverlap(action: string, evidence: string): boolean {
  const actionKey = visualKey(action); const evidenceKey = visualKey(evidence);
  for (let index = 0; index + 4 <= actionKey.length; index++) {
    if (evidenceKey.includes(actionKey.slice(index, index + 4))) return true;
  }
  return false;
}

/** 旧候选没有独立氛围字段时，只从已采用场次的时段补充可见光线，不虚构新的剧情事实。 */
export function storyboardSceneAtmosphere(scene?: { timeOfDay?: { value: string } | null } | null): string | undefined {
  const time = scene?.timeOfDay?.value.trim();
  if (!time) return undefined;
  if (/黄昏|傍晚/u.test(time)) return '黄昏暖色自然光笼罩场景，人物与关键道具保持连续的光影方向';
  if (/清晨|早晨|黎明/u.test(time)) return '清晨柔和自然光照亮人物与关键道具，保留清新的空气感';
  if (/夜|深夜/u.test(time)) return '夜晚低照度环境光下，人物面部与关键道具细节仍清晰可辨';
  if (/阴|雾霾/u.test(time)) return '阴天柔和散射光覆盖场景，保留低饱和色调与真实质感';
  if (/日|白天|正午/u.test(time)) return '日间自然光照亮人物与关键道具，保持真实光影和场景质感';
  return `${time}的环境光保持连续，人物与关键道具细节清晰可辨`;
}

/**
 * 融光式连续自然语言为主体；参考资产、音色和时间轴都来自同一份最终有序绑定。
 * narrativeBeatIds 继续承担全场叙事覆盖，但整场旁白/动作原文不直接复制到单镜视频正文。
 * candidateDirection 仅为旧调用保留兼容，不再把候选制作说明发送给视频模型。
 */
export function buildStoryboardVideoBasePrompt(input: {
  visualStyle?: string;
  shot: Pick<StoryboardShot, 'design' | 'firstFrameAssetId' | 'lastFrameAssetId'>;
  /** 只允许传当前镜绑定的节拍；动作转译为画面，未选中的整场叙事不得传入。 */
  narrativeBeats?: Array<Pick<StoryboardNarrativeBeat, 'kind' | 'text'>>;
  /** 当前场次旁白原文，用于清除旧候选画面字段中整段复制的文学叙述。 */
  narrativeExclusions?: string[];
  /** 已采用场次的时段氛围回退；镜头自身 atmosphere 优先。 */
  atmosphere?: string;
  dialogues?: Array<{ speaker?: string | null; quote: string }>;
  references: StoryboardVideoReference[];
  voiceBindings?: Array<{ speakerName: string; profileId: string }>;
  candidateDirection?: string;
  directorPromptLines?: string[];
  repairPromptLines?: string[];
}): string {
  const references = input.references.map((reference, index) => ({ ...reference,
    token: `@图片${index + 1}` }));
  const assetTokens = new Map<string, string>();
  for (const reference of references) for (const name of reference.names) {
    if (name.trim() && !assetTokens.has(name.trim())) assetTokens.set(name.trim(), reference.token);
  }
  const assetPattern = [...assetTokens.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  const assetMatcher = assetPattern ? new RegExp(assetPattern, 'gu') : null;
  const bindAssets = (value: string) => assetMatcher
    ? value.replace(assetMatcher, name => `${assetTokens.get(name)}${name}`) : value;
  const voices = new Map((input.voiceBindings ?? []).map((voice, index) => [voice.speakerName,
    `#${voice.speakerName}（音色参考音频${index + 1}）`]));
  const dialogueEntries = (input.dialogues ?? []).map(line => ({
    prefix: line.speaker ? `${voices.get(line.speaker) ?? line.speaker}：` : '',
    quote: bindAssets(line.quote),
  }));
  const dialogueLines = dialogueEntries.map(line => `${line.prefix}${line.quote}`);
  const authoredBeats = input.shot.design.visualBeats ?? [];
  const visualEvidence = splitVisualDescription(input.shot.design.visualDescription, input.narrativeExclusions);
  const actionCandidates = (input.narrativeBeats ?? []).filter(beat => beat.kind === 'action')
    .map(beat => visibleActionText(beat.text)).filter(Boolean);
  const overlappingActions = actionCandidates.filter(action =>
    hasVisualOverlap(action, [...visualEvidence, ...authoredBeats].join(' ')));
  const redundantVisualActions = visualEvidence.join('').length >= 6 && overlappingActions.length > 0;
  const currentActions = redundantVisualActions ? [] : actionCandidates.length === 1 ? actionCandidates
    : overlappingActions.length || visualEvidence.join('').length >= 6 ? overlappingActions : actionCandidates;
  const visualParts = uniqueVisualParts([
    ...(authoredBeats.length ? [visualEvidence.join('')] : visualEvidence),
    ...authoredBeats,
    ...currentActions,
  ]).map(bindAssets);
  const atmosphere = bindAssets(input.shot.design.atmosphere?.trim() || input.atmosphere?.trim() || '');
  const atmosphereSentence = atmosphere ? sentence(atmosphere) : '';
  const movement = input.shot.design.cameraMovement.trim();
  const camera = [input.shot.design.shotSize.trim(), input.shot.design.cameraAngle?.trim(),
    CAMERA_MOVEMENTS[movement] ?? movement].filter(Boolean).join('，');
  const assetSentence = references.length
    ? `参考 ${references.map(reference => `${reference.token}${reference.names.join('、')}`).join('，')}，严格保持对应人物、场景、服装与道具一致。`
    : '';
  const frameSentence = input.shot.firstFrameAssetId
    ? `以首帧为画面起点${input.shot.lastFrameAssetId ? '，结尾自然过渡到尾帧构图' : ''}。` : '';
  const sound = input.shot.design.sound?.trim();
  const common = [input.visualStyle?.trim(), assetSentence, frameSentence,
    sound ? `环境音与音效：${sound}。` : ''].filter(Boolean);
  let body: string[];
  if (input.shot.design.timeline !== false) {
    const segments = Math.max(1, Math.ceil(input.shot.design.durationMs / 3000));
    const lastSecond = input.shot.design.durationMs / 1000;
    const dialogueBySegment: string[][] = Array.from({ length: segments }, () => []);
    const dialogueSegments = Array.from({ length: segments }, (_, index) => index).slice(segments > 1 ? 1 : 0);
    const lastDialogueSegment = dialogueSegments.at(-1)!;
    const totalUnits = dialogueEntries.reduce((total, line) => total + spokenUnitCount(line.quote), 0);
    const availableSeconds = dialogueSegments.reduce((total, index) => total +
      (Math.min((index + 1) * 3, lastSecond) - index * 3), 0);
    const compression = Math.max(1, totalUnits / Math.max(0.001, availableSeconds * SPOKEN_UNITS_PER_SECOND));
    let dialogueIndex = 0;
    let remaining = dialogueEntries[0]?.quote ?? '';
    for (const segmentIndex of dialogueSegments) {
      const segmentSeconds = Math.min((segmentIndex + 1) * 3, lastSecond) - segmentIndex * 3;
      const capacity = segmentIndex === lastDialogueSegment ? Number.POSITIVE_INFINITY
        : Math.max(1, Math.floor(segmentSeconds * SPOKEN_UNITS_PER_SECOND * compression));
      let used = 0;
      while (dialogueIndex < dialogueEntries.length && used < capacity) {
        const entry = dialogueEntries[dialogueIndex]!;
        const chunk = takeSpokenPrefix(remaining, capacity - used);
        if (!chunk) break;
        dialogueBySegment[segmentIndex]!.push(`${entry.prefix}${chunk}`);
        remaining = remaining.slice(chunk.length);
        used += spokenUnitCount(chunk);
        if (!remaining) {
          dialogueIndex++;
          remaining = dialogueEntries[dialogueIndex]?.quote ?? '';
        }
      }
    }
    const visualsBySegment: string[][] = Array.from({ length: segments }, () => []);
    for (const index of Array.from({ length: segments }, (_, segment) => segment)) {
      if (visualParts.length >= segments) {
        const start = Math.floor(index * visualParts.length / segments);
        const end = Math.max(start + 1, Math.floor((index + 1) * visualParts.length / segments));
        visualsBySegment[index] = visualParts.slice(start, end);
      } else if (visualParts[index]) visualsBySegment[index] = [visualParts[index]!];
    }
    body = Array.from({ length: segments }, (_, index) => {
      const dialogue = dialogueBySegment[index]!.join(' ');
      const parts = visualsBySegment[index]!;
      const visualAction = parts.length ? parts.map(sentence).join(' ')
        : index === segments - 1 ? '当前动作完成后，人物姿态与关键道具停留在画面中，构图自然收束。'
          : '镜头保持当前机位，人物位置、动作与视线连续推进。';
      return `【${index * 3}–${Math.min((index + 1) * 3, lastSecond)}秒】${index === 0 ? `${camera}。` : ''}${visualAction}${dialogue ? ` ${dialogue}` : ''}${atmosphereSentence ? ` ${atmosphereSentence}` : ''}`;
    });
  } else {
    body = [`${camera}。${visualParts.map(sentence).join(' ')}`, ...dialogueLines, atmosphereSentence];
  }
  return [...common, ...body, ...(input.directorPromptLines ?? []), ...(input.repairPromptLines ?? [])]
    .filter((line): line is string => Boolean(line?.trim())).join('\n');
}

export interface StoryboardShot {
  id: string;
  sceneId: string;
  order: number;
  design: {
    origin: 'designSuggestion';
    visualDescription: string;
    shotSize: string;
    cameraMovement: string;
    durationMs: number;
    /** 可选拍摄建议；旧分镜没有这些字段时保持原提示词。 */
    cameraAngle?: string;
    /** 环境音、音效等文字方向，不代表已经生成正式音轨。 */
    sound?: string;
    /** 当前镜按时间推进的可见动作、表情和结果；每段一个主动作。 */
    visualBeats?: string[];
    /** 当前镜具体光线、色调与氛围；旧候选可由场次时段回退。 */
    atmosphere?: string;
    /** 3 秒时间轴默认启用；仅旧数据显式设为 false 时保留连续自然语言格式。 */
    timeline?: boolean;
  };
  sourceRefs: ShotSourceRef[];
  dialogueIds: string[];
  /** 旧候选可能没有该字段；绑定后正式采用必须覆盖全部旁白和动作节拍。 */
  narrativeBeatIds?: string[];
  /** 可选首尾帧图片资产；旧候选没有该字段时保持原视频行为。 */
  firstFrameAssetId?: string;
  lastFrameAssetId?: string;
  /** 旧候选可能没有该字段；读取时保持旧版本形状。 */
  assetRefs?: StoryboardAssetRef[];
  /** 角色到已授权音色样本的不可变绑定。 */
  voiceBindings?: StoryboardVoiceBinding[];
}
export interface StoryboardScope {
  kind: 'project' | 'episode';
  episodeNumber: number | null;
  baseRevisionId: string | null;
}
export interface StoryboardRevision {
  id: string;
  projectId: string;
  scriptVersionId: string;
  sourcePlanRevisionId: string;
  attemptId: string;
  shots: StoryboardShot[];
  inputDigest: string;
  scope: StoryboardScope;
  promptVersion: string;
  model: string;
  providerRequestId: string | null;
  usage: unknown;
  createdAt: string;
}
export interface StoryboardGenerationRequest {
  allowPaid: true;
  expectedModelConnectionRevision?: string;
  episodeNumber?: number;
  baseRevisionId?: string;
}
export interface StoryboardShotInput {
  id?: string;
  sceneId: string;
  order: number;
  visualDescription: string;
  shotSize: string;
  cameraMovement: string;
  durationMs: number;
  visualBeats?: string[];
  atmosphere?: string;
  sourceRefs: ShotSourceRef[];
  dialogueIds: string[];
  narrativeBeatIds?: string[];
  firstFrameAssetId?: string;
  lastFrameAssetId?: string;
  assetRefs?: StoryboardAssetRef[];
  voiceBindings?: StoryboardVoiceBinding[];
  timeline?: boolean;
}
export interface StoryboardEditRequest { shots: StoryboardShotInput[] }
