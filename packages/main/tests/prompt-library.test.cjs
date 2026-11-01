const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadPromptPacks,
  selectPromptPacks,
  buildPromptPackInjection,
} = require('@lyra/agent');
const { buildScriptReviewPrompt } = require('../dist/review/script-review-prompt');

const PACK_ID = 'screenwriter-skill-review';

test('prompt library registers the screenwriter review pack without enabling it', () => {
  const packs = loadPromptPacks();
  const pack = packs.find((candidate) => candidate.id === PACK_ID);
  assert.ok(pack, 'pack should be registered');
  assert.deepEqual(pack.stages, ['script-review']);
  assert.equal(pack.license, 'MIT');
  assert.equal(pack.enabledByDefault, false);
  assert.equal(selectPromptPacks({ stage: 'script-review' }).length, 0);
});

test('script review prompt stays unchanged when no pack is enabled', () => {
  const prompt = buildScriptReviewPrompt({ script: '第一集：主角被退婚。' });
  assert.equal(prompt.injectedPackIds.length, 0);
  assert.ok(!prompt.system.includes('创作方法包'));
  assert.ok(prompt.system.includes('剧本审稿助手'));
  assert.ok(prompt.user.includes('主角被退婚'));
});

test('enabling the pack injects the 38-rule review methodology on demand', () => {
  const baseline = buildScriptReviewPrompt({ script: '第一集：主角被退婚。' });
  const prompt = buildScriptReviewPrompt({
    script: '第一集：主角被退婚。',
    enabledPackIds: [PACK_ID],
  });
  assert.deepEqual(prompt.injectedPackIds, [PACK_ID]);
  assert.ok(prompt.system.includes('创作方法包（按需加载）'));
  assert.ok(prompt.system.includes('第一集决定生死'));
  assert.ok(prompt.system.includes('爽感必须兑现'));
  assert.ok(prompt.system.length > baseline.system.length + 5000);
  assert.equal(prompt.user, baseline.user, 'pack must not change the user payload');
});

test('pack selection validates unknown ids and stage mismatches', () => {
  assert.throws(
    () => buildPromptPackInjection({ stage: 'script-review', packIds: ['missing-pack'] }),
    /PROMPT_PACK_NOT_FOUND/,
  );
  assert.throws(
    () => buildPromptPackInjection({ stage: 'storyboard', packIds: [PACK_ID] }),
    /PROMPT_PACK_STAGE_MISMATCH/,
  );
});
