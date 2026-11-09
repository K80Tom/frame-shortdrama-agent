const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (!process.env.DATABASE_URL) {
  test('Lineage source reader requires DATABASE_URL', { skip: 'Set DATABASE_URL before test:db.' }, () => {});
} else {
  const d64 = s => crypto.createHash('sha256').update(s).digest('hex');
  const { readDatabaseConfig } = require('../dist/db/config');
  const { PostgresDatabase } = require('../dist/db/client');
  const { lineageNodeId } = require('@lyra/shared');
  const { createDataEvent } = require('../dist/data/event');
  const { LineageProjector } = require('../dist/lineage/projector');
  const { PostgresLineageStore } = require('../dist/lineage/store');
  const { PostgresSourceLineageReader } = require('../dist/lineage/postgres-source-reader');
  const { LineageQueryService } = require('../dist/lineage/query');

  test('PostgreSQL 权威读取器：run_json 生成剧本→任务→产物→交付的双向图谱', async () => {
    const database = new PostgresDatabase(readDatabaseConfig());
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
    const projectId = `proj_${suffix}`;
    const scriptId = `script_${suffix}`;
    const runId = `production_${crypto.randomBytes(16).toString('hex')}`;
    const taskId = `task_${suffix}`;
    const attemptId = `attempt_${suffix}`;
    const artifactId = `artifact_${suffix}`;
    const timelineId = `timeline_${suffix}`;
    const deliveryId = `delivery_${suffix}`;
    const occurredAt = '2026-11-03T00:00:00.000Z';
    try {
      await database.verifyConnection();
      assert.equal(await database.hasMigrations(['046']), true, '先运行 046 迁移。');

      await database.query(
        `INSERT INTO projects (id, title, created_at, workspace_id)
         VALUES ($1, $2, $3::timestamptz, 'ws_00000000000000000000000000000000')`,
        [projectId, `Lineage ${suffix}`, occurredAt],
      );
      await database.query(
        `INSERT INTO script_versions
           (id, project_id, version, raw_text, content_sha256, source_index_json, created_at, workspace_id)
         VALUES ($1, $2, 1, $3, $4, '{}'::jsonb, $5::timestamptz,
                 'ws_00000000000000000000000000000000')`,
        [scriptId, projectId, '第一场：测试剧本。', d64(scriptId), occurredAt],
      );

      const runJson = {
        id: runId,
        clientRequestId: `req_${suffix}`,
        projectId,
        scriptVersionId: scriptId,
        status: 'completed',
        version: 1,
        createdAt: occurredAt,
        tasks: [{ id: taskId, createdAt: occurredAt, updatedAt: occurredAt }],
        attempts: [{ id: attemptId, taskId, startedAt: occurredAt, endedAt: occurredAt }],
        externalOperations: [],
        artifacts: [{ id: artifactId, taskId, sha256: d64(artifactId), createdAt: occurredAt }],
        qualityChecks: [],
        reviews: [],
        timeline: [{ id: timelineId, version: 1, createdAt: occurredAt, tracks: [] }],
        delivery: { id: deliveryId, artifactId, createdAt: occurredAt },
      };
      await database.query(
        `INSERT INTO production_runs
           (id, client_request_id, project_id, script_version_id, status, version, run_json,
            created_at, updated_at, workspace_id)
         VALUES ($1, $2, $3, $4, 'completed', 1, $5::jsonb, $6::timestamptz, $6::timestamptz,
                 'ws_00000000000000000000000000000000')`,
        [runId, runJson.clientRequestId, projectId, scriptId, JSON.stringify(runJson), occurredAt],
      );

      const reader = new PostgresSourceLineageReader(database);
      const event = createDataEvent({
        eventId: 'evt_' + d64(`source-${suffix}`).slice(0, 32),
        eventType: 'lineage.fact.recorded',
        aggregateType: 'production_run',
        aggregateId: runId,
        aggregateVersion: 1,
        occurredAt,
        recordedAt: '2026-11-03T00:00:01.000Z',
        correlationId: `corr-${suffix}-1`,
        authoritativeRef: { kind: 'production_runs', id: runId, revisionId: null, digest: d64(runId) },
        payload: {},
      });
      const fact = await reader.resolve(event);
      assert.ok(fact, '权威 Run 必须可解析');
      const edges = fact.links.map(link => `${link.edgeType}:${link.from.businessId}->${link.to.businessId}`);
      assert.ok(edges.includes(`derived-from:${scriptId}->${runId}`), '剧本→Run 应存在');
      assert.ok(edges.includes(`derived-from:${runId}->${taskId}`), 'Run→任务 应存在');
      assert.ok(edges.includes(`derived-from:${taskId}->${attemptId}`), '任务→尝试 应存在');
      assert.ok(edges.includes(`generated-by:${taskId}->${artifactId}`), '任务→产物 应存在');
      assert.ok(edges.includes(`delivered-as:${artifactId}->${deliveryId}`), '产物→交付 应存在');
      assert.ok(edges.includes(`derived-from:${runId}->${timelineId}`), 'Run→时间线 应存在');
      assert.ok(edges.includes(`delivered-as:${runId}->${deliveryId}`), 'Run→交付 应存在');

      const store = new PostgresLineageStore(database);
      const projector = new LineageProjector(`lineage-src-${suffix}`, store, reader);
      const projected = await projector.deliver(event);
      assert.equal(projected.status, 'projected');
      assert.ok(projected.edgeCount >= 6);

      const query = new LineageQueryService(store);
      const runNodeId = lineageNodeId('production_run', runId, null);
      const upstream = await query.traverse(runNodeId, 'upstream',
        { maxDepth: 6, allowedScopes: ['project:read'] });
      const upstreamKinds = new Set(upstream.nodes.map(node => node.kind));
      assert.ok(upstreamKinds.has('script_version'));

      const deliveryNodeId = lineageNodeId('delivery', deliveryId, null);
      const downstream = await query.traverse(deliveryNodeId, 'upstream',
        { maxDepth: 6, allowedScopes: ['project:read'] });
      const downstreamKinds = new Set(downstream.nodes.map(node => node.kind));
      assert.ok(downstreamKinds.has('artifact'));
      assert.ok(downstreamKinds.has('production_task'));
      assert.ok(downstreamKinds.has('production_run'));
      assert.ok(downstreamKinds.has('script_version'));
    } finally {
      await database.close();
    }
  });
}
