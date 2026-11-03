const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalDigest } = require('@lyra/shared');
const { createDataEvent } = require('../dist/data/event');
const { InMemoryProjectionStore } = require('../dist/data/checkpoint');
const { DataProjector } = require('../dist/data/projector');
const { DataDispatcher } = require('../dist/data/dispatcher');
const { DataReplayService } = require('../dist/data/replay');

const hex = value => value.repeat(64);
const aggregate = suffix => `production_${suffix.repeat(32)}`;
const evt = (version, overrides = {}) => {
  const event = createDataEvent({
    eventType: overrides.eventType ?? 'production.run.status_changed',
    aggregateType: 'production_run',
    aggregateId: overrides.aggregateId ?? aggregate('a'),
    aggregateVersion: version,
    occurredAt: overrides.occurredAt ?? '2026-11-03T00:00:00.000Z',
    recordedAt: overrides.recordedAt ?? overrides.occurredAt ?? '2026-11-03T00:00:01.000Z',
    correlationId: `corr-000${version}`,
    authoritativeRef: { kind: 'production_run', id: aggregate('a'), revisionId: null, digest: hex('b') },
    payload: { status: overrides.status ?? 'running' },
  });
  return event;
};
const stored = (event, outboxId = `obox_${'0'.repeat(32)}`) => ({
  outboxId, event, eventDigest: canonicalDigest(event), status: 'pending', attempts: 0,
  availableAt: event.recordedAt, publishedAt: null, lastError: null, legacySource: null,
  legacyEventId: null, createdAt: event.recordedAt,
});

class MemoryOutbox {
  constructor(events) { this.items = events; this.published = []; }
  async listPending(limit, now) {
    return this.items.filter(item => item.status === 'pending' || item.status === 'failed')
      .filter(item => item.availableAt <= now).slice(0, limit);
  }
  async markPublished(outboxId, at) {
    const item = this.items.find(row => row.outboxId === outboxId);
    item.status = 'published'; item.publishedAt = at; this.published.push(outboxId); return item;
  }
  async markFailure(outboxId, error, availableAt, maxAttempts) {
    const item = this.items.find(row => row.outboxId === outboxId);
    item.attempts += 1; item.lastError = error; item.availableAt = availableAt;
    item.status = item.attempts >= maxAttempts ? 'dead_letter' : 'failed';
    return item;
  }
    async getByEventId(eventId) { return this.items.find(row => row.event.eventId === eventId) ?? null; }
}

test('同一事件连续投递三次只产生一份投影，checkpoint 原子前进', async () => {
  const store = new InMemoryProjectionStore();
  const projector = new DataProjector('test-projector', store);
  const event = evt(1);
  const first = await projector.deliver(event);
  const second = await projector.deliver(event);
  const third = await projector.deliver(event);
  assert.equal(first.status, 'projected');
  assert.equal(second.status, 'duplicate');
  assert.equal(third.status, 'duplicate');
  assert.equal((await store.listProjections('test-projector')).length, 1);
  assert.equal((await store.getCheckpoint('test-projector')).eventId, event.eventId);
});

test('单 aggregate 必须按版本递增；缺口不强行投影且不阻塞其他 aggregate', async () => {
  const store = new InMemoryProjectionStore();
  const projector = new DataProjector('test-projector', store);
  assert.equal((await projector.deliver(evt(3))).status, 'gap');
  assert.equal((await store.listProjections('test-projector')).length, 0);
  assert.equal((await projector.deliver(evt(1))).status, 'projected');
  assert.equal((await projector.deliver(evt(2))).status, 'projected');
  assert.equal((await projector.deliver(evt(3))).status, 'projected');
  const other = evt(1, { aggregateId: aggregate('c'), eventType: 'production.run.created' });
  assert.equal((await projector.deliver(other)).status, 'projected');
  assert.equal((await store.listProjections('test-projector')).length, 4);
  assert.equal((await store.getCheckpoint('test-projector')).eventId, other.eventId,
    'checkpoint 记录最近一次已提交事件');
});

test('未识别 schema 进入隔离区，不产生投影', async () => {
  const store = new InMemoryProjectionStore();
  const projector = new DataProjector('test-projector', store);
  const unknown = { ...evt(1), schemaVersion: 'lyra.unknown.fact/v9' };
  const result = await projector.deliver(unknown);
  assert.equal(result.status, 'quarantined');
  assert.equal((await store.listProjections('test-projector')).length, 0);
  const quarantine = await store.listQuarantine('test-projector');
  assert.equal(quarantine.length, 1);
  assert.equal(quarantine[0].reason, 'UNKNOWN_SCHEMA:lyra.unknown.fact/v9');
});

