/**
 * 3D 导演台 · 模型加载守卫（W5.5 · 资产库 GLB 入台的错误兜底）
 *
 * UploadedModel 的 useLoader 语义是「加载期挂起、失败抛出」；本组件提供
 * Suspense + ErrorBoundary 的标准配对：
 * - 独立 Suspense（fallback=null）：单个模型加载中不拖挂整个场景层
 *   （StageCanvas 外层 Suspense 仍在，这里是模型级细粒度）；
 * - ErrorBoundary：加载失败（404/网络/解析）只隐藏该模型节点，
 *   不连坐整个画布，并把人话错误上报 asset-load-store（资产面板据此显示失败态）；
 * - retry 重挂载：以 entry.attempt 为 key，attempt +1 时 ErrorBoundary 与
 *   UploadedModel 整体重建，配合 useLoader.clear 后重新拉取。
 */
import { Component, Suspense } from "react";
import type { ReactNode } from "react";

import { humanModelLoadError } from "../model-load-error";
import { useAssetLoadStore } from "../asset-load-store";
import type { UploadedModelObject } from "../types";
import { UploadedModel } from "./UploadedModel";

interface ModelErrorBoundaryProps {
  url: string;
  children?: ReactNode;
}

interface ModelErrorBoundaryState {
  failed: boolean;
}

class ModelErrorBoundary extends Component<ModelErrorBoundaryProps, ModelErrorBoundaryState> {
  state: ModelErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ModelErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    useAssetLoadStore.getState().fail(this.props.url, humanModelLoadError(error));
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export function ModelGuard({ object }: { object: UploadedModelObject }) {
  const attempt = useAssetLoadStore((state) => state.byUrl[object.assetUrl]?.attempt ?? 0);
  return (
    <ModelErrorBoundary key={attempt} url={object.assetUrl}>
      <Suspense fallback={null}>
        <UploadedModel object={object} />
      </Suspense>
    </ModelErrorBoundary>
  );
}
