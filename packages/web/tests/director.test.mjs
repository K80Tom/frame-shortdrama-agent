import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => server.close());
const { sampleScene } = await server.ssrLoadModule('/src/director/sample-scene.ts');
const { toSceneSnapshot, fromSceneSnapshot } = await server.ssrLoadModule('/src/director/snapshot.ts');
const { parseLocalScene } = await server.ssrLoadModule('/src/director/local-storage.ts');
const { useDirectorStore } = await server.ssrLoadModule('/src/director/store.ts');
const { resolvePoseId } = await server.ssrLoadModule('/src/director/scene/poses.ts');

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

test('production whitebox lookback and degree yaw survive import', () => {
  assert.equal(resolvePoseId('turn'), 'stand');
  assert.equal(resolvePoseId('lookback'), 'think');
  const loaded = fromSceneSnapshot({
    schemaVersion: 1,
    objects: [{
      id: 'actor-1', type: 'mannequin', name: '沈玥', visible: true,
      transform: { position: { x: 0, y: 0.1, z: 0.25 }, rotation: { x: 0, y: 10.313, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      pose: { preset: 'lookback' }, attachments: [], bodyType: 'male', color: '#9AA0A8', joints: {},
    }, {
      id: 'platform-1', type: 'geometry', name: '地台', visible: true,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      attachments: [], shape: 'box', color: '#323841', size: [6, 0.2, 6],
    }],
    cameras: [{
      id: 'camera-1', type: 'camera', name: '主机位', visible: true, focalLength: 24,
      target: { x: 0, y: 1.25, z: 0 }, transform: { position: { x: 0, y: 1.65, z: 7.5 } },
    }],
    selectedObjectId: null, activeCameraId: 'camera-1', aspectRatio: '9:16',
    environment: { preset: 'night_cold', backgroundColor: '#15181E', ambientLight: 0.6, groundVisible: true },
    ui: { aspect: '9:16', viewMode: 'camera', overlays: { thirds: true, center: false, safeArea: true, nameTags: true },
      order: ['platform-1', 'actor-1', 'camera-1'],
      scene: { groundOpacity: 1, gridSnap: true, panoramaUrl: null, panoramaRotation: 0, panoramaRadius: 30 } },
  });
  assert.deepEqual(loaded.skippedUnknown, []);
  assert.equal(loaded.slice.objects['actor-1'].pose, 'lookback');
  assert.equal(resolvePoseId(loaded.slice.objects['actor-1'].pose), 'think');
  assert.deepEqual(loaded.slice.objects['actor-1'].transform.rotation, [0, 10.313, 0]);
  assert.equal(loaded.slice.objects['camera-1'].focalLength, 24);
  assert.equal(loaded.slice.environment, 'night_cold');
  assert.equal(loaded.slice.activeCameraId, 'camera-1');
  assert.equal(loaded.slice.viewMode, 'camera');
});

test('invalid or non-portable scene cannot silently replace existing work', () => {
  const previous = useDirectorStore.getState().objects;
  assert.throws(() => parseLocalScene({ schemaVersion: 99, objects: [] }));
  const snapshot = toSceneSnapshot(sampleScene());
  snapshot.ui.scene.panoramaUrl = 'https://example.com/remote.jpg';
  assert.throws(() => parseLocalScene(snapshot), /内嵌/);
  assert.equal(useDirectorStore.getState().objects, previous);
});
