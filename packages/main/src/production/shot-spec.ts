import { canonicalDigest, ProductionError } from '@lyra/shared';
import { parseShotSpecV2, parseShotSpecV2Draft, type ShotSpecV2 } from '@lyra/shared/dist/shot-spec';

function body(spec: ShotSpecV2) { const { contentDigest: _digest, ...value } = spec; return value; }
function content(value: ReturnType<typeof parseShotSpecV2Draft>) {
  const { revisionId: _revisionId, createdAt: _createdAt, source: _source, ...productionContent } = value;
  return productionContent;
}
/** Authorization, source span verification and immutable reference lookup are separate caller duties. */
export function sealShotSpecV2(value: unknown): ShotSpecV2 {
  const draft = parseShotSpecV2Draft(value);
  return parseShotSpecV2({ ...draft, contentDigest: canonicalDigest(content(draft)) });
}
export function verifyShotSpecV2(value: unknown): ShotSpecV2 {
  const spec = parseShotSpecV2(value);
  if (canonicalDigest(content(body(spec))) !== spec.contentDigest) {
    throw new ProductionError(409, 'SHOT_SPEC_DIGEST_MISMATCH', '镜头输入摘要不一致，禁止提交生成任务。');
  }
  return spec;
}

export const SHOT_IMPACT_NODES = ['video', 'voice', 'lip_sync', 'sfx', 'music', 'mix', 'subtitles', 'review', 'compose', 'delivery', 'canvas'] as const;
export type ShotImpactNode = typeof SHOT_IMPACT_NODES[number];
const visual = ['video', 'review', 'compose', 'delivery', 'canvas'] as const;
const speech = ['video', 'voice', 'lip_sync', 'mix', 'subtitles', 'review', 'compose', 'delivery', 'canvas'] as const;
const render = ['compose', 'delivery', 'canvas'] as const;
const contentFields = ['episodeId', 'scriptVersionId', 'planRevisionId', 'storyboardRevisionId', 'sceneId', 'order', 'durationMs', 'ratio',
  'shotSize', 'camera', 'dialogue', 'actions', 'assetPacks', 'controls', 'visualStyle', 'negativeConstraints', 'continuity', 'timeline', 'generation', 'sourceRefs'] as const;

/** One-shot dependency impact only. Does not mutate records, adopt a candidate, or invalidate historical runs. */
export function compareShotSpecRevisions(beforeValue: unknown, afterValue: unknown) {
  const before = verifyShotSpecV2(beforeValue), after = verifyShotSpecV2(afterValue);
  if (before.workspaceId !== after.workspaceId || before.projectId !== after.projectId || before.shotId !== after.shotId) {
    throw new ProductionError(404, 'SHOT_SPEC_NOT_FOUND', '镜头版本不存在。');
  }
  if (before.revisionId === after.revisionId && canonicalDigest(body(before)) !== canonicalDigest(body(after))) {
    throw new ProductionError(409, 'SHOT_SPEC_REVISION_REUSED', '不可变镜头版本不能原地改写。');
  }
  const changedFields = contentFields.filter(field => canonicalDigest(before[field]) !== canonicalDigest(after[field]));
  const affected = new Set<ShotImpactNode>();
  const add = (nodes: readonly ShotImpactNode[]) => nodes.forEach(node => affected.add(node));
  for (const field of changedFields) {
    if (field === 'durationMs' || ['episodeId', 'scriptVersionId', 'planRevisionId', 'storyboardRevisionId', 'sceneId', 'generation', 'sourceRefs'].includes(field)) add(SHOT_IMPACT_NODES);
    else if (field === 'order') add(render);
    else if (field === 'dialogue') add(speech);
    else if (field === 'timeline') {
      const kinds = ['dialogue', 'sfx', 'music', 'subtitle'] as const;
      for (const kind of kinds) if (canonicalDigest(before.timeline.filter(c => c.kind === kind)) !== canonicalDigest(after.timeline.filter(c => c.kind === kind))) {
        if (kind === 'dialogue') add(speech);
        else if (kind === 'subtitle') add(['subtitles', ...render]);
        else add([kind, 'mix', 'review', ...render]);
      }
    } else add(visual);
  }
  return { shotId: before.shotId, beforeRevisionId: before.revisionId, afterRevisionId: after.revisionId,
    beforeDigest: before.contentDigest, afterDigest: after.contentDigest, changedFields,
    needsReview: changedFields.length > 0, affectedNodes: SHOT_IMPACT_NODES.filter(node => affected.has(node)) };
}
