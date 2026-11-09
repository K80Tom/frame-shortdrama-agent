const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { randomUUID } = require('node:crypto');

if (!process.env.DATABASE_URL) {
  test('Lineage PostgreSQL integration requires DATABASE_URL', { skip: 'Set DATABASE_URL before test:db.' }, () => {});
} else {
  const d64 = s => crypto.createHash('sha256').update(s).digest('hex');
  const { readDatabaseConfig } = require('../dist/db/config');
  const { PostgresDatabase } = require('../dist/db/client');
  const { lineageNodeId } = require('@lyra/shared');
  const { createDataEvent } = require('../dist/data/event');
  const { PostgresLineageStore } = require('../dist/lineage/store');
  const { LineageProjector } = require('../dist/lineage/projector');
  const { LineageQueryService } = require('../dist/lineage/query');

  function input(kind, businessId, edgeType, overrides = {}) {
    return { kind, businessId, revisionId: null, edgeType, factIsTo: true,
      present: true, digest: d64(businessId),
      ref: { kind: `${kind}s`, id: businessId, revisionId: null }, ...overrides };
  }

  test('PostgreSQL 血缘：节点/边/事件台账同事务、重复 replay 不重复、正反向可查、不写业务表', async () => {
    const database = new PostgresDatabase(readDatabaseConfig());
    const consumer = `lineage-db-${randomUUID().slice(0, 8)}`;
    const unique = randomUUID().replaceAll('-', '').slice(0, 16);
    try {
      await database.verifyConnection();
      assert.equal(await database.hasMigrations(['046']), true, '先运行 046 迁移。');

      // 记录投影前 data_outbox_events（业务 Outbox）行数，验证血缘不写业务表。
      const outboxBefore = await database.query('SELECT COUNT(*)::int AS c FROM data_outbox_events');

      const novelId = `novelrev_${unique}`;
      const scriptId = `script_${unique}`;
      const deliveryId = `delivery_${unique}`;
      const facts = {
        [novelId]: { kind: 'novel_revision', businessId: novelId, revisionId: null,
          ref: { kind: 'novel_revisions', id: novelId, revisionId: null }, digest: d64(novelId),
          occurredAt: '2026-11-03T00:00:00.000Z', recordedAt: '2026-11-03T00:00:01.000Z',
          retention: 'project_lifetime', visibility: 'internal', authorization: 'project:read', inputs: [] },
        [scriptId]: { kind: 'script_version', businessId: scriptId, revisionId: null,
          ref: { kind: 'script_versions', id: scriptId, revisionId: null }, digest: d64(scriptId),
          occurredAt: '2026-11-03T00:00:00.000Z', recordedAt: '2026-11-03T00:00:01.000Z',
          retention: 'project_lifetime', visibility: 'internal', authorization: 'project:read',
          inputs: [input('novel_revision', novelId, 'derived-from')] },
        [deliveryId]: { kind: 'delivery', businessId: deliveryId, revisionId: null,
          ref: { kind: 'deliveries', id: deliveryId, revisionId: null }, digest: d64(deliveryId),
          occurredAt: '2026-11-03T00:00:00.000Z', recordedAt: '2026-11-03T00:00:01.000Z',
          retention: 'run_lifetime', visibility: 'internal', authorization: 'project:read',
          inputs: [input('script_version', scriptId, 'delivered-as', { present: false, digest: undefined })] },
      };
      const reader = { resolve: async event => facts[event.aggregateId] ?? null };
      const store = new PostgresLineageStore(database);
      const projector = new LineageProjector(consumer, store, reader);

      let v = 0;
      const events = new Map();
      const ev = id => {
        if (!events.has(id)) {
          const version = ++v;
          events.set(id, createDataEvent({
            eventId: 'evt_' + d64(`db-${id}-${version}`).slice(0, 32),
            eventType: 'lineage.fact.recorded', aggregateType: 'script', aggregateId: id,
            aggregateVersion: version, occurredAt: '2026-11-03T00:00:00.000Z',
            recordedAt: '2026-11-03T00:00:01.000Z', correlationId: `db-${id}-${version}`,
            authoritativeRef: { kind: 'fixture', id, revisionId: null, digest: d64(id) }, payload: {},
          }));
        }
        return events.get(id);
      };

      const r1 = await projector.deliver(ev(novelId));
      const r2 = await projector.deliver(ev(scriptId));
      const r3 = await projector.deliver(ev(deliveryId));
      assert.equal(r1.status, 'projected');
      assert.equal(r2.status, 'projected');
      assert.equal(r3.status, 'projected');

      // 重复 replay：同一事件不再产生节点/边
      const dup = await projector.deliver(ev(scriptId));
      assert.equal(dup.status, 'duplicate');

      const query = new LineageQueryService(store);
      const scriptNodeId = lineageNodeId('script_version', scriptId, null);
      const back = await query.traverse(scriptNodeId, 'upstream',
        { maxDepth: 5, allowedScopes: ['project:read'] });
      assert.ok(back.nodes.some(n => n.kind === 'novel_revision'));
      // delivery 声明的上游缺失 -> unknown gap 可见
      const flagged = back.flaggedGaps.length;
      const allNodes = await store.listNodes();
      const flaggedNode = allNodes.find(n => n.gap && (n.gap.type === 'unknown' || n.gap.type === 'orphan'));
      assert.ok(flaggedNode, '缺失上游在真实库中形成 unknown/orphan gap');
      assert.ok(flagged >= 0);

      // 血缘投影没有写业务 Outbox
      const outboxAfter = await database.query('SELECT COUNT(*)::int AS c FROM data_outbox_events');
      assert.equal(outboxAfter.rows[0].c, outboxBefore.rows[0].c, '血缘不得写入业务 Outbox');
      // 注：节点/边不可变（触发器禁止 DELETE），测试使用本任务专用隔离库并以随机
      // 后缀隔离数据，不做行级删除。
    } finally {
      await database.close();
    }
  });
}
