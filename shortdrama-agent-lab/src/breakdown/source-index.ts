import { createHash } from "node:crypto";

/**
 * P0.1 原文索引与任务分块。
 *
 * 这一层只做无损定位、保守结构标注和确定性 Prompt 分块；它不判断剧情事实，
 * 不调用模型，也不创建正式 PlanRevision。模型以后只能引用当前任务提供的局部
 * Evidence Alias，程序再把它还原为这里的 canonical SourceRef。
 */

export const SOURCE_INDEX_SCHEMA_VERSION = "script-source-index/1";

export type SourceSpanKind =
  | "titleCandidate"
  | "headingCandidate"
  | "dialogueTurnCandidate"
  | "actionBlockCandidate";

export type SourceConfidence = "explicit" | "heuristic" | "unknown";

export interface ScriptVersion {
  id: string;
  projectId: string;
  version: number;
  rawText: string;
  contentSha256: string;
  createdAt: string;
}

export interface CreateScriptVersionInput {
  id: string;
  projectId: string;
  version: number;
  rawText: string;
  createdAt: string;
}

/** A physical line owns every code point, including a trailing line ending. */
export interface SourceUnit {
  id: string;
  lineNumber: number;
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
  raw: string;
  content: string;
  isBlank: boolean;
}

/** A nonblank semantic candidate. It is deliberately not a final story fact. */
export interface SourceSpan {
  id: string;
  kind: SourceSpanKind;
  confidence: SourceConfidence;
  start: number;
  end: number;
  quote: string;
  lineStart: number;
  lineEnd: number;
  unitIds: string[];
  speakerCandidate: string | null;
}

export type SourceBlockBoundary = "start" | "heading" | "blank";

/** A logical block is a packing preference, not a confirmed scene. */
export interface SourceBlock {
  id: string;
  spanIds: string[];
  start: number;
  end: number;
  quote: string;
  boundaryBefore: SourceBlockBoundary;
  sectionHeadingSpanId: string | null;
}

export interface ScriptSourceIndex {
  schemaVersion: typeof SOURCE_INDEX_SCHEMA_VERSION;
  scriptVersion: ScriptVersion;
  units: SourceUnit[];
  spans: SourceSpan[];
  blocks: SourceBlock[];
}

export interface SourceRef {
  scriptVersionId: string;
  start: number;
  end: number;
  quote: string;
}

export type PromptChunkBoundary = "start" | "heading" | "blank" | "budget";

export interface PromptChunk {
  id: string;
  primarySpanIds: string[];
  contextSpanIds: string[];
  sectionHeadingSpanId: string | null;
  boundaryBefore: PromptChunkBoundary;
  estimatedPrimaryTokens: number;
  estimatedContextTokens: number;
  oversizedPrimarySpanIds: string[];
}

export interface PromptChunkOptions {
  /** A conservative code-point proxy, not a provider-specific tokenizer count. */
  targetEstimatedTokens: number;
}

export interface EvidenceAlias {
  alias: string;
  role: "primary" | "context";
  spanId: string;
  kind: SourceSpanKind;
  sourceRef: SourceRef;
  speakerCandidate: string | null;
}

export class SourceIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceIndexError";
  }
}

export function createScriptVersion(input: CreateScriptVersionInput): ScriptVersion {
  assertNonempty(input.id, "script version id");
  assertNonempty(input.projectId, "project id");
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new SourceIndexError("script version must be a positive integer");
  }
  if (!input.rawText.trim()) throw new SourceIndexError("script text must not be empty");
  assertNonempty(input.createdAt, "createdAt");
  return Object.freeze({
    id: input.id,
    projectId: input.projectId,
    version: input.version,
    rawText: input.rawText,
    contentSha256: sha256Utf8(input.rawText),
    createdAt: input.createdAt,
  });
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Slice JavaScript text with the project's canonical Unicode code-point offsets. */
export function sliceCodePoints(value: string, start: number, end: number): string {
  const points = Array.from(value);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > points.length) {
    throw new SourceIndexError("invalid Unicode code-point range");
  }
  return points.slice(start, end).join("");
}

export function buildScriptSourceIndex(scriptVersion: ScriptVersion): ScriptSourceIndex {
  const units = splitSourceUnits(scriptVersion.rawText);
  const spans = buildSourceSpans(units);
  const blocks = buildSourceBlocks(scriptVersion.rawText, units, spans);
  const index: ScriptSourceIndex = {
    schemaVersion: SOURCE_INDEX_SCHEMA_VERSION,
    scriptVersion,
    units,
    spans,
    blocks,
  };
  validateScriptSourceIndex(index);
  return index;
}

