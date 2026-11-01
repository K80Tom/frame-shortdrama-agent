import { MAYBE_SENT_OUTCOME_CODES } from '../models/submit-disposition';
import type { ProductionExecutorOutcome } from './executor';

/** Keep a paid operation open when the outcome cannot prove the request was never sent.
 * Closing it as succeeded or failed would let a later retry create a second charge. */
export function preserveMaybeSentOutcome(outcome: ProductionExecutorOutcome): ProductionExecutorOutcome {
  if (outcome.state === 'waitingHuman' && outcome.operationUnknown === true) return outcome;
  if (outcome.state !== 'failed' && outcome.state !== 'blocked' && outcome.state !== 'waitingHuman') return outcome;
  const code = outcome.state === 'failed' ? outcome.code : outcome.issue.code;
  if (!MAYBE_SENT_OUTCOME_CODES.has(code)) return outcome;
  const message = outcome.state === 'failed' ? outcome.message : outcome.issue.message;
  const title = outcome.state === 'failed' ? '付费提交结果不明' : outcome.issue.title;
  const artifacts = outcome.state === 'failed' ? undefined : outcome.artifacts;
  return {
    state: 'waitingHuman',
    operationUnknown: true,
    ...(artifacts?.length ? { artifacts } : {}),
    issue: {
      code, title, message, severity: 'error',
      recommendedActions: ['查询或人工核对原任务', '不要重复提交'],
    },
  };
}
