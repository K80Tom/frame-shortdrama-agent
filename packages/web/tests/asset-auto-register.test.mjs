import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoRegisterCandidates, requirementAssetInput, unboundAssetRequirements } from '../src/asset-auto-register.ts';

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

test('需求清单隐藏已绑定资产，只保留缺失和歧义需求', () => {
  const requirements = [
    { ...base, requirementId: 'missing', match: { assetId: null, ambiguous: false, alternatives: [] } },
    { ...base, requirementId: 'bound', match: { assetId: 'asset_1', ambiguous: false, alternatives: [] } },
    { ...base, requirementId: 'ambiguous', match: { assetId: null, ambiguous: true, alternatives: [{ id: 'a' }] } },
  ];
  assert.deepEqual(unboundAssetRequirements(requirements).map(item => item.requirementId), ['missing', 'ambiguous']);
});

test('自动入库复用需求类型与名称，并标注占位素材', () => {
  const input = requirementAssetInput({ kind: 'character', name: '老林' });
  assert.equal(input.kind, 'character');
  assert.equal(input.name, '老林');
  assert.match(input.description, /占位图/);
  assert.match(input.description, /替换为正式素材/);
});

test('无关资产需求通过不可变候选移除，并在人工确认后才采用', () => {
  const view = readFileSync(new URL('../src/ProjectAssetsWorkspace.tsx', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../src/project-workspace-api.ts', import.meta.url), 'utf8');
  assert.match(view, /data-testid="asset-requirement-remove"/);
  assert.match(view, /removeFactPlanEntities/);
  assert.match(view, /checkFactPlan/);
  assert.match(view, /adoptFactPlan/);
  assert.match(view, /window\.confirm/);
  assert.match(view, /不会删除资产库记录/);
  assert.match(api, /removeEntities: entities/);
  assert.match(api, /expectedActivePlanRevisionId/);
  assert.match(api, /allowCheckWarnings/);
  assert.match(api, /export function adoptFactPlan[\s\S]*?method: 'POST', body: input,/);
  assert.doesNotMatch(api, /adoptFactPlan[\s\S]*?actor: 'user'/);
});