/** Reconstruct the exact source from physical units; used by tests and persistence guards. */
export function reconstructSource(index: ScriptSourceIndex): string {
  return index.units.map((unit) => unit.raw).join("");
}

export function sourceRefForSpan(index: ScriptSourceIndex, spanId: string): SourceRef {
  const span = spanById(index, spanId);
  const quote = sliceCodePoints(index.scriptVersion.rawText, span.start, span.end);
  if (quote !== span.quote) throw new SourceIndexError(`span ${spanId} no longer matches its source quote`);
  return {
    scriptVersionId: index.scriptVersion.id,
    start: span.start,
    end: span.end,
    quote,
  };
}

/**
 * A conservative, model-agnostic input estimate. It intentionally counts each
 * Unicode code point as one budget unit so it never becomes a claim about a
 * particular provider tokenizer. Actual usage is calibrated later from receipts.
 */
export function estimateInputTokens(text: string): number {
  return Array.from(text).length;
}

/**
 * Pack logical blocks under a conservative budget. Canonical spans and primary
 * ownership never overlap. Context overlap is adaptive: only soft boundaries
 * (blank or budget) expose one complete neighboring span as context-only.
 */
export function createPromptChunks(index: ScriptSourceIndex, options: PromptChunkOptions): PromptChunk[] {
  if (!Number.isInteger(options.targetEstimatedTokens) || options.targetEstimatedTokens < 1) {
    throw new SourceIndexError("targetEstimatedTokens must be a positive integer");
  }
  if (index.spans.length === 0) return [];

  const spans = spanMap(index);
  const packingSegments = index.blocks.flatMap((block) => splitBlockForPacking(index, block, options.targetEstimatedTokens));
  const drafts: Array<Omit<PromptChunk, "id" | "contextSpanIds" | "estimatedContextTokens" | "sectionHeadingSpanId">> = [];
  let primarySpanIds: string[] = [];
  let primaryBudget = 0;
  let boundaryBefore: PromptChunkBoundary = "start";
  let oversizedPrimarySpanIds: string[] = [];

  const finish = () => {
    if (primarySpanIds.length === 0) return;
    drafts.push({ primarySpanIds, boundaryBefore, estimatedPrimaryTokens: primaryBudget, oversizedPrimarySpanIds });
    primarySpanIds = [];
    primaryBudget = 0;
    oversizedPrimarySpanIds = [];
  };

  for (const segment of packingSegments) {
    const forceBoundary = segment.boundaryBefore === "heading" || segment.boundaryBefore === "blank";
    const exceeds = primarySpanIds.length > 0 && primaryBudget + segment.estimatedTokens > options.targetEstimatedTokens;
    if (primarySpanIds.length > 0 && (forceBoundary || exceeds)) finish();

    if (primarySpanIds.length === 0) {
      // A structural boundary wins over a size boundary. A scene heading must
      // begin a fresh chunk even when the preceding chunk also happened to be
      // near its budget.
      boundaryBefore = drafts.length === 0
        ? "start"
        : (segment.boundaryBefore === "heading" || segment.boundaryBefore === "blank")
          ? segment.boundaryBefore
          : exceeds
            ? "budget"
            : segment.boundaryBefore;
    }
    primarySpanIds.push(...segment.spanIds);
    primaryBudget += segment.estimatedTokens;
    if (segment.oversized) oversizedPrimarySpanIds.push(...segment.spanIds);
  }
  finish();

  let activeHeading: string | null = null;
  const chunks = drafts.map((draft, indexPosition) => {
    for (const spanId of draft.primarySpanIds) {
      const span = required(spans.get(spanId), `unknown span ${spanId}`);
      if (span.kind === "headingCandidate") activeHeading = span.id;
    }
    const previous = indexPosition > 0 ? drafts[indexPosition - 1] : undefined;
    const next = indexPosition + 1 < drafts.length ? drafts[indexPosition + 1] : undefined;
    const contextIds = new Set<string>();
    if (previous && isSoftBoundary(draft.boundaryBefore)) {
      const previousLast = previous.primarySpanIds.at(-1);
      if (previousLast) contextIds.add(previousLast);
    }
    if (next && isSoftBoundary(next.boundaryBefore)) {
      const nextFirst = next.primarySpanIds[0];
      if (nextFirst) contextIds.add(nextFirst);
    }
    for (const primaryId of draft.primarySpanIds) contextIds.delete(primaryId);
    const contextSpanIds = [...contextIds];
    return {
      id: `chunk_${String(indexPosition + 1).padStart(4, "0")}`,
      primarySpanIds: [...draft.primarySpanIds],
      contextSpanIds,
      sectionHeadingSpanId: activeHeading,
      boundaryBefore: draft.boundaryBefore,
      estimatedPrimaryTokens: draft.estimatedPrimaryTokens,
      estimatedContextTokens: contextSpanIds.reduce((sum, spanId) => sum + estimateInputTokens(required(spans.get(spanId), `unknown span ${spanId}`).quote), 0),
      oversizedPrimarySpanIds: [...draft.oversizedPrimarySpanIds],
    } satisfies PromptChunk;
  });

  validatePromptChunks(index, chunks);
  return chunks;
}

