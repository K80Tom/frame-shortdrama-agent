---
description: >
  基于现有故事版本，创造性地重新构想故事（调整主角、故事线、世界观等），
  按 3 阶段流水线生成全新版本（Meta → Characters → Beats），
  每阶段可确认后再进下一步，保存为独立版本不覆盖原版。
  Triggers on: "/screenwriting-reimagine", "重新构想", "再创作", "reimagine",
  "新版本", "换主角", "改故事线", "adapt".
---

# Screenwriting Reimagine

基于已有故事素材，按 **3 阶段流水线** 创造性地重新构想故事核心。每阶段的输出是下一阶段的输入约束，确保结构一致性。

## 与其他 Skill 的区别

| Skill | 功能 | 模式 |
|-------|------|------|
| `/screenwriting-ingest` | 从素材中**提取** | 3 阶段提取（confidence 标注） |
| `/screenwriting-refactor` | 在约束下**微调** | Diff 修改（Hard Rules 严格约束） |
| `/screenwriting-reimagine` | 创造性**重构** | 3 阶段生成（理论约束 + 创作自由） |

## 3 阶段流水线

```
Stage 1: Meta 定位 (genre + logline + theme)
    ↓ 用户确认
Stage 2: 人物设计 (角色卡 + 人物关系 canvas)
    ↓ 用户确认（支持增删改循环）
Stage 3: 故事线节拍表 (15 beats + 故事线 canvas)
    ↓ 用户确认
写入版本目录
```

可加 `--full` 参数跳过中间确认，一次性全生成。

---

## Step 0: 读取现有版本

1. 读取 `wiki/meta/logline.md` + `wiki/meta/genre.md` + `wiki/meta/theme.md`
2. 读取 `wiki/characters/` — 获取所有角色设定
3. 读取 `wiki/beats/` — 获取当前 15-beat 结构
4. 读取 `wiki/故事线.canvas` + `wiki/人物关系.canvas`

汇总为"**原版概要**"，向用户展示后接收创作方向。

---

## Stage 1: Meta 定位

**输入**: 原版概要 + 用户创作方向
**输出**: genre + logline + theme + tone + comparable_works

### 流程

1. **确定 genre**（Save the Cat 10 大类型，必选其一）
   - 屋里有怪物 / 金羊毛 / 如愿以偿 / 麻烦家伙 / 成长仪式
   - 伙伴情 / 推理侦探 / 傻瓜成功 / 被制度化 / 超级英雄
   - 这决定了整个故事的"引擎"，后续角色和 beats 必须兑现类型承诺

2. **撰写 logline**（一句话，最多 50 字）
   - 公式: 一个[有缺陷的主角]，在[催化事件]后，必须[行动目标]，否则[赌注]
   - 必须包含讽刺性（irony）

3. **确定 theme**（题材类型标签，1-3 个）
   - 从标准标签中选: 剧情/喜剧/动作/爱情/惊悚/犯罪/悬疑/科幻 等
   - 第一个为主标签，用于视频平台归类

4. **补充**: tone（基调）、comparable_works（2-3 部对标作品）

### 展示与确认

```
Stage 1 完成 — Meta 定位:

  Genre: {STC 10选1}
  Logline: {一句话故事}
  Theme: {题材标签 1-3个}
  基调: {tone}
  对标: {作品名}

确认？(y/进入 Stage 2 | r/调整 | n/取消)
```

### 理论约束

- genre 必须从 Save the Cat 10 种中选 1（见 `references/genre-constraints.md`）
- logline 必须体现 irony，一句话最多 50 字
- theme 从标准题材标签中选 1-3 个
- genre（结构引擎）和 theme（题材标签）应匹配（如"推理侦探"对应"悬疑/犯罪"）

---

## Stage 2: 人物设计

**输入**: Stage 1 的 meta 定位 + 用户方向
**输出**: N 个角色卡 + 人物关系.canvas

### 流程

1. **查询类型约束**：读取 `references/genre-constraints.md` 中对应 genre 的角色约束
2. **设计角色网络**：基于类型约束 + 创作方向确定角色列表
3. **生成角色卡**（每个角色 3 层结构）：
   - Tab 1 人物塑像: 性别、年龄、外表/行为/社会身份标签
   - Tab 2 人物真相: wants、needs、shard_of_glass、contradiction、arc_type
   - Tab 3 人物维度: big_five、virtues、six_flaws、backstory、relationships
4. **生成人物关系 canvas**
5. **校验**：类型约束的"必须"角色是否都存在？主角 wants ≠ needs？

### 角色生成规则

- 原型必须从标准列表选择: hero / mentor / ally / shadow / shapeshifter / guardian / herald / trickster / other
- `tab2_truth` 中 wants/needs/motivation/shard_of_glass 为**必填**
- `tab2_truth.contradiction` (surface + truth) 为**必填**
- `tab2_truth.arc_type` 为**必填**
- `tab3_dimensions.big_five` 5 项全部填写（1-5）
- `evidence` 写明与原版角色的关系

### 展示与确认

```
Stage 2 完成 — 角色网络 ({N}人):

  - {name} ({archetype}) — {一句话定位}
  - ...

  类型约束校验: ✅ 满足 {genre} 的角色要求

确认？(y/进入 Stage 3 | add/增加角色 | del/删除角色 | edit/修改角色 | r/全部重新生成)
```

### 增删改循环

