import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AssetRecord } from '@ohao/shared';
import { AssetVectorContractError } from './errors';
import type { AssetEmbeddingClient } from './embedding';
import type { AssetVectorStore } from './milvus';

interface VectorManifest {
  schemaVersion: 'asset-vector-manifest/1';
  entries: Record<string, { textHash: string; embeddingModel: string }>;
}

/** Explicit, resumable projection rebuild. It is never invoked by paid production preparation. */
export class AssetVectorProjector {
  constructor(private readonly dependencies: {
    embedding: AssetEmbeddingClient;
    store: AssetVectorStore;
    model: string;
    manifestPath: string;
  }) {}

  async sync(assets: AssetRecord[]): Promise<{ total: number; indexed: number; unchanged: number; deleted: number; manifestPath: string }> {
    const manifestPath = resolve(this.dependencies.manifestPath);
    const manifest = await readManifest(manifestPath);
    const ordered = [...assets].sort((left, right) => left.id.localeCompare(right.id));
    const currentIds = new Set(ordered.map(asset => asset.id));
    let indexed = 0;
    let unchanged = 0;
    for (const asset of ordered) {
      const text = buildAssetVectorText(asset);
      const textHash = createHash('sha256').update(text, 'utf8').digest('hex');
      const previous = manifest.entries[asset.id];
      if (previous?.textHash === textHash && previous.embeddingModel === this.dependencies.model) {
        unchanged++; continue;
      }
      const vector = await this.dependencies.embedding.embedText(text);
      await this.dependencies.store.upsert({ assetId: asset.id, kind: asset.kind, vector, text, textHash,
        embeddingModel: this.dependencies.model });
      manifest.entries[asset.id] = { textHash, embeddingModel: this.dependencies.model };
      indexed++;
      await writeManifest(manifestPath, manifest);
    }
    const stale = Object.keys(manifest.entries).filter(id => !currentIds.has(id));
    if (stale.length) {
      await this.dependencies.store.deleteByAssetIds(stale);
      for (const id of stale) delete manifest.entries[id];
      await writeManifest(manifestPath, manifest);
    }
    if (!indexed && !stale.length) await writeManifest(manifestPath, manifest);
    return { total: ordered.length, indexed, unchanged, deleted: stale.length, manifestPath };
  }
}

export function buildAssetVectorText(asset: AssetRecord): string {
  const kind = asset.kind === 'character' ? '角色' : asset.kind === 'location' ? '场景' : '道具';
  return [`名称：${asset.name.trim()}`, `类型：${kind}`, `描述：${asset.description.trim()}`]
    .join('\n').slice(0, 8_000);
}

async function readManifest(path: string): Promise<VectorManifest> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 'asset-vector-manifest/1', entries: {} };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<VectorManifest>;
    if (parsed.schemaVersion !== 'asset-vector-manifest/1' || !parsed.entries
      || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) throw new Error('invalid');
    return parsed as VectorManifest;
  } catch { throw new AssetVectorContractError('Asset vector manifest is invalid; repair or rebuild it explicitly'); }
}

async function writeManifest(path: string, manifest: VectorManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}