/** Build short, task-local aliases. E aliases may support output; C aliases are context-only. */
export function buildEvidenceAliasCatalog(index: ScriptSourceIndex, chunk: PromptChunk): EvidenceAlias[] {
  const aliases: EvidenceAlias[] = [];
  for (const [position, spanId] of chunk.primarySpanIds.entries()) {
    const span = spanById(index, spanId);
    aliases.push({
      alias: `E${String(position + 1).padStart(3, "0")}`,
      role: "primary",
      spanId,
      kind: span.kind,
      sourceRef: sourceRefForSpan(index, spanId),
      speakerCandidate: span.speakerCandidate,
    });
  }
  for (const [position, spanId] of chunk.contextSpanIds.entries()) {
    const span = spanById(index, spanId);
    aliases.push({
      alias: `C${String(position + 1).padStart(3, "0")}`,
      role: "context",
      spanId,
      kind: span.kind,
      sourceRef: sourceRefForSpan(index, spanId),
      speakerCandidate: span.speakerCandidate,
    });
  }
  return aliases;
}

export function validateScriptSourceIndex(index: ScriptSourceIndex): void {
  if (index.schemaVersion !== SOURCE_INDEX_SCHEMA_VERSION) {
    throw new SourceIndexError("unsupported source index schema version");
  }
  const rawPoints = Array.from(index.scriptVersion.rawText);
  let expectedStart = 0;
  const unitIds = new Set<string>();
  for (const unit of index.units) {
    if (unitIds.has(unit.id)) throw new SourceIndexError(`duplicate source unit id ${unit.id}`);
    unitIds.add(unit.id);
    if (unit.start !== expectedStart || unit.end < unit.start || unit.end > rawPoints.length) {
      throw new SourceIndexError(`source unit ${unit.id} does not form contiguous source coverage`);
    }
    if (sliceCodePoints(index.scriptVersion.rawText, unit.start, unit.end) !== unit.raw) {
      throw new SourceIndexError(`source unit ${unit.id} raw text does not match source`);
    }
    if (unit.contentStart < unit.start || unit.contentEnd < unit.contentStart || unit.contentEnd > unit.end) {
      throw new SourceIndexError(`source unit ${unit.id} content range is invalid`);
    }
    if (sliceCodePoints(index.scriptVersion.rawText, unit.contentStart, unit.contentEnd) !== unit.content) {
      throw new SourceIndexError(`source unit ${unit.id} content does not match source`);
    }
    expectedStart = unit.end;
  }
  if (expectedStart !== rawPoints.length || reconstructSource(index) !== index.scriptVersion.rawText) {
    throw new SourceIndexError("source units do not reconstruct the original script");
  }

  const units = new Map(index.units.map((unit) => [unit.id, unit]));
  const spanIds = new Set<string>();
  let previousSpanEnd = 0;
  for (const span of index.spans) {
    if (spanIds.has(span.id)) throw new SourceIndexError(`duplicate source span id ${span.id}`);
    spanIds.add(span.id);
    if (!span.unitIds.length || span.unitIds.some((unitId) => !units.has(unitId))) {
      throw new SourceIndexError(`source span ${span.id} references an unknown unit`);
    }
    const firstUnit = required(units.get(span.unitIds[0]!), `source span ${span.id} has no first unit`);
    const lastUnit = required(units.get(span.unitIds.at(-1)!), `source span ${span.id} has no last unit`);
    if (span.start !== firstUnit.contentStart || span.end !== lastUnit.contentEnd || span.start < previousSpanEnd) {
      throw new SourceIndexError(`source span ${span.id} does not form an ordered canonical leaf range`);
    }
    if (sliceCodePoints(index.scriptVersion.rawText, span.start, span.end) !== span.quote) {
      throw new SourceIndexError(`source span ${span.id} quote does not match source`);
    }
    previousSpanEnd = span.end;
  }

  const ownedByBlock = new Map<string, number>();
  for (const block of index.blocks) {
    if (!block.spanIds.length) throw new SourceIndexError(`source block ${block.id} is empty`);
    for (const spanId of block.spanIds) {
      if (!spanIds.has(spanId)) throw new SourceIndexError(`source block ${block.id} references an unknown span`);
      ownedByBlock.set(spanId, (ownedByBlock.get(spanId) ?? 0) + 1);
    }
    if (sliceCodePoints(index.scriptVersion.rawText, block.start, block.end) !== block.quote) {
      throw new SourceIndexError(`source block ${block.id} quote does not match source`);
    }
  }
  for (const spanId of spanIds) {
    if (ownedByBlock.get(spanId) !== 1) throw new SourceIndexError(`source span ${spanId} must belong to exactly one source block`);
  }
}

