if (!process.argv.includes('--allow-paid')) throw new Error('此命令会发出一次可能计费的文本请求。请明确传入 --allow-paid。');
const base = `http://127.0.0.1:${process.env.PORT || 8788}`;
// One synthetic text request only. No project content, images, retries or fallback.
try {
  const response = await fetch(`${base}/api/model-calls`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Compute 17 + 25. Reply with the number only.' }],
      maxOutputTokens: 4096, allowPaid: true }),
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS || 180000) + 5000) });
  const result = await response.json();
  const passed = response.ok && result.status === 'completed' && /\b42\b/.test(result.text || '');
  console.log(JSON.stringify({ at: new Date().toISOString(), kind: 'text', passed,
    httpStatus: response.status, requestedModel: result.requestedModel, reportedModel: result.reportedModel,
    usage: result.usage, durationMs: result.durationMs,
    error: result.error ? { code: result.error.code, upstreamStatus: result.error.upstreamStatus } : undefined }));
  if (!passed) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ kind: 'text', passed: false, error: 'TRANSPORT_FAILURE_NO_RETRY' }));
  process.exitCode = 1;
}
