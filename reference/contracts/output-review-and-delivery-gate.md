# 产物审核与交付门禁合同(v0.2.x,2026-07-23 起草)

背景:双盘点合成结论的第一新包(缺口 K16/K22=S12/S17/K21)。现状事实
(Sol 盘点,file:line 可复核):生成产物 media_results 落库后固定
`persisted + needs_review`,**没有任何 API 能把它裁决为通过/拒绝**——
审核域只覆盖资产实体;交付(playback/deliverables)不校验审核状态,未审
镜头照样交付;连播/导出是全有或全无(缺一镜主版本即 409);交付全为只读
GET,无"已交付"记录。结论:12 人协作没有质量关口,交付没有事实账。
上位:platform-ontology.md 二-6(审核关系)、operations-foundation.md §三。

## 一、产物审核(复用资产审核骨架,不发明第二套)

- 状态机:`needs_review → accepted | rejected`;rejected 产物保留可看
  (对照/复盘),不可设主版本、不进交付;
- 动作留痕:平行于 asset_review_actions 建 `media_review_actions`
  (谁、何时、从何态到何态、拒绝理由必填),审核人鉴权=项目 owner 或
  指定审核人(operations-foundation §三 reviewer_user_id 同源);
- **策略沿用 project_review_policies**(image/video 分开):默认
  `automatic` = 产物落库即视同 accepted(轻流程,今天的行为不变但留
  显式动作记录);`pending_review` = 产物必须人工裁决;
- **批量是一等能力**(12h 杠杆③):待审队列 API(项目/集级,分页)+
  批量通过(整集一键通过、逐镜拒绝作例外),不做逐镜强制单点;
- 选主版本与审核解耦但有序:只有 accepted(或 automatic 策略下的产物)
  可设主版本;设主不自动等于审核通过。

## 二、交付门禁与交付对象

- 门禁:playback/deliverables/下载清单只纳入「accepted(或 automatic)
  且为主版本」的产物;策略为 pending_review 的项目里,未审产物出现在
  交付请求中→ 明确报错列出镜号,不静默剔除;
- **部分交付模式**(解 K21):连播与清单支持 `partial=true`——已就绪
  镜头先预演/先出清单,缺口镜头明确列出;默认仍全量校验;
- **交付记录对象** `delivery_records`:每次导出/交付落一行(项目/集/
  清单快照 hash/包含的 media_result ids/操作人/时间/用途标注),
  查询接口按集列交付历史——"哪集交了、交的哪版"从此有账;
- 整集打包/视频合成(K7)**不在本合同**:属交付对象化二期(需转码
  基建),本合同先把"账"和"门"立住。

## 三、API(Sol 实现)

```
GET  /api/v1/projects/:id/media-reviews?status=needs_review&episode_id=&page=   # 待审队列
POST /api/v1/projects/:id/media-reviews/decisions   # 批量:{decisions:[{media_result_id, action, rejection_reason?}]}
GET  /api/v1/episodes/:id/playback?partial=true      # 部分连播
GET  /api/v1/episodes/:id/deliveries                 # 交付历史
POST /api/v1/episodes/:id/deliveries                 # 落交付记录(导出动作触发)
```

既有 set-primary 加 accepted 校验;shot-media 列表带 review_status
(前端不再被隐藏字段误导)。

## 四、前端(Kimi,接口好后入队列)

- 项目级「待审产物」入口(策略开待审时出现):队列视图+整集批量通过+
  逐镜拒绝(看图裁决,键盘可走);
- 版本弹窗:产物卡带审核态徽章;rejected 置灰不可设主;
- 连播/导出:partial 模式的缺口镜号清单;交付历史面板(哪集哪版何时谁)。

## 五、验收口径

1. 真栈:策略 pending_review 下,未审产物不能设主、不进交付,批量通过
   后立即可交付;automatic 策略行为与今天一致但动作有记录;
2. 交付两次同一集,交付历史两行且清单 hash 可对;partial 连播列出缺口;
3. 权限:非审核人裁决 403;拒绝无理由 422。

## 六、边界

- 整集 mp4 合成/打包下载(交付二期);产物复审(accepted 撤销)一期
  不做,误通过走"拒绝新版本+重生成"绕行;审核 SLA/提醒(远期)。
