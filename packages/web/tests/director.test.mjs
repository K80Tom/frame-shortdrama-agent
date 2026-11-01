import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { sampleScene } = await server.ssrLoadModule('/src/director/sample-scene.ts');
const { toSceneSnapshot } = await server.ssrLoadModule('/src/director/snapshot.ts');
const { parseLocalScene } = await server.ssrLoadModule('/src/director/local-storage.ts');
const { useDirectorStore } = await server.ssrLoadModule('/src/director/store.ts');

test('edited pose, transforms, cameras, and embedded uploads survive JSON round trip', () => {
  const scene = sampleScene();
  scene.objects['sample-xiao'].pose = 'arms-crossed';
  scene.objects['sample-xiao'].joints = { head: [10, 15, 0] };
  scene.objects['sample-xiao'].transform.position = [-1.25, 0.1, 0.5];
  scene.objects['sample-camera-2'].focalLength = 85;
  scene.scene.panoramaUrl = 'data:image/png;base64,dGVzdA==';
  scene.objects['local-model'] = { id: 'local-model', type: 'model', name: '上传模型', visible: true,
    assetUrl: 'data:model/gltf-binary;base64,dGVzdA==', fileName: 'test.glb',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } };
  scene.order.push('local-model');
  const snapshot = toSceneSnapshot(scene);
  const restored = parseLocalScene(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored.objects, scene.objects);
  assert.deepEqual(restored.order, scene.order);
  assert.equal(restored.scene.panoramaUrl, scene.scene.panoramaUrl);
  assert.equal(restored.aspect, '9:16');
  useDirectorStore.getState().replaceSceneState(restored);
  const id = useDirectorStore.getState().addCamera();
  assert.equal(useDirectorStore.getState().order.length, scene.order.length + 1);
  assert.ok(!scene.order.includes(id));
});

test('invalid or non-portable scene cannot silently replace existing work', () => {
  const previous = useDirectorStore.getState().objects;
  assert.throws(() => parseLocalScene({ schemaVersion: 99, objects: [] }));
  const snapshot = toSceneSnapshot(sampleScene());
  snapshot.ui.scene.panoramaUrl = 'https://example.com/remote.jpg';
  assert.throws(() => parseLocalScene(snapshot), /内嵌/);
  assert.equal(useDirectorStore.getState().objects, previous);
});
