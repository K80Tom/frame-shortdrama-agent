// 录制「自进化」页面展示视频（README 用）。
// 前置：本地后端 8788 与前端 5173 均在运行，Chrome 已安装。
// 用法：node scripts/evolution-record.mjs [输出.webm]
import { chromium } from 'playwright';

const out = process.argv[2] ?? '/tmp/evolution-raw.webm';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  recordVideo: { dir: '/tmp/evolution-video', size: { width: 1600, height: 900 } },
});
const page = await context.newPage();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function glide(pixels, step = 90, gap = 45) {
  let remaining = pixels;
  while (remaining > 0) { const delta = Math.min(step, remaining); await page.mouse.wheel(0, delta); remaining -= delta; await sleep(gap); }
}

// 1) 首页 → 侧边栏「自进化」
await page.goto('http://127.0.0.1:5173/#/studio', { waitUntil: 'networkidle' });
await sleep(1400);
const nav = page.locator('nav[aria-label="创作工具"] a', { hasText: '自进化' });
await nav.hover(); await sleep(650);
await nav.click();
await page.waitForSelector('.ev-card', { timeout: 15000 });
await sleep(1500);

// 2) 闭环 + 统计卡
await page.locator('.ev-loop-node.is-goal').hover(); await sleep(900);
await glide(560); await sleep(1200);

// 3) 运行阶梯：逐段滚动并悬停突破行
const deep = page.locator('.ev-step.is-breakthrough').last();
await deep.scrollIntoViewIfNeeded();
await glide(420); await sleep(700);
await deep.hover(); await sleep(1400);
await glide(520); await sleep(900);

// 4) 问题台账：悬停预算不足行
await page.locator('.ev-table tbody tr').nth(6).hover(); await sleep(1200);
await glide(640); await sleep(1000);
await page.locator('.ev-table tbody tr').nth(7).hover(); await sleep(900);

// 5) 规则版本 + 页脚
await glide(620); await sleep(1300);

// 6) 跳到当前运行收尾
const current = page.locator('.ev-foot button', { hasText: '查看当前运行' });
if (await current.count() > 0) { await current.click(); await sleep(2600); }

await context.close();
await browser.close();
const fs = await import('node:fs');
const files = fs.readdirSync('/tmp/evolution-video').filter(name => name.endsWith('.webm')).map(name => ({ name, mtime: fs.statSync(`/tmp/evolution-video/${name}`).mtimeMs }));
files.sort((a, b) => b.mtime - a.mtime);
fs.copyFileSync(`/tmp/evolution-video/${files[0].name}`, out);
console.log(`saved ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
