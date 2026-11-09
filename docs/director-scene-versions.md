# #123：不可变导演场景与冻结消费

本页描述后端已实现的核心，不代表导演台发布入口、媒体生产链或整个 #123 完成。接续同一 PR 的 ShotSpec/Snapshot/Run 核心。

## 事实与契约

- shared 导出 `lyra-director-scene/1` DTO/闭合解析器；main 计算规范摘要。场景版本关联 workspace/project/episode/shot 与精确 script/plan/storyboard 来源链。
- 保存的是生产几何、相机和环境：8 个现有人体类型、20 个规范姿态、6 种几何体、群演阵列及显式关节角度。位置/尺寸以米为场景单位，旋转为 XYZ 角度，焦距为 mm。对象/相机 ID 保留包括数字开头 UUID 的不透明身份。
- 名称仅作显示标签，不进入内容 digest；生产几何/相机/源归属进入摘要。未来 V2 视频 Prompt 不得把显示标签当作有摘要保证的生产事实，也不得直接复用旧 Video 路径中按 UI 名称拼接 Prompt 的逻辑。
- 拒绝未知字段、schema、对象类型/姿态/关节、非有限/退化相机、重复 ID、未绑定活动相机、过大阵列与 getter 等活动输入。没有临时 URL、UI selection、未版本化 attachments 或本地文件路径字段。
- 上传模型/全景/图片附件尚未接通正式对象版本；当前是明确拒绝，不会丢弃未知字段后谎称原场景已保存。浏览器编辑快照与此生产契约之间的显式发布适配仍需实现；不宣称已有页面自动兼容。

## 主存储、采用与校验

038 增加 `director_scene_versions` 和 `production_input_director_scene_refs`：workspace 复合 FK、FORCE RLS、不可变版本/保留引用、JSON envelope 绑定。版本创建校验来源分镜曾正式采用且确实包含该镜头，精确来源链用复合 FK 保留；用户不能借显示标签相同 digest 覆写既有版本。事件 `director_scene.created.v1` 在唯一 DataOutbox 同事务提交，只含最小 ID/digest/Actor 摘要。存储异常不泄露 SQL/凭据。

不建立第二套 mutable director Registry/head。场景创建只是候选事实；正式使用通过 ShotSpec 的 `director_scene` control 引用与既有 ShotSpec/project CAS 采用。Snapshot 同事务验证器实际检查场景 PG 行、digest、镜头/来源/画幅和 entity/AssetPack 绑定；领域 hook 不能覆盖这些检查。强制导演策略需要每镜头唯一正式场景，缺失/多选均阻断。

ready/frozen 时通过 FK 保留精确场景版本；即使 ShotSpec head 已采用新场景，旧 Snapshot/Run 仍引用旧场景。038 遇到旧 ready/frozen 中无法证明的非空场景引用会整体失败回滚；不能跳过、伪造场景或重写旧 JSON。升级前必须备份、审计并由维护者处理不可证明的数据。本 PR 此前没有默认启用该生产路径，不能拿开发 oracle 的旧冻结数据冒充可升级生产事实。

## 实际消费与未启用边界

DirectorProductionExecutor 已声明冻结输入支持：按 Run 的 bundle 与确切 control 引用读场景，重复核验摘要/归属，不读当前项目、不重新生成白模。episode 只给冻结清单；shot 返回确定性的展示投影，保持位置、焦距、姿态与关节 tuple。auto 无引用或 never 明确跳过，不输出假的场景；always 缺引用、错版本或存储不可用时阻断。

目前还没有 HTTP/导演台发布和采用入口，也未在默认 main runtime 装配 frozenSceneLoader/启用 V2。资产包/模型附件/控制图、Assets/Video 和其他媒体执行器、正式 profile/权限/能力装配、V1/灰度和完整 E2E 均未完成。几何/相机 JSON 不等于已生成姿态图/深度图，不等于供应商强约束生效。

## 验证证据（2026-11-09）

- 场景单元 9/9；结合冻结 Run/校验器回归 31/31。包括实际 Director adapter、全部人体/姿态 ID、群演/关节投影、浏览器沙箱无 Node 依赖、无法绕过真实 PG 检查、driver 文本脱敏和错版本不回退生成。
- 全新专用 PostgreSQL 17.6 从空库执行当前全部迁移至 038 成功。`test:rls` 5/5：3 项为实际非特权应用角色集成，2 项为管理员隔离 schema 的 036/038 原始迁移成功/回滚验证；不能把后两项算作 RLS 证据。
- 真实生命周期：正式来源→场景/ShotSpec→采用→Snapshot 校验/冻结→新场景经 ShotSpec CAS 采用→新剧本；旧 Run 按新连接恢复，实际 Director shot adapter 仍返回原场景机位（x=2，而新场景 x=99），不可改写/删除/错引用保留均被拒绝。shot adapter 是隔离调用，**不是声称尚未接通的资产/媒体 DAG 已运行**。
- 既有 DB 27/27；全包构建成功；前端 131/131；本地后端 711 通过、1 个既有 Windows drawtext 字体失败、3 跳过，未删断言（#111 修复）。当前 head 仍须独立跑 Linux CI。
- 模型 transport 与尚未落地域策略/能力仍是显式桩/oracle；导演场景校验/保留/读取已用真实 PG。没有付费调用、真实云 HEAD/3D 图像导出、浏览器视觉验收或 Worker 进程级故障接管演练。

合并必须非作者真人审查当前 head 并对齐 #124 前置，不自动合并。回滚保留新增事实、FK 与历史引用，不直接 DROP 或删除冻结版本。
