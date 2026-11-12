/**
 * AI 整段剧本解析的稳定契约。
 *
 * 模型只产出语义内容；服务端负责分配稳定 ID、场次编号并校验
 * `ScriptStructure`。人物、地点和道具在这里只是候选项，确认保存后才进入事实链。
 * v2 新增地点与道具数组；旧客户端可继续只读取 structure/characters。
 */
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
