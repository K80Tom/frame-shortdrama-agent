const { assetPackContentDigest, parseAssetPackVersion, ASSET_PACK_SCHEMA_VERSION } = require('@lyra/shared');
const { PostgresAssetPackRepository } = require('../dist/assets/asset-pack-repository');
const { assetRetrievalAuthorization } = require('../dist/asset-retrieval-governance/authorization');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { Client } = require('pg');
const { PostgresDatabase } = require('../dist/db/client');
const {
  PostgresAssetRetrievalGovernanceRepository,
} = require('../dist/asset-retrieval-governance/repository');
const { AssetRetrievalGovernanceService } = require('../dist/asset-retrieval-governance/service');

const token = () => randomBytes(16).toString('hex');
const at = '2026-11-10T08:00:00.000Z';
const digest = value => createHash('sha256').update(value).digest('hex');
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_APP_URL || process.env.DATABASE_URL;

test('054 asset retrieval governance is tenant isolated and append-only on real PostgreSQL', {
  skip: adminUrl && appUrl ? false : 'DATABASE_ADMIN_URL and DATABASE_URL are required',
}, async t => {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const database = new PostgresDatabase({ connectionString: appUrl }, { unscopedAccess: 'deny' });
  t.after(async () => { await database.close(); await admin.end(); });
  try {
    await database.verifyTenantRole();
  } catch {
    t.skip('asset-retrieval-governance DB test requires DATABASE_APP_URL '
      + '(or DATABASE_URL) to be a non-superuser role without BYPASSRLS.');
    return;
  }
  const appRole = decodeURIComponent(new URL(appUrl).username);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA public TO "${appRole.replaceAll('"', '""')}"`);
  const repository = new PostgresAssetRetrievalGovernanceRepository(database);
  const packs = new PostgresAssetPackRepository(database);
  const service = new AssetRetrievalGovernanceService(repository, { now: () => new Date(at), verifyAuthorization: assetRetrievalAuthorization(packs, () => new Date(at)) });
  const contexts = [0, 1].map(() => {
    const suffix = token();
    return { userId: 'usr_' + suffix, workspaceId: 'ws_' + suffix,
      projectId: 'project_' + suffix, clientRequestId: 'retrieval-' + suffix };
  });
  for (const ctx of contexts) {
    await admin.query(`INSERT INTO users(id,subject,display_name,kind,status,created_at,updated_at)
      VALUES($1,$2,'Retrieval governance test','human','active',$3,$3)`,
      [ctx.userId, 'retrieval-test:' + token(), at]);
    await admin.query(`INSERT INTO workspaces(id,slug,name,status,created_by_user_id,created_at,updated_at)
      VALUES($1,$2,'Retrieval governance test','active',$3,$4,$4)`,
      [ctx.workspaceId, 'retrieval-' + token(), ctx.userId, at]);
    await admin.query(`INSERT INTO workspace_members(workspace_id,user_id,role,status,created_at,updated_at)
      VALUES($1,$2,'owner','active',$3,$3)`, [ctx.workspaceId, ctx.userId, at]);
  }
  const [a, b] = contexts;
  const scoped = (ctx, work) => database.runWithTenant({
    userId: ctx.userId, workspaceId: ctx.workspaceId, role: 'owner', requestId: ctx.clientRequestId,
  }, work);

  const catalog = {
    assetCatalogVersion: 'catalog/1', indexAlias: 'lyra_assets_v1', indexCollection: 'lyra_assets',
    embeddingModel: 'fixture-embedding', embeddingRevision: 'embedding/1',
    authorizationPolicyVersion: 'authorization/1', authorizationSnapshotDigest: digest('authorization-snapshot'),
  };
  const observationInput = (clientRequestId, assetId) => ({
    projectId: a.projectId, shotId: 'shot_fixture', requestId: 'req-' + clientRequestId,
    clientRequestId,
    query: { text: '主角 正面', filters: { kinds: ['character'], statuses: ['ready'] }, limit: 2 },
    strategy: { mode: 'hybrid', ruleVersion: 'rules/1', policyVersion: 'asset-retrieval-policy/1',
      policy: { threshold: 0.62, ambiguityMargin: 0.08, semanticWeight: 0.95 }, catalog, retrievalLimit: 2 },
    candidates: [{
      assetId, assetVersionId: assetId + '-v1', assetVersionDigest: digest(assetId), assetName: assetId,
      assetKind: 'character', assetStatus: 'ready', rank: 1, lexicalScore: 0.9, semanticScore: 0.9,
      finalScore: 0.9, combinedScore: 0.9, matchedFields: ['name'], matchedTerms: [assetId],
      filterReasons: [], explanation: 'fixture', authorizationQuality: 'clean',
    }],
    degradedReason: null, latencyMs: 10, costMicros: 0,
  });
  const ids = new Map();
  for (const ctx of contexts) {
    ids.set(ctx.workspaceId, await scoped(ctx, async () => {
      const base = { schemaVersion: ASSET_PACK_SCHEMA_VERSION, id: 'apv_' + token(), workspaceId: ctx.workspaceId,
        projectScope:'project',projectId:ctx.projectId,kind:'character',logicalAssetId:'asset_'+token(),version:1,parentVersionId:null,
        displayName:'Fixture',aliases:[],description:'',tags:[],sourceType:'imported',sourceRefs:[],license:'internal',
        authorizationStatus:'allowed',authorizationReason:null,reviewStatus:'approved',reviewedBy:ctx.userId,reviewedAt:at,
        validFrom:at,validUntil:null,allowedUsages:['evaluation'],restrictedProjects:[],mediaEntries:[],status:'adopted',createdBy:ctx.userId,createdAt:at };
      const version = parseAssetPackVersion({...base,contentDigest:assetPackContentDigest(base)});
      await packs.create(version);
      await packs.adopt({workspaceId:ctx.workspaceId,adoptionId:'apa_'+token(),logicalAssetId:version.logicalAssetId,versionId:version.id,adoptedBy:ctx.userId,reason:'explicit fixture adoption',createdAt:at});
      const observed = observationInput(ctx.clientRequestId, version.logicalAssetId); observed.projectId=ctx.projectId;
      observed.candidates[0].assetVersionId=version.id; observed.candidates[0].assetVersionDigest=version.contentDigest;
      const observation = await service.recordObservation(ctx.workspaceId, observed);
      await service.recordDecision(ctx.workspaceId, {
        observationId: observation.observationId, clientRequestId: 'decision-' + ctx.clientRequestId,
        decision: 'accept', selectedAssetId: observation.candidates[0].assetId,
        selectedAssetVersionId: observation.candidates[0].assetVersionId, reason: 'fixture choice',
        actorId: ctx.userId, authorization: { quality: 'clean', verifiedAt: at, note: '' },
        outcome: { status: 'success', runId: 'run_' + ctx.clientRequestId },
      });
      const dataset = await service.createDatasetRevision(ctx.workspaceId, {
        purpose: 'policy_search', observationIds: [observation.observationId],
        createdBy: ctx.userId, contentSummary: 'real PostgreSQL fixture',
      });
      const payload = await service.createPolicyPayload(ctx.workspaceId, {
        basePolicyVersion: 'asset-retrieval-policy/1',
        basePolicy: { threshold: 0.62, ambiguityMargin: 0.08, semanticWeight: 0.95 },
        assetRetrievalDatasetRevisionId: dataset.datasetRevisionId,
        policy: { threshold: 0.6, ambiguityMargin: 0.08, semanticWeight: 0.9 }, createdBy: ctx.userId,
      });
      return { observation, dataset, payload, version };
    }));
  }

  await scoped(a, async () => {
    const own = ids.get(a.workspaceId);
    const other = ids.get(b.workspaceId);
    assert.equal(await repository.getObservation(a.workspaceId, own.observation.observationId) !== null, true);
    assert.equal(await repository.getObservation(a.workspaceId, other.observation.observationId), null);
    assert.equal(await repository.getDatasetRevision(a.workspaceId, other.dataset.datasetRevisionId), null);
    assert.equal((await database.query(
      'SELECT 1 FROM asset_retrieval_observations WHERE workspace_id=$1', [b.workspaceId])).rowCount, 0);
    await assert.rejects(database.query(`INSERT INTO asset_retrieval_observations(
      observation_id, workspace_id, project_id, shot_id, request_id, client_request_id,
      query_digest, observed_at, content_digest, observation_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [
      'arobs_' + token(), b.workspaceId, null, null, 'attack', 'attack-' + token(),
      digest('attack'), at, digest('attack'), JSON.stringify(own.observation),
    ]), error => error.code === '42501');
    await assert.rejects(database.query(
      'UPDATE asset_retrieval_observations SET request_id=$1 WHERE observation_id=$2',
      ['mutated', own.observation.observationId]),
    error => error.code === '23514');
  });

  await scoped(a, async () => {
    const own=ids.get(a.workspaceId);
    const revoked={...own.version,id:'apv_'+token(),version:2,parentVersionId:own.version.id,status:'revoked',authorizationStatus:'revoked'};
    revoked.contentDigest=assetPackContentDigest(revoked);await packs.create(parseAssetPackVersion(revoked));
    // The historical immutable row is still allowed; the new authoritative restriction must nevertheless block consumption.
    assert.equal((await packs.get(a.workspaceId,own.version.id)).authorizationStatus,'allowed');
    await assert.rejects(service.datasetSamples(a.workspaceId,own.dataset.datasetRevisionId),e=>e.code==='ASSET_RETRIEVAL_AUTHORIZATION_UNVERIFIED');
    await assert.rejects(service.createDatasetRevision(a.workspaceId,{purpose:'evaluation',observationIds:[own.observation.observationId],createdBy:a.userId}),e=>e.code==='ASSET_RETRIEVAL_DATASET_EMPTY');
    const forged=observationInput('forged-'+token(),'asset_missing');
    const obs=await service.recordObservation(a.workspaceId,forged);
    const decision=await service.recordDecision(a.workspaceId,{observationId:obs.observationId,clientRequestId:'forged-decision-'+token(),decision:'accept',selectedAssetId:forged.candidates[0].assetId,selectedAssetVersionId:forged.candidates[0].assetVersionId,reason:'forged clean',actorId:a.userId,authorization:{quality:'clean'}});
    assert.equal(decision.authorization.quality,'unverified');
  });
  const rls = await admin.query(`SELECT relname, relrowsecurity, relforcerowsecurity
    FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'asset_retrieval_%' AND relkind='r'`);
  assert.equal(rls.rowCount, 5);
  assert.ok(rls.rows.every(row => row.relrowsecurity && row.relforcerowsecurity));
  const policies = await admin.query(`SELECT tablename FROM pg_policies
    WHERE schemaname='public' AND tablename LIKE 'asset_retrieval_%' AND policyname='lyra_workspace_isolation'`);
  assert.equal(policies.rowCount, 5);
});
