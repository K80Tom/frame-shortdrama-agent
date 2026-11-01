import { AssetService } from '../service';
import { PostgresAssetRepository } from '../repository';
import { PostgresDatabase } from '../../db/client';
import { readDatabaseConfig } from '../../db/config';
import { readAssetVectorConfig } from './config';
import { DoubaoAssetEmbeddingClient } from './embedding';
import { MilvusAssetVectorStore } from './milvus';
import { AssetVectorProjector } from './projection';

/** Run explicitly after asset imports: npm run assets:vector-rebuild. */
async function rebuild(): Promise<void> {
  const config = readAssetVectorConfig(process.env, { requireEnabled: true });
  if (!config) throw new Error('向量检索配置不可用。');
  const databaseConfig = readDatabaseConfig();
  if (!databaseConfig) throw new Error('DATABASE_URL 未配置，无法读取正式资产目录。');
  const database = new PostgresDatabase(databaseConfig);
  try {
    if (!await database.hasMigrations(['009'])) throw new Error('资产目录迁移 009 尚未执行。');
    const assets = new AssetService(new PostgresAssetRepository(database), await database.hasMigrations(['010']));
    const projector = new AssetVectorProjector({
      embedding: new DoubaoAssetEmbeddingClient({ endpoint: config.embeddingEndpoint,
        model: config.embeddingModel, apiKey: config.embeddingApiKey, timeoutMs: config.embeddingTimeoutMs }),
      store: new MilvusAssetVectorStore({ uri: config.milvusUri, user: config.milvusUser,
        password: config.milvusPassword, collection: config.milvusCollection }),
      model: config.embeddingModel, manifestPath: config.manifestPath,
    });
    const summary = await projector.sync(await assets.list());
    console.log(`Asset vector projection rebuilt: ${JSON.stringify(summary)}`);
  } finally {
    await database.close();
  }
}

if (require.main === module) {
  void rebuild().catch(() => {
    console.error('Asset vector projection rebuild failed; the formal asset catalog was not changed.');
    process.exitCode = 1;
  });
}
