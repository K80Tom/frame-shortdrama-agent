const { test } = require('node:test');
const assert = require('node:assert/strict');
const { InMemoryPaidGenerationInterceptor, assertPaidGenerationReservation, PaidGenerationError } =
  require('../dist/budget/paid-generation');

const WS = `ws_${'a'.repeat(32)}`;

function budget(limit = 1_000_000) {
  return new InMemoryPaidGenerationInterceptor();
}

test('budget reservation is unique per operation and releases only definite failures', async () => {
  const ledger = budget();
  const first = await ledger.reserve({ workspaceId: WS, operationKey: 'video:shot-1:candidate-0',
    provider: 'kling', model: 'kling-v2', estimateMicros: 100_000, budgetLimitMicros: 300_000, currency: 'CNY' });
  const duplicate = await ledger.reserve({ workspaceId: WS, operationKey: 'video:shot-1:candidate-0',
    provider: 'kling', model: 'kling-v2', estimateMicros: 100_000, budgetLimitMicros: 300_000, currency: 'CNY' });
  assert.equal(first.id, duplicate.id);
  await assert.rejects(
    ledger.reserve({ workspaceId: WS, operationKey: 'video:shot-1:candidate-1',
      provider: 'kling', model: 'kling-v2', estimateMicros: 250_000, budgetLimitMicros: 300_000, currency: 'CNY' }),
    error => error instanceof PaidGenerationError && error.code === 'BUDGET_EXCEEDED');
  await ledger.commit(first, 90_000);
  await assert.rejects(ledger.release(first, 'late failure'),
    error => error instanceof PaidGenerationError && error.code === 'BUDGET_SETTLEMENT_CONFLICT');
});

test('budget unknown holds capacity and cannot be submitted again', async () => {
  const ledger = budget();
  const reservation = await ledger.reserve({ workspaceId: WS, operationKey: 'tts:cue-1',
    provider: 'openai-compatible', model: 'tts-1', estimateMicros: 20_000, budgetLimitMicros: 100_000, currency: 'CNY' });
  const marked = await ledger.markUnknown(reservation, 'network result unknown');
  assert.throws(() => assertPaidGenerationReservation(ledger, marked, {
    workspaceId: WS, operationKey: 'tts:cue-1', provider: 'openai-compatible', model: 'tts-1',
    estimateMicros: 20_000, currency: 'CNY',
  }), error => error instanceof PaidGenerationError && error.code === 'BUDGET_RESERVATION_NOT_OPEN');
  const again = await ledger.reserve({ workspaceId: WS, operationKey: 'tts:cue-1',
    provider: 'openai-compatible', model: 'tts-1', estimateMicros: 20_000, budgetLimitMicros: 100_000, currency: 'CNY' });
  assert.equal(again.status, 'unknown');
});

test('concurrent identical reservations share one hold', async () => {
  const ledger = budget();
  const input = { workspaceId: WS, operationKey: 'comfy:prompt-1', provider: 'comfyui', model: 'sdxl',
    estimateMicros: 5_000, budgetLimitMicros: 50_000, currency: 'CNY' };
  const reservations = await Promise.all(Array.from({ length: 8 }, () => ledger.reserve(input)));
  assert.equal(new Set(reservations.map(item => item.id)).size, 1);
  assert.equal(reservations[0].status, 'reserved');
});
