import { MethodPackError, type MethodPackNode, type StoredProductionRun } from '@lyra/shared';
import { MethodReferenceSpaceError, methodReference } from '../prompt-packs/runtime';
import { renderMethodReference } from './compiler';

/** 旧 V1 执行节点名；新 V2 只有四个真实 Skill 节点。 */
export type LegacyMethodRuntimeNode = 'breakdown' | 'character-image' | 'storyboard' | 'video';

const V2_NODE: Partial<Record<LegacyMethodRuntimeNode, MethodPackNode>> = {
  'character-image': 'character-image',
  storyboard: 'storyboard',
  video: 'video-prompt',
};

/**
 * 执行器只读取 run_json 中冻结的 Manifest：
 * - 有 methodProfile 的运行绝不再读取当前全局方法包/项目配置；
 * - breakdown/剧本事实提取不注入 script-adaptation，避免方法规则污染原文事实；
 * - 历史 V1 运行继续读 methodPacks，行为不变。
 */
export function runMethodReference(run: Readonly<StoredProductionRun>, node: LegacyMethodRuntimeNode,
  limit = 16_000): string {
  if (run.methodProfile) {
    const target = V2_NODE[node];
    if (!target) return '';
    try {
      return renderMethodReference(run.methodProfile.manifest, target, limit);
    } catch (error) {
      if (error instanceof MethodPackError) throw new MethodReferenceSpaceError();
      throw error;
    }
  }
  return methodReference(run.methodPacks, node, limit);
}
