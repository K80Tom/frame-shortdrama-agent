const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');
const { PostgresAssistantRepository } = require('../dist/assistant/postgres-repository');

const connectionString = process.env.DATABASE_URL;

test('migration 029 restores legacy conversation cursors and the next append uses seq 3', {
  skip: connectionString ? false : 'DATABASE_URL is required',
}, async () => {
  const client = new Client({ connectionString });
  await client.connect();
  const schema = `stage1_storage_${randomBytes(8).toString('hex')}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query('CREATE TABLE workspaces (id text PRIMARY KEY)');
    await client.query('CREATE TABLE jobs (workspace_id text NOT NULL, id text NOT NULL, PRIMARY KEY (workspace_id, id))');
    await client.query(`
      CREATE TABLE assistant_sessions (
        id text PRIMARY KEY, context_key text NOT NULL, context_json jsonb NOT NULL,
        title text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE assistant_messages (
        id text PRIMARY KEY, session_id text NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
        seq bigint NOT NULL, role text NOT NULL, content text NOT NULL DEFAULT '', thinking text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'complete', tool_name text, payload_json jsonb,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (session_id, seq)
      )
    `);
    await client.query(`
      INSERT INTO assistant_sessions (id, context_key, context_json)
      VALUES ('asst_legacy', 'global', '{"kind":"global"}'::jsonb)
    `);
    await client.query(`
      INSERT INTO assistant_messages (id, session_id, seq, role, content)
      VALUES ('msg_legacy_1', 'asst_legacy', 1, 'user', 'one'),
             ('msg_legacy_2', 'asst_legacy', 2, 'assistant', 'two')
    `);

    const migration = readFileSync(join(__dirname, '../migrations/029_stage1_storage_projection.sql'), 'utf8');
    await client.query(migration);
    const restored = await client.query(`
      SELECT conversation_version, last_message_seq FROM assistant_sessions WHERE id = 'asst_legacy'
    `);
    assert.deepEqual(restored.rows[0], { conversation_version: '2', last_message_seq: '2' });

    const database = {
      query: (text, values) => client.query(text, values),
      transaction: async work => {
        await client.query('BEGIN');
        try {
          const result = await work(client);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      },
    };
    const repository = new PostgresAssistantRepository(database);
    const appended = await repository.appendMessage({ id: 'msg_legacy_3', sessionId: 'asst_legacy',
      role: 'user', content: 'three', thinking: '', status: 'complete' });
    assert.equal(appended.seq, 3);
    assert.equal(await repository.conversationVersion('asst_legacy'), 3);
  } finally {
    await client.query('SET search_path TO public').catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await client.end();
  }
});
