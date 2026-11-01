# Lyra 首页落地决策（2026-11-01 实施）

在 MASTER.md 基础上，首页采用以下已实施方案；后续页面沿用同一语言。

## 色彩映射

- 全局底色统一为深夜蓝黑：`--bg: #0a0d16`（`style.css`、`workspace.css`），环境层 `:root` 背景 `#070a12`（`ambient.css`）。
- 品牌 accent 统一为星图淡金 `#E8C878`：`--orange` / `--orange-dim` 变量改值不改名，全站自动继承；`workspace.css` 原黄绿 `#d3f57b` 全部替换为金色。
- 保留用户已有的紫蓝极光环境层（`ambient.tsx`），金色只用于品牌与关键交互，不与极光争色。

## 首页结构（WorkspaceHome.tsx + home.css）

- `home-hero` 替代原 create-banner：金色 eyebrow `LYRA · STORY STUDIO`、品牌句「每一集短剧，都是一颗新星。」、副文、金色胶囊 CTA「新建创作项目」；背景为蓝黑渐变 + 星点纹理 + `lyra-mark.svg` 低透明水印（16%）。
- 快捷工具卡：蓝黑渐变底，hover 金色描边 + 图标变金 + 上浮 3px。
- 最近项目 / 特色功能 / 创作参考卡：hover 上浮 2–3px + 金边 + 投影。
- 分节标题：3px 金色竖条装饰；参考分类选中态金色下划线。
- 分层入场：`home-rise` 0.55s，各 section 依次延迟 70ms；`prefers-reduced-motion` 下全部停用入场与悬浮位移。

## 字体

- `index.html` 引入 Inter（300–700），中文继续 PingFang SC / 系统字体；`theme-color` 改为 `#070a12`。

## 验证

- 前端 95/95 测试通过；生产构建通过；dev server 于 `packages/web` 重启（5173）。
- 无头 Chrome 1440×900 截图核验 hero 与卡片排版；`docs/media/home.png` 同步更新（位于 `packages/main/docs/media/`）。
