/**
 * 3D 导演台 · 缩略图工具（S6）
 *
 * 把画布内容等比缩到小尺寸 JPEG dataURL——参考清单条目的 thumbUrl 用。
 * 走 dataURL 而不是 blob object URL：归入条目会落 localStorage（本机归组机制），
 * object URL 刷新即失效会变成破图，dataURL 可持久（192px JPEG 约 8-15KB）。
 */
export function canvasThumbDataUrl(source: HTMLCanvasElement, maxWidth = 192): string | null {
  try {
    if (source.width <= 0 || source.height <= 0) return null;
    const scale = Math.min(1, maxWidth / source.width);
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(source, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch (error: unknown) {
    console.warn("[director] 缩略图生成失败", error);
    return null;
  }
}
