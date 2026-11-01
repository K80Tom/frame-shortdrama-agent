# 声音工坊一期合同(v0.2.0,2026-07-23 起草)

背景:0.2.0 已拍板卡(DC 7-23:配音/旁白 TTS+音效+BGM,火山语音系打底)。
给料已齐(台账条 36/40):火山 seed-audio-1.0 API 文档(ark-cli 可查全文)、
丽芬初设计(MiniMax 文档+两张截图)。丽芬方案的**交互与数据模型照收,
供应商不采**(MiniMax/Elev 与"火山打底"拍板冲突;多供应商=0.3.0 自定义
provider 的事)。本合同遵守 platform-ontology.md 与 ai-foundation-gateway.md。

## 一、对象模型(接平台本体,不另立系统)

- **声音参考资产**(资产域):复用既有 kind `sound`/`music`,细分 usage:
  角色声线(挂角色资产,条 26「角色资产=形象+声音」)/BGM/音效/环境声。
  声音资产与图像资产同权:入库、审核、引用追踪一套规则。
- **声音输入包**(生产域):= 控制包的**音频 lane**(丽芬截图「Seedance
  输入包」五类:角色声线/台词试音/音乐参考/动效参考/环境声)。候选≠成员
  铁律(R2)同样适用:生成出的音频=候选版本,进输入包必须显式选用。
- **版本状态机**(丽芬截图照抄,与本体二-5 对齐):候选→已选(进当前
  片段输入包)→锁定(可转项目声音参考资产)/废弃(默认隐藏)。
  审核规则:当前片段临时使用可直接设默认;**锁定角色声线、转声音参考、
  或从 Seedance 有声视频提取音色,必须送审**(复用审核域,不新建流程)。

## 二、生成链(走既有付费红线,不开旁路)

