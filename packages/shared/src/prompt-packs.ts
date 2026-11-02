/** Optional production-run snapshot. The excerpts are private model inputs. */
export type MethodNode = 'breakdown' | 'character-image' | 'storyboard' | 'video';
export interface FrozenMethodPack {
  id: string;
  digest: string;
  nodes: MethodNode[];
  excerpt: string;
}

/** Library tags describe creative disciplines. Only actual generation nodes consume them. */
export function methodNodesFor(stages: readonly string[], adaptedScript: boolean): MethodNode[] {
  const nodes = new Set<MethodNode>();
  for (const stage of stages) {
    if (['episode-outline', 'script', 'script-review'].includes(stage) || (stage === 'adaptation' && adaptedScript)) {
      nodes.add('breakdown');
    }
    if (stage === 'character') nodes.add('character-image');
    if (stage === 'storyboard') nodes.add('storyboard');
    if (stage === 'video-prompt' || stage === 'production') nodes.add('video');
  }
  return [...nodes];
}
