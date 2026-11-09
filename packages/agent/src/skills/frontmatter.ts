import { AgentContractError, type SkillFrontmatter } from '@lyra/shared';

/**
 * SKILL.md frontmatter 解析。
 *
 * 只支持方法包真实使用的 YAML 子集：顶层标量、一层 `metadata` 映射、
 * 行内数组与 `|` / `>` 块标量。序列、锚点、标签和复杂合并一律拒绝，
 * 避免“解析器以为读懂了、运行时却按另一套语义编译”。
 */

export interface SplitFrontmatter {
  matched: boolean;
  body: string;
  raw: string | null;
  warnings: string[];
}

export type YamlValue = string | Map<string, YamlValue>;

const MAX_FRONTMATTER_CHARS = 16_384;
const MAX_NESTING = 4;

export function splitFrontmatter(markdown: string): SplitFrontmatter {
  let text = markdown;
  const warnings: string[] = [];
  if (text.startsWith('\uFEFF')) {
    text = text.slice(1);
    warnings.push('已移除 UTF-8 BOM。');
  }
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.startsWith('---\n')) {
    return { matched: false, body: text, raw: null, warnings };
  }
  const end = text.indexOf('\n---', 4);
  if (end < 0) throw new AgentContractError(400, 'SKILL_FRONTMATTER_UNCLOSED', 'SKILL.md frontmatter 没有结束标记。');
  const after = text.slice(end + 4);
  const bodyStart = after.startsWith('\n') ? end + 5 : end + 4;
  const raw = text.slice(4, end).replace(/\n$/, '');
  if ([...raw].length > MAX_FRONTMATTER_CHARS) {
    throw new AgentContractError(413, 'SKILL_FRONTMATTER_TOO_LARGE', 'SKILL.md frontmatter 超过 16384 个字符上限。');
  }
  return { matched: true, body: text.slice(bodyStart), raw, warnings };
}

export function parseYamlMapping(raw: string): Map<string, YamlValue> {
  const lines = raw.split('\n');
  const parsed = parseBlock(lines, 0, 0, 0);
  if (parsed.next < lines.length && firstContent(lines, parsed.next) !== null) {
    throw yamlError('frontmatter 存在无法归属的缩进内容');
  }
  return parsed.map;
}

export function parseSkillFrontmatter(markdown: string): {
  frontmatter: SkillFrontmatter;
  body: string;
  warnings: string[];
} {
  const split = splitFrontmatter(markdown);
  const warnings = [...split.warnings];
  if (!split.matched || split.raw === null) {
    throw new AgentContractError(400, 'SKILL_FRONTMATTER_REQUIRED', 'SKILL.md 必须以 YAML frontmatter 开头。');
  }
  const map = parseYamlMapping(split.raw);
  const name = requiredScalar(map, 'name', 64);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new AgentContractError(400, 'SKILL_NAME_INVALID', 'frontmatter.name 只能包含小写字母、数字和非连续短横线，最长 64 位。');
  }
  const description = requiredScalar(map, 'description', 1024);
  const license = optionalScalar(map, 'license');
  const compatibility = optionalScalar(map, 'compatibility', 500);
  const allowedToolsRaw = optionalScalar(map, 'allowed-tools');
  const allowedTools = allowedToolsRaw
    ? allowedToolsRaw.split(',').map(item => item.trim()).filter(Boolean).slice(0, 64)
    : [];
  if (allowedTools.length > 0) warnings.push('allowed-tools 只作说明保存，不会自动授予任何工具权限。');

  const metadata = new Map<string, string>();
  const metadataValue = map.get('metadata');
  if (metadataValue instanceof Map) {
    for (const [key, value] of metadataValue) {
      if (value instanceof Map) throw new AgentContractError(400, 'SKILL_METADATA_INVALID', 'frontmatter.metadata 必须是字符串键值映射。');
      metadata.set(key, value);
    }
  } else if (metadataValue !== undefined) {
    throw new AgentContractError(400, 'SKILL_METADATA_INVALID', 'frontmatter.metadata 必须是映射。');
  }

  const extra: Record<string, string> = {};
  const standard = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
  for (const [key, value] of map) {
    if (standard.has(key)) continue;
    if (value instanceof Map) {
      warnings.push(`非标准嵌套字段 ${key} 已忽略。`);
      continue;
    }
    extra[key] = value;
    warnings.push(`将原样保留非标准 frontmatter 字段：${key}`);
  }

  const body = split.body.replace(/^\n/, '');
  if (body.trim() === '') throw new AgentContractError(400, 'SKILL_BODY_REQUIRED', 'SKILL.md 正文不能为空。');
  if (markdown.split('\n').length > 500) warnings.push('SKILL.md 超过 500 行，建议拆分到 references/。');

  return {
    frontmatter: {
      name, description,
      license: license ?? null,
      compatibility: compatibility ?? null,
      allowedTools,
      metadata: Object.fromEntries(metadata),
      extra,
    },
    body,
    warnings,
  };
}

