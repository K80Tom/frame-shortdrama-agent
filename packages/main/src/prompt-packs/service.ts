import { loadPromptPacks, PROMPT_PACK_STAGES, type LoadedPromptPack } from '@lyra/agent';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PromptPackImportRepository, PromptPackStateRepository } from './repository';

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
  origin: 'library' | 'imported';
}

export interface PromptPackContent {
  id: string;
  name: string;
  license: string;
  origin: 'library' | 'imported';
  content: string;
}

const MAX_CONTENT_BYTES = 512 * 1024;
const PACK_ID_PATTERN = /^[a-z0-9-]{1,80}$/u;
const IMPORTED_SOURCE = '本机导入';

async function repositoryOf(directory: string): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(path.join(directory, 'source.json'), 'utf8')) as { repository?: unknown };
    return typeof raw.repository === 'string' ? raw.repository : '';
  } catch {
    return '';
  }
}

function text(value: unknown, field: string, max: number, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) throw new PromptPackError(400, 'PROMPT_PACK_INVALID_INPUT', `缺少${field}。`);
    return '';
  }
  if (typeof value !== 'string') throw new PromptPackError(400, 'PROMPT_PACK_INVALID_INPUT', `${field}必须是文本。`);
  const trimmed = value.trim();
  if (required && trimmed.length === 0) throw new PromptPackError(400, 'PROMPT_PACK_INVALID_INPUT', `${field}不能为空。`);
  if (trimmed.length > max) throw new PromptPackError(400, 'PROMPT_PACK_INVALID_INPUT', `${field}过长（上限 ${max} 字）。`);
  return trimmed;
}

function parseStages(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PromptPackError(400, 'PROMPT_PACK_INVALID_INPUT', '请至少选择一个阶段。');
  }
  if (value.length > PROMPT_PACK_STAGES.length) {
    throw new PromptPackError(400, 'PROMPT_PACK_INVALID_INPUT', '阶段数量超出范围。');
  }
  const stages: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !(PROMPT_PACK_STAGES as readonly string[]).includes(item)) {
      throw new PromptPackError(400, 'PROMPT_PACK_INVALID_INPUT', `阶段 ${String(item).slice(0, 20)} 不受支持。`);
    }
    if (!stages.includes(item)) stages.push(item);
  }
  return stages;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);
}

/** 方法包目录：只读注册表与文本，启用状态与自导入包单独存 PostgreSQL。 */
export class PromptPackService {
  constructor(
    private readonly states: PromptPackStateRepository,
    private readonly imports: PromptPackImportRepository,
    private readonly root?: string,
  ) {}

  private packs(): LoadedPromptPack[] {
    return loadPromptPacks(this.root);
  }

  private findLibrary(packId: string): LoadedPromptPack {
    if (!PACK_ID_PATTERN.test(packId)) {
      throw new PromptPackError(400, 'PROMPT_PACK_INVALID_ID', '方法包标识无效。');
    }
    const pack = this.packs().find((candidate) => candidate.id === packId);
    if (!pack) throw new PromptPackError(404, 'PROMPT_PACK_NOT_FOUND', '方法包不存在。');
    return pack;
  }

  async list(): Promise<{ packs: PromptPackListItem[]; total: number }> {
    const states = new Map((await this.states.all()).map((row) => [row.packId, row.enabled]));
    const imported = await this.imports.all();
    const library = await Promise.all(this.packs().map(async (pack) => ({
      id: pack.id,
      name: pack.name,
      summary: pack.summary.slice(0, 160),
      stages: pack.stages,
      models: pack.models,
      license: pack.license,
      quality: pack.quality,
      enabled: states.get(pack.id) ?? pack.enabledByDefault,
      source: await repositoryOf(pack.directory),
      origin: 'library' as const,
    })));
    const own = imported.map((row) => ({
      id: row.id,
      name: row.name,
      summary: row.summary.slice(0, 160),
      stages: row.stages,
      models: [],
      license: row.license,
      quality: 'unevaluated',
      enabled: states.get(row.id) ?? false,
      source: IMPORTED_SOURCE,
      origin: 'imported' as const,
    }));
    const packs = [...own, ...library];
    return { packs, total: packs.length };
  }

  /** 按需返回正文（列表只给摘要，避免一次把 375 个 SKILL.md 塞进页面）。 */
  async content(packId: string): Promise<PromptPackContent> {
    if (!PACK_ID_PATTERN.test(packId)) {
      throw new PromptPackError(400, 'PROMPT_PACK_INVALID_ID', '方法包标识无效。');
    }
    const imported = await this.imports.find(packId);
    if (imported) {
      return { id: imported.id, name: imported.name, license: imported.license, origin: 'imported', content: imported.content };
    }
    const pack = this.findLibrary(packId);
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
    return { id: pack.id, name: pack.name, license: pack.license, origin: 'library', content };
  }

  async setState(packId: string, enabled: boolean): Promise<{ id: string; enabled: boolean; updatedAt: string }> {
    if (!PACK_ID_PATTERN.test(packId)) {
      throw new PromptPackError(400, 'PROMPT_PACK_INVALID_ID', '方法包标识无效。');
    }
    const imported = await this.imports.find(packId);
    if (!imported) this.findLibrary(packId);
    const saved = await this.states.save(packId, enabled);
    return { id: saved.packId, enabled: saved.enabled, updatedAt: saved.updatedAt };
  }

  /** 自己导入方法：正文与元数据一起入库，默认不启用，不写仓库目录。 */
  async importPack(body: unknown): Promise<{ id: string; name: string; stages: string[]; total: number }> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new PromptPackError(400, 'PROMPT_PACK_INVALID_INPUT', '导入参数无效。');
    }
    const raw = body as Record<string, unknown>;
    const name = text(raw.name, '名称', 80, true);
    const stages = parseStages(raw.stages);
    const summary = text(raw.summary, '摘要', 200, false);
    const license = text(raw.license, '许可', 60, false) || '自建（未声明许可）';
    const content = text(raw.content, '正文', MAX_CONTENT_BYTES, true);
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
      throw new PromptPackError(413, 'PROMPT_PACK_TOO_LARGE', '正文超过 512KB 上限。');
    }

    const libraryIds = new Set(this.packs().map((pack) => pack.id));
    const importedRows = await this.imports.all();
    const ownIds = new Set(importedRows.map((row) => row.id));
    const taken = (candidate: string) => libraryIds.has(candidate) || ownIds.has(candidate);

    let id: string;
    if (raw.id !== undefined && raw.id !== null && raw.id !== '') {
      id = text(raw.id, '标识', 80, true).toLowerCase();
      if (!PACK_ID_PATTERN.test(id)) {
        throw new PromptPackError(400, 'PROMPT_PACK_INVALID_INPUT', '自定义标识只能用小写字母、数字和连字符。');
      }
      if (taken(id)) throw new PromptPackError(409, 'PROMPT_PACK_ID_TAKEN', '该标识已被占用，请换一个。');
    } else {
      const base = `self-${slugify(name) || Date.now().toString(36)}`;
      id = base;
      let suffix = 2;
      while (taken(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
        if (suffix > 99) throw new PromptPackError(409, 'PROMPT_PACK_ID_TAKEN', '同名方法包过多，请自定义标识。');
      }
    }

    await this.imports.create({ id, name, summary, stages, license, content });
    return { id, name, stages, total: libraryIds.size + ownIds.size + 1 };
  }
}
