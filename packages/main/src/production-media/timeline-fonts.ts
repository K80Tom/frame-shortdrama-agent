import { access } from 'node:fs/promises';
import { win32 } from 'node:path';

/** 后端本机字体候选，不来自 HTTP 参数，不写入交付 manifest。 */
export function timelineFontCandidates(
  platform: string = process.platform,
  systemRoot: string = process.env.SystemRoot ?? 'C:\\Windows',
): string[] {
  const unix = [
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/System/Library/Fonts/Supplemental/Songti.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  ];
  if (platform !== 'win32') return unix;
  // 仅接受本地盘符绝对路径，拒绝网络字体与滤镜语法。
  const root = /^[a-z]:[\\/][\p{L}\p{N}_ .\\/-]+$/iu.test(systemRoot)
    && !/[\r\n]/u.test(systemRoot) ? systemRoot : 'C:\\Windows';
  return ['msyh.ttc', 'simhei.ttf', 'arial.ttf'].map(name =>
    win32.join(root, 'Fonts', name).replace(/\\/g, '/'));
}

export async function findTimelineFont(
  candidates: readonly string[],
  readable: (path: string) => Promise<boolean> = path => access(path).then(() => true, () => false),
): Promise<string | null> {
  for (const candidate of candidates) {
    if (await readable(candidate)) return candidate;
  }
  return null;
}

/** 盘符冒号需在 drawtext 参数内转义，拒绝额外滤镜语法。 */
export function timelineFontFilterPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.startsWith('//') || /[\r\n]/u.test(normalized)
    || !/^(?:[a-z]:)?\/[\p{L}\p{N}_ ./-]+$/iu.test(normalized)) {
    throw new TypeError('时间线字体路径无效。');
  }
  return normalized.replace(/:/g, '\\:');
}
