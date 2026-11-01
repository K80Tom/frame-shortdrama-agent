/**
 * 3D 导演台 · 上传 GLTF 模型（Wave 2 · presentational）
 *
 * 签名 `({object}: {object: UploadedModelObject})`，由 StageCanvas 包进 SceneObjectNode。
 * object.assetUrl 是 URL.createObjectURL 的浏览器内地址，经 useLoader(GLTFLoader) 加载
 * （three 0.185 的 examples/jsm 路径；类型由 @types/three 提供）。
 *
 * 加载后归一化（对齐 HTML 原型 handleModelFile，按任务规格调整阈值）：
 * 1. 克隆场景（SkeletonUtils.clone，useLoader 按 url 缓存，复制对象会共享同一 gltf.scene，
 *    直接 primitive 会互抢父节点；克隆同时兼容带骨骼的模型）
 * 2. 全部网格 castShadow + receiveShadow
 * 3. 计算包围盒：最大边超过 3m 时等比缩到 3m（缩完再算一次盒）
 * 4. 底面贴地（minY → 0）+ 水平居中，满足契约「group 原点 = 对象落地中心点」
 *
 * 加载失败由 ModelGuard（Suspense + ErrorBoundary）捕获并上报 asset-load-store；
 * 加载成功（归一化完成）同样上报 done，资产面板据此解除「加载中」进度态。
 */
import { useEffect, useMemo } from "react";
import { useLoader } from "@react-three/fiber";
import { Box3, Vector3 } from "three";
import type { Mesh } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

import { useAssetLoadStore } from "../asset-load-store";
import type { UploadedModelObject } from "../types";

/** 模型最大边上限（米），超过则等比缩到该值 */
const MAX_DIM = 3;

export function UploadedModel({ object }: { object: UploadedModelObject }) {
  const gltf = useLoader(GLTFLoader, object.assetUrl);

  const normalized = useMemo(() => {
    const inner = cloneSkeleton(gltf.scene);
    inner.traverse((node) => {
      if ((node as Mesh).isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });

    const box = new Box3().setFromObject(inner);
    const size = box.getSize(new Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    // 空模型 / 退化包围盒不缩放，防止除零
    if (Number.isFinite(maxDim) && maxDim > MAX_DIM) {
      inner.scale.multiplyScalar(MAX_DIM / maxDim);
    }

    // 缩放后重算包围盒：水平居中 + 底面贴地
    const grounded = new Box3().setFromObject(inner);
    if (!grounded.isEmpty()) {
      const center = grounded.getCenter(new Vector3());
      inner.position.x -= center.x;
      inner.position.z -= center.z;
      inner.position.y -= grounded.min.y;
    }
    return inner;
  }, [gltf.scene]);

  // 归一化完成即加载成功：上报 asset-load-store 解除资产面板的进度态（无记录时静默忽略）
  useEffect(() => {
    useAssetLoadStore.getState().done(object.assetUrl);
  }, [normalized, object.assetUrl]);

  return <primitive object={normalized} />;
}
