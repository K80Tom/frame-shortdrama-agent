import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { randomBytes } from "node:crypto";
import type { DatabaseConfig } from "./config";
import {
  applyDatabaseScope,
  tenantExecutionScope,
  type TenantExecutionScope,
} from "../tenancy/scope";
import type { TenantContext } from "../tenancy/context";

export interface PostgresDatabaseOptions {
  /**
   * `deny` is the Stage 1 API/Worker mode: tenant tables are invisible until
   * the caller enters a tenant or audited system scope. `legacy-system` keeps
   * pre-Stage-1 utilities and isolated repository tests working during the
   * expand migration and must not be used by an internet-facing process.
   */
  unscopedAccess?: "deny" | "legacy-system";
  executionScope?: TenantExecutionScope;
}

export class PostgresDatabase {
  private readonly pool: Pool;
  private readonly unscopedAccess: "deny" | "legacy-system";
  private readonly executionScope: TenantExecutionScope;

  constructor(config: DatabaseConfig, options: PostgresDatabaseOptions = {}) {
    this.pool = new Pool({
      connectionString: config.connectionString,
      max: 4,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
    this.unscopedAccess = options.unscopedAccess ?? "legacy-system";
    this.executionScope = options.executionScope ?? tenantExecutionScope;
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const explicitScope = this.executionScope.current();
    const scope = explicitScope ?? (this.unscopedAccess === "legacy-system"
      ? { kind: "system" as const, reason: "legacy.unscoped" }
      : undefined);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await applyDatabaseScope(client, scope);
      const result = await client.query<Row>(text, [...values]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const explicitScope = this.executionScope.current();
      const scope = explicitScope ?? (this.unscopedAccess === "legacy-system"
        ? { kind: "system" as const, reason: "legacy.unscoped" }
        : undefined);
      await applyDatabaseScope(client, scope);
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

  runWithTenant<T>(tenant: TenantContext, work: () => T): T {
    return this.executionScope.runWithTenant(tenant, work);
  }

  runAsSystem<T>(reason: string, work: () => T): T {
    return this.executionScope.runAsSystem(reason, work);
  }

  async verifyConnection(): Promise<void> {
    await this.query("SELECT 1");
  }

  /**
   * Readiness must prove that the application role can perform DML, not only
   * open a read-only connection. The row is inserted into the Stage 1 runtime
   * heartbeat table behind a savepoint and rolled back before the surrounding
   * transaction commits, so the probe has no durable side effect.
   */
  async verifyWritable(): Promise<void> {
    const instanceId = `runtime_${randomBytes(16).toString("hex")}`;
    await this.transaction(async client => {
      await client.query("SAVEPOINT lyra_readiness_write_probe");
      await client.query(`
        INSERT INTO runtime_heartbeats
          (instance_id, role, started_at, last_seen_at, expires_at)
        VALUES ($1, 'api', clock_timestamp(), clock_timestamp(),
                clock_timestamp() + interval '1 second')
      `, [instanceId]);
      await client.query("ROLLBACK TO SAVEPOINT lyra_readiness_write_probe");
      await client.query("RELEASE SAVEPOINT lyra_readiness_write_probe");
    });
  }

  /**
   * FORCE ROW LEVEL SECURITY still cannot constrain a PostgreSQL superuser or
   * a role with BYPASSRLS. Internet-facing session mode therefore refuses to
   * start with an administrative connection instead of advertising a tenant
   * boundary that the database would silently bypass.
   */
  async verifyTenantRole(): Promise<void> {
    const result = await this.query<{ rolsuper: boolean; rolbypassrls: boolean }>(`
      SELECT rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname = current_user
    `);
    const role = result.rows[0];
    if (!role || role.rolsuper || role.rolbypassrls) {
      throw new Error("Session runtime requires a non-superuser PostgreSQL role without BYPASSRLS");
    }
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
