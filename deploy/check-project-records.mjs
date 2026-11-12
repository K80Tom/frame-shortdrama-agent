#!/usr/bin/env node
// 项目记录只读门禁：共享事实与个人本地状态分离。
// 用法：npm run docs:check（直接执行：node deploy/check-project-records.mjs）

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PERSONAL_FILES = ['NOW.local.md', 'MAP.local.md', 'RUNBOOK.local.md'];
export const TEMPLATE_FILES = ['NOW.local.example.md', 'MAP.local.example.md', 'RUNBOOK.local.example.md'];
export const REQUIRED_FILES = [
  'PROJECT_INDEX.md',
  'NOW.md',
  'MAP.md',
  'RUNBOOK.md',
  'DECISIONS.md',
  'RISKS.md',
  ...TEMPLATE_FILES,
  '.gitignore',
];
const MANAGED_DOCS = [
  'PROJECT_INDEX.md',
  'NOW.md',
  'MAP.md',
  'RUNBOOK.md',
  'DECISIONS.md',
  'RISKS.md',
  ...TEMPLATE_FILES,
  'README.md',
  'docs/documentation-index.md',
];
const PERSONAL_STATE_RULES = [
  { rule: 'personal-absolute-path', pattern: /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/])/, message: '共享 NOW/MAP 不得包含个人绝对路径' },
  { rule: 'personal-git-divergence', pattern: /\b(?:ahead|behind)\s+\d+\b/i, message: '个人分支 ahead/behind 状态只写入 NOW.local.md' },
  { rule: 'personal-git-head', pattern: /当前分支\s*(?:\/|：|:|@)/, message: '个人当前分支/HEAD 快照只写入 NOW.local.md' },
  { rule: 'personal-worktree-path', pattern: /\.\.[\\/]lyra-(?!<topic>)/, message: '实际 worktree 路径只写入 MAP.local.md' },
  { rule: 'personal-commit-snapshot', pattern: /\b[\w.-]+@[0-9a-f]{7,40}\b/i, message: '个人 branch@commit 快照只写入 NOW.local.md' },
];

function collectMarkdown(directory, base = directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectMarkdown(absolute, base));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(relative(base, absolute).split(sep).join('/'));
  }
  return files.sort();
}

function contentLines(source, visit) {
  let fenced = false;
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) visit(line, index + 1);
  }
}

function listTrackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function checkIgnore(root, file) {
  const result = spawnSync('git', ['check-ignore', '-q', '--', file], { cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore 无法检查 ${file}（退出码 ${result.status}）`);
  }
  return result.status === 0;
}

function linkTarget(raw) {
  const value = raw.trim();
  if (value.startsWith('<')) {
    const end = value.indexOf('>');
    return end === -1 ? value : value.slice(1, end);
  }
  return value.split(/\s+/)[0] ?? '';
}

function insideRoot(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * @param {string} root 仓库根目录
 * @param {{git?: boolean, trackedFiles?: string[]}} [options]
 */
export function checkProjectRecords(root, options = {}) {
  const violations = [];
  const useGit = options.git !== false;
  const report = (file, line, rule, message) => violations.push({ file, line, rule, message });

  for (const file of REQUIRED_FILES) {
    const absolute = join(root, file);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) report(file, 1, 'missing-file', '缺少必需的项目记录或模板文件');
  }
  if (!existsSync(join(root, 'history')) || !statSync(join(root, 'history')).isDirectory()) {
    report('history/', 1, 'missing-directory', '缺少 history/ 过程归档目录');
  }

  const ignorePath = join(root, '.gitignore');
  const ignoreLines = existsSync(ignorePath)
    ? readFileSync(ignorePath, 'utf8').split(/\r?\n/).map(line => line.trim())
    : [];
  for (const file of PERSONAL_FILES) {
    if (!ignoreLines.includes(`/${file}`)) report('.gitignore', 1, 'missing-ignore', `必须添加根路径忽略规则 /${file}`);
  }

  const trackedFiles = options.trackedFiles ?? (useGit ? listTrackedFiles(root) : []);
  for (const file of trackedFiles) {
    if (file.endsWith('.local.md')) report(file, 1, 'tracked-local-file', '个人 *.local.md 不得被 Git 跟踪；共享模板应命名为 *.local.example.md');
  }
  if (useGit) {
    for (const file of PERSONAL_FILES) {
      if (!checkIgnore(root, file)) report(file, 1, 'not-ignored', '个人记录未被 git check-ignore 识别为忽略文件');
    }
    for (const file of TEMPLATE_FILES) {
      if (existsSync(join(root, file)) && checkIgnore(root, file)) {
        report(file, 1, 'ignored-template', '共享 local 示例模板不得被忽略');
      }
    }
  }

  const indexPath = join(root, 'PROJECT_INDEX.md');
  if (existsSync(indexPath)) {
    const size = Buffer.byteLength(readFileSync(indexPath, 'utf8'), 'utf8');
    if (size < 2048 || size > 4096) report('PROJECT_INDEX.md', 1, 'index-size', `项目索引应保持约 2–4 KiB，当前为 ${size} 字节`);
  }

  for (const file of ['NOW.md', 'MAP.md']) {
    const absolute = join(root, file);
    if (!existsSync(absolute)) continue;
    contentLines(readFileSync(absolute, 'utf8'), (line, number) => {
      for (const item of PERSONAL_STATE_RULES) {
        if (item.pattern.test(line)) report(file, number, item.rule, item.message);
      }
    });
  }

  const documents = new Set(MANAGED_DOCS.filter(file => existsSync(join(root, file))));
  for (const file of collectMarkdown(join(root, 'history'))) documents.add(`history/${file}`);
  let checkedLinks = 0;

  for (const file of [...documents].sort()) {
    const absolute = join(root, file);
    const source = readFileSync(absolute, 'utf8');
    source.split(/\r?\n/).forEach((line, index) => {
      if (line.endsWith(' ') || line.endsWith('\t')) report(file, index + 1, 'trailing-whitespace', '删除行尾空白');
    });

    contentLines(source, (line, number) => {
      const pattern = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
      for (const match of line.matchAll(pattern)) {
        let target = linkTarget(match[1]);
        if (!target || target.startsWith('#') || /^(?:https?:|mailto:)/i.test(target) || target.startsWith('//')) continue;
        target = target.split('#', 1)[0];
        if (!target) continue;
        try {
          target = decodeURIComponent(target);
        } catch {
          report(file, number, 'invalid-link-encoding', `本地链接编码无效：${target}`);
          continue;
        }
        checkedLinks += 1;
        if (isAbsolute(target)) {
          report(file, number, 'absolute-local-link', `共享文档不得使用本机绝对链接：${target}`);
          continue;
        }
        const resolved = resolve(dirname(absolute), target);
        if (!insideRoot(root, resolved)) {
          report(file, number, 'outside-repository-link', `本地链接不得指向仓库外：${target}`);
        } else if (!existsSync(resolved)) {
          report(file, number, 'missing-link', `本地链接目标不存在：${target}`);
        }
      }
    });
  }

  return { files: documents.size, checkedLinks, violations };
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const result = checkProjectRecords(root);
    if (result.violations.length > 0) {
      console.error(`::error title=Project records gate::发现 ${result.violations.length} 个项目记录问题`);
      for (const item of result.violations) {
        console.error(`  ${item.file}:${item.line} [${item.rule}] ${item.message}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`✓ 项目记录检查通过：${result.files} 份文档，${result.checkedLinks} 个本地链接；个人文件未跟踪且忽略规则有效。`);
  } catch (error) {
    console.error(`::error title=Project records gate::${error.message}`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entry === import.meta.url) main();
