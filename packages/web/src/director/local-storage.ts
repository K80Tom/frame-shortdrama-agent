import { fromSceneSnapshot, toSceneSnapshot, type DirectorSceneSnapshot } from './snapshot';
import { useDirectorStore } from './store';

const DATABASE = 'frame-director-v1';
const STORE = 'scenes';
const KEY = 'personal-scene';

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(new Error('浏览器存储无法打开，请导出场景留存。'));
    request.onblocked = () => reject(new Error('存储升级被其他页面占用，请关闭其他工作台后重试。'));
    request.onsuccess = () => resolve(request.result);
  });
}

export async function readSavedScene(): Promise<unknown | undefined> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readonly');
      const request = transaction.objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('场景读取失败。原保存内容未改动。'));
    });
  } finally { db.close(); }
}

export async function persistScene(snapshot: DirectorSceneSnapshot): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(snapshot, KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(new Error('保存失败，存储空间可能不足。请导出场景留存。'));
    });
  } finally { db.close(); }
}

// Embed uploads so saved scenes and exported JSON stay editable after a refresh.
export async function readLocalFile(file: File, maxMB: number): Promise<string> {
  if (file.size > maxMB * 1024 * 1024) throw new Error(`文件过大，请使用 ${maxMB} MB 以内的文件。`);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('文件读取失败，请重新选择。'));
    reader.readAsDataURL(file);
  });
}

export function parseLocalScene(input: unknown) {
  const result = fromSceneSnapshot(input);
  if (result.skippedUnknown.length || result.skippedEphemeral.length) {
    throw new Error('场景含有无法恢复的对象，请使用本工作台导出的完整场景。');
  }
  for (const object of Object.values(result.slice.objects)) {
    if (object.type === 'model' && !/^data:[^,]*;base64,/.test(object.assetUrl)) {
      throw new Error('场景中的模型需要内嵌保存，请重新上传 GLB。');
    }
  }
  const panorama = result.slice.scene.panoramaUrl;
  if (panorama && !/^data:image\/(png|jpeg|webp);base64,/.test(panorama)) {
    throw new Error('全景背景需要是内嵌的 PNG、JPG 或 WebP 图片。');
  }
  return result.slice;
}

export const currentSnapshot = () => toSceneSnapshot(useDirectorStore.getState());
