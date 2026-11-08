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
