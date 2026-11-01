#!/usr/bin/env node
/**
 * OHAO CLI —— main 的命令行客户端。
 *
 * 边界：只通过 HTTP 调用 main，不连接数据库、不读取模型密钥。
 * 付费纪律：run create 只生成并保存"生产计划"（不提交、不扣费）；
 * 只有用户再执行 run submit 才把同一份冻结请求提交给 main，重复提交由 clientRequestId 幂等。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseCreateProductionRun, type CreateProductionRun } from '@ohao/shared';

const DEFAULT_API = process.env.OHAO_API ?? 'http://127.0.0.1:8788';
const PENDING_FILE = join(homedir(), '.ohao', 'pending-run.json');

interface Flags { [key: string]: string | boolean; }

function parseArgs(argv: string[]): { path: string[]; flags: Flags; json: boolean } {
  const path: string[] = [];
  const flags: Flags = {};
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--json') { json = true; continue; }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1; } else flags[key] = true;
      continue;
    }
    path.push(token);
  }
  return { path, flags, json };
}

function apiBase(flags: Flags): string {
  return String(flags.api ?? DEFAULT_API).replace(/\/+$/, '');
}

async function request<T>(method: string, path: string, flags: Flags, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase(flags)}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'X-Shortdrama-Call': '1' }),
        ...(process.env.OHAO_TOKEN ? { authorization: `Bearer ${process.env.OHAO_TOKEN}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error(`无法连接 OHAO 后端 ${apiBase(flags)}。请先启动 packages/main（npm run dev），或用 --api / OHAO_API 指定地址。`);
  }
  const text = await response.text();
  let payload: unknown = undefined;
  try { payload = text === '' ? undefined : JSON.parse(text); } catch { payload = { error: { message: '服务返回了非 JSON 响应。' } }; }
  if (!response.ok) {
    const message = (payload as { error?: { message?: string } } | undefined)?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

function print(data: unknown, json: boolean, human: () => void): void {
  if (json) { console.log(JSON.stringify(data, null, 2)); return; }
  human();
}

function money(micros: number): string { return `${(micros / 1000000).toFixed(2)} 元`; }

function budgetFromFlags(flags: Flags): number {
  const raw = String(flags.budget ?? '30');
  const yuan = Number(raw);
  if (!Number.isFinite(yuan) || yuan <= 0 || yuan > 10000) throw new Error('--budget 必须是 0～10000 之间的数字（单位：元）。');
  return Math.round(yuan * 1000000);
}

function buildRunRequest(flags: Flags): CreateProductionRun {
  const projectId = String(flags.project ?? '');
  const scriptVersionId = String(flags['script-version'] ?? '');
  if (!projectId || !scriptVersionId) throw new Error('run create 需要 --project <projectId> 和 --script-version <scriptVersionId>。');
  const gacha = flags.gacha === true;
  const candidateLimit = Number(flags.candidates ?? (gacha ? 2 : 1));
  return parseCreateProductionRun({
    projectId,
    scriptVersionId,
    ratio: String(flags.ratio ?? '9:16'),
    targetDurationSec: Number(flags.duration ?? 60),
    visualStyle: String(flags.style ?? '电影感写实'),
    qualityPreset: String(flags.quality ?? 'balanced'),
    automationMode: String(flags.mode ?? 'auto'),
    candidatePolicy: gacha ? 'gacha' : 'direct',
    candidateLimit,
    directorPolicy: 'auto',
    budgetMicros: budgetFromFlags(flags),
    currency: 'CNY',
    allowPaid: true,
    clientRequestId: `cli_${randomUUID()}`,
  });
}

function savePending(requestBody: CreateProductionRun): void {
  mkdirSync(join(homedir(), '.ohao'), { recursive: true });
  writeFileSync(PENDING_FILE, JSON.stringify(requestBody, null, 2), { mode: 0o600 });
}

function loadPending(): CreateProductionRun {
  if (!existsSync(PENDING_FILE)) throw new Error('没有待提交的生产计划。先用 ohao run create 生成计划。');
  const raw = readFileSync(PENDING_FILE, 'utf8');
  return parseCreateProductionRun(JSON.parse(raw));
}

const HELP = `OHAO CLI（只调用 main API；付费需先 create 计划、再 submit 确认）

用法：
  ohao doctor [--json]                       后端连通性与模型可用性
  ohao project list [--json]                 项目列表
  ohao project get <projectId> [--json]      项目详情
  ohao run get <runId> [--json]              制片运行状态与阻断原因
  ohao run create --project <id> --script-version <id> [选项]
                                             生成生产计划（不提交、不扣费）
  ohao run submit [--json]                   确认并提交上一次 create 的计划
  ohao run cancel                            丢弃待提交计划

run create 选项：
  --duration <秒>      目标时长，默认 60        --ratio <9:16|16:9>   画幅
  --quality <fast|balanced|quality>            质量档位，默认 balanced
  --mode <auto|checkpoints|coDirector>         自动化模式，默认 auto
  --style <视觉风格>                            默认 电影感写实
  --budget <元>        本次预算上限，默认 30     --gacha --candidates <1-4>  多候选

全局：--api <地址> 或 OHAO_API（默认 ${DEFAULT_API}）；OHAO_TOKEN 可附加访问令牌。

示例：
  ohao run create --project proj_1 --script-version sv_3 --duration 60 --budget 30
  ohao run submit
`;

async function main(): Promise<void> {
  const { path, flags, json } = parseArgs(process.argv.slice(2));
  const [group, action, id] = path;
  if (!group || flags.help === true) { console.log(HELP); return; }

  if (group === 'doctor') {
    const health = await request<{ status: string }>('GET', '/healthz', flags);
    const models = await request<{ models?: unknown[] }>('GET', '/api/models', flags);
    print({ health, models }, json, () => {
      console.log(`后端：${apiBase(flags)} 状态 ${health.status}`);
      const list = Array.isArray(models) ? models : (models as { models?: unknown[] }).models ?? [];
      console.log(`模型配置：${Array.isArray(list) ? list.length : 0} 条（仅列出本机可见配置，不含密钥）`);
    });
    return;
  }

  if (group === 'project') {
    if (action === 'list') {
      const data = await request<unknown>('GET', '/api/projects', flags);
      print(data, json, () => console.log(JSON.stringify(data, null, 2)));
      return;
    }
    if (action === 'get' && id) {
      const data = await request<unknown>('GET', `/api/projects/${encodeURIComponent(id)}`, flags);
      print(data, json, () => console.log(JSON.stringify(data, null, 2)));
      return;
    }
  }

  if (group === 'run') {
    if (action === 'get' && id) {
      const data = await request<Record<string, unknown>>('GET', `/api/production-runs/${encodeURIComponent(id)}`, flags);
      print(data, json, () => {
        const run = (data as { run?: Record<string, unknown> }).run ?? data;
        console.log(JSON.stringify(run, null, 2));
        const reason = (run as { blockingReason?: { message?: string } }).blockingReason;
        if (reason?.message) console.log(`\n阻断原因：${reason.message}`);
      });
      return;
    }
    if (action === 'create') {
      const plan = buildRunRequest(flags);
      savePending(plan);
      console.log('已生成生产计划，尚未提交、不会扣费：');
      console.log(JSON.stringify(plan, null, 2));
      console.log(`\n预算上限：${money(plan.budgetMicros)}（实际成本由 main 按任务预算流水结算，提交即授权在本次预算内付费）`);
      console.log(`请求已冻结到 ${PENDING_FILE}`);
      console.log('确认无误后执行：ohao run submit　　放弃：ohao run cancel');
      return;
    }
    if (action === 'submit') {
      const plan = loadPending();
      const result = await request<Record<string, unknown>>('POST', '/api/production-runs', flags, plan);
      rmSync(PENDING_FILE, { force: true });
      print(result, json, () => {
        const run = (result as { run?: { id?: string; status?: string } }).run;
        console.log(`已提交生产运行：${run?.id ?? JSON.stringify(result)}`);
        console.log(`状态：${run?.status ?? 'unknown'}　　跟踪：ohao run get ${run?.id ?? '<runId>'}`);
      });
      return;
    }
    if (action === 'cancel') {
      rmSync(PENDING_FILE, { force: true });
      console.log('已丢弃待提交计划，未产生任何费用。');
      return;
    }
  }

  console.error(`未识别的命令：${path.join(' ')}\n`);
  console.log(HELP);
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(`错误：${error instanceof Error ? error.message : '未知错误'}`);
  process.exitCode = 1;
});
