import { ModelError } from './contracts';

/**
 * Local ModelError codes that are raised before fetch starts. Anything else,
 * including a lost socket, a timeout, or an unclassified throw, may already
 * have been accepted by the provider.
 */
const NOT_SENT_PROVIDER_CODES = new Set([
  'INVALID_REQUEST',
  'INPUT_TOO_LARGE',
  'UNKNOWN_MODEL',
  'EFFORT_UNSUPPORTED',
  'LOCAL_BUSY',
  'MODEL_NOT_CONFIGURED',
  'MEDIA_NOT_CONFIGURED',
  'INVALID_MEDIA_REQUEST',
]);

export type PaidSubmitDisposition = 'notSent' | 'maybeSent';

export function classifyPaidProviderError(error: unknown): PaidSubmitDisposition {
  if (error instanceof ModelError && NOT_SENT_PROVIDER_CODES.has(error.code)) return 'notSent';
  return 'maybeSent';
}

/** Executor outcome codes that mean a paid request may already have left this process. */
export const MAYBE_SENT_OUTCOME_CODES = new Set([
  'BREAKDOWN_SUBMISSION_UNKNOWN',
  'BREAKDOWN_RUN_ID_MISSING',
  'VIDEO_RUN_ID_MISSING',
  'VIDEO_SUBMISSION_UNKNOWN',
  'VIDEO_SUBMISSION_UNCERTAIN',
  'VIDEO_RECONCILIATION_LIMIT_REACHED',
  'MODEL_EXECUTION_UNKNOWN',
  'IMAGE_SUBMISSION_UNKNOWN',
  'IMAGE_SUBMISSION_UNCERTAIN',
  'EXTERNAL_SUBMISSION_UNKNOWN',
]);
