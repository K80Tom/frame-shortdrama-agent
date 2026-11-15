import type { ScriptEpisode } from '@lyra/shared';
import type { FactPlan } from '../facts-editor';

export type { StoryboardAssetRef, StoryboardRevision, StoryboardShot } from '@lyra/shared';
export type StoryboardScene = FactPlan['content']['scenes'][number] & {
  locationId?: string | null;
  characterIds?: string[];
};
export type EpisodeView = Pick<ScriptEpisode, 'id' | 'episodeNumber' | 'title' | 'synopsis'> & {
  scenes: Array<{ id: string; sceneNumber: string }>;
};
