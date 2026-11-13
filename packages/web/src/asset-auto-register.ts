import type { ProjectAssetRequirementsResponse } from '@lyra/shared';

export type AssetRequirement = ProjectAssetRequirementsResponse['requirements'][number];

/** 只有「未匹配且无歧义候选」的需求允许一键自动入库；歧义项仍需人工选择。 */
export function autoRegisterCandidates(requirements: AssetRequirement[]): AssetRequirement[] {
  return requirements.filter(item => !item.match.assetId && !item.match.ambiguous);
}

export function requirementAssetInput(item: Pick<AssetRequirement, 'kind' | 'name'>): {
  kind: 'character' | 'location' | 'prop'; name: string; description: string;
} {
  return {
    kind: item.kind,
    name: item.name,
    description: '来自剧本需求自动登记（占位图，请在资产库替换为正式素材）。',
  };
}

const kindLabels = { character: '人物', location: '地点', prop: '道具' } as const;

/** 生成真实 PNG 占位图，避免手动填表/上传；仅在有画布的浏览器环境调用。 */
export function placeholderPngBase64(item: Pick<AssetRequirement, 'kind' | 'name'>): string {
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 640;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器不支持生成占位图，请改用资产库手动导入。');
  context.fillStyle = '#151a26';
  context.fillRect(0, 0, 640, 640);
  context.strokeStyle = '#3d475c';
  context.lineWidth = 4;
  context.strokeRect(24, 24, 592, 592);
  context.fillStyle = '#8fa0bd';
  context.font = '500 34px sans-serif';
  context.textAlign = 'center';
  context.fillText(`${kindLabels[item.kind]} · 占位素材`, 320, 250);
  context.fillStyle = '#f2f5fa';
  context.font = '600 56px sans-serif';
  const name = item.name.length > 12 ? `${item.name.slice(0, 12)}…` : item.name;
  context.fillText(name, 320, 340);
  context.fillStyle = '#6c7a95';
  context.font = '400 26px sans-serif';
  context.fillText('待替换为正式素材', 320, 420);
  const data = canvas.toDataURL('image/png');
  return data.slice(data.indexOf(',') + 1);
}