test('Dispatcher 失败重试并在超限后进入 dead-letter', async () => {
  const event = evt(1);
  const outbox = new MemoryOutbox([stored(event)]);
  const brokenStore = {
    async hasProcessed() { return false; },
    async getAggregateVersion() { return null; },
    async commit() { throw new Error('projection store unavailable'); },
    async recordQuarantine() {},
  };
  const projector = new DataProjector('test-projector', brokenStore);
  const dispatcher = new DataDispatcher(outbox, projector, { maxAttempts: 2, backoffMs: 0, batchSize: 10 });
  const first = await dispatcher.runOnce();
  assert.equal(first.failed, 1);
  assert.equal(outbox.items[0].status, 'failed');
  const second = await dispatcher.runOnce();
  assert.equal(second.failed, 1);
  assert.equal(second.deadLettered, 1);
  assert.equal(outbox.items[0].status, 'dead_letter');
  assert.equal(outbox.published.length, 0);
});

test('Checkpoint 只从已提交位置继续，失败前不产生半份状态', async () => {
  const store = new InMemoryProjectionStore();
  const projector = new DataProjector('test-projector', store);
  await projector.deliver(evt(1));
  assert.equal((await store.getCheckpoint('test-projector')).aggregateVersion, 1);
  const secondProjector = new DataProjector('test-projector', store);
  assert.equal((await secondProjector.deliver(evt(2))).status, 'projected');
  assert.equal((await store.listProjections('test-projector')).length, 2);
  assert.equal((await store.getCheckpoint('test-projector')).aggregateVersion, 2);

  const failing = {
    async hasProcessed() { return false; },
    async getAggregateVersion() { return 0; },
    async commit() { throw new Error('crash before commit'); },
    async recordQuarantine() {},
  };
  const failingProjector = new DataProjector('test-projector', failing);
  await assert.rejects(failingProjector.deliver(evt(1)), /crash before commit/);
  assert.equal((await store.getCheckpoint('test-projector')).aggregateVersion, 2,
    '失败提交不能推进 checkpoint');
});

test('范围重放按时间/aggregate/event type 过滤，dry-run 零写入且命名空间隔离', async () => {
  const events = [
    stored(evt(1, { occurredAt: '2026-11-03T00:00:00.000Z', eventType: 'production.run.created' }), `obox_${'1'.repeat(32)}`),
    stored(evt(2, { occurredAt: '2026-11-03T01:00:00.000Z', eventType: 'production.run.status_changed' }), `obox_${'2'.repeat(32)}`),
    stored(evt(1, { aggregateId: aggregate('c'), occurredAt: '2026-11-03T02:00:00.000Z', eventType: 'production.run.created' }), `obox_${'3'.repeat(32)}`),
  ];
  const source = { list: async () => events };
  const onlineStore = new InMemoryProjectionStore();
  const replayStore = new InMemoryProjectionStore();
  const replay = new DataReplayService(source, replayStore);
  const filter = {
    from: '2026-11-03T00:00:00.000Z', to: '2026-11-03T01:30:00.000Z',
    aggregateType: 'production_run', aggregateId: aggregate('a'),
    eventTypes: ['production.run.status_changed'],
  };
  const dry = await replay.replay({ replayId: 'replay-dry-01', consumerName: 'projector-main',
    filter, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.matched, 1);
  assert.equal(dry.projected, 0);
  assert.equal((await replayStore.listProjections('projector-main:replay:replay-dry-01')).length, 0);
  assert.equal((await onlineStore.getCheckpoint('projector-main')), null);

  const actual = await replay.replay({ replayId: 'replay-run-01', consumerName: 'projector-main', filter });
  assert.equal(actual.matched, 1);
  assert.equal(actual.projected, 1);
  assert.match(actual.namespace, /projector-main:replay:replay-run-01/u);
  assert.equal((await replayStore.listProjections(actual.namespace)).length, 1);
  assert.equal(await replayStore.getCheckpoint('projector-main'), null,
    '重放不能污染线上 checkpoint');

  const timeOnly = await replay.replay({ replayId: 'replay-time-01', consumerName: 'projector-main',
    filter: { from: '2026-11-03T01:00:00.000Z', to: '2026-11-03T02:00:00.000Z' }, dryRun: true });
  assert.equal(timeOnly.matched, 2, '时间范围重放');
  const aggregateOnly = await replay.replay({ replayId: 'replay-aggr-01', consumerName: 'projector-main',
    filter: { aggregateId: aggregate('a') }, dryRun: true });
  assert.equal(aggregateOnly.matched, 2, 'aggregate 重放');
  const typeOnly = await replay.replay({ replayId: 'replay-type-01', consumerName: 'projector-main',
    filter: { eventTypes: ['production.run.created'] }, dryRun: true });
  assert.equal(typeOnly.matched, 2, 'event type 重放');
});
