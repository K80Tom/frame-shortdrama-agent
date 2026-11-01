/**
 * 一次性脚本：把抽帧评估报告转成剪辑指令，重剪一版成片。
 * 用法：node --env-file=.env scripts/recompose-with-assessment.mjs <productionRunId> [targetSeconds] [reportPath] [title]
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { BoundedProcessRunner, FfprobeVideoProber, ProductionMediaStore, TimelineComposer } from '../dist/production-media/index.js';

const [runId, targetArg, reportArg, titleArg] = process.argv.slice(2);
if (!/^production_[0-9a-f]{32}$/u.test(runId ?? '')) {
  throw new Error('用法：node --env-file=.env scripts/recompose-with-assessment.mjs <productionRunId> [targetSeconds] [reportPath] [title]');
}
const REPORT_PATH = reportArg || 'outputs/private/deliverables/frame-assessment.json';
const targetSeconds = Number(targetArg ?? 60);
if (!Number.isFinite(targetSeconds) || targetSeconds < 5 || targetSeconds > 900) {
  throw new Error('targetSeconds 必须在 5 到 900 之间');
}
const title = titleArg?.trim() || 'Lyra 自动剪辑成片';

const report = JSON.parse(await readFile(REPORT_PATH, 'utf8'));
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const runRow = (await db.query('SELECT run_json FROM production_runs WHERE id = $1', [runId])).rows[0];
if (!runRow) throw new Error('生产运行不存在');
const run = typeof runRow.run_json === 'string' ? JSON.parse(runRow.run_json) : runRow.run_json;
await db.end();
if (report.runId && report.runId !== run.id) throw new Error('评估报告不属于指定生产运行');

const mediaByShot = new Map(run.artifacts
  .filter(a => a.metadata?.key === 'shot-video' && a.status === 'current' && a.metadata.mediaId)
  .map(a => [a.metadata.shotId, a.metadata.mediaId]));

const videoIds = [];
const directives = [];
for (const shot of report.shots) {
  const mediaId = mediaByShot.get(shot.shotId);
  if (!mediaId) { console.log('missing media for', shot.shotId); continue; }
  videoIds.push(mediaId);
  if (shot.advice.action === 'drop') directives.push({ videoId: mediaId, action: 'drop' });
  else if (shot.advice.action === 'trim' && shot.advice.trimSeconds) {
    directives.push({ videoId: mediaId, action: 'trim', trimSeconds: shot.advice.trimSeconds });
  } else if (shot.advice.action === 'speedup' && shot.advice.speedFactor > 1) {
    directives.push({ videoId: mediaId, action: 'speedup', speedFactor: shot.advice.speedFactor });
  }
}
console.log(`镜头 ${videoIds.length} 个，剪辑指令 ${directives.length} 条:`,
  directives.map(d => `${d.action}${d.trimSeconds ? `(${d.trimSeconds}s)` : ''}${d.speedFactor ? `(x${d.speedFactor})` : ''}`).join(' '));

const runner = new BoundedProcessRunner();
const store = new ProductionMediaStore(resolve('outputs/private/production-media'), new FfprobeVideoProber(runner));
const composer = new TimelineComposer(store, runner);
try {
  const manifest = await composer.compose({
    videoIds,
    title,
    edit: { titleCardText: title, titleCardSubtitle: 'AI 自动制作短片 · 抽帧评估剪辑版',
      endCardText: '本片由 AI 流水线自动生成', transitionSeconds: 0.4, targetSeconds, clipDirectives: directives },
  });
  console.log('COMPOSE OK:', manifest.id, '| duration:', manifest.output.probe.durationSeconds);
  console.log('output:', manifest.output.id);
} catch (error) {
  console.log('COMPOSE FAILED:', error.code || error.constructor.name, '|', error.message);
}
