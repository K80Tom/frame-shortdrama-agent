# 界面参考与第三方代码

更新：2026-10-12（同步仓库改名，保留原始来源记录）。

## 实际复用的代码

### React Bits · SpotlightCard

- 作者：David Haz。
- 官方项目：https://github.com/DavidHDev/react-bits
- 组件来源：https://github.com/DavidHDev/react-bits/tree/main/src/ts-default/Components/SpotlightCard
- 本地文件：`src/vendor/SpotlightCard.tsx`、`src/vendor/SpotlightCard.css`。
- 复用了官方 TypeScript 组件与 CSS 聚光实现，调整了样式、尺寸、暖橙配色和减少动态效果的处理。
- 原始许可完整保留在 `src/vendor/REACT_BITS_LICENSE.md`：MIT + Commons Clause。这里集成到应用中，不作为组件库转售。

### 用户指定仓库的 3D 导演台

- 仓库：[K80Tom/frame-shortdrama-agent](https://github.com/K80Tom/frame-shortdrama-agent)（原仓库名 `-`），本地来源提交 `e1f879204be39518f01e663f8025963112c87336`。
- 用户链接指向 `shortdrama-agent`，实际前端实现位于同仓的 `短剧Main/frontend/shortdrama-rag-demo/src/components/director/`。
- 按用户明确要求直接复制到 `src/director/`：人物骨架、体型与姿势、场景对象、相机、光照、坐标变换、属性面板、状态和快照、PNG/宫格/深度图/运镜录制逻辑。
- 本项目新增或修改：独立页面壳与路由、暖色与移动布局、手工练习场景、IndexedDB 保存、JSON 导入导出、内嵌本地上传媒体、导出预览；删除旧账号、HTTP API、远端模板清单与云素材库入口。未改动旧仓源码。
- Three.js 0.185.1、React Three Fiber 9.6.1、Drei 10.7.7、Zustand 5.0.14 由 npm 安装并锁定，许可证随依赖保留；后续分发应同时保留原代码与依赖的许可说明。
- 图片 `public/assets/duel.png` 沿用本项目的原有示意图。人物和资产卡片为同图裁切，不代表独立生成的资产。
- 原独立流程教学页 `../flow-explainer/` 保留既有 Three.js 0.180.0 简化演示；新 React 工作台已改用复制的导演台模块。

## 视觉与交互参考（自行实现）

| 来源 | 查看内容 | 在项目中的使用 |
|---|---|---|
| [MotionSites](https://motionsites.ai/) | 首页列出的 Hero、Landing Page 与 Features 设计类型 | 电影画面主视觉、大标题与行动入口的版式方向；没有获取或复制付费提示词。 |
| [React Bits 索引](https://reactbits.dev/get-started/index)、[Light Rays](https://reactbits.dev/c/backgrounds/light-rays) | 动画组件与光束背景 | 本项目首页用轻量 CSS 光效自行实现，未引入 Light Rays 的 WebGL 代码。 |
| [Aceternity Bento Grid](https://ui.aceternity.com/components/bento-grid) | 卡片分区与信息层级 | 首页创作入口、项目与流程区域；本项目自行实现 CSS 布局。 |
| [Aceternity File Upload](https://ui.aceternity.com/components/file-upload) | 拖拽上传交互 | 剧本 TXT 拖拽区；文件读取与反馈自行实现。 |
| [Aceternity Multi Step Loader](https://ui.aceternity.com/components/multi-step-loader) | 多步骤展示 | 参考其步骤可视化思路；本项目展示流程导航，不播放虚假的自动任务进度。 |
| [Uiverse · cssbuttons-io 按钮](https://uiverse.io/cssbuttons-io/massive-mayfly-74) | 简洁箭头按钮与悬停反馈 | 自行实现箭头位移、暖橙主按钮与次级按钮，没有复制该页面源码。 |

React、Vite、Motion 与 Lucide 等 npm 依赖的版本记录在 package-lock.json，各自许可证随依赖提供。