TTS 是媒体生成,不是 LLM 辅助——**走 generation 主链**(estimate→confirm
→submit),media_kind 增 `audio`;不走 /api/v1/ai/*(那是 LLM 网关,#28)。

- **能力档**:`aud-seedaudio10-<档>` 按 `original_duration` 秒计价
  (per_second;文档明示计费以 original_duration 为准,上限 120s)。
  **未实测不上档**:首档需一次付费冒烟走能力档合同第五节解锁流程
  (实测→计费核对→附表登记→上档),定价按火山官方口径核实后录
  pricing_rules。
- **提交参数**(v01Contract 模式建 audio 合同段):model=
  `seed-audio-1.0-multilingual`;text_prompt≤3000 字符;参考音频≤3 条
  ×30s(与参考图片互斥,speaker/audio_data/audio_url 三选一);
  audio_config:format/sample_rate 定档,speech_rate/loudness_rate/
  pitch_rate 三滑杆开放(范围按文档 [-50,100]/[-50,100]/[-12,12]);
  `enable_subtitle=true` **默认开**(字级时间戳=短剧对轨关键能力,
  产物随附字幕 JSON 落库)。
- **水印合规**:`aigc_metadata.enable=true` 隐式水印**默认开**(AIGC
  标识合规),显式 aigc_watermark 默认关;开关不暴露给普通用户。
- 产物:音频落 TOS+duration/字幕存 media_results 同链;url 两小时过期
  ——**必须落库不许直连供应商 URL**。

## 三、音色库(条 36 交互口径)

- 服务端代理豆包 2.0 音色列表(缓存),`GET /api/v1/audio/voices`:
  筛选=语言/类别(旁白·对话式·社交媒体·娱乐·广告·教育)/性别/年龄
  +搜索;前端=搜索+筛选+**试听播放**+语速滑杆(0.01 级微调,条 36)。
- 试听=真实调用也计费:用固定短句(≤20 字)按档计价,确认卡明示
  「试听约 N 积分」;不做无感免费试听(红线:AI 永不代点付费)。
- **声音复刻(音色克隆)不在一期**:涉真人声音授权,需 clearance 登记
  +授权流程设计,0.2.x 随资产授权矩阵 enforcement 排。

## 四、接口汇总(Sol 实现)

```
GET  /api/v1/audio/generation-schema                         # 表单约束与生产链入口
GET  /api/v1/audio/voices?language=&category=&gender=&age=&q=   # 音色库代理
POST /api/v1/generations/estimate|confirm|…  media_kind=audio    # 走既有链
POST /api/v1/audio/extract        # Seedance 有声视频提取音轨(送审态入库)
CRUD 控制包音频 lane(013 control_packages 扩 lane 枚举,不新表)
```

`generation-schema` 是只读、登录后可读的表单合同：返回文本、时长、参考数和滑杆范围，
以及字幕/AIGC 标识默认值；同时明确一期 `background_music_generation=false`、朗读文本
不接收时间码、付费提交仍必须经过 estimate→confirm→submit。它只描述既有生产链，不创建
第二套音频提交接口或参数真源。

鉴权/项目归属/记账与运营底座合同一致(每笔 audio 生成入 cost_entries)。

## 五、前端(Kimi,丽芬两截图为设计基准)

- 「音频 · 声音输入」页:输入包五类卡+当前处理对象+角色音频关注点六维
  (音色基准/表演情绪/语速停顿/语言口音/声音距离/连续性——作为声音
  提示词的结构化引导,组装在服务端,R7)+版本管理列(按用途对象不按
  散文件)。
- 「新增音频」弹窗:生成目标三分(角色音频/音乐参考/动效音频)+声音
  提示词+模型与候选数+保存对象;生成结果多候选试听对比,设默认/送审。
- 音色选择器按第三节交互;所有入口显隐走 capabilities(R7)。

## 六、边界(一期不做)

- BGM 音乐生成:seed-audio 文档口径是"音效、音色"自然语言描述,**音乐
  生成能力未核实**——一期 BGM 只支持上传+参考引用,生成能力核实后再上档
  (核实项归 Sol 包内只读验证,不冒烟);
- 多供应商(截图中 Elev/MiniMax 候选)→ 0.3.0 自定义 provider;
- 声音复刻/克隆(授权流程)、配音对轨自动化(时间轴驱动逐镜配音)→ 0.2.x+;
- 长文本(>3000 字符)分段与流式合成→ 按需求出现再评。

## 七、验收口径

1. 真栈:音色库筛选试听可用;一笔 audio 生成走完 estimate(按档报价)→
   人工确认→产物落 TOS+字幕 JSON→cost_entries 可见且三处同源;
2. 输入包:生成候选不自动进包;锁定/转资产强制过审核;
3. 合规:产物元数据含隐式水印标记;供应商 URL 不出现在用户看得到的地方;
4. 纪律抽查:声音提示词组装/关注点模板在服务端(R7),前端零拼装。

## 实施切分

Sol 一包=迁移(media_kind audio+lane 扩)+音色代理+audio 合同段+提取
端点+一档解锁冒烟(DC 授权额度内);Kimi 一包=第五节(等 Sol 接口)。
排队位:Sol 在资产注册链(下包 2)之后;Kimi 在 S10 候选池按就绪度取。

---

## 八、供应商事实核查(Fable 2026-07-27,查官方文档,不是推断)

S38 交付时留了三条「供应商事实待定」。查证结果:

| # | 问题 | 官方事实 | 出处 |
| --- | --- | --- | --- |
| 1 | 音色列表的查询 endpoint | **不存在。** 音色清单是**静态文档页**,没有公开的「列出全部可用 voice_type」的 HTTP 接口;只有声音复刻(克隆)出来的 speaker 能程序化查状态 | `docs/6561/97465`(音色列表)、`docs/6561/1096680`(API 文档) |
| 2 | TTS 的 endpoint | `https://openspeech.bytedance.com/api/v1/tts` —— **不是 Ark 域名**,是独立的 openspeech 服务 | `docs/6561/1257584` |
| 3 | 鉴权 header | **`Authorization: Bearer;${token}`** —— **Bearer 与 token 之间是分号,不是空格** | 同上 |
| 4 | audio 字段 | `voice_type`(必需)/ `encoding`(wav/pcm/ogg_opus/mp3,默认 pcm)/ `speed_ratio`([0.1,2] 默认 1)/ `rate`(默认 24000)/ `emotion` / `loudness_ratio`([0.5,2] 默认 1) | 同上 |
| 5 | 返回体 | `reqid` / `code`(**3000 = 成功**)/ `message` / `sequence` / `data`(base64 音频)/ `addition.duration`(毫秒) | 同上 |
| 6 | 字级时间戳 | **`with_timestamp: 1`** —— 传 1 启用,返回 TN 后文本的时间戳。这就是字幕 JSON 的来源 | 同上 |

### 由此产生的两条结论

**结论一:`voiceCatalog.ts` 的配置化静态目录是正解,不是权宜之计。** 既然供应商
根本没有音色列表接口,「等接口出来再改」这个选项不存在。可以把它当长期方案,
只需保证目录内容可配置、不写死在代码里。

**结论二(要改代码):鉴权 header 现在是错的。**
`src/modules/generation/provider/arkGenerationProvider.ts:377` 对**所有** operation
统一用 `Authorization: Bearer ${apiKey}`(空格)。TTS 要求的是**分号**。
拿真 token 跑必然 401,而且这种错在冒烟时最难查——看着像密钥不对。

**这条正好证明了「不猜、查文档」的价值**:S38 很守规矩地把 endpoint 留空、
注释写「未验证的路径不许由代码猜测」,但 header 是复用现有 provider 的,
不在它「留空」的范围里,于是错得很安静。**留空能防住猜路径,防不住复用错格式。**
