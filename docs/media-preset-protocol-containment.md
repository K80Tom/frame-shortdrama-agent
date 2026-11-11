# 异构媒体预设协议拦截（#174 第一阶段）

日期：2026-11-11。Owner：@K80Tom / @255308153。适用分支：`fix/media-preset-protocol-guard`，基于 `dev df976eb`。

## 已实现

- 现有媒体客户端只实现 Ark 图片/视频协议；目录中的其他媒体预设（包括未验证的即梦模板）不能被当作已经接通的适配器。
- 按内置目录的模型标识与已知供应商主机进行保守拦截。已知不兼容模型换自定义 Endpoint 仍拒绝；已知非 Ark 供应商主机改模型名仍拒绝。
- 这些 Profile 可保存供查看、修复或取消分配，但公开状态为 `execution: metadata-only`、`configured: false`。分配、兼容用途写入、修改已选 Profile 和运行时 resolve 均拒绝，不改变原用途和版本。
- 重启后读取的旧 schemaVersion 2 配置无须覆盖或丢弃凭据：运行前重新检查；已有 Worker 文件刷新也不能把被禁止连接继续当作可执行。
- `DoubaoImageClient` / `SeedanceVideoClient` 构造时也拦截，避免内部调用绕过 Profile 分配直接提交/轮询。错误不含密钥，拦截发生在 transport 前。

## 范围限制

这是对 #173 新增目录的紧急遏制，不是通用协议认证，也不是完整完成 #174 / #172。未知的手动配置与兼容网关仍遵循原契约，不能由未命中此拦截表推断其兼容、免费或已验真。未持久化 provider/adapter/protocol discriminator，未实现新的供应商路由和请求/轮询适配器，未接通分辨率、时长、首尾帧等预设高级参数。上述缺口仍需后续实现与非作者真人审批。

## 验证

- `npm run build`：全包成功；Agent 44/44、Web 140/140。Vite 有既有 chunk 大小提示与测试服务关闭时的 dep-scan 警告，退出码 0。
- `cd packages/main; node --test tests/media-protocol-guard.test.cjs tests/media-client.test.cjs tests/model-presets.test.cjs tests/model-connections.test.cjs`：83/83。
- 新测试覆盖全部内置非 Ark 媒体预设、两种客户端、改 Endpoint / 改模型名、旧配置重启与 Worker 刷新、CAS 不变、HTTP 拒绝与密钥脱敏；原 Ark 请求体/轮询协议测试仍通过。transport 全部为本地模拟，禁止时请求数为 0，不等于供应商账单验真。
- `npm --prefix packages/main test`：1023 项，1016 pass / 2 fail / 5 skipped。失败为既有 `governance-workflows.test.cjs:171` 路径分隔符和 `storage-driver.test.cjs:60` Windows 对象路径判断；不通过跳过/弱化断言掩盖。
- 构建产物临时关闭拦截后，6 项负面测试均失败、1 项原生兼容测试仍通过；恢复产物后新测试 7/7，通过故障注入证明测试确实覆盖拦截行为。

没有真实付费调用、新供应商验收、浏览器验收或本地数据库迁移。须非作者真人审批当前 head，不自动合并。
