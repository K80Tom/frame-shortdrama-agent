import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

try {
  const [path, format = 'json', ...extra] = process.argv.slice(2);
  if (!path || !['json', 'markdown'].includes(format) || extra.length) throw new Error('input');
  const chunks = [];
  let length = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    length += chunk.length;
    if (length > 8 * 1024 * 1024) throw new Error('limit');
    chunks.push(chunk);
  }
  const { compareOfflineEvaluations, offlineComparisonExitCode, offlineComparisonMarkdown } =
    require('../dist/evaluation/compare.js');
  const report = compareOfflineEvaluations(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  process.stdout.write(format === 'json' ? JSON.stringify(report, null, 2) + '\n' : offlineComparisonMarkdown(report));
  process.exitCode = offlineComparisonExitCode(report);
} catch {
  // 不输出解析输入、个人路径、凭据或原始异常；退出 2 表示契约/读取失败。
  console.error('离线比较失败：请检查输入契约、8 MiB 上限与构建状态。用法：node scripts/evaluation-gate.mjs input.json [json|markdown]');
  process.exitCode = 2;
}