export function validatePromptChunks(index: ScriptSourceIndex, chunks: PromptChunk[]): void {
  const spans = spanMap(index);
  const primaryOwners = new Map<string, string>();
  const chunkIds = new Set<string>();
  for (const chunk of chunks) {
    if (chunkIds.has(chunk.id)) throw new SourceIndexError(`duplicate prompt chunk id ${chunk.id}`);
    chunkIds.add(chunk.id);
    if (!chunk.primarySpanIds.length) throw new SourceIndexError(`prompt chunk ${chunk.id} has no primary spans`);
    const primary = new Set<string>();
    for (const spanId of chunk.primarySpanIds) {
      if (!spans.has(spanId)) throw new SourceIndexError(`prompt chunk ${chunk.id} references an unknown primary span`);
      if (primary.has(spanId)) throw new SourceIndexError(`prompt chunk ${chunk.id} repeats primary span ${spanId}`);
      primary.add(spanId);
      if (primaryOwners.has(spanId)) throw new SourceIndexError(`source span ${spanId} has more than one primary owner`);
      primaryOwners.set(spanId, chunk.id);
    }
    const context = new Set<string>();
    for (const spanId of chunk.contextSpanIds) {
      if (!spans.has(spanId)) throw new SourceIndexError(`prompt chunk ${chunk.id} references an unknown context span`);
      if (primary.has(spanId)) throw new SourceIndexError(`prompt chunk ${chunk.id} uses primary span ${spanId} as its own context`);
      if (context.has(spanId)) throw new SourceIndexError(`prompt chunk ${chunk.id} repeats context span ${spanId}`);
      context.add(spanId);
    }
  }
  for (const span of index.spans) {
    if (!primaryOwners.has(span.id)) throw new SourceIndexError(`source span ${span.id} has no primary owner`);
  }
}

function splitSourceUnits(rawText: string): SourceUnit[] {
  const points = Array.from(rawText);
  const units: SourceUnit[] = [];
  let start = 0;
  let lineNumber = 1;
  for (let index = 0; index < points.length; index += 1) {
    if (points[index] !== "\n") continue;
    units.push(makeUnit(points, units.length + 1, lineNumber, start, index + 1));
    start = index + 1;
    lineNumber += 1;
  }
  if (start < points.length) units.push(makeUnit(points, units.length + 1, lineNumber, start, points.length));
  return units;
}

function makeUnit(points: string[], ordinal: number, lineNumber: number, start: number, end: number): SourceUnit {
  let contentEnd = end;
  if (contentEnd > start && points[contentEnd - 1] === "\n") contentEnd -= 1;
  if (contentEnd > start && points[contentEnd - 1] === "\r") contentEnd -= 1;
  const raw = points.slice(start, end).join("");
  const content = points.slice(start, contentEnd).join("");
  return {
    id: `unit_${String(ordinal).padStart(5, "0")}`,
    lineNumber,
    start,
    end,
    contentStart: start,
    contentEnd,
    raw,
    content,
    isBlank: content.trim().length === 0,
  };
}

