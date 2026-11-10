import type { EvaluationService } from '../evaluation/service';
import type {
  AssetRetrievalEvaluationDatasetRegistrar,
  RegisteredAssetRetrievalEvaluationDataset,
} from '@lyra/shared';

/**
 * #134 EvaluationService 适配器：只调用其公开的 createDataset/freezeDatasetRevision，
 * 不复制 Dataset/Revision/Scorecard 状态机，也不直接访问其表。
 */
export class EvaluationServiceAssetRetrievalRegistrar implements AssetRetrievalEvaluationDatasetRegistrar {
  constructor(private readonly evaluation: Pick<EvaluationService, 'createDataset' | 'freezeDatasetRevision'>) {}

  async register(input: Parameters<AssetRetrievalEvaluationDatasetRegistrar['register']>[0]):
  Promise<RegisteredAssetRetrievalEvaluationDataset> {
    const bundle = await this.evaluation.createDataset({
      kind: 'asset_retrieval',
      title: input.title,
      description: input.description,
      note: '由资产检索策略治理领域数据集冻结生成',
      contentSummary: input.contentSummary || '资产检索策略观测/决策评测集',
      slices: [input.workspaceId],
      tags: ['asset_retrieval_governance'],
      authorization: input.authorization,
      sensitivity: input.sensitivity,
      provenance: {
        sourceKind: 'internal',
        sourceRefs: [],
        generator: 'human',
        notes: 'Exported from AssetRetrievalDatasetRevision',
        createdAt: new Date().toISOString(),
      },
      cases: input.cases,
    });
    const frozen = await this.evaluation.freezeDatasetRevision(
      bundle.revision.datasetId,
      bundle.revision.id,
      { expectedDigest: bundle.revision.digest, reason: '资产检索策略数据集注册评测' },
    );
    return {
      datasetId: frozen.revision.datasetId,
      revisionId: frozen.revision.id,
      digest: frozen.revision.digest,
      caseCount: frozen.revision.caseCount,
      schemaVersion: 'lyra-evaluation-dataset/1',
    };
  }
}
