const [mode, ...args] = process.argv.slice(2);
const base = `http://127.0.0.1:${process.env.PORT || 8788}`;
if (mode === 'list') {
  const response = await fetch(`${base}/api/models`, { signal: AbortSignal.timeout(5000) });
  console.log(JSON.stringify(await response.json(), null, 2));
  if (!response.ok) process.exitCode = 1;
} else {
  if (mode !== 'text' || !args.includes('--allow-paid')) {
    throw new Error('仅支持 list 或 text "提示词" --allow-paid。文本调用可能计费。');
  }
  const values = args.filter(arg => arg !== '--allow-paid');
  if (values.length !== 1 || !values[0]) throw new Error('请提供一个提示词；使用服务端配置的唯一文本模型。');
  const response = await fetch(`${base}/api/model-calls`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' },
    body: JSON.stringify({ messages: [{ role: 'user', content: values[0] }], allowPaid: true }),
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS || 180000) + 5000),
  });
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok || result.status !== 'completed') process.exitCode = 1;
}