interface ParsedBlock { map: Map<string, YamlValue>; next: number }

function parseBlock(lines: string[], start: number, indent: number, depth: number): ParsedBlock {
  if (depth > MAX_NESTING) throw yamlError('frontmatter 嵌套超过 4 层');
  const map = new Map<string, YamlValue>();
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) { index += 1; continue; }
    if (trimmed === '---' || trimmed === '...') break;
    if (line.includes('\t') && line.slice(0, line.length - line.trimStart().length).includes('\t')) {
      throw yamlError('frontmatter 不能使用 Tab 缩进');
    }
    const indentation = line.length - line.trimStart().length;
    if (indentation < indent) break;
    if (indentation > indent) throw yamlError(`缩进不一致：${trimmed.slice(0, 40)}`);
    const match = /^([A-Za-z0-9_-]+):(?:[ ]+(.*))?$/.exec(trimmed);
    if (!match) throw yamlError(`无法解析的行：${trimmed.slice(0, 60) || '(blank)'}`);
    const key = match[1]!;
    if (map.has(key)) throw yamlError(`重复的键：${key}`);
    const rawValue = match[2];

    if (rawValue === undefined || rawValue === '') {
      const child = nextContent(lines, index + 1);
      if (child === null || child.indent <= indentation) {
        map.set(key, new Map());
        index += 1;
      } else {
        const nested = parseBlock(lines, child.index, child.indent, depth + 1);
        map.set(key, nested.map);
        index = nested.next;
      }
      continue;
    }

    if (/^[|>][+-]?$/.test(rawValue.trim())) {
      const folded = rawValue.trim().startsWith('>');
      const block = parseBlockScalar(lines, index + 1, indentation);
      map.set(key, folded
        ? block.text.split('\n').map(line => line.trim()).join(' ').trim()
        : block.text);
      index = block.next;
      continue;
    }

    if (rawValue.trim() === '[]') { map.set(key, ''); index += 1; continue; }
    map.set(key, parseScalar(rawValue));
    index += 1;
  }
  return { map, next: index };
}

function parseBlockScalar(lines: string[], start: number, parentIndent: number): { text: string; next: number } {
  const collected: string[] = [];
  let index = start;
  let contentIndent: number | null = null;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === '') { collected.push(''); index += 1; continue; }
    const indentation = line.length - line.trimStart().length;
    if (indentation <= parentIndent) break;
    if (contentIndent === null) contentIndent = indentation;
    collected.push(line.slice(Math.min(contentIndent, indentation)));
    index += 1;
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
  return { text: collected.join('\n'), next: index };
}

function nextContent(lines: string[], start: number): { index: number; indent: number } | null {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed === '---' || trimmed === '...') return null;
    return { index, indent: line.length - line.trimStart().length };
  }
  return null;
}

function firstContent(lines: string[], start: number): { index: number; indent: number } | null {
  return nextContent(lines, start);
}

function parseScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw yamlError('单引号标量没有闭合');
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) throw yamlError('双引号标量没有闭合');
    const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
    return value.slice(1, -1).replace(/\\(.)/g, (_match, code: string) => escapes[code] ?? code);
  }
  if (value.startsWith('[') || value.startsWith('{')) throw yamlError('frontmatter 不支持内联集合语法');
  if (value.startsWith('&') || value.startsWith('*') || value.startsWith('!')) throw yamlError('frontmatter 不支持锚点、别名或标签');
  const hash = value.indexOf(' #');
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}

function requiredScalar(map: Map<string, YamlValue>, key: string, maxLength: number): string {
  const value = map.get(key);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgentContractError(400, 'SKILL_FRONTMATTER_FIELD_REQUIRED', `frontmatter.${key} 不能为空。`);
  }
  const text = value.trim();
  if ([...text].length > maxLength) {
    throw new AgentContractError(400, 'SKILL_FRONTMATTER_FIELD_TOO_LONG', `frontmatter.${key} 不能超过 ${maxLength} 个字符。`);
  }
  return text;
}

function optionalScalar(map: Map<string, YamlValue>, key: string, maxLength = 1024): string | null {
  const value = map.get(key);
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new AgentContractError(400, 'SKILL_FRONTMATTER_FIELD_INVALID', `frontmatter.${key} 必须是字符串。`);
  const text = value.trim();
  if (text === '') return null;
  if ([...text].length > maxLength) {
    throw new AgentContractError(400, 'SKILL_FRONTMATTER_FIELD_TOO_LONG', `frontmatter.${key} 不能超过 ${maxLength} 个字符。`);
  }
  return text;
}

function yamlError(message: string): AgentContractError {
  return new AgentContractError(400, 'SKILL_FRONTMATTER_INVALID', message);
}
