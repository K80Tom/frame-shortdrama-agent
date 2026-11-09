# 媒体下载特殊地址回归（#78 增量）

日期：2026-11-08；dev 基线 0622a35；Owner 沿用 @K80Tom 默认维护责任。
本增量 implemented，完整 #78 仍为 partial。

内网例外策略原先仅识别 IPv4-mapped loopback，遗漏映射的链路本地与未指定地址。
现在 ::ffff:0:0/96 统一还原 IPv4 并复用相同本机地址规则；内网例外继续允许私有单播，但禁止多播、IPv4-compatible IPv6 及映射多播/广播。
默认公网策略补充拒绝 2001:2::/48 benchmark 与 3fff::/20 documentation。
依据：[IANA IPv6 Special-Purpose Registry](https://www.iana.org/assignments/iana-ipv6-special-registry/)。此处只采用登记中的用途/范围，不推断所有特殊网段均不可全球路由。

新增回归覆盖 DNS 与字面地址、十六进制/点分等价表示、CIDR 边界及允许的私网/公网对照。
全部使用注入 DNS、fetch 和媒体探针，禁止真实公网/内网请求；不是供应商验证。
未更改 HTTPS/重定向/DNS pinning、预算、媒体持久化或租户权限。

命令：npm run build；node --test packages/main/tests/production-media.test.cjs；npm test。
内网模式仍是显式风险例外，不宣称完成所有 SSRF/DNS rebinding、文件格式、资源限制及凭据门禁；完整范围由 #78 继续跟踪。

2026-11-08 本地 Node 24.15：全项目构建通过，地址安全定向 14/14 通过；媒体全文件 33 通过/1 跳过/1 既有字体失败；后端全量 648 项，644 通过、3 跳过、1 相同字体失败；前端 117/117 通过。#111 尚待合并，未将本地全量表述为全绿。

## 2026-11-09 当前 dev 同步与策略复核

已同步 dev b264844，保留冻结输入/Run、画布/Assistant 与既有租户媒体投影；没有把待审 #111 字体、#122 DNS 超时或 #147 对象版本夹带合入。原 #78 已关闭，但这不代表完整 SSRF 或生产安全验收已完成。

本轮读取 IANA IPv6 Special-Purpose Registry（页面标注最后更新2025-10-09），核对 2001::/23、2001:2::/48、3fff::/20 等用途/范围。IANA明确提醒特殊登记不保证特定网络中的可路由性；本项目默认媒体过滤器更保守，不等于完整IANA“Globally Reachable”分类或网络可达性探针。

**兼容性收紧**：默认路径现在拒绝整个 2001::/23 特殊协议分配空间，包括其中的未分配空隙和部分IANA列为可全球到达的特殊服务/标识地址，而不是把窄段之间的空隙判成普通CDN。2001:2:1::不再作为“公网正例”；普通global-unicast测试使用超出该大段的地址。保留2001:db8文档、3fff::/20文档与2002过渡地址等既有/新增拒绝。该保守选择需owner针对媒体源兼容性审核，不宣称IANA把整个空间都认定不可达。

新增回归验证：大段首尾与外边界、混合DNS答案的两种顺序、null/undefined/缺字段/非法IP/家族不符记录、普通公网+映射本机地址混合，均在fetch前整体拒绝，fetch计数为0。畸形记录短路验证，不再先访问null.address抛原始TypeError。显式内网模式继续允许私有/ULA候选，但同样拒绝映射本机、链路本地、未指定和组播；不是安全门禁的通用绕过开关。

- 全包build通过；媒体地址/下载门禁定向12/12，无跳过。
- 完整媒体文件36项：34pass /1项既有Windows字体fail /1平台skipped；后端全量719项715pass /1同样字体fail /3平台skipped，未改或跳过字体断言，不宣称本地全绿。#111当前分支通过也不等于本分支已获得该修复。
- Web135/135；当前head Linux/Database CI另行验收。本轮本地无SQL或DB改动，未额外运行PG。
- 继续只使用注入DNS/fetch/媒体探针，没有真实媒体下载、真实DNS路由或供应商/付费验证。规则/边界与fetch未调用的证明不能外推成防火墙、私有DNS、HTTP代理及全链路SSRF/DNS rebinding全部安全。
