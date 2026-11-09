import { spawnSync } from 'node:child_process';

if (!process.env.DATABASE_URL) {
  console.error('test:db requires DATABASE_URL. For local development run: node --env-file=.env scripts/test-db.mjs');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ['--test',
    'tests/breakdown-persistence.db.test.cjs', 'tests/production-persistence.db.test.cjs',
    'tests/production-e2e.db.test.cjs', 'tests/evaluation-catalog.db.test.cjs',
    'tests/evaluation-run-persistence.db.test.cjs',
    'tests/data-outbox-persistence.db.test.cjs',
    'tests/data-projection.db.test.cjs',
    'tests/stage1-data-foundation.db.test.cjs',
    'tests/stage1-storage-migration.db.test.cjs',
    'tests/production-media-object-projection.db.test.cjs',
    'tests/agent-runtime-persistence.db.test.cjs',
    'tests/agent-budget-concurrency.db.test.cjs'], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exitCode = result.status ?? 1;
}
