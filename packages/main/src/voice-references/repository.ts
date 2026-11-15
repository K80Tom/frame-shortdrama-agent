import { sanitizeStoryboardVoiceBinding } from '@lyra/shared';
import type { CharacterVoiceAsset, StoryboardVoiceBinding } from '@lyra/shared';
import type { PostgresDatabase } from '../db/client';

const ASSET_ID = /^asset_[a-f0-9]{32}$/u;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const PROJECT_ID = /^project_[a-f0-9]{32}$/u;
const clone = <T>(value: T): T => structuredClone(value);

function validIdentity(assetId: string, binding: StoryboardVoiceBinding): void {
  if (!ASSET_ID.test(assetId) || !PROJECT_ID.test(binding.profile.projectId)
    || !WORKSPACE_ID.test(binding.profile.workspaceId)) throw new Error('Invalid character voice identity.');
}
function stored(assetId: unknown, value: unknown): CharacterVoiceAsset {
  const binding = sanitizeStoryboardVoiceBinding(value);
  if (typeof assetId !== 'string' || !ASSET_ID.test(assetId) || !binding) {
    throw new Error('Stored character voice is invalid.');
  }
  validIdentity(assetId, binding);
  return { assetId, binding };
}

export interface VoiceReferenceRepository {
  list(projectId: string, workspaceId: string): Promise<CharacterVoiceAsset[]>;
  save(assetId: string, binding: StoryboardVoiceBinding): Promise<CharacterVoiceAsset>;
}

export class InMemoryVoiceReferenceRepository implements VoiceReferenceRepository {
  private readonly records = new Map<string, CharacterVoiceAsset>();
  async list(projectId: string, workspaceId: string): Promise<CharacterVoiceAsset[]> {
    return [...this.records.values()]
      .filter(item => item.binding.profile.projectId === projectId && item.binding.profile.workspaceId === workspaceId)
      .map(clone);
  }
  async save(assetId: string, input: StoryboardVoiceBinding): Promise<CharacterVoiceAsset> {
    const item = stored(assetId, input);
    const key = `${item.binding.profile.workspaceId}\0${item.binding.profile.projectId}\0${assetId}`;
    this.records.set(key, item);
    return clone(item);
  }
}

interface VoiceRow { asset_id: unknown; binding_json: unknown }
export class PostgresVoiceReferenceRepository implements VoiceReferenceRepository {
  constructor(private readonly database: PostgresDatabase) {}
  async list(projectId: string, workspaceId: string): Promise<CharacterVoiceAsset[]> {
    const result = await this.database.query<VoiceRow>(
      'SELECT asset_id, binding_json FROM character_voice_references WHERE project_id = $1 AND workspace_id = $2 ORDER BY updated_at DESC, asset_id ASC',
      [projectId, workspaceId]);
    return result.rows.map(row => stored(row.asset_id, row.binding_json));
  }
  async save(assetId: string, input: StoryboardVoiceBinding): Promise<CharacterVoiceAsset> {
    const item = stored(assetId, input);
    const result = await this.database.query<VoiceRow>(
      `INSERT INTO character_voice_references
        (workspace_id, project_id, asset_id, speaker_entity_id, binding_json, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
       ON CONFLICT (workspace_id, project_id, asset_id) DO UPDATE
       SET speaker_entity_id = EXCLUDED.speaker_entity_id, binding_json = EXCLUDED.binding_json, updated_at = NOW()
       RETURNING asset_id, binding_json`,
      [item.binding.profile.workspaceId, item.binding.profile.projectId, assetId,
        item.binding.speakerEntityId, JSON.stringify(item.binding)]);
    if (!result.rows[0]) throw new Error('Character voice save returned no record.');
    return stored(result.rows[0].asset_id, result.rows[0].binding_json);
  }
}
