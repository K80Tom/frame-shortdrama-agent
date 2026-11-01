/**
 * 一次性脚本：对生产 run 的 22 个镜头做抽帧质量评估，产出剪辑建议报告。
 * 用法：node --env-file=.env scripts/assess-shots.mjs <productionRunId> <storyboardRevisionId> [reportPath]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Client } from 'pg';
import { BoundedProcessRunner, FfprobeVideoProber, FrameAssessor, ProductionMediaStore } from '../dist/production-media/index.js';

const [runId, storyboardId, reportArg] = process.argv.slice(2);
if (!/^production_[0-9a-f]{32}$/u.test(runId ?? '') || !/^storyboard_[0-9a-f]{32}$/u.test(storyboardId ?? '')) {
  throw new Error('用法：node --env-file=.env scripts/assess-shots.mjs <productionRunId> <storyboardRevisionId> [reportPath]');
}
const REPORT_PATH = reportArg || 'outputs/private/deliverables/frame-assessment.json';

const connections = JSON.parse(await readFile('outputs/private/model-connections.json', 'utf8'));
const assignment = connections.assignments?.general;
const profile = connections.profiles.find(item => item.id === assignment?.profileId);
if (!profile) throw new Error('general 模型连接未配置');

const judge = {
  call: async input => {
    const messages = input.messages.map(message => typeof message.content === 'string' ? message : {
      role: message.role,
      content: message.content.map(part => part.type === 'text' ? { type: 'text', text: part.text }
        : { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` } }),
    });
    const response = await fetch(profile.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
      body: JSON.stringify({ model: profile.model, messages, max_tokens: 1024 }),
    });
    if (!response.ok) throw new Error(`vision call failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('vision call returned no text');
    return { text };
  },
};

const runner = new BoundedProcessRunner();
const store = new ProductionMediaStore(resolve('outputs/private/production-media'), new FfprobeVideoProber(runner));
await store.initialize();
const assessor = new FrameAssessor(store, runner, judge);

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const runRow = (await db.query('SELECT run_json FROM production_runs WHERE id = $1', [runId])).rows[0];
if (!runRow) throw new Error('生产运行不存在');
const run = typeof runRow.run_json === 'string' ? JSON.parse(runRow.run_json) : runRow.run_json;
const boardRow = (await db.query('SELECT content_json FROM storyboard_revisions WHERE id = $1', [storyboardId])).rows[0];
if (!boardRow) throw new Error('分镜版本不存在');
const board = typeof boardRow.content_json === 'string' ? JSON.parse(boardRow.content_json) : boardRow.content_json;
await db.end();

const shotsById = new Map(board.shots.map(shot => [shot.id, shot]));
const inputs = run.artifacts
  .filter(artifact => artifact.metadata?.key === 'shot-video' && artifact.status === 'current' && artifact.metadata.mediaId)
  .map(artifact => ({
    shotId: artifact.metadata.shotId,
    mediaId: artifact.metadata.mediaId,
    label: `镜 ${shotsById.get(artifact.metadata.shotId)?.order ?? '?'}`,
    hint: shotsById.get(artifact.metadata.shotId)?.design?.visualDescription ?? '',
  }))
  .sort((left, right) => (shotsById.get(left.shotId)?.order ?? 0) - (shotsById.get(right.shotId)?.order ?? 0));

console.log(`评估 ${inputs.length} 个镜头…`);
const started = Date.now();
const report = await assessor.assess(inputs);
report.runId = run.id;
report.generatedAt = new Date().toISOString();
report.model = profile.model;

await mkdir(dirname(REPORT_PATH), { recursive: true });
await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
console.log(`完成，用时 ${((Date.now() - started) / 1000).toFixed(0)}s -> ${REPORT_PATH}`);
console.log('summary:', JSON.stringify(report.summary));
for (const shot of report.shots) {
  const order = shotsById.get(shot.shotId)?.order ?? '?';
  console.log(`镜${order} ${shot.verdict.padEnd(6)} 外貌${shot.scores.identity} 形体${shot.scores.anatomy} 动作${shot.scores.action} 画质${shot.scores.quality} | ${shot.advice.action}${shot.advice.trimSeconds ? `(${shot.advice.trimSeconds}s)` : ''}${shot.advice.speedFactor > 1 ? `(x${shot.advice.speedFactor})` : ''} | ${(shot.issues[0] || '').slice(0, 40)}`);
}
