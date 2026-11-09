import { canonicalDigest, ProductionError } from '@lyra/shared';
import { parseProductionInputSnapshot, parseProductionInputSnapshotDraft,
  type ProductionInputSnapshotDraft, type ProductionInputSnapshot } from '@lyra/shared/dist/production-input-snapshot';

function content(value: ProductionInputSnapshotDraft) {
  const { id: _id, state: _state, findings: _findings, createdBy: _createdBy, createdAt: _createdAt, reason: _reason, ...inputs } = value;
  return inputs;
}
/** Hashing alone does not establish ready/frozen authority; only the authorized validation transaction may do that. */
export function sealProductionInputSnapshot(value: unknown): ProductionInputSnapshot {
  const draft = parseProductionInputSnapshotDraft(value);
  return parseProductionInputSnapshot({ ...draft, snapshotDigest: canonicalDigest(content(draft)) });
}
export function verifyProductionInputSnapshot(value: unknown): ProductionInputSnapshot {
  const snapshot = parseProductionInputSnapshot(value);
  const { snapshotDigest, ...draft } = snapshot;
  if (canonicalDigest(content(draft)) !== snapshotDigest) {
    throw new ProductionError(409, 'DIGEST_MISMATCH', '生产输入快照摘要不一致。');
  }
  return snapshot;
}