function buildSourceSpans(units: SourceUnit[]): SourceSpan[] {
  const spans: SourceSpan[] = [];
  let firstNonblank = true;
  for (const unit of units) {
    if (unit.isBlank) continue;
    const detected = classifySource(unit.content, firstNonblank);
    firstNonblank = false;
    spans.push({
      id: `span_${String(spans.length + 1).padStart(5, "0")}`,
      kind: detected.kind,
      confidence: detected.confidence,
      start: unit.contentStart,
      end: unit.contentEnd,
      quote: unit.content,
      lineStart: unit.lineNumber,
      lineEnd: unit.lineNumber,
      unitIds: [unit.id],
      speakerCandidate: detected.speakerCandidate,
    });
  }
  return spans;
}

function buildSourceBlocks(rawText: string, units: SourceUnit[], spans: SourceSpan[]): SourceBlock[] {
  const spanByUnit = new Map<string, SourceSpan>();
  for (const span of spans) spanByUnit.set(span.unitIds[0]!, span);

  const blocks: SourceBlock[] = [];
  let currentSpanIds: string[] = [];
  let currentBoundary: SourceBlockBoundary = "start";
  let activeHeadingSpanId: string | null = null;
  let nextBoundary: SourceBlockBoundary = "start";

  const flush = () => {
    if (!currentSpanIds.length) return;
    const first = required(spanByIdFrom(spans, currentSpanIds[0]!), "source block has unknown first span");
    const last = required(spanByIdFrom(spans, currentSpanIds.at(-1)!), "source block has unknown last span");
    blocks.push({
      id: `block_${String(blocks.length + 1).padStart(5, "0")}`,
      spanIds: [...currentSpanIds],
      start: first.start,
      end: last.end,
      quote: sliceCodePoints(rawText, first.start, last.end),
      boundaryBefore: currentBoundary,
      sectionHeadingSpanId: activeHeadingSpanId,
    });
    currentSpanIds = [];
  };

  for (const unit of units) {
    if (unit.isBlank) {
      flush();
      nextBoundary = "blank";
      continue;
    }
    const span = required(spanByUnit.get(unit.id), `missing source span for ${unit.id}`);
    if (span.kind === "headingCandidate") {
      flush();
      activeHeadingSpanId = span.id;
      currentBoundary = blocks.length === 0 ? "start" : "heading";
      currentSpanIds = [span.id];
      nextBoundary = "heading";
      continue;
    }
    if (!currentSpanIds.length) {
      currentBoundary = blocks.length === 0 ? "start" : nextBoundary;
      currentSpanIds = [span.id];
    } else {
      currentSpanIds.push(span.id);
    }
  }
  flush();
  return blocks;
}

