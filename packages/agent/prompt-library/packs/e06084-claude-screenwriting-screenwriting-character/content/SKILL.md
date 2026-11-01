---
description: >
  查看、创建或编辑角色卡。基于 Vogler 8 原型 + McKee 矛盾 + Save the Cat 四大支柱。
  3 层结构：人物塑像（外在）、人物真相（内在）、人物维度（结构）。
  支持增删改单个角色并全级联更新（人物关系 canvas + 故事线 beats）。
  Triggers on: "/screenwriting-character", "角色", "人物", "character card", "角色卡".
---

# /screenwriting-character — 角色卡管理

## 用法

```
/screenwriting-character              — 列出所有角色
/screenwriting-character 小明         — 查看/编辑角色「小明」
/screenwriting-character new          — 引导式创建新角色
/screenwriting-character del 小明     — 删除角色（带级联）
/screenwriting-character 小明 --deep  — 深度理论诊断
```

## 角色卡三层结构

### Tab 1: 人物塑像（外在可见）
性别、年龄、外表标签、行为标签、社会身份

### Tab 2: 人物真相（内在驱动）
Wants、Needs、Shard of Glass、矛盾（surface/truth）、压力选择、弧光

### Tab 3: 人物维度（结构指标）
大五人格、核心美德、六大缺陷、小传、关系网络

## 8 原型

Hero / Mentor / Ally / Shadow / Shapeshifter / Guardian / Herald / Trickster

## 类型约束

创建/编辑角色时，读取 `wiki/meta/genre.md` 获取当前 genre，对照 `references/genre-constraints.md` 检查：
- 当前角色网络是否满足 genre 的"必须"角色要求
- 新增/删除操作后是否仍满足

---

## CRUD 操作与级联更新

### 新增角色 (new)

```
流程:
1. 确定角色名 + 原型 + 功能定位
2. 引导填写三层结构（至少完成 Tab 2 核心字段）
3. 写入 wiki/characters/{name}.md
4. 级联更新:
   a. 更新 wiki/人物关系.canvas — 添加节点 + 与现有角色的关系边
   b. 扫描 wiki/beats/ — 识别该角色应参与的 beats
   c. 更新相关 beats 的 characters_involved + content
   d. 更新 wiki/故事线.canvas（如角色出现影响 beat 可视化）
5. 校验类型约束
```

### 删除角色 (del)

```
流程:
1. 读取该角色卡，分析其在故事中的功能
2. 扫描 wiki/beats/ 找出所有涉及该角色的 beats
3. 生成级联影响报告:

   ⚠️ 删除角色「小明」将影响:
   - 人物关系 canvas: 移除节点 + 3 条关系边
   - 涉及 beats: Beat 4, 7, 9, 11, 14 (5个)
   - 功能转移建议: 小明的 mentor 功能可转移给「老王」

4. 用户确认后执行:
   a. 删除 wiki/characters/{name}.md
   b. 更新 wiki/人物关系.canvas — 移除节点和相关边
   c. 重写受影响的 beats（功能转移或情节调整）
   d. 更新 wiki/故事线.canvas
5. 校验: 类型约束是否仍满足？主角弧光是否受影响？
```

### 修改角色 (edit)

```
流程:
1. 读取角色卡当前内容
2. 用户指定修改项（如 "wants 改为..." / "原型改为 shadow"）
3. 更新角色卡对应字段
4. 分析影响面:
   - 修改原型 → 关系 canvas 需更新（位置/边类型）
   - 修改 wants/needs → arc 相关 beats 需调整
   - 修改 contradiction → 与该角色有矛盾关系的 beats 需调整
   - 修改 relationships → 关系 canvas 边需更新
5. 生成级联影响报告 + diff 预览
6. 用户确认后执行级联更新
```

### 级联更新的展示模式（提案式）

所有级联更新采用**提案式**——先展示 diff，用户确认后执行：

```
📋 级联更新提案:

1. wiki/人物关系.canvas:
   + 新增节点: 老李 (trickster)
   + 新增边: 老李 --嘲讽--> 主角

2. wiki/beats/beat-08-游戏时间.md:
   - characters_involved: [主角, 反派]
   + characters_involved: [主角, 反派, 老李]
   - content: "主角独自面对..."
   + content: "主角在老李的干扰下..."

3. wiki/故事线.canvas:
   (无变化)

执行？(y/全部执行 | p/逐项确认 | n/取消)
```

---

## 深度分析模式（--deep）

基于已填写字段给出理论诊断：
- Wants/Needs 是否形成张力？
- Contradiction 是否有 3D 潜力？（McKee）
- Shard of Glass 是否与 arc 对齐？（Save the Cat）
- 在角色网络中的功能是否清晰？（Vogler）
- 与 genre 类型要求是否匹配？

---

## 理论参考

- `references/theory-vogler.md` — 原型定义
- `references/theory-mckee.md` — 矛盾与压力选择
- `references/theory-save-the-cat.md` — 四大支柱 + 碎玻璃 + 六大缺陷
- `references/character-schema.md` — 完整字段 schema
- `references/genre-constraints.md` — 类型对角色的约束
