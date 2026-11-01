import { loadPromptPacks, type LoadedPromptPack } from '@lyra/agent';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PromptPackStateRepository } from './repository';

export class PromptPackError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'PromptPackError';
  }
}

export interface PromptPackListItem {
  id: string;
  name: string;
  summary: string;
  stages: string[];
  models: string[];
  license: string;
  quality: string;
  enabled: boolean;
  source: string;
}

const MAX_CONTENT_BYTES = 512 * 1024;

async function repositoryOf(directory: string): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(path.join(directory, 'source.json'), 'utf8')) as { repository?: unknown };
    return typeof raw.repository === 'string' ? raw.repository : '';
  } catch {
    return '';
  }
}

/** 方法包目录：只读注册表与文本，启用状态单独存 PostgreSQL。 */
export class PromptPackService {
  constructor(
    private readonly states: PromptPackStateRepository,
    private readonly root?: string,
  ) {}

  private packs(): LoadedPromptPack[] {
    return loadPromptPacks(this.root);
  }

  private find(packId: string): LoadedPromptPack {
    if (!/^[a-z0-9-]{1,128}$/u.test(packId)) {
      throw new PromptPackError(400, 'PROMPT_PACK_INVALID_ID', '方法包标识无效。');
    }
    const pack = this.packs().find((candidate) => candidate.id === packId);
    if (!pack) throw new PromptPackError(404, 'PROMPT_PACK_NOT_FOUND', '方法包不存在。');
    return pack;
  }

  async list(): Promise<{ packs: PromptPackListItem[]; total: number }> {
    const states = new Map((await this.states.all()).map((row) => [row.packId, row.enabled]));
    const packs = await Promise.all(this.packs().map(async (pack) => ({
      id: pack.id,
      name: pack.name,
      summary: pack.summary.slice(0, 160),
      stages: pack.stages,
      models: pack.models,
      license: pack.license,
      quality: pack.quality,
      enabled: states.get(pack.id) ?? pack.enabledByDefault,
      source: await repositoryOf(pack.directory),
    })));
    return { packs, total: packs.length };
  }

  /** 按需返回正文（列表只给摘要，避免一次把 375 个 SKILL.md 塞进页面）。 */
  async content(packId: string): Promise<{ id: string; license: string; content: string }> {
    const pack = this.find(packId);
    if ((pack.contentPolicy ?? 'imported') === 'reference-only') {
      throw new PromptPackError(400, 'PROMPT_PACK_REFERENCE_ONLY', '该条目仅登记参考，未入库正文。');
    }
    const file = path.resolve(pack.directory, pack.entry);
    if (!file.startsWith(path.resolve(pack.directory) + path.sep)) {
      throw new PromptPackError(400, 'PROMPT_PACK_INVALID_ENTRY', '方法包入口不在包目录内。');
    }
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      throw new PromptPackError(404, 'PROMPT_PACK_CONTENT_MISSING', '方法包正文缺失。');
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
      throw new PromptPackError(413, 'PROMPT_PACK_TOO_LARGE', '方法包正文过大。');
    }
    return { id: pack.id, license: pack.license, content };
  }

  async setState(packId: string, enabled: boolean): Promise<{ id: string; enabled: boolean; updatedAt: string }> {
    this.find(packId);
    const saved = await this.states.save(packId, enabled);
    return { id: saved.packId, enabled: saved.enabled, updatedAt: saved.updatedAt };
  }
}
