# Lyra 提示词方法包库（prompt-library）

把外部短剧 SKILL.md 的**方法论**沉淀为 Lyra 可加载、可切换、可评测的提示词资产。
这里只有**文本与元数据**，不包含也不执行任何第三方脚本。

## 渐进式披露 + 中心注册

- **中心注册**：所有包在 `index.json` 登记（名称、阶段、适用模型、许可、质量、默认开关）。
- **渐进式披露**：界面与模型都只在需要时展开对应包——未选中的包不会进入任何提示词。
- **按需注入**：`buildPromptPackInjection({ stage, packIds })` 只把选中包的内容拼入对应阶段的提示词；`packIds` 为空时不产生任何注入。

## 目录规范

```
prompt-library/
  index.json                 # 总目录（中心注册表）
  packs/<pack-id>/
    pack.json                # 元数据：阶段/模型/许可/质量/入口
    source.json              # 原仓库 URL + commit + 同步时间（用于增量更新）
    LICENSE                  # 原包许可证
    content/                 # 提取的文本方法论（SKILL.md、references、templates）
```

### pack.json 字段

| 字段 | 含义 |
| --- | --- |
| `id` | 唯一标识（与目录名一致） |
| `name` / `summary` | 展示名称与用途简介 |
| `stages` | 可注入阶段：`topic / adaptation / character / episode-outline / script / script-review / storyboard / video-prompt / production` |
| `models` | 适用模型，`["*"]` 表示通用 |
| `license` | `MIT / Apache-2.0 / CC0 / CC-BY-4.0` 可整合；`CC-BY-NC-*` 标记商用受限；无许可不复制内容 |
| `quality` | `unevaluated`（未评测）或 `evaluated`（离线对照通过） |
| `enabledByDefault` | 是否默认启用，**入库一律 false**，评测后再打开 |
| `entry` | 注入时读取的主文档（相对包目录） |

## 边界与安全

1. `agent` 只提供方法包内容与拼接逻辑，**不持密钥、不连数据库、不调用模型**；由 `main` 在对应阶段加载注入。
2. 入库内容视为**参考资料**，注入时明确其不替代系统指令、不触发任何外部操作或付费行为。
3. 许可逐包审查并保留 `LICENSE` 与来源链接；第三方脚本、安装器一律不入库。
