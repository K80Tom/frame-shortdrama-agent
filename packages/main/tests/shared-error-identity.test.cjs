const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dirname, sep } = require('node:path');

function reloadShared() {
  const entry = require.resolve('@lyra/shared');
  const dist = dirname(entry) + sep;
  for (const loaded of Object.keys(require.cache)) {
    if (loaded === entry || loaded.startsWith(dist)) delete require.cache[loaded];
  }
  return require('@lyra/shared');
}

test('shared domain errors retain instanceof identity across physical package copies', () => {
  const first = reloadShared();
  const modelError = new first.ModelError(503, 'MODEL_NOT_CONFIGURED', 'not configured');
  const novelError = new first.NovelError(409, 'NOVEL_ADAPTATION_INCOMPLETE', 'not ready');
  const second = reloadShared();

  assert.notEqual(first.ModelError, second.ModelError);
  assert.notEqual(first.NovelError, second.NovelError);
  assert.equal(modelError instanceof second.ModelError, true);
  assert.equal(novelError instanceof second.NovelError, true);
  assert.equal(new Error('ordinary') instanceof second.ModelError, false);
  assert.equal({ code: modelError.code, message: modelError.message } instanceof second.ModelError, false);

  const brand = Symbol.for('@lyra/shared/error/ModelError/v1');
  const nonError = { [brand]: true, status: 503, code: 'MODEL_NOT_CONFIGURED', message: 'forged', details: {} };
  assert.equal(nonError instanceof second.ModelError, false);
  for (const invalid of [
    { status: 200, code: 'MODEL_NOT_CONFIGURED' },
    { status: 503, code: 'model-not-configured' },
    { status: 503, code: 'MODEL_NOT_CONFIGURED', details: [] },
  ]) {
    const forged = Object.assign(new Error('forged'), { details: {}, ...invalid });
    Object.defineProperty(forged, brand, { value: true });
    assert.equal(forged instanceof second.ModelError, false);
  }
});
