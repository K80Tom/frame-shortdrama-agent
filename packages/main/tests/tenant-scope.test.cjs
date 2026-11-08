const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TenantExecutionScope, applyDatabaseScope } = require('../dist/tenancy/scope');

const tenant = char => ({
  userId: `usr_${char.repeat(32)}`,
  workspaceId: `ws_${char.repeat(32)}`,
  role: 'owner',
  requestId: `request-tenant-${char.repeat(8)}`,
});
test('tenant execution scope is isolated across concurrent asynchronous work', async () => {
  const scope = new TenantExecutionScope();
  let releaseOne;
  const gateOne = new Promise(resolve => { releaseOne = resolve; });
  let releaseTwo;
  const gateTwo = new Promise(resolve => { releaseTwo = resolve; });
  const first = scope.runWithTenant(tenant('1'), async () => {
    await gateOne;
    return scope.current();
  });
  const second = scope.runWithTenant(tenant('2'), async () => {
    await gateTwo;
    return scope.current();
  });
  releaseTwo(); releaseOne();
  assert.equal((await first).tenant.workspaceId, tenant('1').workspaceId);
  assert.equal((await second).tenant.workspaceId, tenant('2').workspaceId);
  assert.equal(scope.current(), undefined);
});
test('tenant work cannot silently elevate itself to system authority', () => {
  const scope = new TenantExecutionScope();
  assert.throws(() => scope.runWithTenant(tenant('3'), () =>
    scope.runAsSystem('unsafe-escalation', () => undefined)), /Cannot elevate/u);
  assert.equal(scope.runAsSystem('worker-claim', () => scope.current().kind), 'system');
  assert.throws(() => scope.runAsSystem('Not Valid', () => undefined), /Invalid/u);
});
test('database scope uses transaction-local settings and defaults to fail closed', async () => {
  const calls = [];
  const client = { async query(text, values) { calls.push({ text, values }); return { rows: [] }; } };
  await applyDatabaseScope(client, { kind: 'tenant', tenant: tenant('4') });
  await applyDatabaseScope(client, { kind: 'system', reason: 'migration' });
  await applyDatabaseScope(client, undefined);
  assert.deepEqual(calls[0].values, [tenant('4').workspaceId, tenant('4').userId, tenant('4').requestId]);
  assert.deepEqual(calls[1].values, ['on']);
  assert.deepEqual(calls[2].values, ['off']);
  assert.match(calls[0].text, /set_config\('lyra\.workspace_id'/u);
  assert.match(calls[0].text, /set_config\('lyra\.system_bypass', 'off'/u);
});
