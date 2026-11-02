/**
 * 导出该次生产运行已落库的抽帧报告供本地剪辑使用。
 * 用法：node --env-file=.env scripts/assess-shots.mjs <productionRunId> <storyboardRevisionId> [reportPath]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Client } from 'pg';

const [runId, storyboardId, reportPath = 'outputs/private/deliverables/frame-assessment.json'] = process.argv.slice(2);
if (!/^production_[0-9a-f]{32}$/u.test(runId ?? '') || !/^storyboard_[0-9a-f]{32}$/u.test(storyboardId ?? '')) {
  throw new Error('用法：node --env-file=.env scripts/assess-shots.mjs <productionRunId> <storyboardRevisionId> [reportPath]');
}

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const row = (await db.query('SELECT run_json FROM production_runs WHERE id = $1', [runId])).rows[0];
  if (!row) throw new Error('生产运行不存在');
  const run = typeof row.run_json === 'string' ? JSON.parse(row.run_json) : row.run_json;
  const current = run.artifacts.filter(artifact => artifact.status === 'current');
  const board = current.filter(artifact => Array.isArray(artifact.metadata.shots) && artifact.metadata.storyboardRevisionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  if (board?.metadata.storyboardRevisionId !== storyboardId) throw new Error('该运行当前采用的分镜版本不匹配。');
  const artifact = current.filter(item => item.metadata.key === 'frame-review').at(-1);
  if (!artifact) throw new Error('该运行还没有可导出的抽帧报告。请查看自动制片页的镜头评估状态及预算。');
  const { shots, summary } = artifact.metadata;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ runId, storyboardId, shots, summary, generatedAt: artifact.createdAt }, null, 2));
  console.log(`已导出 ${shots.length} 个已评估镜头至 ${reportPath}`);
} finally {
  await db.end();
}
