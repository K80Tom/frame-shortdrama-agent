const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DataEventContractError,
  assertDataEventDigest,
  dataEventDigest,
  dataEventIdempotencyKey,
  parseDataEventV1,
} = require('@lyra/shared');

const hex = value => value.repeat(64);
const id = (prefix, char) => `${prefix}_${char.repeat(32)}`;
const eventFixture = () => ({
  eventId: id('evt', 'a'),
  eventType: 'production.run.succeeded',
  schemaVersion: 'lyra.production.run/v1',
  aggregateType: 'production_run',
  aggregateId: 'run_001',
  aggregateVersion: 3,
  occurredAt: '2026-11-03T00:00:00.000Z',
  recordedAt: '2026-11-03T00:00:01.000Z',
  correlationId: 'corr_0001',
  causationId: id('evt', 'b'),
  idempotencyKey: 'production_run:run_001:3:production.run.succeeded',
  authoritativeRef: { kind: 'production_run', id: 'run_001', revisionId: null, digest: hex('c') },
  payload: { status: 'completed', attemptCount: 1, costMicros: 0 },
});

function assertCode(action, code, path) {
  assert.throws(action, error => {
    assert.ok(error instanceof DataEventContractError);
    assert.equal(error.code, code, error.message);
    if (path) assert.ok(error.details.some(item => item.path.endsWith(path)), JSON.stringify(error.details));
    return true;
  });
}

test('DataEventV1 解析、摘要稳定且 payload 只含最小字段', () => {
  const event = parseDataEventV1(eventFixture());
  assert.equal(event.aggregateType, 'production_run');
  assert.equal(event.aggregateVersion, 3);
  assert.equal(dataEventDigest(event).length, 64);
  const reordered = eventFixture();
  reordered.payload = { costMicros: 0, attemptCount: 1, status: 'completed' };
  assert.equal(dataEventDigest(parseDataEventV1(reordered)), dataEventDigest(event));
  assert.equal(dataEventIdempotencyKey('production_run', 'run_001', 3, 'production.run.succeeded'),
    event.idempotencyKey);
});

test('缺权威摘要、非法 schema、非法事件类型、版本和时间都拒绝', () => {
  const noDigest = eventFixture();
  delete noDigest.authoritativeRef.digest;
  assertCode(() => parseDataEventV1(noDigest), 'DATA_EVENT_INPUT_INVALID', 'authoritativeRef.digest');
  const badSchema = { ...eventFixture(), schemaVersion: 'production-run-v1' };
  assertCode(() => parseDataEventV1(badSchema), 'DATA_EVENT_INPUT_INVALID', 'schemaVersion');
  const badType = { ...eventFixture(), eventType: 'ProductionRunSucceeded' };
  assertCode(() => parseDataEventV1(badType), 'DATA_EVENT_INPUT_INVALID', 'eventType');
  const badVersion = { ...eventFixture(), aggregateVersion: 0 };
  assertCode(() => parseDataEventV1(badVersion), 'DATA_EVENT_INPUT_INVALID', 'aggregateVersion');
  const badTime = { ...eventFixture(), occurredAt: '2026-11-03T00:00:02.000Z' };
  assertCode(() => parseDataEventV1(badTime), 'DATA_EVENT_INPUT_INVALID', 'occurredAt');
  const badCausation = { ...eventFixture(), causationId: 'evt_bad' };
  assertCode(() => parseDataEventV1(badCausation), 'DATA_EVENT_INPUT_INVALID', 'causationId');
});

test('敏感字段与敏感值在 payload 内被拒绝', () => {
  const apiKey = eventFixture();
  apiKey.payload.apiKey = 'sk-abcdefghijklmnopqrstuvwx';
  assertCode(() => parseDataEventV1(apiKey), 'DATA_EVENT_SENSITIVE_FIELD', 'payload.apiKey');
  const raw = eventFixture();
  raw.payload.content = '整章正文';
  assertCode(() => parseDataEventV1(raw), 'DATA_EVENT_SENSITIVE_FIELD', 'payload.content');
  const signed = eventFixture();
  signed.payload.artifactUrl = 'https://example.test/a?X-Amz-Signature=abc';
  assertCode(() => parseDataEventV1(signed), 'DATA_EVENT_SENSITIVE_FIELD', 'payload.artifactUrl');
  const absolute = eventFixture();
  absolute.payload.artifactPath = '/Users/lqc/Downloads/asset.bin';
  assertCode(() => parseDataEventV1(absolute), 'DATA_EVENT_SENSITIVE_FIELD', 'payload.artifactPath');
});

test('payload 拒绝嵌套对象、超长数组和超长字符串', () => {
  const nested = eventFixture();
  nested.payload.meta = { status: 'completed' };
  assertCode(() => parseDataEventV1(nested), 'DATA_EVENT_INPUT_INVALID', 'payload.meta');
  const longArray = eventFixture();
  longArray.payload.ids = Array.from({ length: 17 }, (_, index) => `id-${index}`);
  assertCode(() => parseDataEventV1(longArray), 'DATA_EVENT_INPUT_INVALID', 'payload.ids');
  const longString = eventFixture();
  longString.payload.summary = 'x'.repeat(513);
  assertCode(() => parseDataEventV1(longString), 'DATA_EVENT_INPUT_INVALID', 'payload.summary');
  const badKey = eventFixture();
  badKey.payload['bad-key'] = 1;
  assertCode(() => parseDataEventV1(badKey), 'DATA_EVENT_INPUT_INVALID', 'payload.bad-key');
});

test('事件摘要覆盖业务内容，摘要不一致会被拒绝', () => {
  const event = parseDataEventV1(eventFixture());
  assert.doesNotThrow(() => assertDataEventDigest(event, dataEventDigest(event)));
  assertCode(() => assertDataEventDigest(event, hex('d')), 'DATA_EVENT_DIGEST_MISMATCH', 'eventDigest');
  const changed = { ...event, payload: { ...event.payload, status: 'failed' } };
  assert.notEqual(dataEventDigest(event), dataEventDigest(changed));
});

test('聚合版本与幂等键必须可定位到同一事实', () => {
  const event = parseDataEventV1(eventFixture());
  assert.equal(event.aggregateVersion, 3);
  assertCode(() => parseDataEventV1({ ...eventFixture(), idempotencyKey: 'short' }),
    'DATA_EVENT_INPUT_INVALID', 'idempotencyKey');
  const duplicateVersion = { ...eventFixture(), eventId: id('evt', 'd') };
  assert.equal(parseDataEventV1(duplicateVersion).aggregateVersion, event.aggregateVersion);
  assert.notEqual(parseDataEventV1(duplicateVersion).eventId, event.eventId);
});
