import { createSeedSceneState, type SceneStateSlice } from './store';
import type { SceneObject, Vec3 } from './types';

/** Hand-arranged rehearsal; character blocking and cameras are design suggestions. */
export function sampleScene(): SceneStateSlice {
  const transform = (position: Vec3, rotation: Vec3 = [0, 0, 0]) => ({ position, rotation, scale: [1, 1, 1] as Vec3 });
  const items: SceneObject[] = [
    { id: 'sample-xiao', type: 'mannequin', name: '萧炎 · 站位', visible: true, transform: transform([-1, 0.06, 0], [0, 65, 0]), bodyType: 'male', color: '#B9C1CA', pose: 'stand', joints: {} },
    { id: 'sample-nalan', type: 'mannequin', name: '纳兰嫣然 · 站位', visible: true, transform: transform([1, 0.06, 0], [0, -65, 0]), bodyType: 'female', color: '#E2B197', pose: 'stand', joints: {} },
    { id: 'sample-platform', type: 'geometry', name: '广场台基', visible: true, transform: transform([0, 0, 0]), shape: 'box', size: [6, 0.06, 4], color: '#777773' },
    { id: 'sample-column-1', type: 'geometry', name: '左侧石柱', visible: true, transform: transform([-2.7, 0.06, -1.6]), shape: 'cylinder', size: [0.35, 2.8, 0.35], color: '#AAA9A2' },
    { id: 'sample-column-2', type: 'geometry', name: '右侧石柱', visible: true, transform: transform([2.7, 0.06, -1.6]), shape: 'cylinder', size: [0.35, 2.8, 0.35], color: '#AAA9A2' },
    { id: 'sample-camera-1', type: 'camera', name: '01 · 双人同框', visible: true, transform: transform([0, 1.7, 7]), target: [0, 1.05, 0], focalLength: 24 },
    { id: 'sample-camera-2', type: 'camera', name: '02 · 萧炎近景', visible: true, transform: transform([0.4, 1.4, 1.5]), target: [-1, 1.05, 0], focalLength: 50 },
    { id: 'sample-camera-3', type: 'camera', name: '03 · 纳兰近景', visible: true, transform: transform([-0.4, 1.4, 1.5]), target: [1, 1.05, 0], focalLength: 50 },
  ];
  return { ...createSeedSceneState(), objects: Object.fromEntries(items.map(item => [item.id, item])), order: items.map(item => item.id), activeCameraId: 'sample-camera-1', scene: { ...createSeedSceneState().scene, skyColor: '#292B2E' } };
}
