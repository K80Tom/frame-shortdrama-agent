import Ajv from 'ajv';
import { Type } from '@sinclair/typebox';
import { isDeepStrictEqual } from 'node:util';
import { validateAssetRecord, type AssetRecord } from '@ohao/shared';
import { NovelAssetNoteSchema, NovelError, validateNovelAssetBindings, type NovelAssetBinding, type NovelContent, type NovelRevision } from '@ohao/shared';

const Id = Type.String({ minLength: 1, maxLength: 100 });
const BindingPatchSchema = Type.Object({
  expectedRevisionId: Id,
  bindings: Type.Array(Type.Object({
    itemId: Id,
    status: Type.Union([Type.Literal('linked'), Type.Literal('missing')]),
    assetId: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
    note: NovelAssetNoteSchema,
  }, { additionalProperties: false }), { minItems: 1, maxItems: 2000 }),
}, { additionalProperties: false });
const validatePatch = new Ajv({ allErrors: false }).compile(BindingPatchSchema);
interface BindingPatch {
  expectedRevisionId: string;
  bindings: { itemId: string; status: 'linked' | 'missing'; assetId: string | null; note: string }[];
}

/** This is a free, explicit user selection; caller-owned asset snapshots are never accepted. */
export function applyNovelAssetBindings(base: NovelRevision, input: unknown, assets: readonly AssetRecord[]): NovelContent {
  if (!validatePatch(input)) throw new NovelError(400, 'INVALID_NOVEL_ASSET_BINDINGS', '资产引用请求格式不正确。');
  const patch = input as BindingPatch;
  if (patch.expectedRevisionId !== base.id) throw new NovelError(409, 'NOVEL_REVISION_CONFLICT', '资产引用基准已变化，请重新读取最新版本。');
  validateNovelAssetBindings(base.content);
  const items = new Map(base.content.items.map(item => [item.id, item]));
  const catalog = new Map(assets.map(asset => [asset.id, asset]));
  const bindings = new Map((base.content.assetBindings ?? []).map(binding => [binding.itemId, structuredClone(binding)]));
  const seen = new Set<string>();
  let changed = false;
  for (const value of patch.bindings) {
    if (seen.has(value.itemId)) throw new NovelError(400, 'DUPLICATE_NOVEL_ASSET_BINDING', '同一次保存不能重复修改同一条目的资产引用。');
    seen.add(value.itemId);
    const item = items.get(value.itemId);
    if (!item || item.kind === 'dialogue') throw new NovelError(400, 'NOVEL_ASSET_ITEM_INVALID', '只能给本章的人物、场景或道具关联资产。');
    if (item.review !== 'confirmed' || item.uncertainty !== null) {
      throw new NovelError(400, 'NOVEL_ASSET_ITEM_UNCONFIRMED', '请先校对确认小说条目，再关联资产或标记待补。');
    }
    let asset: AssetRecord | null = null;
    if (value.status === 'linked') {
      if (value.assetId === null) throw new NovelError(400, 'INVALID_NOVEL_ASSET_BINDINGS', '关联资产时必须选择已有资产。');
      const stored = catalog.get(value.assetId);
      if (!stored) throw new NovelError(404, 'NOVEL_ASSET_NOT_FOUND', '所选资产不存在，请刷新资产列表。');
      try { validateAssetRecord(stored); }
      catch { throw new NovelError(400, 'INVALID_NOVEL_ASSET_SNAPSHOT', '所选资产记录无效。'); }
      if (stored.kind !== item.kind) throw new NovelError(400, 'NOVEL_ASSET_KIND_MISMATCH', '只能关联同类型的已有资产。');
      asset = structuredClone(stored);
    } else if (value.assetId !== null) {
      throw new NovelError(400, 'INVALID_NOVEL_ASSET_BINDINGS', '标记待补时不能同时选择资产。');
    }
    const binding: NovelAssetBinding = { itemId: item.id, status: value.status, asset, note: value.note };
    changed ||= !isDeepStrictEqual(bindings.get(item.id), binding);
    bindings.set(item.id, binding);
  }
  if (!changed) throw new NovelError(400, 'NOVEL_ASSET_NO_CHANGES', '资产引用没有变化，无需保存新版本。');
  const content: NovelContent = { ...structuredClone(base.content), assetBindings: [...bindings.values()] };
  validateNovelAssetBindings(content);
  return content;
}
