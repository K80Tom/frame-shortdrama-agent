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
        await client.query(migration.sql);
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
