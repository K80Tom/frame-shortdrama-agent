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

## 2026-11-09 最新 dev 同步与真实 Composer 验证

本 PR 已同步 dev b264844，保留已合并冻结输入/Run、Canvas/Assistant 与媒体对象存储行为；没有把待审 #147/040、#132/042 或其它 PR 合入来制造通过。原 #69 已关闭，但这不等于本修复已合并、完整版本化交付或目标部署已验收。

- 路径工具额外拒绝 UNC 和 Windows 设备网络路径；字体选择仍是后端系统配置/构造选项，不新增客户端传入字体路径的能力。
- 扩充同一个显式开启的真实 FFmpeg 冒烟：除了手写 drawtext 帧，还实际调用 ProductionMediaStore + FfprobeVideoProber + TimelineComposer 生成 MP4，抽取片头和片尾稳定时刻的 RGB 帧，检查亮色字形像素、尺寸、ffprobe 时长、私有字体路径不进入 manifest，以及重复 compose 不再次执行 FFmpeg。
- 真实 Windows / Node 24.15.0 / FFmpeg 9.0.2；`LYRA_TEST_FFMPEG=1` 媒体回归 37 项：36pass / 1 项符号链接权限测试 skipped / 0fail。该显式开启的真实字体/Composer 测试实际执行并通过，不是桩。
- `LYRA_TEST_FFMPEG=1 npm test` 整体退出0：全包构建通过，后端720项717pass /3平台skipped /0fail；前端135/135。未删、跳过或放宽原 drawtext 渲染断言；纯单元成功用例使用明确的字体 fixture+桩 runner，以避免取决于测试主机字体，而真实集成另行承担真实渲染证明。
- 未设置环境开关时媒体套件37项35pass /2skipped /0fail：其中1个是平台符号链接、1个是公开标注的可选真实FFmpeg测试。默认CI的可选跳过不代表在Linux/macOS已做真实字体渲染。
- 前端测试的Vite依赖预扫描在测试server关闭时输出既有警告，已检查为“server is being restarted or closed”且测试退出0；不声称日志零警告。没有修改前端/测试关闭策略来隐藏它。

本轮本地不额外跑PG（无SQL/DB逻辑改动）；当前head CI数据库回归需独立验收。没有真实云/模型/付费调用，也没有字体许可、所有中文字形、排版美感、逐像素复现或完整项目生产E2E证明。未改变无字体时降级、已保存manifest幂等保护或预算/外部操作逻辑；不自动重绘历史交付。
