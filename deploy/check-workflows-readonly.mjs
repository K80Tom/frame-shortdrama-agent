#!/usr/bin/env node
// 仓库级「Actions 纯只读」静态门禁。
//
// 规则来源：AGENTS.md 要求 GitHub Actions 只做只读 CI 门禁，严禁持有写权限、
// 模型密钥或自动合并能力。本脚本扫描 .github/workflows/**，发现下列任一情况即失败：
//   1. 顶层未声明 permissions（否则会继承仓库默认 token 权限）；
//   2. 任意 write 权限（含 write-all、内联 map）；
//   3. GitHub CLI 写操作（gh pr merge / gh release / gh api -X POST 等）；
//   4. 等价发布行为（action-gh-release、镜像 push、npm publish、git push 等）。
//
// 用法：node deploy/check-workflows-readonly.mjs
// 退出码：0 = 全部只读；1 = 发现违规或无法读取工作流目录。

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WORKFLOW_FILE = /^[a-z0-9._-]+\.(?:yml|yaml)$/i;
const TOP_LEVEL_PERMISSIONS = /^permissions\s*:/;
const WRITE_ALL = /^[ \t]*permissions[ \t]*:[ \t]*["']?(?:write|write-all)["']?[ \t]*(?:#.*)?$/i;
const WRITE_SCOPE = /^[ \t]*["']?([a-z][a-z0-9-]*)["']?[ \t]*:[ \t]*["']?write["']?[ \t]*(?:#.*)?$/i;
const PERMISSIONS_INLINE = /^[ \t]*permissions[ \t]*:[ \t]*\{([^}]*)\}[ \t]*(?:#.*)?$/i;

const GH_WRITE_PATTERNS = [
  /\bgh\s+pr\s+(?:merge|close|reopen|edit|create|comment|review|ready)\b/i,
  /\bgh\s+release\b/i,
  /\bgh\s+workflow\s+run\b/i,
  /\bgh\s+(?:secret|variable)\s+(?:set|delete)\b/i,
  /\bgh\s+repo\s+(?:edit|delete|rename|archive)\b/i,
  /\bgh\s+(?:issue|label|milestone)\s+(?:create|close|edit|delete|comment)\b/i,
];

const PUBLISH_PATTERNS = [
  { pattern: /\baction-gh-release\b/i, rule: 'publish-action', message: '禁止在 Actions 中创建 GitHub Release' },
  { pattern: /\bdocker\/login-action\b/i, rule: 'publish-action', message: '禁止在 Actions 中登录镜像仓库' },
  { pattern: /\bdocker\s+push\b/i, rule: 'publish-action', message: '禁止在 Actions 中推送镜像' },
  { pattern: /\bnpm\s+publish\b/i, rule: 'publish-action', message: '禁止在 Actions 中发布 npm 包' },
  { pattern: /\btwine\s+upload\b/i, rule: 'publish-action', message: '禁止在 Actions 中上传 Python 包' },
  { pattern: /\bgit\s+push\b/i, rule: 'git-push', message: '禁止在 Actions 中向仓库推送提交或标签' },
];

/** 去掉 YAML 行注释；`#` 只在行首或空白之后视为注释。 */
function codeOf(line) {
  const index = line.indexOf('#');
  if (index === -1) return line;
  if (index === 0 || /\s/.test(line[index - 1])) return line.slice(0, index);
  return line;
}

function firstLineOf(source, pattern) {
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(codeOf(lines[index]))) return index + 1;
  }
  return 1;
}

/**
 * 扫描单个工作流文本，返回违规清单。
 * @param {string} source YAML 文本
 * @param {string} file 用于报告的文件名
 * @returns {{file: string, line: number, rule: string, message: string}[]}
 */
