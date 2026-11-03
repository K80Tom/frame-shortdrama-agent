import { createHash } from 'node:crypto';
import {
  canonicalDigest,
  evaluationSnapshotDigest,
  type FrozenEvaluationSnapshot,
} from '@lyra/shared';

/** 只读生产运行视图。B 线不允许注入完整 ProductionRepository。 */
export interface EvaluationProductionRunReader {
  get(id: string): Promise<unknown | null>;
}

export interface EvaluationRunCase {
  caseId: string;
  /** 数据集 revision 中的输入摘要；执行器只使用摘要，不读取原始全文。 */
  inputDigest: string;
}

export interface EvaluationCaseCatalog {
  listCases(snapshot: FrozenEvaluationSnapshot): Promise<EvaluationRunCase[]>;
}

export interface EvaluationLocalExecutionInput {
  runId: string;
  caseId: string;
  inputDigest: string;
  sampleIndex: number;
  attemptNumber: number;
  snapshot: FrozenEvaluationSnapshot;
  signal: AbortSignal;
}

export interface EvaluationLocalResult {
  outputDigest: string;
  durationMs: number;
  costMicros: number;
  currency: string;
  output: Record<string, string | number | boolean | null>;
}

export interface EvaluationLocalExecutor {
  execute(input: EvaluationLocalExecutionInput): Promise<EvaluationLocalResult>;
}

export class EvaluationExecutionError extends Error {
  constructor(
    public readonly category: 'validation' | 'execution' | 'timeout' | 'cancelled' | 'unknown',
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EvaluationExecutionError';
  }
}

/**
 * 确定性本地桩：不调用模型、不读写网络。
 * 相同快照、case、seed 与 sample 序号产生相同输出摘要；成本为 0。
 */
export class DeterministicEvaluationLocalExecutor implements EvaluationLocalExecutor {
  async execute(input: EvaluationLocalExecutionInput): Promise<EvaluationLocalResult> {
    if (input.signal.aborted) {
      throw new EvaluationExecutionError('cancelled', 'EVALUATION_RUN_CANCELLED', '本地执行已取消。');
    }
    const output = {
      executor: 'local-deterministic/v1',
      snapshotDigest: evaluationSnapshotDigest(input.snapshot),
      seed: input.snapshot.seed,
      caseId: input.caseId,
      inputDigest: input.inputDigest,
      sampleIndex: input.sampleIndex,
    };
    return {
      outputDigest: canonicalDigest(output),
      durationMs: 0,
      costMicros: 0,
      currency: 'CNY',
      output,
    };
  }
}

/** 稳定分片：同一 caseId 在任何进程、任何批次都落在同一 shard。 */
export function stableShardIndex(caseId: string, shardCount: number): number {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error('shardCount must be a positive integer.');
  const first = createHash('sha256').update(caseId, 'utf8').digest('hex').slice(0, 8);
  return Number.parseInt(first, 16) % shardCount;
}

export function caseBelongsToShard(caseId: string, shardCount: number, shardIndex: number): boolean {
  return stableShardIndex(caseId, shardCount) === shardIndex;
}
