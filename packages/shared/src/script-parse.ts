/**
 * AI 整段剧本解析的稳定契约。
 *
 * 模型只产出语义内容；服务端负责分配稳定 ID、场次编号并校验
 * `ScriptStructure`。人物、地点和道具在这里只是候选项，确认保存后才进入事实链。
 * v2 新增地点与道具数组；旧客户端可继续只读取 structure/characters。
 */
import type { ScriptEntityKind, ScriptEntityRole, ScriptStructure } from './script-structure';

export const SCRIPT_PARSE_PROMPT_VERSION = 'script-parse/2' as const;
export const SCRIPT_DIALOGUE_REPAIR_PROMPT_VERSION = 'script-dialogue-repair/1' as const;

export interface ScriptDialogueSourceRef {
  scriptVersionId: string;
  start: number;
  end: number;
  quote: string;
}

export interface ScriptDialogueExclusion {
  sourceRef: ScriptDialogueSourceRef;
  reason: string;
}

export interface ScriptDialogueRepairPreview {
  issueId: string;
  kind: 'append' | 'exclude';
  reason: string;
  addedDialogues: Array<{
    sceneId: string;
    sceneNumber: string;
    characterName: string;
    parenthetical: string;
    content: string;
    sourceRef: ScriptDialogueSourceRef;
  }>;
  exclusions: ScriptDialogueExclusion[];
}

export interface ScriptParseEntity {
  name: string;
  aliases: string[];
  description: string | null;
  /** 模型给出的实体档位；缺省时按路人处理，不影响旧客户端读取。 */
  role?: ScriptEntityRole;
  confidence?: number | null;
}

export type ScriptParseCharacter = ScriptParseEntity;

export interface ScriptParseResult {
  structure: import('./script-structure').ScriptStructure;
  characters: ScriptParseCharacter[];
  locations: ScriptParseEntity[];
  props: ScriptParseEntity[];
  repair?: ScriptDialogueRepairPreview;
}

export interface ScriptParseAttempt {
  id: string;
  scriptVersionId: string;
  scriptVersion: number;
  model: string;
  promptVersion: string;
  status: 'running' | 'succeeded' | 'failed';
  errorCode: string | null;
  providerRequestId: string | null;
  usage: Record<string, unknown> | null;
  output: ScriptParseResult | null;
  createdAt: string;
  endedAt: string | null;
}

/* -------------------------------------------------------------------------
 * 阶段一：单集增量解析契约。
 *
 * 整剧解析契约（ScriptParseResult / ScriptParseAttempt）保持不变；以下类型
 * 只描述“按集解析”的请求与响应。模型产出的人物/地点/道具在确认保存前
 * 只是候选，不会直接写入正式资产链。
 * ---------------------------------------------------------------------- */

/** 模型识别出的实体输入（角色 / 场景 / 道具），档位与置信度可缺省。 */
export interface ParsedEntityInput {
  kind: ScriptEntityKind;
  name: string;
  aliases?: string[];
  description?: string | null;
  role?: ScriptEntityRole;
  confidence?: number | null;
}

/** 资产库中已有实体的匹配引用，用于同名/别名复用既有 ID。 */
export interface ExistingEntityMatch {
  id: string;
  kind: ScriptEntityKind;
  name: string;
  aliases?: string[];
}

/**
 * 解析输出中的实体候选：只有被用户勾选确认后才进入正式库。
 * background（路人）默认不勾选；existing 命中既有资产时复用既有 ID，
 * 不覆盖名称、定妆照、设定或其他资产字段。
 */
export interface ParsedEntityCandidate {
  candidateId: string;
  kind: ScriptEntityKind;
  name: string;
  aliases: string[];
  description: string | null;
  existing: boolean;
  existingAssetId: string | null;
  role: ScriptEntityRole;
  confidence: number | null;
  /** 默认勾选建议；路人为 false，已有资产或草稿中实际出现的核心角色/场景/道具为 true。 */
  suggested: boolean;
}

/** 单集增量解析请求；rawText 为弹窗粘贴的该集新原文，allowPaid 必须显式为 true。 */
export interface EpisodeParseRequest {
  episodeNumber: number;
  rawText: string;
  commandId: string;
  overwriteConfirmed: boolean;
  allowPaid: boolean;
  expectedModelConnectionRevision?: string;
  scriptVersionId?: string;
}

/** 单集解析响应；structure 只包含目标集草稿，其余集不受影响。 */
export interface EpisodeParseResponse {
  episodeNumber: number;
  commandId: string;
  attemptId: string;
  model: string;
  promptVersion: string;
  usage: Record<string, unknown> | null;
  structure: ScriptStructure;
  characters: ParsedEntityCandidate[];
  locations: ParsedEntityCandidate[];
  props: ParsedEntityCandidate[];
  /** 命中同一 commandId 的历史成功记录时为 true，本次未再次调用模型。 */
  reused: boolean;
}

