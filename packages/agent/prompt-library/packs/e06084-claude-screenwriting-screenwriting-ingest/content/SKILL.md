---
description: >
  从素材文件中提取结构化故事元素，按 3 阶段流水线输出（Meta → Characters → Beats），
  写入 Obsidian wiki 页面并维护 backlinks，同时生成故事线和人物关系 Canvas。
  Triggers on: "/screenwriting-ingest", "导入素材", "摄入", "ingest".
---

# Screenwriting Ingest

将原始素材（大纲、笔记、剧本、反馈意见等）转化为结构化的故事 wiki 页面。按 3 阶段流水线提取，每阶段可确认后再继续。

## 3 阶段提取流水线

```
Stage 1: 提取 Meta 定位 (genre + logline + theme)
    ↓ 用户确认
Stage 2: 提取 Characters (角色卡 + 人物关系 canvas)
    ↓ 用户确认
Stage 3: 提取 Beats (15-beat + 故事线 canvas)
    ↓ 用户确认
写入 wiki
```

与 reimagine 的区别：ingest 是**提取**（从素材中识别已有信息），reimagine 是**生成**（创造性构想新内容）。因此 ingest 的每个元素都有 `confidence` 标注和 `evidence` 原文支撑。

---

## Step 0: 读取与分析素材

1. 读取指定素材文件全文
2. 判断素材类型：
   - **大纲型**: 有完整或部分情节线（可提取 beats）
   - **角色型**: 侧重人物描写（可提取 characters）
   - **反馈型**: 他人意见或修改建议（提取 meta/建议）
   - **混合型**: 以上兼有

---

## Stage 1: 提取 Meta 定位

**输入**: 原始素材
**输出**: genre + logline + theme + tone + comparable_works

### 提取规则

1. **genre**: 判断故事属于 Save the Cat 10 大类型中的哪一个
   - 必须从 10 种中选 1（屋里有怪物/金羊毛/如愿以偿/麻烦家伙/成长仪式/伙伴情/推理侦探/傻瓜成功/被制度化/超级英雄）
   - 如果无法确定，标注 confidence: low 并给出最可能的选项

2. **logline**: 从素材中提炼一句话故事（最多 50 字）
   - 公式: 一个[主角特征] + [催化事件] + [目标] + [赌注]
   - 如素材不完整无法提炼，标注 confidence: low

3. **theme**: 选 1-3 个题材类型标签
   - 从标准标签选: 剧情/喜剧/动作/爱情/惊悚/犯罪/悬疑/科幻/恐怖/冒险/奇幻 等
   - 第一个为主标签

4. **tone**: 基调描述
5. **comparable_works**: 2-3 部对标作品名

### 展示与确认

```
Stage 1 — Meta 提取结果:

  Genre: {STC 10选1} (confidence: high/medium/low)
  Logline: {一句话故事}
  Theme: {题材标签 1-3个}
  基调: {tone}
  对标: {作品名}

  证据: "{原文片段}"

确认？(y/进入 Stage 2 | edit/修正某项 | r/重新提取)
```

---

## Stage 2: 提取 Characters

**输入**: 原始素材 + Stage 1 的 genre 定位
**输出**: N 个角色卡 + 人物关系.canvas

### 提取规则

1. **角色识别阈值**: 至少有名字 + 一个行为/描述才创建角色条目；纯提及不算
2. **原型判断**: 基于角色在故事中的功能判断原型
3. **提取优先级**:
   - 优先提取 Tab 2 核心: wants/needs/shard_of_glass/motivation
   - 其次提取 Tab 1: 外在特征
   - 最后提取 Tab 3: 性格/关系
4. **类型约束校验**: 对照 `references/genre-constraints.md`，检查提取到的角色是否满足 genre 的角色要求
5. **Null 优于猜测**: 无法从素材判断的字段设为 null

### 展示与确认

```
Stage 2 — 角色提取结果 ({N}人):

  - {name} ({archetype}, confidence: high) — {一句话}
  - ...

  类型约束: {满足/缺少 X 角色类型}

确认？(y/进入 Stage 3 | add/补充角色 | del/删除 | edit/修正 | r/重新提取)
```

用户可在此阶段补充素材中未明确但逻辑上需要的角色。

---

## Stage 3: 提取 Beats

**输入**: 原始素材 + Stage 1 meta + Stage 2 角色表
**输出**: 15 beats + 故事线.canvas

### 提取规则

1. 识别故事事件并尝试映射到 15-beat 位置
2. 不确定位置的事件标记为 `beat_number: null`
3. 提取: 事件内容、情绪、涉及角色、冲突、价值转变
4. **类型引擎校验**: 对照 genre 的 beat 约束检查
5. 素材不完整时，缺失的 beat 标注 `status: empty`

### 展示与确认

```
Stage 3 — Beat 提取结果:

  | # | Beat | 状态 | 内容概要 |
  |---|------|------|---------|
  | 1 | 开场画面 | ✅ | ... |
  | 2 | 主题陈述 | ⚠️ low | ... |
  | ... |
  | 8 | 游戏时间 | ⬜ | (素材未覆盖) |

  完成度: {X}/15
  类型承诺: {Beat 8 是否兑现 genre 承诺}

确认写入？(y/写入 wiki | edit/修正 | r/重新提取)
```

---

## 写入 Wiki

用户确认后，按以下规则写入：

### 文件生成

| 内容 | 路径 | 模板 |
|------|------|------|
| Beat 卡片 | `wiki/beats/beat-{XX}-{名称}.md` | `_templates/beat-card.md` |
| 角色卡 | `wiki/characters/{名称}.md` | `_templates/character-card.md` |
| Logline | `wiki/meta/logline.md` | `_templates/logline.md` |
| Genre | `wiki/meta/genre.md` | `_templates/genre.md` |
| Theme | `wiki/meta/theme.md` | `_templates/theme.md` |
| 素材摘要 | `wiki/sources/source-{文件名}.md` | — |
| 故事线 | `wiki/故事线.canvas` | `_templates/storyline-canvas.md` |
| 人物关系 | `wiki/人物关系.canvas` | `_templates/character-canvas.md` |

### Canvas 生成

1. **`wiki/故事线.canvas`** — Beat 时间线，按三幕分行排列
2. **`wiki/人物关系.canvas`** — 角色关系网络，Hero 居中

### 更新索引

1. 更新 `wiki/index.md` 中的 beats 表格和角色列表
2. 在 `wiki/log.md` 追加操作记录

---

## 合并策略

当已有内容存在时：

| 情况 | 策略 |
|------|------|
| Beat 位置已有内容 | 展示旧+新，用户选择覆盖/合并/跳过 |
| 角色名已存在 | 自动合并新字段到已有卡片（不覆盖已填字段） |
| Logline/Theme 已存在 | 展示两个版本，用户选择 |
| Source 已 ingest 过 | 提示"已导入过该素材" |

---

## 质量标准

- 每个提取元素必须有 `evidence`（原文支撑片段）
- 不确定的内容标记 `confidence: low` 或 `status: uncertain`
- 素材中未提及的字段留空（null），不用通用模板话术填充
- genre 必须从 Save the Cat 10 种中选 1，不能自创
- logline 必须是一句话（最多 50 字）
- theme 是题材标签（1-3 个），不是一句话陈述
