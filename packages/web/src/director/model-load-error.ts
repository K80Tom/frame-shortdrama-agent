export function humanModelLoadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/404|not found/i.test(message)) return "模型文件不存在或已下架";
  if (/failed to fetch|networkerror|cors|network/i.test(message)) return "网络异常，模型下载失败";
  if (/parse|invalid|unexpected|json/i.test(message)) return "模型文件损坏，无法解析";
  return "模型加载失败，请重试";
}
