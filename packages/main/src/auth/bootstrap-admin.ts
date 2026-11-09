import { randomBytes } from 'node:crypto';
import { PostgresDatabase } from '../db/client';
import { requireDatabaseConfig } from '../db/config';
import { normalizeEmail, validatePassword } from './contracts';
import { insertBootstrapAdmin } from './repository';
import { LEGACY_WORKSPACE_ID } from '../tenancy/context';
import { passwordHash } from './service';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function label(name: string, max: number): string {
  const value = required(name);
  if (value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

async function main() {
  const database = new PostgresDatabase(requireDatabaseConfig());
  try {
    if (!await database.hasMigrations(['025', '028', '030', '031', '042'])) {
      throw new Error('migrations 025, 028, 030, 031 and 042 are required');
    }
    const email = normalizeEmail(required('LYRA_BOOTSTRAP_EMAIL'));
    const password = validatePassword(process.env.LYRA_BOOTSTRAP_PASSWORD, 12);
    const displayName = label('LYRA_BOOTSTRAP_DISPLAY_NAME', 120);
    const workspaceName = label('LYRA_BOOTSTRAP_WORKSPACE_NAME', 120);
    const workspaceSlug = required('LYRA_BOOTSTRAP_WORKSPACE_SLUG').toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/u.test(workspaceSlug)) {
      throw new Error('LYRA_BOOTSTRAP_WORKSPACE_SLUG is invalid');
    }
    const passwordSalt = randomBytes(16).toString('hex');
    const input = {
      userId: `usr_${randomBytes(16).toString('hex')}`,
      // Keep immutable pre-Stage-1 rows in the workspace assigned by migration
      // 025. insertBootstrapAdmin atomically activates and adopts this record.
      workspaceId: LEGACY_WORKSPACE_ID,
      email,
      displayName,
      workspaceName,
      workspaceSlug,
      passwordSalt,
      passwordHash: await passwordHash(password, passwordSalt),
      now: new Date().toISOString(),
    };
    await insertBootstrapAdmin(database, input);
    console.log(JSON.stringify({ created: true, userId: input.userId, workspaceId: input.workspaceId,
      email: input.email, workspaceSlug: input.workspaceSlug }));
  } finally {
    await database.close();
  }
}

main().catch(() => {
  console.error('创建首个管理员失败：请检查迁移、环境变量以及邮箱/workspace slug 是否重复。');
  process.exitCode = 1;
});
