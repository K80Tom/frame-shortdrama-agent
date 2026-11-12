import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { emptyScriptStructure } = await server.ssrLoadModule('/src/script-structure.ts');
const {
  clearScriptParsePreview, draftFromParseAttempt, readScriptParsePreview, writeScriptParsePreview,
} = await server.ssrLoadModule('/src/script-parse-preview.ts');

class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key) { return this.values.get(key) ?? null; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  removeItem(key) { this.values.delete(key); }
  setItem(key, value) { this.values.set(key, String(value)); }
}

test('未确认解析预览在刷新后可恢复，并按原文版本隔离', () => {
  const storage = new MemoryStorage();
  const structure = emptyScriptStructure();
  const draft = {
    attemptId: 'scriptparse_one', scriptVersionId: 'script_one', structure,
    characters: [{ name: '林澈', aliases: [], description: null }],
    locations: [{ name: '旧钟表店', aliases: [], description: null }],
    props: [{ name: '放大镜', aliases: [], description: '已人工核对' }],
  };
  assert.equal(writeScriptParsePreview(storage, 'project_one', draft), true);
  const restored = readScriptParsePreview(storage, 'project_one', 'script_one');
  assert.equal(restored.attemptId, 'scriptparse_one');
  assert.equal(restored.props[0].description, '已人工核对');
  assert.equal(readScriptParsePreview(storage, 'project_one', 'script_two'), null);
  clearScriptParsePreview(storage, 'project_one', 'script_one');
  assert.equal(readScriptParsePreview(storage, 'project_one', 'script_one'), null);
});

test('损坏草稿安全忽略，历史成功记录可重开且旧协议实体数组回退为空', () => {
  const storage = new MemoryStorage();
  storage.setItem('lyra.script-parse-preview.v1.project_one.script_one', '{broken');
  assert.equal(readScriptParsePreview(storage, 'project_one', 'script_one'), null);
  const attempt = {
    id: 'scriptparse_old', scriptVersionId: 'script_old', scriptVersion: 1,
    model: 'stub', promptVersion: 'script-parse/1', status: 'succeeded', errorCode: null,
    providerRequestId: null, usage: null, createdAt: '2026-11-12T00:00:00.000Z', endedAt: null,
    output: { structure: emptyScriptStructure(), characters: [] },
  };
  const draft = draftFromParseAttempt(attempt);
  assert.deepEqual(draft.locations, []);
  assert.deepEqual(draft.props, []);
  assert.equal(draftFromParseAttempt({ ...attempt, status: 'failed', output: null }), null);
});

test('非对白修复预览随本地草稿恢复，并保留原文范围与理由', () => {
  const storage = new MemoryStorage();
  const repair = {
    issueId: 'issue_one', kind: 'exclude', reason: '叙事说明，不是人物对白。',
    addedDialogues: [],
    exclusions: [{
      sourceRef: { scriptVersionId: 'script_one', start: 0, end: 12, quote: '老林有个怪脾气：只收钟点。' },
      reason: '叙事说明，不是人物对白。',
    }],
  };
  const draft = {
    attemptId: 'manual-dialogue-repair:issue_one', scriptVersionId: 'script_one',
    structure: emptyScriptStructure(), characters: [], locations: [], props: [],
    repair, promptVersion: 'manual-dialogue-repair/1',
  };
  assert.equal(writeScriptParsePreview(storage, 'project_one', draft), true);
  const restored = readScriptParsePreview(storage, 'project_one', 'script_one');
  assert.equal(restored.repair.kind, 'exclude');
  assert.equal(restored.repair.exclusions[0].sourceRef.start, 0);
  assert.equal(restored.promptVersion, 'manual-dialogue-repair/1');
});
