import type { PostgresDatabase } from '../db/client';

export interface PromptPackState {
  packId: string;
  enabled: boolean;
  updatedAt: string;
}

export interface PromptPackStateRepository {
  all(): Promise<PromptPackState[]>;
  save(packId: string, enabled: boolean): Promise<PromptPackState>;
}

export class PostgresPromptPackStateRepository implements PromptPackStateRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async all(): Promise<PromptPackState[]> {
    const result = await this.database.query<{ pack_id: string; enabled: boolean; updated_at: Date }>(
      'SELECT pack_id, enabled, updated_at FROM prompt_pack_states ORDER BY pack_id',
    );
    return result.rows.map((row) => ({
      packId: row.pack_id,
      enabled: row.enabled,
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async save(packId: string, enabled: boolean): Promise<PromptPackState> {
    const result = await this.database.query<{ pack_id: string; enabled: boolean; updated_at: Date }>(
      `INSERT INTO prompt_pack_states (pack_id, enabled, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (pack_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
       RETURNING pack_id, enabled, updated_at`,
      [packId, enabled],
    );
    const row = result.rows[0];
    if (!row) throw new Error('PROMPT_PACK_STATE_NOT_SAVED');
    return { packId: row.pack_id, enabled: row.enabled, updatedAt: row.updated_at.toISOString() };
  }
}