export function scanWorkflowSource(source, file = '<inline>') {
  const violations = [];
  const lines = source.split(/\r?\n/);
  let hasTopLevelPermissions = false;

  const report = (line, rule, message) => violations.push({ file, line, rule, message });
  let permissionsIndent = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const code = codeOf(raw);
    const line = index + 1;
    const indent = (code.match(/^[ \t]*/) ?? [''])[0].length;

    if (TOP_LEVEL_PERMISSIONS.test(raw)) hasTopLevelPermissions = true;

    if (WRITE_ALL.test(code)) {
      report(line, 'permission-write', '禁止声明 permissions: write 或 write-all');
      permissionsIndent = null;
      continue;
    }

    if (/^[ \t]*["']?permissions["']?[ \t]*:/.test(code)) {
      const inline = PERMISSIONS_INLINE.exec(code);
      if (inline) {
        permissionsIndent = null;
        if (/[a-z][a-z0-9-]*[ \t]*:[ \t]*["']?write\b/i.test(inline[1])) {
          report(line, 'permission-write', '禁止在 permissions 内联映射中声明写权限');
        }
      } else {
        permissionsIndent = indent;
      }
      continue;
    }

    if (permissionsIndent !== null) {
      if (code.trim() === '') continue;
      if (indent > permissionsIndent) {
        const scope = WRITE_SCOPE.exec(code);
        if (scope) {
          report(line, 'permission-write', `禁止声明写权限 ${scope[1]}: write`);
        }
        continue;
      }
      permissionsIndent = null;
    }

    if (GH_WRITE_PATTERNS.some(pattern => pattern.test(code))) {
      report(line, 'gh-write', '禁止在 Actions 中调用 GitHub CLI 写操作');
      continue;
    }

    if (/\bgh\s+api\b/i.test(code)) {
      const writeMethod = /(?:-X|--method)(?:\s+|=)(?:POST|PATCH|PUT|DELETE)\b/i.test(code);
      const bodyFlag = /(?:^|\s)(?:-f|-F|--field|--raw-field)(?:\s+|=)/i.test(code);
      if (writeMethod || bodyFlag) {
        report(line, 'gh-write', '禁止在 Actions 中通过 gh api 发起写请求');
        continue;
      }
    }

    let publishReported = false;
    for (const { pattern, rule, message } of PUBLISH_PATTERNS) {
      if (pattern.test(code)) {
        report(line, rule, message);
        publishReported = true;
        break;
      }
    }
    if (publishReported) continue;
  }

  if (/docker\/build-push-action/i.test(source) && /^[ \t]*push[ \t]*:[ \t]*true/im.test(source)) {
    report(firstLineOf(source, /docker\/build-push-action/i), 'publish-action',
      '禁止在 Actions 中构建并推送镜像（docker/build-push-action 且 push: true）');
  }

  if (!hasTopLevelPermissions) {
    report(1, 'missing-permissions',
      '每个工作流必须显式声明顶层 permissions（例如 permissions: contents: read）');
  }

  return violations;
}

/**
 * 递归收集工作流目录下的 YAML 文件（返回相对路径）。
 * @param {string} directory
 * @param {string} [base]
 * @returns {string[]}
 */
function collectWorkflowFiles(directory, base = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectWorkflowFiles(absolute, base));
    } else if (entry.isFile() && WORKFLOW_FILE.test(entry.name)) {
      files.push(relative(base, absolute));
    }
  }
  return files.sort();
}

/**
 * 扫描工作流目录。
 * @param {string} directory
 * @returns {{files: string[], violations: object[]}}
 */
export function checkWorkflows(directory) {
  const files = collectWorkflowFiles(directory);
  const violations = [];
  for (const name of files) {
    const source = readFileSync(join(directory, name), 'utf8');
    violations.push(...scanWorkflowSource(source, name));
  }
  return { files, violations };
}

function formatViolation(violation) {
  return `  ${violation.file}:${violation.line} [${violation.rule}] ${violation.message}`;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const directory = join(resolve(here, '..'), '.github', 'workflows');

  let result;
  try {
    result = checkWorkflows(directory);
  } catch (error) {
    console.error(`::error title=Actions read-only gate::无法读取工作流目录 ${directory}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (result.violations.length > 0) {
    console.error('::error title=Actions read-only gate::检测到 GitHub Actions 写权限或等价发布行为');
    console.error(`违规 ${result.violations.length} 处：`);
    for (const violation of result.violations) console.error(formatViolation(violation));
    console.error('修复方式：工作流仅声明 contents: read；发版改走 deploy/build-release-bundle.sh 的离线受控流程。');
    process.exitCode = 1;
    return;
  }

  console.log(`✓ ${result.files.length} 个 GitHub Actions 工作流均为纯只读：${result.files.join(', ')}`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entry === import.meta.url) main();
