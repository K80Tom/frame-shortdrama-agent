const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CompositeDataProjector } = require('../dist/data/composite-projector');
const { LineageDataProjector } = require('../dist/lineage/data-projector');

const event = { eventId: 'evt_' + 'a'.repeat(32) };

function projector(status, reason) {
  return { deliver: async () => ({ status, reason }) };
}

test('CompositeDataProjector：任一 gap/quarantined 优先，全部 duplicate 才 duplicate', async () => {
  assert.throws(() => new CompositeDataProjector([]), /At least one/);
  assert.deepEqual(
    await new CompositeDataProjector([projector('projected'), projector('duplicate')]).deliver(event),
    { status: 'projected' },
  );
  assert.deepEqual(
    await new CompositeDataProjector([projector('projected'), projector('gap', '缺上游')]).deliver(event),
    { status: 'gap', reason: '缺上游' },
  );
  assert.deepEqual(
    await new CompositeDataProjector([projector('quarantined', '坏事件'), projector('projected')]).deliver(event),
    { status: 'quarantined', reason: '坏事件' },
  );
  assert.deepEqual(
    await new CompositeDataProjector([projector('duplicate'), projector('duplicate')]).deliver(event),
    { status: 'duplicate' },
  );
});

test('LineageDataProjector：已提交 unknown 根节点按 projected 计，duplicate 原样透传', async () => {
  const unknown = new LineageDataProjector({ deliver: async () => ({ status: 'unknown', nodeCount: 1 }) });
  assert.deepEqual(await unknown.deliver(event), { status: 'projected' });
  const duplicate = new LineageDataProjector({ deliver: async () => ({ status: 'duplicate', nodeCount: 0 }) });
  assert.deepEqual(await duplicate.deliver(event), { status: 'duplicate' });
});
