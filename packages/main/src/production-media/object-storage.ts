import type { ObjectDescriptor, ObjectStorage, ObjectStorageScope } from '../infrastructure/object-storage';
import { ProductionMediaError, parseMediaId, type LocalVideoObject } from './contracts';
import type { ProductionMediaStore } from './store';

/**
 * Explicit idempotent projection between the existing verified local media
 * store and object storage. It is intentionally not called from putVideoBuffer:
 * a PostgreSQL Outbox consumer/worker must coordinate projection and metadata.
 */
export class ProductionMediaObjectProjection {
  constructor(private readonly local: ProductionMediaStore, private readonly objects: ObjectStorage) {}

  async project(scope: ObjectStorageScope, mediaIdValue: unknown): Promise<ObjectDescriptor> {
    const mediaId = parseMediaId(mediaIdValue);
    const content = await this.local.content(mediaId);
    const key = objectKey(content.object);
    const descriptor = await this.objects.put({ scope, key, body: content.bytes,
      contentType: content.object.mimeType, expectedSha256: content.object.sha256 });
    if (descriptor.sha256 !== content.object.sha256 || descriptor.size !== content.object.bytes) {
      throw new ProductionMediaError(409, 'OBJECT_MEDIA_VERIFICATION_FAILED',
        '对象存储中的视频与本地已校验媒体不一致。');
    }
    return descriptor;
  }

  /** Restores the local rollback/work copy and re-runs ffprobe plus media limits. */
  async restore(scope: ObjectStorageScope, reference: Pick<ObjectDescriptor, 'key' | 'sha256' | 'size'> & Partial<Pick<ObjectDescriptor,'versionId'>>):
  Promise<LocalVideoObject> {
    if (!reference || !Number.isSafeInteger(reference.size) || reference.size < 1
      || reference.size > this.local.limits.maxBytes) {
      throw new ProductionMediaError(409, 'OBJECT_MEDIA_REFERENCE_INVALID', '对象媒体引用无效。');
    }
    const result = await this.objects.get({ scope, key: reference.key,
      expectedSha256: reference.sha256, maxBytes: this.local.limits.maxBytes,...(reference.versionId!=null?{providerVersionId:reference.versionId}:{}) });
    if (result.body.length !== reference.size || result.object.size !== reference.size || reference.versionId!=null&&result.object.versionId!==reference.versionId) {
      throw new ProductionMediaError(409, 'OBJECT_MEDIA_VERIFICATION_FAILED',
        '对象存储中的视频大小与登记信息不一致。');
    }
    const restored = await this.local.putVideoBuffer(result.body, 'ownedFile');
    if (restored.sha256 !== reference.sha256) {
      throw new ProductionMediaError(409, 'OBJECT_MEDIA_VERIFICATION_FAILED',
        '恢复后的视频与登记校验值不一致。');
    }
    return restored;
  }
}

export function objectKey(media: Pick<LocalVideoObject, 'sha256'>): string {
  if (!media || !/^[a-f0-9]{64}$/u.test(media.sha256)) {
    throw new ProductionMediaError(409, 'OBJECT_MEDIA_REFERENCE_INVALID', '对象媒体校验值无效。');
  }
  return `production-media/objects/${media.sha256.slice(0, 2)}/${media.sha256}.mp4`;
}
