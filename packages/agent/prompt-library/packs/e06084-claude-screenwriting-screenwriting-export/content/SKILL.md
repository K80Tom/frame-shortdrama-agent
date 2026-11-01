---
description: >
  导出故事材料为特定格式。支持一页式大纲、人物表、剧本骨架、完整包。
  Triggers on: "/screenwriting-export", "导出", "export outline", "export characters".
---

# /screenwriting-export — 导出文档

## 用法

```
/screenwriting-export outline     — 一页式大纲（logline + 15 beats 概要）
/screenwriting-export characters  — 人物表（所有角色卡精简版）
/screenwriting-export screenplay  — 剧本骨架（beat → 场景映射）
/screenwriting-export full        — 以上全部打包
```

## 输出位置

导出文件存入 `exports/` 目录：
- `exports/大纲-{故事名}-{日期}.md`
- `exports/人物表-{故事名}-{日期}.md`
- `exports/剧本骨架-{故事名}-{日期}.md`

## 参数

| 参数 | 说明 |
|------|------|
| `--lang zh` | 中文输出（默认） |
| `--lang en` | 英文输出 |
