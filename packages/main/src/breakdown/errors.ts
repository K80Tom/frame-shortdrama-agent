/**
 * Errors that are safe to expose through the local HTTP API.
 *
 * Database driver errors, SQL statements, raw model output and local paths must
 * never be forwarded to the browser.  Domain code should use this small error
 * type when the caller can take an informed next action.
 */
export class BreakdownError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BreakdownError";
  }
}

export type PaidModelCallState = "none" | "confirmed" | "unknown";

/** Internal execution signal used by the production orchestrator. The public
 * error remains sanitized while preserving whether a paid request definitely
 * ran, may have run, or never reached the adapter. */
export class PaidModelExecutionError extends BreakdownError {
  constructor(
    status: number,
    code: string,
    message: string,
    public readonly paidModelCallState: PaidModelCallState,
  ) {
    super(status, code, message);
    this.name = "PaidModelExecutionError";
  }
}
