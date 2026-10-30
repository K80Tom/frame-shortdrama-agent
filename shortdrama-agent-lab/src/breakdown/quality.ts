import type { ExtractFactsPlanContent, PlanRevisionRecord } from "./plan";
import { dialogueBodyRange, sliceCodePoints, type ScriptSourceIndex, type SourceRef, type SourceSpan } from "./source-index";

export const FACT_CHECK_RULE_VERSION = "extract-facts-completeness/2";
export type FactCheckRuleVersion = "extract-facts-completeness/1" | typeof FACT_CHECK_RULE_VERSION;

export interface PlanIssueRecord {
  id: string;
  checkId: string;
  projectId: string;
  planRevisionId: string;
  kind: "validation" | "storyAmbiguity";
  code: string;
  message: string;
  scope: { kind: "project" | "scene"; targetId: string | null };
  sourceRefs: SourceRef[];
  blocking: true;
  status: "open";
  createdAt: string;
}

export interface PlanCheckRecord {
  id: string;
  projectId: string;
  planRevisionId: string;
  ruleVersion: FactCheckRuleVersion;
  method: "program";
  result: "passed" | "failed";
  contentDigest: string;
  issueIds: string[];
  createdAt: string;
}

export interface PlanAdoptionRecord {
  id: string;
  projectId: string;
  fromRevisionId: string | null;
  toRevisionId: string;
  checkId: string;
  actor: "user" | "agent";
  createdAt: string;
}

export type ProposedIssue = Pick<PlanIssueRecord, "kind" | "code" | "message" | "scope" | "sourceRefs" | "blocking">;

/** Deterministic completeness rules. Semantic fidelity still needs a human review. */
export function inspectExtractFactsPlan(plan: PlanRevisionRecord, sourceIndex: ScriptSourceIndex): ProposedIssue[] {
  const content = plan.content;
  const issues: ProposedIssue[] = [];
  const add = (code: string, message: string, refs: SourceRef[] = [], sceneId: string | null = null,
    kind: ProposedIssue["kind"] = "validation") => {
    issues.push({ code, message, kind, scope: sceneId === null
      ? { kind: "project", targetId: null }
      : { kind: "scene", targetId: sceneId }, sourceRefs: refs.map((ref) => ({ ...ref })), blocking: true });
  };
  if (!content.synopsis) add("SYNOPSIS_MISSING", "缺少剧情梗概。");
  if (content.scenes.length === 0) add("SCENE_MISSING", "没有识别到任何场次。");
  if (content.characters.length === 0 && sourceIndex.spans.some((span) => span.kind === "dialogueTurnCandidate")) {
    add("CHARACTERS_MISSING", "原文存在对白，但候选没有人物。");
  }
  for (const dialogue of content.dialogues) {
    if (dialogue.speakerId === null) {
      add("SPEAKER_UNRESOLVED", "对白说话人无法从原文确认，请核对。", [dialogue.sourceRef], dialogue.sceneId, "storyAmbiguity");
    }
  }
  const dialogueSpans = sourceIndex.spans.filter((span) => span.kind === "dialogueTurnCandidate");
  for (const span of dialogueSpans) {
    const covering = content.dialogues.filter((dialogue) => contains(span, dialogue.sourceRef));
    if (covering.length === 0) add("DIALOGUE_MISSING", "原文对白没有进入拆解结果。", [refForSpan(sourceIndex, span)]);
    if (covering.length > 1) add("DIALOGUE_DUPLICATED", "同一段原文对白被拆解为多条，请核对是否重复。", [refForSpan(sourceIndex, span)]);
    if (covering.length !== 1) continue;
    const dialogue = covering[0]!;
    const body = dialogueBodyRange(span);
    if (!body) {
      add("DIALOGUE_BOUNDARY_UNCERTAIN", "对白正文含括号说明等不确定边界，暂不能自动确认完整性，请人工核对原文。",
        [refForSpan(sourceIndex, span)], dialogue.sceneId, "storyAmbiguity");
      continue;
    }
    const expected: SourceRef = { scriptVersionId: sourceIndex.scriptVersion.id, ...body,
      quote: sliceCodePoints(span.quote, body.start - span.start, body.end - span.start) };
    if (!contains(dialogue.sourceRef, expected)) {
      add("DIALOGUE_INCOMPLETE", "对白只提取了原文的一部分，缺少开头、结尾或标点，请保留完整正文。", [expected], dialogue.sceneId);
    }
    if (!contains(expected, dialogue.sourceRef)) {
      add("DIALOGUE_BOUNDARY_INVALID", "对白包含说话人标注或正文之外的内容，请只引用要说的完整原文。", [expected], dialogue.sceneId);
    }
  }
  for (const scene of content.scenes) {
    if (!content.dialogues.some((dialogue) => dialogue.sceneId === scene.id)
      && scene.sourceRefs.some((ref) => dialogueSpans.some((span) => contains(ref, refForSpan(sourceIndex, span))))) {
      add("SCENE_DIALOGUE_MISSING", "场次引用了对白原文，但没有所属对白。", scene.sourceRefs, scene.id);
    }
  }
  for (const span of sourceIndex.spans) {
    if (span.kind === "titleCandidate") continue;
    // Chapter headings are structural markers (第X章), not scene content:
    // they anchor sections but no scene is expected to claim them.
    if (span.kind === "headingCandidate" && /^第[0-9一二三四五六七八九十百千〇零两]+章/u.test(span.quote.trim())) continue;
    const sourceRef = refForSpan(sourceIndex, span);
    if (!content.scenes.some((scene) => scene.sourceRefs.some((ref) => contains(ref, sourceRef)))) {
      add("SOURCE_SPAN_UNASSIGNED", "这段剧本原文没有归属任何场次。", [sourceRef]);
    }
  }
  for (const duplicate of duplicateEntityNames(content)) {
    add("ENTITY_NAME_DUPLICATED", `同类实体名称重复：${duplicate}，请核对是否同一对象。`);
  }
  return issues;
}

function duplicateEntityNames(content: ExtractFactsPlanContent): string[] {
  const duplicates: string[] = [];
  for (const group of [content.characters, content.locations, content.props]) {
    const seen = new Set<string>();
    for (const entity of group) {
      const name = entity.name.value.trim();
      if (seen.has(name)) duplicates.push(name);
      seen.add(name);
    }
  }
  return duplicates;
}

function contains(outer: { start: number; end: number }, inner: { start: number; end: number }): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

function refForSpan(index: ScriptSourceIndex, span: SourceSpan): SourceRef {
  return { scriptVersionId: index.scriptVersion.id, start: span.start, end: span.end, quote: span.quote };
}
