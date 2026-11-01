import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { compatibleProfiles, profileDraft, copyProfileDraft, profilePayload, validateProfileDraft, modelSettingsApi } = await server.ssrLoadModule('/src/model-connections.ts');
const { ProfileCard, RoleSelection } = await server.ssrLoadModule('/src/ModelLibrary.tsx');
const names = ['DeepSeek', 'Kimi K3', 'GPT-5.6 Sol', 'GPT-5.6 Terra'];
const profiles = names.map((name, i) => ({ id: `model_${i}`, name, model: name === 'DeepSeek' ? 'deepseek-v4.1-flash-1017' : name === 'Kimi K3' ? 'kimi-k3' : name,
  kind: 'text', endpoint: `https://private-${i}.test/v1/chat/completions`, authType: i === 0 ? 'api-key' : 'bearer',
  hasApiKey: true, configured: true, revision: `revision_${i}`, maxOutputTokens: 8192, timeoutMs: 180000, source: 'local', execution: 'text', roles: i === 1 ? ['breakdown'] : [] }));
const image = { ...profiles[0], id: 'image_profile', name: '专用生图', kind: 'image' };
const video = { ...profiles[0], id: 'video_profile', name: '专用视频', kind: 'video' };
const connection = { ...profiles[1], role: 'breakdown', profileId: profiles[1].id, profileName: profiles[1].name };
const noop = () => {};

test('text selectors include all four models by stable profile ID and media selectors never include text profiles', () => {
  const all = [...profiles, image, video];
  assert.deepEqual(compatibleProfiles(all, 'breakdown').map(p => p.id), profiles.map(p => p.id));
  assert.deepEqual(compatibleProfiles(all, 'general').map(p => p.id), profiles.map(p => p.id));
  assert.deepEqual(compatibleProfiles(all, 'image').map(p => p.id), [image.id]);
  assert.deepEqual(compatibleProfiles(all, 'video').map(p => p.id), [video.id]);
  const html = renderToStaticMarkup(createElement(RoleSelection, { item: connection, profiles: all, selectedId: profiles[0].id,
    busy: false, onChange: noop, onApply: noop, onAdd: noop }));
  for (const name of names) assert.ok(html.includes(name));
  assert.ok(html.includes('选择尚未应用')); assert.ok(html.includes('应用到此用途'));
  assert.equal(html.includes(image.name), false); assert.equal(html.includes(video.name), false);
  const imageHtml = renderToStaticMarkup(createElement(RoleSelection, { item: { ...connection, role: 'image', profileId: null, profileName: null },
    profiles, selectedId: '', busy: false, onChange: noop, onApply: noop, onAdd: noop }));
  assert.ok(imageHtml.includes('资产生图已接入')); assert.ok(imageHtml.includes('添加此类连接'));
  for (const name of names) assert.equal(imageHtml.includes(name), false);
});

test('library cards show model, assignment and safe credential status without embedding endpoint or secrets', () => {
  const html = renderToStaticMarkup(createElement(ProfileCard, { profile: { ...profiles[1], apiKey: 'never-render-test-key' }, disabled: false, onEdit: noop, onCopy: noop }));
  assert.ok(html.includes('Kimi K3')); assert.ok(html.includes('kimi-k3')); assert.ok(html.includes('密钥已保存'));
  assert.ok(html.includes('拆解模型正在使用')); assert.ok(html.includes('复制连接'));
  assert.equal(html.includes('private-1.test'), false); assert.equal(html.includes('never-render-test-key'), false);
  assert.equal(html.includes('<img'), false);
});

test('profile drafts support editing, creation and server-side credential reuse without retrieving a key', () => {
  const sol = profiles[2]; const draft = profileDraft(sol);
  assert.equal(draft.name, 'GPT-5.6 Sol'); assert.equal(draft.apiKey, '');
  assert.equal(validateProfileDraft(draft), null);
  assert.equal(profilePayload(draft, sol).expectedRevision, sol.revision);
  const copy = { ...copyProfileDraft(sol), name: 'GPT-5.6 Terra', model: 'GPT-5.6 Terra' };
  assert.deepEqual(copy.copyCredentialsFrom, { profileId: sol.id, revision: sol.revision });
  assert.equal(copy.apiKey, ''); assert.equal(validateProfileDraft(copy), null);
  assert.equal(profilePayload(copy).expectedRevision, undefined);
  assert.ok(validateProfileDraft({ ...copy, apiKey: 'test-key' }));
  assert.ok(validateProfileDraft({ ...draft, name: '  ' }));
  assert.ok(validateProfileDraft({ ...draft, name: 'bad\nname' }));
  const media = profileDraft(undefined, 'video');
  assert.equal(media.kind, 'video'); assert.equal(media.apiKey, '');
});

test('selection requests send only profile identity and expected role version, never a credential', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    requests.push({ path, options }); return new Response(JSON.stringify({ profiles, connections: [] }));
  });
  await modelSettingsApi('/api/model-assignments/breakdown', { profileId: profiles[0].id, expectedRevision: 'old-role' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, 'POST'); assert.equal(requests[0].options.cache, 'no-store');
  assert.equal(requests[0].options.headers['X-Shortdrama-Call'], '1');
  assert.deepEqual(JSON.parse(requests[0].options.body), { profileId: profiles[0].id, expectedRevision: 'old-role' });
});

test('novel and storyboard requests bind model spending consent to the displayed connection revision', async () => {
  for (const file of ['NovelBreakdown.tsx', 'production.tsx']) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.ok(source.includes('expectedModelConnectionRevision:'));
  }
});
