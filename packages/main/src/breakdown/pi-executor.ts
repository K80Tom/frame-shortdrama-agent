import {
  EXTRACT_FACTS_PROMPT_VERSION,
  EXTRACT_FACTS_SYSTEM_PROMPT,
  type ExtractFactsStageContext,
  type ExtractFactsStageExecutor,
  type RecordedStageModelPort,
} from './execution';
import { runPiJsonAgent } from './pi-json';

export const PI_EXTRACT_FACTS_EXECUTOR_VERSION = 'pi-agent-core-extract-facts/1';

/** Pi owns the transcript and lifecycle; the recorded port owns the bounded paid call. */
export class PiExtractFactsStageExecutor implements ExtractFactsStageExecutor {
  readonly version = PI_EXTRACT_FACTS_EXECUTOR_VERSION;

  async execute(context: ExtractFactsStageContext, modelPort: RecordedStageModelPort): Promise<unknown> {
    return runPiJsonAgent({ systemPrompt: EXTRACT_FACTS_SYSTEM_PROMPT,
      prompt: { operation: 'extractFacts', context },
      invoke: (systemPrompt, userText) => modelPort.call({
        operation: 'extractFacts', promptVersion: EXTRACT_FACTS_PROMPT_VERSION,
        systemPrompt, messages: [{ role: 'user', content: userText }],
      }),
    });
  }
}
