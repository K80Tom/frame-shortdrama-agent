/**
 * Migrations required before each local capability is allowed to start.
 * HTTP startup never applies these files; `npm run db:migrate` does.
 */

/** Project, script, fact, check, adoption, and storyboard reads and writes. */
export const BREAKDOWN_PERSISTENCE_MIGRATIONS = ["001", "002", "003", "004", "005", "006", "007"] as const;

/**
 * `model_calls.response_json`. Extract-facts records the paid provider payload
 * in this column after the model returns. Starting that stage without 017
 * makes the completion UPDATE fail after the charge.
 */
export const EXTRACT_FACTS_LEDGER_MIGRATIONS = ["017"] as const;

/** Evaluation catalog tables, immutability triggers, and usage ledger. */
export const EVALUATION_CATALOG_MIGRATIONS = ["022"] as const;

/** Offline-first EvaluationRun snapshots, attempts, and append-only events. */
export const EVALUATION_RUN_PERSISTENCE_MIGRATIONS = ["023"] as const;

/** Unified transactional outbox; production writes require it before starting. */
export const DATA_OUTBOX_MIGRATIONS = ["024"] as const;

/** Unified append-only evaluation results, evidence, and layered metrics (#42). */
export const EVALUATION_RESULTS_MIGRATIONS = ["025"] as const;
