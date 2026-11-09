import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PostgresDatabase } from "./client";
import { requireDatabaseConfig } from "./config";

interface Migration {
  version: string;
  fileName: string;
  sql: string;
  checksum: string;
}

/**
 * Checksums are defined on LF bytes, matching the committed SQL files.
 * A Windows checkout or editor may still present CRLF. Fold only that line
 * ending before hashing or applying. No other whitespace is canonicalized,
 * and a changed statement still fails the recorded checksum.
 */
export function normalizeMigrationSql(sql: string): string {
  return sql.replace(/\r\n/g, "\n");
}

interface TopLevelStatement {
  start: number;
  end: number;
  code: string;
}

const DOLLAR_QUOTE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u;
const TRANSACTION_CONTROL = /^(?:BEGIN(?:\s|$)|START\s+TRANSACTION(?:\s|$)|COMMIT(?:\s|$)|END(?:\s|$)|ROLLBACK(?:\s|$)|ABORT(?:\s|$)|SAVEPOINT(?:\s|$)|RELEASE(?:\s|$)|PREPARE\s+TRANSACTION(?:\s|$)|SET\s+(?:LOCAL\s+)?TRANSACTION(?:\s|$)|SET\s+SESSION\s+CHARACTERISTICS\s+AS\s+TRANSACTION(?:\s|$))/iu;

/**
 * Split only PostgreSQL top-level statements. Semicolons and transaction words
 * inside strings, comments, quoted identifiers or dollar-quoted PL/pgSQL bodies
 * are deliberately invisible to this scanner.
 */
function topLevelStatements(sql: string): TopLevelStatement[] {
  const statements: TopLevelStatement[] = [];
  let start = 0;
  let code = "";
  let index = 0;
  let blockCommentDepth = 0;
  let state: "code" | "single" | "double" | "line-comment" | "block-comment" | "dollar" = "code";
  let dollarDelimiter = "";

  const finish = (end: number) => {
    if (code.trim()) statements.push({ start, end, code: code.replace(/\s+/gu, " ").trim() });
    start = end;
    code = "";
  };

  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (state === "line-comment") {
      if (char === "\n") { state = "code"; code += " "; }
      index += 1;
      continue;
    }
    if (state === "block-comment") {
      if (char === "/" && next === "*") { blockCommentDepth += 1; index += 2; continue; }
      if (char === "*" && next === "/") {
        blockCommentDepth -= 1;
        index += 2;
        if (blockCommentDepth === 0) { state = "code"; code += " "; }
        continue;
      }
      index += 1;
      continue;
    }
    if (state === "single") {
      if (char === "'" && next === "'") { index += 2; continue; }
      if (char === "'") state = "code";
      index += 1;
      continue;
    }
    if (state === "double") {
      if (char === '"' && next === '"') { index += 2; continue; }
      if (char === '"') state = "code";
      index += 1;
      continue;
    }
    if (state === "dollar") {
      if (sql.startsWith(dollarDelimiter, index)) {
        index += dollarDelimiter.length;
        state = "code";
      } else index += 1;
      continue;
    }

    if (char === "-" && next === "-") { state = "line-comment"; index += 2; continue; }
    if (char === "/" && next === "*") {
      state = "block-comment";
      blockCommentDepth = 1;
      index += 2;
      continue;
    }
    if (char === "'") { state = "single"; code += " literal "; index += 1; continue; }
    if (char === '"') { state = "double"; code += " identifier "; index += 1; continue; }
    if (char === "$") {
      const delimiter = DOLLAR_QUOTE.exec(sql.slice(index))?.[0];
      if (delimiter) {
        state = "dollar";
        dollarDelimiter = delimiter;
        code += " dollar_body ";
        index += delimiter.length;
        continue;
      }
    }
    if (char === ";") { finish(index + 1); index += 1; continue; }
    code += char;
    index += 1;
  }

  if (state === "single" || state === "double" || state === "dollar" || state === "block-comment") {
    throw new Error("Migration SQL contains an unterminated quoted value or comment");
  }
  finish(sql.length);
  return statements;
}

/**
 * Migration checksums remain defined on the exact normalized file bytes.  For
 * execution only, remove one audited outer BEGIN/COMMIT pair because the
 * runner already owns the transaction containing the advisory xact lock, DDL,
 * and schema_migrations insert. Any other top-level transaction control is a
 * hard error instead of silently committing the runner transaction early.
 */
