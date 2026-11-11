import { ModelError } from '@lyra/shared';
import { assertExecutionBinding, bindingForConnection } from './execution-binding';
import { DoubaoImageClient, SeedanceVideoClient, type MediaClientConfig } from './media-client';

export function createImageModelClient(config: MediaClientConfig): DoubaoImageClient {
  const binding = assertExecutionBinding('image', config.endpoint, config.model,
    config.executionBinding ?? bindingForConnection('image', config.endpoint, config.model));
  switch (binding.adapter) {
    case 'ark-image': return new DoubaoImageClient({ ...config, executionBinding: binding });
    default: throw new ModelError(400, 'MEDIA_PROTOCOL_UNSUPPORTED', '没有匹配的图片执行适配器，未调用供应商。');
  }
}

export function createVideoModelClient(config: MediaClientConfig): SeedanceVideoClient {
  const binding = assertExecutionBinding('video', config.endpoint, config.model,
    config.executionBinding ?? bindingForConnection('video', config.endpoint, config.model));
  switch (binding.adapter) {
    case 'ark-video': return new SeedanceVideoClient({ ...config, executionBinding: binding });
    default: throw new ModelError(400, 'MEDIA_PROTOCOL_UNSUPPORTED', '没有匹配的视频执行适配器，未调用供应商。');
  }
}
