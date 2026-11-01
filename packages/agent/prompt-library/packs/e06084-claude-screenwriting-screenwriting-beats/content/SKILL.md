---
description: >
  查看、编辑或 AI 生成 Save the Cat 15-beat 节拍表。
  生成时基于 genre 类型引擎约束和已有角色表驱动 beat 内容。
  Triggers on: "/screenwriting-beats", "节拍表", "beat sheet", "15 beats", "beat 表".
---

# /screenwriting-beats — 节拍表管理

## 用法

```
/screenwriting-beats              — 概览 15-beat 表格
/screenwriting-beats catalyst     — 深入查看某个 beat
/screenwriting-beats generate     — AI 生成完整 beat 表草稿
/screenwriting-beats validate     — 校验类型承诺是否兑现
```

## 概览输出格式

| # | Beat | 状态 | 一句话内容 |
|---|------|------|-----------|
| 1 | 开场画面 | ✅ | ... |
| 2 | 主题陈述 | ⬜ | — |
| ... | | | |

## Beat 名称映射

| 英文标识 | 中文名 |
|----------|--------|
| opening_image | 开场画面 |
| theme_stated | 主题陈述 |
| setup | 铺垫 |
| catalyst | 催化剂 |
| debate | 犹豫 |
| break_into_two | 进入第二幕 |
| b_story | B 故事 |
| fun_and_games | 游戏时间 |
| midpoint | 中点 |
| bad_guys_close_in | 反派逼近 |
| all_is_lost | 一无所有 |
| dark_night | 灵魂黑夜 |
| break_into_three | 进入第三幕 |
| finale | 终局 |
| final_image | 终场画面 |

---

## generate — AI 生成 Beat 表

### 前置条件

生成 beat 表**必须**基于已有的：
1. `wiki/meta/genre.md` — 确定类型引擎（必须存在）
2. `wiki/meta/logline.md` — 确定故事前提（必须存在）
3. `wiki/meta/theme.md` — 确定主题（建议存在）
4. `wiki/characters/` — 确定角色表（必须至少有 hero）

如果这些前置内容不存在，提示用户先完成 Stage 1 和 Stage 2：
```
⚠️ 生成 beat 表需要先完成:
  - [ ] Meta 定位 (genre + logline + theme)  → /screenwriting-reimagine 或手动创建
  - [ ] 角色设计 (至少 hero)                 → /screenwriting-character new
```

### 生成流程

1. 读取 genre → 查 `references/genre-constraints.md` 获取该类型的 beat 约束
2. 读取角色表 → 基于角色 wants/needs/arc 分配角色到各 beat
3. 生成 15 beat 内容：
   - `content`: 具体事件/情节（非抽象结构说明）
   - `emotion`: 情绪走向
   - `conflict`: 冲突描述
   - `value_shift`: 价值从X到Y
   - `characters_involved`: 涉及角色名
4. 校验类型承诺（见下方 validate）
5. 展示完整 beat 表给用户确认
6. 确认后写入 `wiki/beats/` + 更新 `wiki/故事线.canvas`

### 类型引擎驱动

每种 genre 的 beat 有特定功能要求（摘要）：

| Genre | Beat 8 必须兑现 | Beat 14 核心动作 |
|-------|----------------|-----------------|
| 屋里有怪物 | 被困+逃脱尝试 | 面对自身的"罪" |
| 金羊毛 | 旅途新奇遭遇 | 归来时已变 |
| 如愿以偿 | 享受新能力的爽感 | 放弃魔法/接受原本 |
| 麻烦家伙 | 以弱敌强的博弈 | 普通人非凡意志 |
| 成长仪式 | 与变化的挣扎 | 接受新阶段 |
| 伙伴情 | 两人化学反应 | 重新合一/有意义分离 |
| 推理侦探 | 线索拼图快感 | 揭露真相+承受代价 |
| 傻瓜成功 | 非常规方式小胜 | 以"傻"方式最终获胜 |
| 被制度化 | 体制内生存游戏 | 留下/离开/改造 |
| 超级英雄 | 能力展示奇观 | 接受能力与诅咒共存 |

完整约束见 `references/genre-constraints.md`。

---

## validate — 类型承诺校验

读取当前 beats + genre，逐条检查：

```
类型承诺校验 (genre: 推理侦探):

  ✅ Beat 4: 谜题出现 — "监控录像中出现不可能的影子"
  ✅ Beat 8: 线索拼图 — "三条线索指向同一个人，但动机不成立"
  ⚠️ Beat 9: 应有方向转折 — 当前内容缺乏关键线索揭示
  ✅ Beat 11: 侦探被牵入 — "翟发现自己的指纹出现在案发现场"
  ✅ Beat 14: 揭露+代价 — "真相大白但友情破裂"

  通过: 4/5 | 建议调整 Beat 9
```

---

## 行为细节

### 无参数（概览）
1. 读取 `wiki/beats/` 下所有 beat 文件
2. 输出 15-beat 表格
3. 标注缺失的 beat 和建议

### 指定 beat（深入）
1. 读取对应 beat 文件完整内容
2. 显示当前内容 + 类型约束提醒
3. 如内容为空，引导填写

### generate（AI 生成）
见上方详细流程。

### validate（校验）
见上方详细流程。

---

## 理论参考

- `references/theory-save-the-cat.md` — 15 beats 定义 + 10 大类型
- `references/genre-constraints.md` — 各类型对 beats 的具体约束