用户可在 Stage 2 反复调整角色，每次调整触发：
- **增加**: 确定原型+功能 → 生成角色卡 → 更新关系 canvas → 校验类型约束
- **删除**: 确认功能转移方案 → 移除角色卡 → 更新关系 canvas → 校验类型约束
- **修改**: 更新角色卡指定字段 → 更新关系 canvas 边标签 → 标记受影响的 beats（如已存在）

满意后输入 `y` 进入 Stage 3。

---

## Stage 3: 故事线节拍表

**输入**: Stage 1 meta + Stage 2 角色表
**输出**: 15 beats + 故事线.canvas

### 流程

1. **读取类型引擎约束**：查 `references/genre-constraints.md` 中对应 genre 的 beat 约束
2. **构建 beat 骨架**：基于类型引擎确定各 beat 的结构功能
3. **分配角色**：基于角色的 wants/needs/arc 将角色分配到各 beat
4. **生成 beat 内容**：每个 beat 填写 content/emotion/conflict/value_shift
5. **生成故事线 canvas**
6. **校验**：
   - Beat 8 是否兑现类型承诺？
   - Opening Image / Final Image 是否形成对比？
   - 主角的 arc 在 beats 中是否有清晰轨迹？

### Beat 生成规则

- 15 个 beat 全部生成，`beat_number` 为 1-15
- `content` 必须具体（写出事件/情节，不写抽象结构说明）
- `emotion` / `conflict` / `value_shift` 必须填写
- `characters_involved` 引用 Stage 2 的角色名
- `confidence` 统一设为 `"medium"`
- `evidence` 写明与原版的关系

### 展示与确认

```
Stage 3 完成 — 15-Beat 节拍表:

  第一幕 (1-6): {一句话}
  第二幕 (7-12): {一句话}
  第三幕 (13-15): {一句话}

  类型承诺校验:
    ✅ Beat 8 兑现 {genre} 承诺
    ✅ Opening/Final Image 对比
    ✅ 主角弧光轨迹完整

确认写入？(y/写入版本 | r/调整某个beat | n/取消)
```

---

## 写入版本

用户确认后，将完整版本写入 wiki：

### 目录结构

```
wiki/versions/reimagine-v{N}-{YYYYMMDD}/
├── beats/
│   ├── beat-01-开场画面.md
│   ├── ...
│   └── beat-15-终场画面.md
├── characters/
│   ├── {角色1}.md
│   └── ...
├── meta/
│   ├── logline.md
│   ├── genre.md
│   └── theme.md
├── 故事线.canvas
├── 人物关系.canvas
└── README.md
```

### 写入规则

1. Beat 用 `_templates/beat-card.md` 模板
2. 角色用 `_templates/character-card.md` 模板
3. Meta 用 `_templates/genre.md` + `_templates/logline.md` + `_templates/theme.md` 模板
4. Canvas 用 `_templates/storyline-canvas.md` + `_templates/character-canvas.md` 规则
5. 所有页面 `source` frontmatter 标注为 `"reimagine-v{N}-{YYYYMMDD}"`
6. **不修改原版任何文件**

### 写入顺序（防超时，必须严格遵守）

分 3 批写入，每批完成后确认再继续：

```
批次 1: meta/ (3 files) + characters/ (N files)
批次 2: beats/ (15 files)
批次 3: 故事线.canvas + 人物关系.canvas + README.md
```

**重要**:
- 如果上下文已经很长（如前面有大量确认交互），在批次 2 完成后**主动告知用户**已完成文本内容，Canvas 文件将在下一轮对话中生成，避免超时。
- Canvas 生成时**直接套用模板坐标**（`_templates/storyline-canvas.md` 中的坐标速查表），只替换 `"file"` 路径中的 beat 文件名，不要重新计算坐标。
- 人物关系 canvas 根据角色数量选择最近的布局参考，均匀分配坐标即可。

### 版本目录只包含内容文件

| 允许 | 禁止 |
|------|------|
| beats/ | hot.md |
| characters/ | log.md |
| meta/ (logline + genre + theme) | index.md |
| 故事线.canvas | sources/ |
| 人物关系.canvas | |
| README.md | |

### 更新索引

在 `wiki/log.md` 追加操作记录。

---

## 质量标准

### 结构完整性

1. 15-beat 全部填写且逻辑连贯
2. 主角 wants ≠ needs（内在张力）
3. Beat 4 为外力催化事件
4. 主角有清晰的 arc_type 和 changes
5. Beat 8 兑现 genre 的类型承诺
6. Opening/Final Image 形成弧光对比
7. Theme 在 beats 中至少 3 处呼应

### 与 Ingest 对齐

1. Schema 格式完全一致（可被 ingest 下游流程消费）
2. 模板使用一致
3. Canvas 格式一致
4. Frontmatter 规范一致
5. Backlink 使用 `[[wikilink]]` 格式

### 不允许

- 生成空洞结构说明代替具体情节
- 无视用户的保留元素要求
- 生成与原版完全无关的故事
- 覆盖原版 wiki 文件

---

## 多轮迭代

生成版本后，用户可继续调整：

- 调整 Stage 1: "类型改为金羊毛" → 重新走 Stage 1-3
- 调整 Stage 2: "增加一个 trickster 角色" → 走 Stage 2 增加流程 → 级联 Stage 3
- 调整 Stage 3: "Beat 8 不够有趣" → 只调整指定 beat

每次调整保存为新 version（v2, v3...），保留完整历史。