function normalizeEntityName(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

/** “旁白”是叙事元素标签，不是需要人物资产的出场角色。 */
export function isNarrationCharacterName(name: string): boolean {
  return normalizeEntityName(name) === '旁白';
}

function namesOf(name: string, aliases: readonly string[] | undefined): Set<string> {
  return new Set([name, ...(aliases ?? [])].map(normalizeEntityName).filter(Boolean));
}

function entityPresentInDraft(draft: ScriptStructure | null | undefined, kind: ScriptEntityKind,
  names: Set<string>): boolean {
  if (!draft) return false;
  for (const episode of draft.episodes) {
    for (const scene of episode.scenes) {
      if (kind === 'location') {
        if (names.has(normalizeEntityName(scene.location))) return true;
        continue;
      }
      for (const element of scene.dialogues) {
        if (kind === 'character') {
          if (element.type === 1
            && names.has(normalizeEntityName(element.characterName ?? ''))) return true;
        } else if (Array.from(element.content).some(part => names.has(normalizeEntityName(part)))) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * 把模型实体输入规划为候选清单：匹配既有资产、计算草稿出场与默认勾选建议。
 * 纯函数，不修改入参；路人（background）即使出场也不默认勾选。
 */
export function planEpisodeEntityCandidates(draft: ScriptStructure | null | undefined,
  entities: readonly ParsedEntityInput[], existing: readonly ExistingEntityMatch[]): ParsedEntityCandidate[] {
  const indexed = new Map<ScriptEntityKind, Map<string, ExistingEntityMatch>>();
  for (const match of existing) {
    const byKind = indexed.get(match.kind) ?? new Map<string, ExistingEntityMatch>();
    for (const key of namesOf(match.name, match.aliases)) byKind.set(key, match);
    indexed.set(match.kind, byKind);
  }
  return entities
    .filter(entity => entity.kind !== 'character' || !isNarrationCharacterName(entity.name))
    .map((entity, index) => {
    const names = namesOf(entity.name, entity.aliases);
    const byKind = indexed.get(entity.kind);
    const matched = [...names].map(key => byKind?.get(key)).find(Boolean) ?? null;
    // 模型未给档位时按出场启发式兜底：草稿中出现的归为配角，未出现的归为路人，
    // 避免主角被默认路人化而不勾选。
    const present = entityPresentInDraft(draft, entity.kind, names);
    const role: ScriptEntityRole = entity.role === 'protagonist' || entity.role === 'supporting'
      || entity.role === 'background' ? entity.role : (present ? 'supporting' : 'background');
    const existingMatch = matched !== null;
    // 主角/配角默认建议勾选，路人默认不勾选；是否出场只影响候选展示，不关闭建议。
    const suggested = existingMatch || role !== 'background';
    return {
      candidateId: `candidate_${index + 1}`,
      kind: entity.kind,
      name: entity.name.trim(),
      aliases: (entity.aliases ?? []).map(alias => alias.trim()).filter(Boolean),
      description: entity.description?.trim() || null,
      existing: existingMatch,
      existingAssetId: matched?.id ?? null,
      role,
      confidence: typeof entity.confidence === 'number' && Number.isFinite(entity.confidence)
        ? Math.min(1, Math.max(0, entity.confidence)) : null,
      suggested,
    };
  });
}

/* -------------------------------------------------------------------------
 * 模型 JSON 尾部截断的有界、保守修复。
 *
 * 只做两类安全动作：去掉未闭合字符串的残缺尾部、补齐缺失的容器闭合符；
 * 不猜测残缺值、不补引号外的内容。修复后仍无法解析时明确报错，不吞错误。
 * ---------------------------------------------------------------------- */

export interface RepairedJsonOutput {
  ok: boolean;
  repaired: boolean;
  value?: unknown;
  reason?: 'EMPTY_JSON' | 'NOT_JSON_CONTAINER' | 'MISMATCHED_BRACKET' | 'UNREPAIRABLE_JSON';
}

function tryParseJson(text: string): { ok: boolean; value?: unknown } {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

export function repairModelJsonPayload(input: string): RepairedJsonOutput {
  const text = (input ?? '').trim();
  if (!text) return { ok: false, repaired: false, reason: 'EMPTY_JSON' };
  const direct = tryParseJson(text);
  if (direct.ok) return { ok: true, repaired: false, value: direct.value };
  if (text[0] !== '{' && text[0] !== '[') return { ok: false, repaired: false, reason: 'NOT_JSON_CONTAINER' };

  const out: string[] = [];
  const stack: Array<'{' | '['> = [];
  let inString = false;
  let escape = false;
  let repaired = false;

  for (const ch of text) {
    if (inString) {
      out.push(ch);
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = false; continue; }
      continue;
    }
    if (ch === '"') { inString = true; out.push(ch); continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); out.push(ch); continue; }
    if (ch === '}' || ch === ']') {
      const open = stack.pop();
      const expected: '}' | ']' = open === '{' ? '}' : ']';
      if (ch !== expected) return { ok: false, repaired: false, reason: 'MISMATCHED_BRACKET' };
      out.push(ch);
      continue;
    }
    out.push(ch);
  }

  // 结尾仍是未闭合字符串：丢弃残缺的字符串片段。
  if (inString) {
    repaired = true;
    while (out.length && out[out.length - 1] !== '"') out.pop();
    out.pop();
  }
  // 去掉残缺的尾部逗号或空白。
  while (out.length) {
    const last = out[out.length - 1]!.trim();
    if (last === '' || last === ',') { out.pop(); repaired = true; } else break;
  }
  // 字符串值被丢弃后，尾部可能残留一个不完整的 "key": 成员，一并移除。
  let pending = out.join('');
  const incompleteMember = /(?:,\s*)?"[^"\\]*(?:\\.[^"\\]*)*"\s*:\s*,?\s*$/;
  if (incompleteMember.test(pending)) {
    repaired = true;
    pending = pending.replace(incompleteMember, '');
    out.length = 0;
    out.push(...pending);
  }
  // 按栈补齐缺失的容器闭合符。
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    out.push(stack[index] === '{' ? '}' : ']');
    repaired = true;
  }

  const candidate = out.join('');
  const again = tryParseJson(candidate);
  if (!again.ok) return { ok: false, repaired: true, reason: 'UNREPAIRABLE_JSON' };
  if (typeof again.value !== 'object' || again.value === null) {
    return { ok: false, repaired: true, reason: 'NOT_JSON_CONTAINER' };
  }
  return { ok: true, repaired: true, value: again.value };
}
