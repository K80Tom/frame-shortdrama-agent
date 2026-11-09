import { createHash } from 'node:crypto';
import {
  AgentContractError, computeSkillManifestDigest, digestOf, normalizeSkillNode, sanitizeSkillBody,
  type SkillFrontmatter, type SkillImportCandidate, type SkillImportFile, type SkillImportPreview, type SkillNode,
} from '@lyra/shared';
import { parseSkillFrontmatter } from './frontmatter';
import type { SkillFile } from './zip';

/**
 * 方法包导入检查：目录布局、SKILL.md 解析、可执行文件与提示注入扫描。
 *
 * 导入只产出版本记录所需的纯数据；是否准入由 WorkspaceSkillAdmission 单独决定，
 * 导入本身不会让方法包进入任何运行中的 Agent。
 */

export interface InspectedSkill {
  rootPath: string;
  name: string;
  description: string;
  version: number | null;
  nodes: SkillNode[];
  frontmatter: SkillFrontmatter;
  body: string;
  /** 完整 SKILL.md（含 frontmatter），用于内容摘要。 */
  markdown: string;
  files: SkillImportFile[];
  totalBytes: number;
  contentDigest: string;
  manifestDigest: string;
  licenseCode: string;
  commercialUseAllowed: boolean;
  compatibility: { models: string[]; minContextTokens: number | null };
  warnings: string[];
  errors: string[];
}

export interface SkillInspectionResult {
  preview: SkillImportPreview;
  skills: InspectedSkill[];
}

const MAX_SKILL_MD_BYTES = 256 * 1024;
const EXECUTABLE_EXTENSIONS = /\.(?:js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|ps1|bat|cmd|exe|dll|so|dylib|jar|wasm|rb|php|go|rs)$/i;
const SECRET_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: 'OPENAI_KEY', pattern: /sk-[A-Za-z0-9]{20,}/ },
  { code: 'AWS_KEY', pattern: /AKIA[0-9A-Z]{16}/ },
  { code: 'GITHUB_TOKEN', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { code: 'PRIVATE_KEY', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { code: 'BEARER_TOKEN', pattern: /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/-]{20,}/i },
];
const INJECTION_HINTS: Array<{ label: string; pattern: RegExp }> = [
  { label: '覆盖系统指令', pattern: /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above)\s+instructions|忽略(?:以上|之前|所有)(?:的)?(?:指令|提示|要求)/i },
  { label: '伪装系统消息', pattern: /<system>|\[SYSTEM\]|system\s*prompt|系统提示词/i },
  { label: '要求执行命令', pattern: /(?:执行|运行)(?:以下|这些)?(?:命令|脚本)|run\s+(?:this|the following)\s+(?:command|script)|curl\s+http|rm\s+-rf/i },
  { label: '要求读取密钥或环境变量', pattern: /process\.env|printenv|os\.environ|读取(?:密钥|环境变量|token)/i },
  { label: '外发数据', pattern: /(?:发送|上传|回传)(?:到|至)?\s*https?:|exfiltrat|POST\s+https?:/i },
];

export function inspectSkillPackage(files: SkillFile[], sourceType: 'zip' | 'directory' = 'zip'): SkillInspectionResult {
  const totalBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
  const preview: SkillImportPreview = {
    sourceType, totalFiles: files.length, totalBytes, candidates: [], warnings: [], errors: [],
  };
  const roots = findRoots(files);
  if (roots.length === 0) {
    preview.errors.push('压缩包中没有找到 SKILL.md。');
    return { preview, skills: [] };
  }
  const stray = files.filter(file => !roots.some(root => isUnderRoot(file.path, root)));
  if (stray.length > 0) preview.warnings.push(`有 ${stray.length} 个文件不在任何方法包根目录下，已忽略。`);

  const skills: InspectedSkill[] = [];
  for (const root of roots) {
    const candidate = inspectOneRoot(root, files);
    const previewCandidate: SkillImportCandidate = {
      rootPath: root, name: candidate.name || null, description: candidate.description || null,
      version: candidate.version, nodes: candidate.nodes,
      files: candidate.files, totalBytes: candidate.totalBytes,
      warnings: candidate.warnings, errors: candidate.errors,
    };
    preview.candidates.push(previewCandidate);
    preview.warnings.push(...candidate.warnings.map(message => `${root || '.'}: ${message}`));
    preview.errors.push(...candidate.errors.map(message => `${root || '.'}: ${message}`));
    skills.push(candidate);
  }
  if (skills.length > 1) preview.warnings.push('压缩包包含多个方法包，导入时必须逐个确认。');
  return { preview, skills };
}

function findRoots(files: SkillFile[]): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    if (!file.path.endsWith('/SKILL.md') && file.path !== 'SKILL.md') continue;
    const root = file.path === 'SKILL.md' ? '' : file.path.slice(0, -'/SKILL.md'.length);
    roots.add(root);
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
}

function isUnderRoot(path: string, root: string): boolean {
  return root === '' ? true : path === root || path.startsWith(`${root}/`);
}

