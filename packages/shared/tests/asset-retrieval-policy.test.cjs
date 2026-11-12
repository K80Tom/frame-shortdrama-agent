const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_ASSET_RETRIEVAL_POLICY,
  DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY,
  assetRetrievalPolicyDigest,
} = require('../dist/asset-retrieval.js');

test('frozen default asset policy keeps its canonical digest without computing it at module load', () => {
  assert.equal(DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY.policyDigest,
    assetRetrievalPolicyDigest(DEFAULT_ASSET_RETRIEVAL_POLICY));
  assert.equal(DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY.registryRevision, 0);
  assert.equal(DEFAULT_FROZEN_ASSET_RETRIEVAL_POLICY.sourceCandidateId, null);
});
