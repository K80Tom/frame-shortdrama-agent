---
description: >
  剧作结构健康度检查。扫描 wiki vault，按编剧理论维度诊断结构完整性、
  角色弧一致性、连接完整性，输出评分报告和优先修复建议。
  Triggers on: "/screenwriting-lint", "诊断", "检查", "健康度", "story health".
---

# Screenwriting Lint

对故事 wiki 进行全面的结构健康度检查，基于 Vogler/McKee/Save the Cat 理论标准。

## 诊断维度

### 1. Beat 完整度（30 分）

| 检查项 | 分值 | 严重度 |
|--------|------|--------|
| 15 个 beat 文件全部存在 | 10 | Error if missing |
| 关键 beat 有实质内容（#4 Catalyst, #9 Midpoint, #11 All Is Lost, #13 Break into Three） | 10 | Error if empty |
| Opening Image (#1) 有内容 | 3 | Warning |
| Final Image (#15) 有内容 | 3 | Warning |
| Opening 与 Final 有可对比性 | 4 | Warning |

**关键 beat 诊断标准**:
- Catalyst: 必须描述一个外力事件（非主角主动选择）
- Midpoint: 必须有"赌注升级"或"规则改变"的表述
- All Is Lost: 必须有"死亡气息"（字面或象征性的丧失）
- Break into Three: 必须有 A+B 融合的顿悟

### 2. 角色弧一致性（30 分）

| 检查项 | 分值 | 严重度 |
|--------|------|--------|
| 主角（hero）存在 | 5 | Error |
| 主角有 Wants | 5 | Error |
| 主角有 Needs | 5 | Error |
| Wants ≠ Needs（存在张力） | 5 | Warning |
| 主角有 Shard of Glass | 3 | Warning |
| 主角有 Contradiction（surface ≠ truth） | 3 | Warning |
| 主角有 arc_type 设置 | 2 | Info |
| Shadow/反派有独立动机 | 2 | Warning |

**Wants/Needs 张力检测**:
- 如果 Wants 和 Needs 用词高度相似 → Warning "张力不足"
- 如果 Wants 的实现路径必然满足 Needs → Warning "无内在冲突"

### 3. 结构健康度（25 分）

| 检查项 | 分值 | 严重度 |
|--------|------|--------|
| Catalyst 是外力事件 | 6 | Error |
| Midpoint 有转折/升赌注 | 6 | Warning |
| All Is Lost 够低（有丧失感） | 5 | Warning |
| B Story 存在且与主题关联 | 4 | Warning |
| Theme Stated (#2) 与 logline 主题呼应 | 4 | Info |

### 4. 连接完整性（15 分）

| 检查项 | 分值 | 严重度 |
|--------|------|--------|
| 无孤儿角色（每个角色至少被 1 个 beat 引用） | 5 | Warning |
| 无断链（无指向不存在页面的 [[link]]） | 5 | Error |
| 每个 beat/character 有 source backlink | 5 | Info |

## 执行流程

1. `Glob` 获取 `wiki/` 下所有 .md 文件列表
2. `Read` 关键文件：index.md, 所有 beats, 所有 characters, meta/logline.md
3. 逐维度检查，记录发现
4. 计算总评分
5. 按严重度排序输出报告

## 输出格式

```
📊 故事健康度: {score}/100

分项评分:
├── Beat 完整度: {x}/30
├── 角色弧一致性: {x}/30
├── 结构健康度: {x}/25
└── 连接完整性: {x}/15

🔴 Error ({count}) — 必须修复
{逐条列出，含文件路径和具体问题}

🟡 Warning ({count}) — 建议修复
{逐条列出}

ℹ️ Info ({count}) — 可选优化
{逐条列出}

🟢 Good ({count}) — 做得好
{肯定已完成的部分}

💡 优先修复建议（Top 3）:
1. {最高优先级 + 为什么 + 怎么修}
2. {次优先级}
3. {第三优先级}
```

## 特殊情况处理

### Wiki 为空或极度不完整

如果发现：
- 无 index.md → 输出"Wiki 未初始化，请先运行 /story"
- 无任何 beat 文件 → 输出"尚未开始创建节拍，建议 /ingest 或 /beats generate"
- 仅有 1-2 个文件 → 给出"初始化阶段建议"而非大量错误

### --fix 模式

当用户使用 `/lint --fix` 时：
1. 对每个可自动修复的问题生成修复建议
2. 展示修复内容，逐项确认
3. 仅修复用户确认的项目
4. 记录修复到 `wiki/log.md`

**可自动修复的问题**:
- 缺失的 beat 文件（创建空模板）
- 断链（创建空的被引用页面）
- 缺失的 source backlink（添加到文件末尾）

**不可自动修复的问题**:
- 内容质量问题（Catalyst 不是外力等）
- Wants/Needs 张力不足
- 任何需要创意判断的改动
