import type { NovelAssetBinding, NovelContent, NovelItem } from '@lyra/shared';
import type { AssetRecord } from '@lyra/shared';
import { workspaceFetch } from './deployment';

export type AssetKind = 'character' | 'location' | 'prop';
export type { AssetRecord };
export interface AssetRegistration { kind: AssetKind; name: string; description: string; resourceUrl: string }
export interface AssetBindingInput { itemId: string; status: 'linked' | 'missing'; assetId: string | null; note: string }
export const assetKindLabels: Record<AssetKind, string> = { character: '人物', location: '场景 / 地点', prop: '道具' };
export const maxAssetFileBytes = 6 * 1024 * 1024;
export function localAssetLink(url: string): string | null {
  return /^\/api\/assets\/asset_[a-f0-9]{32}\/content$/u.test(url) ? url : null;
}
export function assetFileError(file: Pick<File, 'size' | 'type'> | null): string | null {
  if (!file) return '请选择要导入的图片。';
  if (file.size <= 0 || file.size > maxAssetFileBytes) return '图片不能为空，且最多为 6 MiB。';
  if (file.type && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return '仅支持 PNG、JPEG 和静态 WebP 图片。';
  return null;
}
export function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取所选图片，请重新选择。'));
    reader.onload = () => {
      const value = reader.result;
      if (typeof value !== 'string' || !value.includes(',')) reject(new Error('无法读取所选图片。'));
      else resolve(value.slice(value.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

export async function assetApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await workspaceFetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message ?? `请求失败（${response.status}），请确认本地后端已启动并完成资产迁移。`);
  return data as T;
}

/** Validate links without fetching; only exact server-owned paths support previews. */
export function assetLink(url: string): string | null {
  if (localAssetLink(url)) return url;
  const authority = /^https:\/\/([^/?#]+)/iu.exec(url)?.[1];
  if (!authority || authority.includes('@') || /[\s\\\u0000-\u001f\u007f]/u.test(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : null;
  } catch { return null; }
}

export function assetRegistrationErrors(input: AssetRegistration): string[] {
  const errors: string[] = [];
  if (!Object.hasOwn(assetKindLabels, input.kind)) errors.push('请选择人物、场景或道具类型。');
  if (!input.name.trim() || input.name.trim().length > 200) errors.push('资产名称需为 1–200 字符。');
  if (input.description.trim().length > 2000) errors.push('说明不可超过 2000 字符。');
  if (input.resourceUrl.trim().length > 2000 || !/^https:\/\//iu.test(input.resourceUrl.trim()) || !assetLink(input.resourceUrl.trim())) errors.push('请填写不含账号密码的 HTTPS 素材链接，最多 2000 字符。');
  return errors;
}

export function filterAssets(assets: AssetRecord[], kind: AssetKind | 'all', query: string): AssetRecord[] {
  const search = query.trim().toLocaleLowerCase();
  return assets.filter(asset => (kind === 'all' || asset.kind === kind)
    && (!search || `${asset.name} ${asset.id}`.toLocaleLowerCase().includes(search)));
}

export function bindingBlock(item: NovelItem, options: { editable: boolean; dirty: boolean; busy: boolean }): string | null {
  if (item.kind === 'dialogue') return '对白不关联人物、场景或道具资产。';
  if (!options.editable) return '历史版本只读。请切回本章最新版本后关联资产。';
  if (options.dirty) return '请先保存或放弃本章校对草稿，再关联资产。';
  if (options.busy) return '当前操作尚未完成，请稍候。';
  if (item.review !== 'confirmed' || item.uncertainty !== null) return '请先对照原文确认此项，并保存校对版本，再关联资产。';
  return null;
}

export function bindingFor(content: Pick<NovelContent, 'assetBindings'>, item: NovelItem): NovelAssetBinding | null {
  if (item.kind === 'dialogue') return null;
  const binding = content.assetBindings?.find(value => value.itemId === item.id);
  if (binding) return binding;
  return item.review === 'confirmed' && item.uncertainty === null
    ? { itemId: item.id, status: 'missing', asset: null, note: '' } : null;
}

export function assetBindingSummary(content: NovelContent) {
  const counts = { linked: 0, missing: 0, needsReview: 0, unconfirmed: 0 };
  for (const item of content.items) {
    if (item.kind === 'dialogue') continue;
    const binding = bindingFor(content, item);
    if (binding) counts[binding.status] += 1;
    else counts.unconfirmed += 1;
  }
  return counts;
}

export function buildAssetBinding(item: NovelItem, status: 'linked' | 'missing', assetId: string | null, note: string, assets: AssetRecord[]): AssetBindingInput {
  if (item.kind === 'dialogue' || item.review !== 'confirmed' || item.uncertainty !== null) throw new Error('只有已保存且已确认的实体可关联资产。');
  if (note.trim().length > 2000) throw new Error('引用说明不可超过 2000 字符。');
  if (status === 'linked' && !assets.some(asset => asset.id === assetId && asset.kind === item.kind)) throw new Error('请选择资产目录中与该条目同类型的资产。');
  return { itemId: item.id, status, assetId: status === 'linked' ? assetId : null, note: note.trim() };
}
