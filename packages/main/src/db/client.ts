import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { DatabaseConfig } from "./config";

export class PostgresDatabase {
  private readonly pool: Pool;

  constructor(config: DatabaseConfig) {
    this.pool = new Pool({
      connectionString: config.connectionString,
      max: 4,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, [...values]);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original operation error is more useful and is sanitized at the
        // HTTP boundary.  Never replace it with a rollback transport error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async verifyConnection(): Promise<void> {
    await this.query("SELECT 1");
  }

  /** Read-only readiness check; migrations are never run during app startup. */
  async hasMigrations(versions: readonly string[]): Promise<boolean> {
    const table = await this.query<{ name: string | null }>(
      "SELECT to_regclass('public.schema_migrations') AS name",
    );
    if (!table.rows[0]?.name) return false;
    if (versions.length === 0) return true;
    const rows = await this.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = ANY($1::text[])",
      [versions],
    );
    return rows.rowCount === versions.length;
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
