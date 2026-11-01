const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PiExtractFactsStageExecutor } = require('../dist/breakdown/pi-executor');

const context = {
  schemaVersion: 'extract-facts-context/1', runId: 'run_test', taskId: 'task_test',
  requirements: {}, inputManifest: {}, chunks: [{ id: 'chunk_0001', boundaryBefore: 'start',
    sectionHeadingAlias: null, evidence: [{ alias: 'E001', role: 'primary', kind: 'line',
      quote: '林晚：你好。', speakerCandidate: '林晚' }] }],
};

test('Pi Agent Core executes one recorded extractFacts call and returns parsed JSON', async () => {
  let calls = 0;
  const result = await new PiExtractFactsStageExecutor().execute(context, {
    async call(payload) {
      calls++;
      assert.equal(payload.operation, 'extractFacts');
      assert.match(payload.messages[0].content, /林晚：你好/);
      return { synopsis: null, characters: [], locations: [], props: [], scenes: [], dialogues: [] };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { synopsis: null, characters: [], locations: [], props: [], scenes: [], dialogues: [] });
});

test('Pi Agent Core does not retry a failed recorded call', async () => {
  let calls = 0;
  await assert.rejects(() => new PiExtractFactsStageExecutor().execute(context, {
    async call() { calls++; throw new Error('private upstream body'); },
  }));
  assert.equal(calls, 1);
});
