import type { ExtractFactsPlanContent, PlanRevisionRecord } from "./plan";
import { dialogueBodySpans, sliceCodePoints, type ScriptSourceIndex, type SourceRef, type SourceSpan } from "./source-index";

export const FACT_CHECK_RULE_VERSION = "extract-facts-completeness/2";
export type FactCheckRuleVersion = "extract-facts-completeness/1" | typeof FACT_CHECK_RULE_VERSION;

/** Stable location of one fact-check failure. Stored inside `scope_json`; older rows omit `field`. */
export interface IssueFieldRef {
  objectKind: "synopsis" | "scene" | "dialogue" | "character" | "location" | "prop" | "sourceSpan";
  objectId: string | null;
  fieldPath: string;
  expected: string | null;
  actual: string | null;
}

export interface PlanIssueScope {
  kind: "project" | "scene";
  targetId: string | null;
  field?: IssueFieldRef;
}

export interface PlanIssueRecord {
  id: string;
  checkId: string;
  projectId: string;
  planRevisionId: string;
  kind: "validation" | "storyAmbiguity";
  code: string;
  message: string;
  scope: PlanIssueScope;
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

const FIELD_TEXT_MAX = 240;

function fieldText(value: string | null): string | null {
  if (value === null) return null;
  const points = Array.from(value);
  return points.length <= FIELD_TEXT_MAX ? value : `${points.slice(0, FIELD_TEXT_MAX).join("")}…`;
}

function fieldRef(
  objectKind: IssueFieldRef["objectKind"],
  objectId: string | null,
  fieldPath: string,
  expected: string | null,
  actual: string | null,
): IssueFieldRef {
  return { objectKind, objectId, fieldPath, expected: fieldText(expected), actual: fieldText(actual) };
}

/** Compact lines for a stage-level PLAN_CHECK_FAILED issue. Quotes stay on the plan issue. */
export function describePlanCheckFailure(issues: Array<Pick<PlanIssueRecord, "code" | "scope">>): { message: string; impact: string[] } {
  const lines = issues.slice(0, 8).map((issue) => {
    const field = issue.scope.field;
    if (field?.fieldPath) {
      const object = field.objectId ? ` ${field.objectId}` : "";
      return `${issue.code}${object} ${field.fieldPath}`;
    }
    if (issue.scope.kind === "scene" && issue.scope.targetId) return `${issue.code} /scenes/${issue.scope.targetId}`;
    return issue.code;
  });
  const remainder = issues.length > lines.length ? `另有 ${issues.length - lines.length} 项。` : "";
  const detail = lines.length ? `${lines.join("；")}。${remainder}` : "";
  return { message: `候选版本存在阻断问题，不能采用。${detail}`, impact: lines };
}

/** Deterministic completeness rules. Semantic fidelity still needs a human review. */
export function inspectExtractFactsPlan(plan: PlanRevisionRecord, sourceIndex: ScriptSourceIndex): ProposedIssue[] {
  const content = plan.content;
  const issues: ProposedIssue[] = [];
  const add = (code: string, message: string, field: IssueFieldRef, refs: SourceRef[] = [], sceneId: string | null = null,
    kind: ProposedIssue["kind"] = "validation") => {
    issues.push({ code, message, kind, scope: {
      ...(sceneId === null ? { kind: "project" as const, targetId: null } : { kind: "scene" as const, targetId: sceneId }),
      field,
    }, sourceRefs: refs.map((ref) => ({ ...ref })), blocking: true });
  };
  if (!content.synopsis) add("SYNOPSIS_MISSING", "缺少剧情梗概。", fieldRef("synopsis", null, "/synopsis", "有梗概", "缺失"));
  if (content.scenes.length === 0) add("SCENE_MISSING", "没有识别到任何场次。", fieldRef("scene", null, "/scenes", "至少 1 场", "0"));
  if (content.characters.length === 0 && sourceIndex.spans.some((span) => span.kind === "dialogueTurnCandidate")) {
    add("CHARACTERS_MISSING", "原文存在对白，但候选没有人物。", fieldRef("character", null, "/characters", "至少 1 个人物", "0"));
  }
  for (const dialogue of content.dialogues) {
    if (dialogue.speakerId === null) {
      add("SPEAKER_UNRESOLVED", "对白说话人无法从原文确认，请核对。",
        fieldRef("dialogue", dialogue.id, `/dialogues/${dialogue.id}/speakerId`, "已确认的说话人", "null"),
        [dialogue.sourceRef], dialogue.sceneId, "storyAmbiguity");
    }
  }
  const dialogueSpans = sourceIndex.spans.filter((span) => span.kind === "dialogueTurnCandidate");
  for (const span of dialogueSpans) {
    const covering = content.dialogues.filter((dialogue) => contains(span, dialogue.sourceRef));
    const spanPath = `/sourceSpans/${span.start}:${span.end}`;
    if (covering.length === 0) {
      add("DIALOGUE_MISSING", "原文对白没有进入拆解结果。", fieldRef("sourceSpan", null, spanPath, "1", "0"), [refForSpan(sourceIndex, span)]);
    }
    if (covering.length > 1) {
      add("DIALOGUE_DUPLICATED", "同一段原文对白被拆解为多条，请核对是否重复。",
        fieldRef("sourceSpan", null, spanPath, "1", covering.map((dialogue) => dialogue.id).join(",")),
        [refForSpan(sourceIndex, span)]);
    }
    if (covering.length !== 1) continue;
    const dialogue = covering[0]!;
    const body = dialogueBodySpans(span);
    if (!body) {
      add("DIALOGUE_BOUNDARY_UNCERTAIN", "对白正文含括号说明等不确定边界，暂不能自动确认完整性，请人工核对原文。",
        fieldRef("dialogue", dialogue.id, `/dialogues/${dialogue.id}/sourceRef`, null, dialogue.sourceRef.quote),
        [refForSpan(sourceIndex, span)], dialogue.sceneId, "storyAmbiguity");
      continue;
    }
    const expected: SourceRef = { scriptVersionId: sourceIndex.scriptVersion.id, ...body.inner,
      quote: sliceCodePoints(span.quote, body.inner.start - span.start, body.inner.end - span.start) };
    const sourceField = fieldRef("dialogue", dialogue.id, `/dialogues/${dialogue.id}/sourceRef`, expected.quote, dialogue.sourceRef.quote);
    if (!contains(dialogue.sourceRef, expected)) {
      add("DIALOGUE_INCOMPLETE", "对白只提取了原文的一部分，缺少开头、结尾或标点，请保留完整正文。", sourceField, [expected], dialogue.sceneId);
    }
    if (!contains(expected, dialogue.sourceRef)
      && !(body.quoted && contains(body.quoted, dialogue.sourceRef))) {
      add("DIALOGUE_BOUNDARY_INVALID", "对白包含说话人标注或正文之外的内容，请只引用要说的完整原文。", sourceField, [expected], dialogue.sceneId);
    }
  }
  for (const scene of content.scenes) {
    if (!content.dialogues.some((dialogue) => dialogue.sceneId === scene.id)
      && scene.sourceRefs.some((ref) => dialogueSpans.some((span) => contains(ref, refForSpan(sourceIndex, span))))) {
      add("SCENE_DIALOGUE_MISSING", "场次引用了对白原文，但没有所属对白。",
        fieldRef("scene", scene.id, `/scenes/${scene.id}/dialogues`, "至少 1 条对白", "0"), scene.sourceRefs, scene.id);
    }
  }
  for (const span of sourceIndex.spans) {
    if (span.kind === "titleCandidate") continue;
    // Chapter headings are structural markers (第X章), not scene content:
    // they anchor sections but no scene is expected to claim them.
    if (span.kind === "headingCandidate" && /^第[0-9一二三四五六七八九十百千〇零两]+章/u.test(span.quote.trim())) continue;
    const sourceRef = refForSpan(sourceIndex, span);
    if (!content.scenes.some((scene) => scene.sourceRefs.some((ref) => contains(ref, sourceRef)))) {
      add("SOURCE_SPAN_UNASSIGNED", "这段剧本原文没有归属任何场次。",
        fieldRef("sourceSpan", null, `/sourceSpans/${span.start}:${span.end}`, "归属到场次", "未归属"), [sourceRef]);
    }
  }
  for (const duplicate of duplicateEntities(content)) {
    add("ENTITY_NAME_DUPLICATED", `同类实体名称重复：${duplicate.name}，请核对是否同一对象。`,
      fieldRef(duplicate.kind, duplicate.id, `/${duplicate.collection}/${duplicate.id}/name`, "同类名称唯一", duplicate.name));
  }
  return issues;
}

function duplicateEntities(content: ExtractFactsPlanContent): Array<{
  kind: "character" | "location" | "prop"; collection: "characters" | "locations" | "props"; id: string; name: string;
}> {
  const duplicates: Array<{ kind: "character" | "location" | "prop"; collection: "characters" | "locations" | "props"; id: string; name: string }> = [];
  const groups = [
    ["character", "characters", content.characters],
    ["location", "locations", content.locations],
    ["prop", "props", content.props],
  ] as const;
  for (const [kind, collection, group] of groups) {
    const seen = new Set<string>();
    for (const entity of group) {
      const name = entity.name.value.trim();
      if (seen.has(name)) duplicates.push({ kind, collection, id: entity.id, name });
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
