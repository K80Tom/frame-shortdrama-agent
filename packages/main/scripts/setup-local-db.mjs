import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** Only fills local database settings; never rotates an existing password. */
export function setupLocalDatabaseEnv(directory) {
  const path = resolve(directory, '.env');
  let content = readFileSync(existsSync(path) ? path : resolve(directory, '.env.example'), 'utf8');
  const env = parseEnv(content);
  if (env.DATABASE_URL && !env.POSTGRES_PASSWORD) {
    throw new Error('已有 DATABASE_URL：请保留现有数据库连接，或先填写与其一致的 POSTGRES_* 配置。');
  }
  const user = env.POSTGRES_USER || 'shortdrama';
  const database = env.POSTGRES_DB || 'shortdrama_agent';
  const port = env.POSTGRES_PORT || '5432';
  if (![user, database].every(value => /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value))) {
    throw new Error('POSTGRES_USER / POSTGRES_DB 只支持字母、数字和下划线，且不能以数字开头。');
  }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('POSTGRES_PORT 必须是 1–65535 的端口号。');
  }
  const password = env.POSTGRES_PASSWORD || randomBytes(24).toString('hex');
  const connectionString = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
  if (env.DATABASE_URL && env.DATABASE_URL !== connectionString) {
    throw new Error('已有 DATABASE_URL 与 POSTGRES_* 不一致；未修改配置。请同步主机、端口、用户、密码和库名。');
  }
  const settings = {
    POSTGRES_USER: user,
    POSTGRES_DB: database,
    POSTGRES_PORT: port,
    POSTGRES_PASSWORD: password,
    DATABASE_URL: connectionString,
  };
  const updates = Object.entries(settings).filter(([key]) => !env[key]);
  for (const [key, value] of updates) {
    // Generated values are single-line and quote-safe. Existing values stay verbatim.
    const line = `${key}='${value}'`;
    const emptyAssignment = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'm');
    content = emptyAssignment.test(content)
      ? content.replace(emptyAssignment, () => line)
      : `${content}${content.endsWith('\n') ? '' : '\n'}${line}\n`;
  }
  if (updates.length || !existsSync(path)) writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { changed: updates.length > 0, host: '127.0.0.1', port: Number(port), database, user };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = setupLocalDatabaseEnv(fileURLToPath(new URL('..', import.meta.url)));
    console.log(result.changed ? '本地数据库配置已写入 .env；保留原有模型配置。' : '本地数据库配置已存在，保持原密码与连接。');
    console.log(`PostgreSQL: ${result.host}:${result.port} / ${result.database} / ${result.user}`);
    console.log('密码保存在忽略 Git 的 .env 中。接下来运行 npm run db:up 和 npm run db:migrate。');
  } catch (error) {
    // Only our fixed validation messages are safe to display, never file contents.
    console.error(error instanceof Error && !('code' in error) ? error.message : '无法配置本地数据库，请检查 .env 文件权限。');
    process.exitCode = 1;
  }
}