export function migrationSqlForExecution(fileName: string, sql: string): string {
  const statements = topLevelStatements(sql);
  if (statements.length === 0) throw new Error(`Migration ${fileName} is empty`);
  const first = statements[0]!;
  const last = statements.at(-1)!;
  const wrapped = first.code.toUpperCase() === "BEGIN" && last.code.toUpperCase() === "COMMIT";
  const transactionStatements = statements.filter((statement) => TRANSACTION_CONTROL.test(statement.code));

  if (wrapped) {
    if (statements.length < 3 || transactionStatements.length !== 2
      || transactionStatements[0] !== first || transactionStatements[1] !== last) {
      throw new Error(`Migration ${fileName} contains unsupported transaction control`);
    }
    const executionSql = sql.slice(first.end, last.start);
    if (!executionSql.trim()) throw new Error(`Migration ${fileName} has an empty transaction wrapper`);
    return executionSql;
  }
  if (transactionStatements.length > 0) {
    throw new Error(`Migration ${fileName} contains unsupported transaction control`);
  }
  return sql;
}

/**
 * 003 was originally applied with two final LF bytes; its checked-in copy has
 * one. These exact, audited files differ only by that trailing blank line.
 * Preserve both recorded histories. The CRLF fold above only restores the
 * committed LF bytes; it is not this exception. No other migration, checksum,
 * or SQL change is eligible.
 */
const EXECUTION_LEDGER_CHECKSUMS = new Set([
  '83957719239e47e6ea3ced16f0747ca80ccc5de2eb2c6690d7ec6ab7acca68c9',
  '4164f2cc048e8e4df705fe156577eaf3716dd72303d687c2f308c15fa707a780',
]);
export function acceptsRecordedChecksum(migration: Migration, recorded: string): boolean {
  if (migration.checksum === recorded) return true;
  return migration.version === '003'
    && migration.fileName === '003_extract_facts_execution.sql'
    && EXECUTION_LEDGER_CHECKSUMS.has(migration.checksum)
    && EXECUTION_LEDGER_CHECKSUMS.has(recorded)
    && createHash('sha256').update(migration.sql, 'utf8').digest('hex') === migration.checksum;
}

const MIGRATION_NAME = /^(\d+)_([a-z0-9_-]+)\.sql$/i;

export async function readMigrations(directory: string): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((fileName) => MIGRATION_NAME.test(fileName)).sort();
  const migrations = await Promise.all(files.map(async (fileName) => {
    const match = MIGRATION_NAME.exec(fileName);
    if (!match) throw new Error("Invalid migration filename");
    const sql = normalizeMigrationSql(await readFile(join(directory, fileName), "utf8"));
    if (!sql.trim()) throw new Error(`Migration ${fileName} is empty`);
    return {
      version: match[1]!,
      fileName,
      sql,
      checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
    };
  }));
  if (migrations.length === 0) throw new Error("No migrations found");
  const versions = new Map<string, string>();
  for (const migration of migrations) {
    const previous = versions.get(migration.version);
    if (previous) {
      throw new Error(`迁移版本 ${migration.version} 重复：${previous} 与 ${migration.fileName}；请为未发布迁移分配唯一编号，不要改写已应用历史。`);
    }
    versions.set(migration.version, migration.fileName);
  }
  return migrations;
}

/**
 * Apply checked-in SQL migrations in lexical order.  This command is explicit:
 * the HTTP server never performs schema changes as a side effect of startup.
 */
export async function runMigrations(options: { directory?: string } = {}): Promise<string[]> {
  const migrations = await readMigrations(options.directory ?? join(process.cwd(), "migrations"));
  const database = new PostgresDatabase(requireDatabaseConfig());
  try {
    return await database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["shortdrama-agent-lab:migrations"]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          checksum CHAR(64) NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      const recorded = await client.query<{ version: string; checksum: string }>(
        "SELECT version, checksum FROM schema_migrations",
      );
      const existing = new Map(recorded.rows.map((row) => [row.version, row.checksum]));
      const applied: string[] = [];

      for (const migration of migrations) {
        const previousChecksum = existing.get(migration.version);
        if (previousChecksum) {
          if (!acceptsRecordedChecksum(migration, previousChecksum)) {
            throw new Error(`Migration checksum mismatch for ${migration.fileName}`);
          }
          continue;
        }
        await client.query(migrationSqlForExecution(migration.fileName, migration.sql));
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [migration.version, migration.checksum],
        );
        applied.push(migration.version);
      }
      return applied;
    });
  } finally {
    await database.close();
  }
}

if (require.main === module) {
  runMigrations()
    .then((versions) => console.log(versions.length ? `Applied migrations: ${versions.join(", ")}` : "Database is up to date."))
    .catch(() => {
      // Do not echo connection strings, SQL text, or driver details.
      console.error("数据库迁移失败：请检查本机 PostgreSQL、DATABASE_URL 与迁移状态。未输出凭据或 SQL 详情。");
      process.exitCode = 1;
    });
}
