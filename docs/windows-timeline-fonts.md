# Windows 时间线字体修复

日期：2026-11-06；分支：dev；适用基线：890cc36 / 0.1.0。
跟踪：[交付 #69](https://github.com/K80Tom/frame-shortdrama-agent/issues/69)，父 Epic [#16](https://github.com/K80Tom/frame-shortdrama-agent/issues/16)。
Owner：@K80Tom（仓库默认维护责任）。本增量状态 implemented，整个 #69 仍为 partial。

## 问题与实现

原时间线合成只查找 macOS/Linux 字体，在 Windows 上即使 FFmpeg 支持 drawtext 也会产生无文字片头/片尾。
新增[内部字体工具](../packages/main/src/production-media/timeline-fonts.ts)：

- Windows 优先查找 SystemRoot 下的微软雅黑、黑体、Arial；其他平台保留原候选顺序。
- SystemRoot 必须是本地盘符绝对路径，拒绝网络位置及滤镜控制字符；非法值回退默认系统目录。
- FFmpeg 参数统一使用正斜线并转义盘符冒号，防止盘符被解释为 drawtext 参数分隔符。
- 无可读字体或无 drawtext 时保留原有纯色卡降级，不改变卡片时长、交叉淡入淡出或合片幂等性。
- 后端构造选项可注入字体候选供单测使用，不接受客户端字体路径；路径不写入交付 manifest。

原成功渲染单测改用临时字体文件和桩 runner，不再依赖运行测试的机器预装字体。
[新增回归](../packages/main/tests/production-media.test.cjs)覆盖 Windows/Unix 候选、Unicode 系统目录、非法根目录、缺字体回退和盘符转义。

## 验证命令

```powershell
npm run setup
$env:LYRA_TEST_FFMPEG='1'
node --test packages/main/tests/production-media.test.cjs
npm test
```

LYRA_TEST_FFMPEG=1 开启真实本地 FFmpeg 冒烟测试：使用系统字体渲染中文文本为 RGB 帧，检查成功退出、帧大小及可见文字像素。
默认 CI 不要求安装 FFmpeg，冒烟测试显式跳过；纯单元回归始终执行。真实模型/付费供应商未调用。

## 限制

不验证中文排版美感、完整字形覆盖、字体许可或逐像素可复现性，Arial 回退不保证所有中文字形。
未改变无字体时降级为无文字卡的既有策略；运行前能力诊断仍由 #74 跟进。
已保存 manifest 继续幂等复用，不自动覆盖历史交付。完整版本化配置、清单、工具版本与离线交付校验仍属 #69 后续范围。
本分支不依赖尚未合并的 #109，统一状态台账可在其合并后链接此验证记录。

## 本地执行记录

2026-11-06，Windows、Node 24.15.0、FFmpeg 9.0.2：

- 媒体定向回归（开启真实 FFmpeg）：30 项，29 通过、1 项符号链接权限测试跳过、0 失败。
- `LYRA_TEST_FFMPEG=1 npm test`：全部包构建通过；后端 576 项，573 通过、3 项平台相关跳过、0 失败；前端 105/105 通过。
- FFmpeg 冒烟验证的只是本地字体路径解析与文字像素渲染，不代表供应商、音视频语义或最终成片验收。