function classifySource(content: string, firstNonblank: boolean): Pick<SourceSpan, "kind" | "confidence" | "speakerCandidate"> {
  const trimmed = content.trim();
  if (firstNonblank && /^(?:《[^》]{1,160}》|#{1,6}\s+\S)/u.test(trimmed)) {
    return { kind: "titleCandidate", confidence: "explicit", speakerCandidate: null };
  }
  if (looksLikeHeading(trimmed)) {
    return { kind: "headingCandidate", confidence: "explicit", speakerCandidate: null };
  }
  const dialogue = parseDialogueLine(trimmed);
  if (dialogue) return { kind: "dialogueTurnCandidate", confidence: "heuristic", speakerCandidate: dialogue.speaker };
  return { kind: "actionBlockCandidate", confidence: "unknown", speakerCandidate: null };
}

function looksLikeHeading(value: string): boolean {
  // Most screenplay headings carry a descriptive suffix (for example
  // “第十二场 医院走廊 夜 内”), so heading markers deliberately match a
  // prefix rather than requiring the whole line to end immediately after it.
  return /^(?:第[0-9一二三四五六七八九十百千〇零两]+(?:场|幕|集|章)(?:\s|[：:，,]|$)|(?:场景|场次|地点|时间)\s*[：:]|(?:INT|EXT)\.?\b)/iu.test(value)
    || /^【[^】]{1,160}】$/u.test(value);
}

function parseDialogueLine(value: string): { speaker: string; body: string } | null {
  const match = /^([^：:\n]{1,48}?)(?:[（(][^）)\n]{0,80}[）)])?\s*[：:]\s*(\S[\s\S]*)$/u.exec(value);
  if (match) {
    const speaker = match[1]?.trim() ?? "";
    return isSpeakerLabel(speaker) ? { speaker, body: match[2]! } : null;
  }

  // Many Chinese stage plays use a fixed-width name column rather than a colon:
  // “田先生　　　来，来，来。”  This is intentionally a heuristic label, not
  // proof that the name is a confirmed character or that the rest is dialogue.
  const column = /^([^\s　（(：:]{1,48})(?:[\t 　]{2,})(\S[\s\S]*)$/u.exec(value);
  if (!column) return null;
  const speaker = column[1]?.trim() ?? "";
  return isSpeakerLabel(speaker) ? { speaker, body: column[2]! } : null;
}

/** Only a plain, single-line spoken body has an unambiguous range here.
 * Parenthetical text inside the body may be stage direction or spoken content;
 * leave it for explicit review instead of guessing or silently dropping words.
 * This derives ranges from the existing index without changing its stored schema.
 */
export function dialogueBodyRange(span: SourceSpan): { start: number; end: number } | null {
  if (span.kind !== "dialogueTurnCandidate") return null;
  const trimmed = span.quote.trim();
  const parsed = parseDialogueLine(trimmed);
  if (!parsed || /[（）()]/u.test(parsed.body)) return null;
  const leadingWhitespace = Array.from(span.quote).length - Array.from(span.quote.trimStart()).length;
  const prefixLength = Array.from(trimmed).length - Array.from(parsed.body).length;
  const start = span.start + leadingWhitespace + prefixLength;
  return { start, end: start + Array.from(parsed.body).length };
}

function isSpeakerLabel(value: string): boolean {
  return Boolean(value) && ![
    "场景", "场次", "地点", "时间", "作者", "编剧", "原著", "备注", "说明", "版权",
  ].includes(value);
}

interface PackingSegment {
  spanIds: string[];
  estimatedTokens: number;
  boundaryBefore: PromptChunkBoundary;
  oversized: boolean;
}

function splitBlockForPacking(index: ScriptSourceIndex, block: SourceBlock, target: number): PackingSegment[] {
  const spans = spanMap(index);
  const wholeBudget = estimateInputTokens(block.quote);
  if (wholeBudget <= target) {
    return [{ spanIds: [...block.spanIds], estimatedTokens: wholeBudget, boundaryBefore: block.boundaryBefore, oversized: false }];
  }

  const groups: string[][] = [];
  const ids = [...block.spanIds];
  if (ids.length > 1 && required(spans.get(ids[0]!), "unknown heading span").kind === "headingCandidate") {
    groups.push([ids[0]!, ids[1]!]);
    ids.splice(0, 2);
  }
  for (const id of ids) groups.push([id]);

  const segments: PackingSegment[] = [];
  let current: string[] = [];
  let budget = 0;
  let nextBoundary: PromptChunkBoundary = block.boundaryBefore;
  const flush = () => {
    if (!current.length) return;
    segments.push({ spanIds: current, estimatedTokens: budget, boundaryBefore: nextBoundary, oversized: false });
    current = [];
    budget = 0;
    nextBoundary = "budget";
  };

  for (const group of groups) {
    const groupBudget = group.reduce((sum, id) => sum + estimateInputTokens(required(spans.get(id), `unknown span ${id}`).quote), 0);
    if (groupBudget > target) {
      flush();
      segments.push({ spanIds: [...group], estimatedTokens: groupBudget, boundaryBefore: nextBoundary, oversized: true });
      nextBoundary = "budget";
      continue;
    }
    if (current.length > 0 && budget + groupBudget > target) flush();
    current.push(...group);
    budget += groupBudget;
  }
  flush();
  return segments;
}

function isSoftBoundary(boundary: PromptChunkBoundary): boolean {
  return boundary === "blank" || boundary === "budget";
}

function spanMap(index: ScriptSourceIndex): Map<string, SourceSpan> {
  return new Map(index.spans.map((span) => [span.id, span]));
}

function spanById(index: ScriptSourceIndex, spanId: string): SourceSpan {
  return required(spanMap(index).get(spanId), `unknown source span ${spanId}`);
}

function spanByIdFrom(spans: SourceSpan[], spanId: string): SourceSpan | undefined {
  return spans.find((span) => span.id === spanId);
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new SourceIndexError(message);
  return value;
}

function assertNonempty(value: string, label: string): void {
  if (!value.trim()) throw new SourceIndexError(`${label} must not be empty`);
}
