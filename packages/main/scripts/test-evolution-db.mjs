import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) {
  console.error('test:evolution-db requires DATABASE_URL; it creates and drops only its own disposable database.');
  process.exitCode = 1;
} else {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const name = `lyra_evolution_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error('Unsafe generated test database name.');
  const testUrl = new URL(sourceUrl); testUrl.pathname = `/${name}`;
  const admin = new Client({ connectionString: sourceUrl });
  let created = false;
  const run = args => {
    const result = spawnSync(process.execPath, args, { cwd: packageRoot, stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: testUrl.toString(), EVOLUTION_TEST_DATABASE_URL: testUrl.toString() } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Command failed with exit code ${result.status ?? 'unknown'}.`);
  };
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`); created = true;
    run(['dist/db/migrate.js']);
    run(['--test', 'tests/asset-evolution.db.test.cjs']);
  } catch (error) {
    console.error('Isolated evolution database verification failed; credentials are intentionally not printed.');
    process.exitCode = 1;
  } finally {
    if (created) {
      try { await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
      catch { console.error(`Disposable database ${name} could not be dropped; remove only this test-owned database after checking active connections.`); process.exitCode = 1; }
    }
    await admin.end().catch(() => {});
  }
}
