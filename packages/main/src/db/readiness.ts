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

/**
 * Versioned Tool/Agent/Skill/MCP persistence: tool definitions and grants,
 * invocation/attempt ledger, agent runs and approvals, skill versions and
 * admissions, and MCP server revisions.
 */
export const AGENT_PERSISTENCE_MIGRATIONS = ["041"] as const;

/** 基础设施异步 Outbox（Worker 任务出件箱，#124/#133 Worker 拓扑）。 */
export const INFRA_OUTBOX_MIGRATIONS = ["042", "043"] as const;

/** 模型生成执行层（#127/#130）：预算账本、ComfyUI 工作流版本、调用台账。 */
export const MODEL_GENERATION_MIGRATIONS = ["047"] as const;

/** Unified lineage read model (nodes/edges/gaps); derived projection only. */
export const LINEAGE_MIGRATIONS = ["048"] as const;
