/**
 * 剧本审稿提示词构建。
 *
 * 只构建提示词，不调用模型、不产生费用。
 * 基础审稿要求始终存在；可选的创作方法包仅在显式启用时追加（渐进式披露）。
 */
import { buildPromptPackInjection } from '@lyra/agent';

export interface ScriptReviewPromptInput {
  script: string;
  characterBios?: string;
  /** 显式启用的方法包 id；为空时使用 Lyra 基础审稿规则。 */
  enabledPackIds?: readonly string[];
}

export interface ScriptReviewPrompt {
  system: string;
  user: string;
  injectedPackIds: string[];
}

export function buildScriptReviewPrompt(input: ScriptReviewPromptInput): ScriptReviewPrompt {
  const packIds = [...(input.enabledPackIds ?? [])];
  const injection = buildPromptPackInjection({ stage: 'script-review', packIds });
  const system = [
    '你是 Lyra 的剧本审稿助手。你的任务是审查剧本、标记问题并给出改稿建议，不重写剧本，不执行任何外部操作。',
    '请按「致命问题 / 信息前置 / 台词质量 / 人设执行 / 爽感兑现」分类输出，诚实指出问题，并给出 P1-P3 修改优先级。',
    injection,
  ].join('\n');
  const user = [
    '请审查以下短剧剧本。',
    input.characterBios ? `【人物小传】\n${input.characterBios}` : '',
    `【剧本】\n${input.script}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return { system, user, injectedPackIds: packIds };
}
