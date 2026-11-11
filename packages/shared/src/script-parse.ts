/**
 * AI 整段剧本解析的稳定契约。
 *
 * 模型只产出语义内容；服务端负责分配稳定 ID、场次编号并校验
 * `ScriptStructure`。人物在这里只是候选项，确认保存后才进入事实链。
 */
export const SCRIPT_PARSE_PROMPT_VERSION = 'script-parse/1' as const;

export interface ScriptParseCharacter {
  name: string;
  aliases: string[];
  description: string | null;
}

export interface ScriptParseResult {
  structure: import('./script-structure').ScriptStructure;
  characters: ScriptParseCharacter[];
}
