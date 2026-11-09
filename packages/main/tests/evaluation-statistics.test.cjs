// Shared contract tests are discovered by the Stage 1 backend test runner.
require('../../shared/tests/evaluation-statistics.test.cjs');

const {test}=require('node:test');
const assert=require('node:assert/strict');
const shared=require('@lyra/shared');

test('main consumes statistics and the merged Canvas/frozen-production contracts from the same shared public entry',()=>{
  assert.equal(shared.EVALUATION_STATISTICS_VERSION,'lyra-evaluation-statistics/1');
  assert.equal(shared.SHOT_SPEC_SCHEMA_VERSION,'lyra-shot-spec/2');
  assert.equal(shared.PRODUCTION_INPUT_SCHEMA_VERSION,'lyra-production-input/1');
  assert.equal(shared.CANVAS_SCHEMA_VERSION,1);
  for(const name of ['aggregateMetricSamples','parseCanvasCommandBatch','parseShotSpecV2',
    'parseProductionInputSnapshot','parseDirectorSceneVersion'])assert.equal(typeof shared[name],'function',name);
  const result=shared.aggregateMetricSamples([{sampleId:'planned-one',status:'pass',value:1}],{expectedCount:2,minimumSamples:1});
  assert.equal(result.status,'uncertain');
  assert.equal(result.missingCount,1);
  assert.equal(result.passDenominator,2);
  assert.equal(result.passRate,0.5,'a missing planned result cannot disappear at the package boundary');
});
