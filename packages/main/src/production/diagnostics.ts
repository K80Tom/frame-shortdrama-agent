/** 日志不是业务 outbox，也不能反向改变生产状态。 */
export type ProductionDiagnosticSink = (line: string) => unknown;

const ID_PATTERNS = {
  projectId: /^project_[a-f0-9]{32}$/,
  runId: /^production_[a-f0-9]{32}$/,
  taskId: /^ptask_[a-f0-9]{32}$/,
  attemptId: /^pattempt_[a-f0-9]{32}$/,
  operationId: /^pop_[a-f0-9]{32}$/,
};

/**
 * 只允许本地生成的关联 ID；不接收/遍历错误、原文、URL、message 或 stack。
 * 使用自有数据属性，避免触发 getter、toJSON 或循环对象序列化。
 * 缺少合法 ID 时省略该字段，绝不把原始值写入日志。
 */
export function logProductionOutputRejected(
  context: unknown,
  sink: ProductionDiagnosticSink = line => console.error(line),
): void {
  try {
    const record: Record<string, string> = {
      schemaVersion: 'lyra-production-diagnostic/1',
      level: 'error',
      event: 'production.task.output_rejected',
      timestamp: new Date().toISOString(),
    };
    if (context !== null && typeof context === 'object') {
      for (const [key, pattern] of Object.entries(ID_PATTERNS)) {
        const descriptor = Object.getOwnPropertyDescriptor(context, key);
        const value: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
        if (typeof value === 'string' && value.length < 80 && !/[\r\n]/u.test(value) && pattern.test(value)) {
          record[key] = value;
        }
      }
    }
    // 不等待 sink：同步抛错、异步 reject 或永不完成均不得改变业务结果。
    void Promise.resolve(sink(JSON.stringify(record))).catch(() => {});
  } catch {
    // 不尝试记录日志系统自己的原始错误，也不递归调用 sink。
  }
}
