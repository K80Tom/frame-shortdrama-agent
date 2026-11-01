export interface DatabaseConfig {
  /** Never log this value: it contains the local development password. */
  connectionString: string;
}

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

/**
 * P0 uses a local PostgreSQL instance only.  Keep this separate from the model
 * configuration so model-only tests and utilities never need a database.
 */
export function readDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig | null {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) return null;

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new DatabaseConfigError("Invalid DATABASE_URL");
  }

  const allowedHosts = new Set(["127.0.0.1", "[::1]"]);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const port = url.port === "" ? 5432 : Number(url.port);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !allowedHosts.has(url.hostname)
    || !url.username
    || !url.password
    || !Number.isInteger(port)
    || port < 1
    || port > 65535
    || !/^[A-Za-z0-9_-]{1,63}$/.test(databaseName)
    || url.search
    || url.hash
  ) {
    throw new DatabaseConfigError(
      "DATABASE_URL must point to a local PostgreSQL database at 127.0.0.1 or ::1",
    );
  }

  return Object.freeze({ connectionString });
}

export function requireDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const config = readDatabaseConfig(env);
  if (!config) throw new DatabaseConfigError("DATABASE_URL is required for database commands");
  return config;
}
