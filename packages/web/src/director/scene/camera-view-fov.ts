/**
 * 3D 导演台 · 机位视角 FOV 换算（过扫描 WYSIWYG，B5 修复）
 *
 * 背景 bug：机位视角曾把相机 aspect 直接设为画幅值（如 9:16=0.5625），而画布
 * 仍是宽屏——three.js 按相机 aspect 投影后铺满整个画布，画面被横向拉伸变形。
 *
 * 正确做法（本模块唯一公式）：相机 aspect 始终跟随画布（不拉伸），FOV 按画幅
 * 等效放大——遮幅区域内的视角与真实机位完全一致，遮幅区域外是过扫描余量
 * （FrameOverlays 的遮幅矩形正好框住画幅区）。
 *
 * 推导：真实机位垂直 FOV = vfov_real。当画布比画幅更窄（竖画布装横画幅）时，
 * 画幅区贴满画布左右边，水平视角必须等于真实机位水平视角：
 *   tan(camVfov/2) · canvasAspect = tan(vfov_real/2) · frameAspect
 * 画布比画幅宽时（宽画布装竖画幅），画幅区贴满上下边，camVfov = vfov_real。
 * 统一为 scale = max(1, frameAspect / canvasAspect)。
 *
 * 纯函数、零 three 依赖，node:test 直接 import（见 camera-view-fov.test.ts）。
 */

/**
 * 机位视角相机垂直 FOV（角度制）。
 * @param vfovDeg 真实机位垂直 FOV（focalToVfov 输出，角度）
 * @param frameAspect 画幅宽高比（如 9:16 = 0.5625；auto 档传画布比）
 * @param canvasAspect 画布实际宽高比（size.width / size.height）
 */
export function cameraViewFov(vfovDeg: number, frameAspect: number, canvasAspect: number): number {
  const safeCanvas = Math.max(1e-6, canvasAspect);
  const scale = Math.max(1, frameAspect / safeCanvas);
  return 2 * Math.atan(Math.tan((vfovDeg * Math.PI) / 360) * scale) * (180 / Math.PI);
}
