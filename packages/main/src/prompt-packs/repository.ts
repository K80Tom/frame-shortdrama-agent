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

export interface PromptPackImport {
  id: string;
  name: string;
  summary: string;
  stages: string[];
  license: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptPackImportRepository {
  all(): Promise<PromptPackImport[]>;
  find(id: string): Promise<PromptPackImport | null>;
  create(input: Omit<PromptPackImport, 'createdAt' | 'updatedAt'>): Promise<PromptPackImport>;
}

export class PostgresPromptPackImportRepository implements PromptPackImportRepository {
  constructor(private readonly database: PostgresDatabase) {}

  private static map(row: {
    id: string;
    name: string;
    summary: string;
    stages: string[];
    license: string;
    content: string;
    created_at: Date;
    updated_at: Date;
  }): PromptPackImport {
    return {
      id: row.id,
      name: row.name,
      summary: row.summary,
      stages: row.stages,
      license: row.license,
      content: row.content,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async all(): Promise<PromptPackImport[]> {
    const result = await this.database.query<{
      id: string;
      name: string;
      summary: string;
      stages: string[];
      license: string;
      content: string;
      created_at: Date;
      updated_at: Date;
    }>('SELECT id, name, summary, stages, license, content, created_at, updated_at FROM prompt_pack_imports ORDER BY created_at DESC');
    return result.rows.map((row) => PostgresPromptPackImportRepository.map(row));
  }

  async find(id: string): Promise<PromptPackImport | null> {
    const result = await this.database.query<{
      id: string;
      name: string;
      summary: string;
      stages: string[];
      license: string;
      content: string;
      created_at: Date;
      updated_at: Date;
    }>('SELECT id, name, summary, stages, license, content, created_at, updated_at FROM prompt_pack_imports WHERE id = $1', [id]);
    const row = result.rows[0];
    return row ? PostgresPromptPackImportRepository.map(row) : null;
  }

  async create(input: Omit<PromptPackImport, 'createdAt' | 'updatedAt'>): Promise<PromptPackImport> {
    const result = await this.database.query<{
      id: string;
      name: string;
      summary: string;
      stages: string[];
      license: string;
      content: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO prompt_pack_imports (id, name, summary, stages, license, content)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, summary, stages, license, content, created_at, updated_at`,
      [input.id, input.name, input.summary, input.stages, input.license, input.content],
    );
    const row = result.rows[0];
    if (!row) throw new Error('PROMPT_PACK_IMPORT_NOT_SAVED');
    return PostgresPromptPackImportRepository.map(row);
  }
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
