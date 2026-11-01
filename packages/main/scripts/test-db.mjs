import { spawnSync } from 'node:child_process';

if (!process.env.DATABASE_URL) {
  console.error('test:db requires DATABASE_URL. For local development run: node --env-file=.env scripts/test-db.mjs');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ['--test',
    'tests/breakdown-persistence.db.test.cjs', 'tests/production-persistence.db.test.cjs'], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exitCode = result.status ?? 1;
}
