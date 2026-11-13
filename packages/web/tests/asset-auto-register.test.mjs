import test from 'node:test';
import assert from 'node:assert/strict';
import { autoRegisterCandidates, requirementAssetInput } from '../src/asset-auto-register.ts';

const base = {
  requirementId: 'req_1', name: '老林', kind: 'character', sceneIds: ['s1'],
  action: { kind: 'create' },
};

test('只有未匹配且无歧义的需求可以一键入库', () => {
  const requirements = [
    { ...base, requirementId: 'missing', match: { assetId: null, ambiguous: false, alternatives: [] } },
    { ...base, requirementId: 'bound', match: { assetId: 'asset_1', ambiguous: false, alternatives: [] } },
    { ...base, requirementId: 'ambiguous', match: { assetId: null, ambiguous: true, alternatives: [{ id: 'a' }] } },
  ];
  assert.deepEqual(autoRegisterCandidates(requirements).map(item => item.requirementId), ['missing']);
  assert.deepEqual(autoRegisterCandidates([]), []);
});

test('自动入库复用需求类型与名称，并标注占位素材', () => {
  const input = requirementAssetInput({ kind: 'character', name: '老林' });
  assert.equal(input.kind, 'character');
  assert.equal(input.name, '老林');
  assert.match(input.description, /占位图/);
  assert.match(input.description, /替换为正式素材/);
});