function inspectOneRoot(root: string, allFiles: SkillFile[]): InspectedSkill {
  const files = allFiles.filter(file => isUnderRoot(file.path, root)).map(file => ({
    path: root === '' ? file.path : file.path.slice(root.length + 1),
    bytes: file.bytes,
  }));
  const warnings: string[] = [];
  const errors: string[] = [];
  const skillFile = files.find(file => file.path === 'SKILL.md');
  if (!skillFile) {
    return emptySkill(root, files, ['缺少 SKILL.md。']);
  }
  if (skillFile.bytes.length > MAX_SKILL_MD_BYTES) {
    errors.push('SKILL.md 超过 256KB。');
  }
  let markdown: string;
  try {
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(skillFile.bytes);
  } catch {
    return emptySkill(root, files, ['SKILL.md 不是合法 UTF-8。']);
  }

  let parsed: ReturnType<typeof parseSkillFrontmatter>;
  try {
    parsed = parseSkillFrontmatter(markdown);
  } catch (error) {
    const code = error instanceof AgentContractError ? error.code : 'SKILL_IMPORT_INVALID';
    return emptySkill(root, files, [`${code}: ${error instanceof Error ? error.message : String(error)}`]);
  }
  warnings.push(...parsed.warnings);

  const directoryName = root === '' ? null : root.split('/').pop()!;
  if (directoryName) {
    const normalizedDirectory = directoryName.replace(/_/g, '-').toLowerCase();
    if (normalizedDirectory !== parsed.frontmatter.name) {
      errors.push(`frontmatter.name=${parsed.frontmatter.name} 与目录名 ${directoryName} 不一致，运行时无法定位。`);
    }
  }

  const body = sanitizeSkillBody(parsed.body);
  if (body.length === 0) errors.push('SKILL.md 正文为空。');
  const secrets = SECRET_PATTERNS.filter(item => item.pattern.test(markdown)).map(item => item.code);
  if (secrets.length > 0) errors.push(`疑似包含密钥：${secrets.join(', ')}；方法包禁止携带任何凭据。`);
  const injection = INJECTION_HINTS.filter(item => item.pattern.test(body)).map(item => item.label);
  if (injection.length > 0) warnings.push(`正文包含高风险指令样式（${injection.join('、')}），请人工确认；编译时正文只会进入低优先级参考区。`);

  const executable = files.filter(file => EXECUTABLE_EXTENSIONS.test(file.path));
  if (executable.length > 0) {
    warnings.push(`方法包包含 ${executable.length} 个可执行脚本文件；Lyra 只保存不执行，也不会挂载到 Prompt。`);
  }
  const binary = files.filter(file => !isTextPath(file.path));
  if (binary.length > 0) warnings.push(`方法包包含 ${binary.length} 个非文本文件，只作为附件保存。`);

  const nodes = parseNodes(parsed.frontmatter, warnings);
  const version = parseVersion(parsed.frontmatter);
  const models = splitList(parsed.frontmatter.metadata.models ?? parsed.frontmatter.extra.models);
  const minContext = parsePositiveInteger(parsed.frontmatter.metadata['min-context-tokens'] ?? parsed.frontmatter.extra['min-context-tokens']);
  const licenseCode = (parsed.frontmatter.license ?? parsed.frontmatter.metadata.license ?? 'unknown').slice(0, 64);
  const commercialUseAllowed = parseBoolean(parsed.frontmatter.metadata['commercial-use'] ?? parsed.frontmatter.extra['commercial-use']);

  const manifestFiles: SkillImportFile[] = files.map(file => ({
    path: file.path, bytes: file.bytes.length, digest: sha256(file.bytes),
  })).sort((left, right) => left.path.localeCompare(right.path));
  const contentDigest = digestOf({ frontmatter: parsed.frontmatter, body });
  const manifestDigest = computeSkillManifestDigest(manifestFiles, contentDigest);

  return {
    rootPath: root,
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    version,
    nodes,
    frontmatter: parsed.frontmatter,
    body,
    markdown,
    files: manifestFiles,
    totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
    contentDigest,
    manifestDigest,
    licenseCode,
    commercialUseAllowed,
    compatibility: { models, minContextTokens: minContext },
    warnings,
    errors,
  };
}

function emptySkill(root: string, files: Array<{ path: string; bytes: Buffer }>, errors: string[]): InspectedSkill {
  const manifestFiles: SkillImportFile[] = files.map(file => ({
    path: file.path, bytes: file.bytes.length, digest: sha256(file.bytes),
  }));
  return {
    rootPath: root, name: '', description: '', version: null, nodes: [],
    frontmatter: {
      name: '', description: '', license: null, compatibility: null, allowedTools: [], metadata: {}, extra: {},
    },
    body: '', markdown: '', files: manifestFiles,
    totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
    contentDigest: digestOf({ error: errors }), manifestDigest: digestOf({ files: manifestFiles }),
    licenseCode: 'unknown', commercialUseAllowed: false,
    compatibility: { models: [], minContextTokens: null },
    warnings: [], errors,
  };
}

function parseNodes(frontmatter: SkillFrontmatter, warnings: string[]): SkillNode[] {
  const raw = frontmatter.metadata.nodes ?? frontmatter.extra.nodes;
  if (!raw) {
    warnings.push('未声明 nodes：导入后不能绑定到任何生产节点，需要管理员在准入时补充。');
    return [];
  }
  const nodes: SkillNode[] = [];
  for (const item of splitList(raw)) {
    try {
      const node = normalizeSkillNode(item);
      if (!nodes.includes(node)) nodes.push(node);
    } catch {
      warnings.push(`忽略不支持的方法节点：${item}（V1 仅支持 script-adaptation/character-image/storyboard/video-prompt）。`);
    }
  }
  return nodes;
}

function parseVersion(frontmatter: SkillFrontmatter): number | null {
  const raw = frontmatter.metadata.version ?? frontmatter.extra.version;
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000 ? value : null;
}

function parseBoolean(raw: string | undefined): boolean {
  if (!raw) return false;
  return /^(?:true|yes|1)$/i.test(raw.trim());
}

function parsePositiveInteger(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[,，]/).map(item => item.trim()).filter(Boolean).slice(0, 32);
}

function isTextPath(path: string): boolean {
  return /\.(?:md|txt|yaml|yml|json|csv|tsv)$/i.test(path) || !/\.\w+$/.test(path);
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
