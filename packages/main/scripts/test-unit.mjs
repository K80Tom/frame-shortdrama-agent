import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const tests = readdirSync(new URL('../tests/', import.meta.url))
  .filter(file => file.endsWith('.test.cjs') && !file.endsWith('.db.test.cjs'))
  .sort()
  .map(file => `tests/${file}`);

if (tests.length === 0) {
  console.error('No backend unit tests were found.');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: new URL('..', import.meta.url),
    stdio: 'inherit',
    env: process.env,
  });
  process.exitCode = result.status ?? 1;
}
