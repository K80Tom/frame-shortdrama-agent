# Lyra Stage 1 集成基线部署手册

本目录是 Lyra 单受信 workspace 试运行的单主机参考拓扑，不再把宿主机单进程开发方式当作部署方案。它提供可执行的 Stage 1 集成基线，但不等同于已经完成公网多租户生产验收。`compose.yaml` 运行：

- PostgreSQL 17：结构化事实源、会话、任务、租户化 Outbox；管理员只初始化/迁移，API/Worker 使用独立的非特权 `NOBYPASSRLS` 账号；
- Redis：可重建的对话上下文快照，启用 AOF；
- MinIO：对象存储端口的默认依赖，应用账号只有 `lyra-media` 最小权限；验真后的生产媒体通过持久任务投影到对象存储，session 租户 API 从对象存储校验读取，共享私有卷只作暂存/过渡/恢复副本；
- etcd + Milvus Standalone：为携带 `workspace_id` 的 v2 向量端口提供探针目标；默认关闭向量检索，显式开启并完整配置 Embedding 后，持久化 reconciliation/index job 才会运行且可能产生费用；
- `migrate`：应用启动前的一次性数据库迁移；
- `main-api` / `main-worker`：同一镜像以不同 `LYRA_RUNTIME_ROLE` 启动；
- `web`：唯一对外端口，同源反向代理 `/api`、`/livez` 和 `/readyz`。

Kubernetes、Kafka、多区双活不在 Stage 1。云上可以将 Compose 中的状态服务替换为托管 PostgreSQL、Redis、Zilliz/Milvus 和 S3/OSS/COS，但应用仍只通过相同端口访问它们。

## 上线前提

- Docker Engine 24+ 和 Compose v2；
- 单机评估环境建议至少 8 GiB 内存、20 GiB 可用磁盘；真实媒体容量按项目另行规划；
- 可用的 HTTPS 域名和前置负载均衡/WAF；
- 彼此不同且强随机的 PostgreSQL 管理员/应用密码，以及 Redis、MinIO root/应用密钥；
- 目标媒体 Worker 镜像已包含 `ffmpeg` / `ffprobe`；
- 外部模型和 Embedding 账号、预算与出网策略已由负责人审核。

Compose 是单机基线，不自动提供 PITR、异机备份、TLS 证书、WAF、Secret Manager 或多副本故障切换。这些是实际上线的必需运维项，不能因为容器健康就宣称已完成。

## 1. 准备配置

```sh
cd deploy
cp .env.example .env
chmod 600 .env
```

至少填写：

```dotenv
POSTGRES_PASSWORD=<strong-random-value>
POSTGRES_APP_USER=lyra_app
POSTGRES_APP_PASSWORD=<another-strong-random-value>
REDIS_PASSWORD=<strong-random-value>
MINIO_ROOT_USER=<non-default-admin>
MINIO_ROOT_PASSWORD=<strong-random-value>
LYRA_OBJECT_ACCESS_KEY=<application-access-key>
LYRA_OBJECT_SECRET_KEY=<strong-random-value>

LYRA_PUBLIC_ORIGIN=https://lyra.example.com
LYRA_SESSION_TTL_SECONDS=604800
# LYRA_COOKIE_DOMAIN=lyra.example.com
MILVUS_COLLECTION_V2=lyra_asset_vectors_v2

# 可选：登录页与工作台共用的公开背景素材，只接受 HTTPS URL
LYRA_BACKDROP_VIDEO_URL=https://cdn.example.com/lyra/backdrop.mp4
LYRA_BACKDROP_POSTER_URL=https://cdn.example.com/lyra/backdrop.webp
```

Compose 固定启用 session 认证，并在容器内配置 MinIO 与 Milvus 地址；不要试图通过 `.env` 降级为匿名 Legacy 模式。Cookie 会话在公网环境只允许 HTTPS。`LYRA_PUBLIC_ORIGIN` 必须是用户浏览器看到的完整同源 Origin，不包含路径、查询、凭据或尾斜杠。不要把 `.env` 提交到 Git，不要在工单或聊天中粘贴它。

`LYRA_BACKDROP_VIDEO_URL` / `LYRA_BACKDROP_POSTER_URL` 是浏览器可直接访问的公开视觉素材地址，不是密钥，也不能包含签名凭据或短期 token。Web 容器在启动时把它们写入 `runtime-config.js`，因此同一镜像可以用于不同环境；部署时不要改成仅供 Vite 开发使用的 `VITE_*` 变量。修改这两个值后无需重建镜像，只需执行 `docker compose up -d --force-recreate web`。留空时工作台使用内置 CSS 背景降级；移动端、节省流量和“减少动态效果”模式也会自动停止视频。

PostgreSQL 凭据职责固定如下：

| 凭据 | 可见服务 | 权限与用途 |
| --- | --- | --- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` | `postgres`、一次性 `postgres-app-role`、`migrate` | 数据库所有者/迁移管理员；创建角色、修改 schema、执行显式 migration；不得注入 API/Worker |
| `POSTGRES_APP_USER` / `POSTGRES_APP_PASSWORD` | `main-api`、`main-worker` | `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`；仅连接、schema usage、表 DML、序列和所需函数执行 |

`postgres-app-role` 每次启动都会幂等校正应用角色属性和密码，清除旧角色成员关系与角色级配置，为已有表补权限，并为迁移管理员后续创建的表/序列/函数/类型设置默认权限；随后 `migrate` 才以管理员 DSN 执行。应用角色名只允许小写 PostgreSQL 标识符且不能与管理员相同，两个密码也必须不同；如果应用角色意外成为数据库/schema/table/function owner，初始化会直接失败，必须先由管理员重新分配 owner。迁移 025–031 构成当前 Stage 1 schema，其中迁移 030 对租户表执行回填、`workspace_id NOT NULL`、RLS `ENABLE/FORCE`，迁移 031 收紧向量投影 fencing/checkpoint；API/Worker 启动以 031 为最低基线，并拒绝 superuser 或 `BYPASSRLS` 连接，避免因错误 DSN 绕过租户策略。

Compose 只把显式白名单中的运行变量传给 `main-api` / `main-worker`，不会用 `env_file` 把整个 `.env` 注入容器；因此 PostgreSQL 管理员密码和 MinIO root 密码不会出现在应用容器环境中。

> **上线阻断项：** 当前入口权限已将 `viewer` 限制为只读，并将模型连接配置限定为 `owner/admin`；应用内已接入 Redis 登录/IP 与会话/API 分布式限流，Redis 失效时限流会失败关闭。但公网部署仍必须在 WAF 或反向代理中对 `/api/auth/login` 设置源 IP 限速和异常告警，对其他 `/api/` 设置有界速率与并发上限。未完成边缘配置和压测时，不得将本 Compose 拓扑直接暴露到公网或称为通过生产安全验收。
>
> 迁移 030 已关闭迁移 025 的 nullable expand 窗口，并对所列租户表强制 RLS；它用于防止应用漏带租户作用域，不是应用数据库凭据泄漏或 SQL 注入后的安全边界，也不替代跨租户资源访问测试、边缘限流、备份恢复和目标环境验收。在这些门禁全绿前，这个参考拓扑仍只允许一个受信 workspace 试运行，不得用作共享多租户 SaaS。

模型连接可以在首次登录后由服务端设置；真正生产应改用 Secret Manager/KMS，不长期保留在普通 Compose `.env` 或共享卷。

## 2. 校验并启动

```sh
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps
```

`postgres-app-role` 与 `migrate` 退出码为 0 属正常。前者必须先完成角色/权限校正，后者再应用 migration。`web`、`main-api`、`main-worker`、PostgreSQL、Redis、MinIO 和 Milvus 应保持运行；如果任一 required 服务不可用，`/readyz` 应返回非 2xx。

```sh
curl --fail https://lyra.example.com/livez
curl --fail https://lyra.example.com/readyz
```

`/livez` 只说明 API 进程存活；`/readyz` 才表示 required 探针已就绪。Worker 不开放 HTTP 健康端点，API 通过 PostgreSQL 中未过期的 Worker 心跳判断其在线状态。Redis/Milvus 可重建能力在单个探针降级时不应伪装成业务事实丢失；工作台“系统状态”会分开显示六项服务。

探针成功只表示所配置的服务可响应：它不证明队列已清空、历史媒体已全部投影、Milvus Collection 已回填，也不证明签名 URL 对公网浏览器可达。`.env.example` 默认 `ASSET_VECTOR_ENABLED=0`，此时资产业务检索仍走确定性词法模式，不产生 Embedding 费用。

## 3. 创建首个管理员

迁移不创建任何已知账号或默认密码。只在受信终端中为一次性 bootstrap 容器注入：

```sh
export LYRA_BOOTSTRAP_EMAIL='admin@example.com'
export LYRA_BOOTSTRAP_PASSWORD='<a-unique-strong-password>'
export LYRA_BOOTSTRAP_DISPLAY_NAME='平台管理员'
export LYRA_BOOTSTRAP_WORKSPACE_NAME='Lyra Studio'
export LYRA_BOOTSTRAP_WORKSPACE_SLUG='lyra-studio'

docker compose run --rm \
  -e LYRA_BOOTSTRAP_EMAIL \
  -e LYRA_BOOTSTRAP_PASSWORD \
  -e LYRA_BOOTSTRAP_DISPLAY_NAME \
  -e LYRA_BOOTSTRAP_WORKSPACE_NAME \
  -e LYRA_BOOTSTRAP_WORKSPACE_SLUG \
  main-api node dist/auth/bootstrap-admin.js

unset LYRA_BOOTSTRAP_PASSWORD
```

命令只输出新建用户/workspace 标识，不输出密码。建议在 shell history 禁用或受控的发布作业中执行，执行后立即清理环境变量。不要用 SQL 手工填写密码 hash。

### 可选：受信自托管注册

标准 Stage 1 部署仍按上面的 bootstrap 流程创建首个管理员，且默认设置
`LYRA_REGISTRATION_MODE=disabled`。仓库不会提供已知账号或默认明文密码。

只有在成员范围受信、部署者明确接受自助开户时，才可在 `deploy/.env` 设置：

```dotenv
LYRA_REGISTRATION_MODE=workspace
```

重建或重启 API/Web 后，登录页会显示注册入口。每次注册都会由后端生成新的用户与独立
workspace，并把注册者设为该 workspace 的 `owner`；客户端不能指定既有 workspace、用户 ID
或更改初始角色。注册密码由用户自行设置，只以服务端密码 hash 保存，不进入前端源码、镜像
默认值或 Git。必须先完成上述首个管理员 bootstrap；控制 workspace 尚未激活时，注册接口会
失败关闭，避免首个访问者抢占部署级管理权。

`workspace` 模式只面向受信自托管，不代表已经具备公网 SaaS 注册条件。直接向互联网开放前，
仍必须补齐邮箱验证、CAPTCHA/边缘限速、异常注册告警、租户额度与计费控制，并完成跨租户和
付费链路验收。当前模型连接仍是部署级私有配置，不能把注册开关当作模型密钥或费用隔离边界。

## 4. 云服务替换目标

每个环境只选一个对象存储 provider：

| 环境 | 建议 provider | 关键配置 |
| --- | --- | --- |
| 私有化/单机 | `minio` | `OBJECT_STORAGE_ENDPOINT`、独立应用账号、`FORCE_PATH_STYLE=true` |
| AWS | `s3` | region/bucket；优先 workload identity，不填长期 key |
| 阿里云 | `oss` | HTTPS endpoint/region/bucket；上线前验证当前 SDK 所需 API |
| 腾讯云 | `cos` | HTTPS endpoint/region/bucket；上线前验证当前 SDK 所需 API |

当前 Compose 文件固定以 MinIO 作为对象存储探针目标；切换到云 provider 需要在目标环境的部署配置中显式替换 `OBJECT_STORAGE_*`，不能只改工作台显示。`/api/production-media/:id/access` 已接入租户授权后的短期签名入口，但签名所用 endpoint 必须是浏览器或上游模型能访问的公网 HTTPS 地址；容器内部的 `http://minio:9000` 只服务于私网，不能当作公网验收证据。迁移时使用“新旧双读/必要时双写 → 批量复制 → SHA-256 对账 → 切换 → 观察期”，不直接删除旧对象。OSS/COS 被归入统一 S3-compatible 边界不代表所有厂商行为完全一致；必须对 `put/get/head/delete/presign`、公网签名可达性和版本行为做真实集成测试。

## 5. 升级与回滚

1. 备份 PostgreSQL 和对象存储，记录当前镜像 digest 与 migration 版本。
2. 先在隔离环境用管理员凭据执行 `postgres-app-role` 和 `migrate`，确认应用角色仍为非 superuser/`NOBYPASSRLS`，再运行全量数据库测试。
3. 生产中先更新并验证角色/默认权限，再以管理员 DSN 执行 `migrate`；API/Worker 始终使用应用 DSN。随后更新 API，最后停止旧 Worker 领取、等待排空并更新 Worker。
4. 验证登录、workspace 越权 404、创建/查询任务、对象 checksum、Redis 回源和 Milvus 租户 filter。
5. 应用回滚只回切兼容旧 schema 的镜像；不自动回退数据库迁移。如新迁移已写入新数据，按预先审核的 expand/contract 程序处理。

API/Worker 切换期间只允许一套调度器领取付费任务。不要在新旧 Worker 上同时开启无 fencing 的内嵌调度。

## 6. 备份与恢复

需要同时备份 PostgreSQL 和对象存储。Redis 和 Milvus 是派生状态，可以保留 AOF/快照加快热恢复，但不得以它们替代事实源备份。

恢复顺序固定为：

```text
PostgreSQL 及租户/项目事实
  → 对象存储及 object_key/checksum 对账
  → API 查询能力
  → Redis 快照按会话版本回源重建
  → Milvus v2 显式授权回填
  → Worker 与 Outbox Dispatcher 恢复领取
```

生产 PostgreSQL 应使用托管 PITR 或等价的 WAL 归档。逻辑备份通常不包含集群角色；恢复到新实例时先创建/校正迁移管理员和应用角色，再恢复数据库并重新运行 `postgres-app-role` 权限对账，不能把管理员 DSN 临时交给 API/Worker。对象存储应开启版本、生命周期与异机备份。Compose 命名卷只是持久化，不是备份；`docker compose down -v` 会删除本机卷，不可用作普通排障步骤。

## 7. 上线验收目标（不是已完成证据）

下表定义目标环境必须执行并留证的演练，不表示当前仓库或 Compose 已经通过。没有日志、指标、数据库记录和恢复校验的项目一律保持“未验证”。

| 演练场景 | 验收目标 | 当前证据状态 |
| --- | --- | --- |
| 重启 `main-api` | Worker 正在执行的任务不被中断，API 恢复后可查询进度 | 待目标环境执行 |
| 强制停止 `main-worker` | 租约过期后由新 Worker 接管，不重复付费 | 待通用 jobs 接管业务任务后执行 |
| 清空 Redis 测试库 | 完整消息不丢，快照从 PostgreSQL 按版本重建 | 待目标环境执行 |
| 停止 Milvus | 资产检索受控降级，不跨 workspace 泄漏，不隐式触发付费回填 | 持久投影任务已接入；待目标环境 Collection/回填后执行 |
| 拒绝对象存储访问 | 上传/下载失败可见，PostgreSQL 不把未验真对象标为 `ready` | 对象投影 Worker 已接入；待目标环境执行 |
| 使用另一 workspace 的 ID | 项目、对象、会话和向量访问统一返回 404/无命中 | 数据库 contract 已收紧；待目标环境做完整跨租户回归 |
| 从备份恢复单个项目 | 业务数据与媒体 checksum 一致，Redis/Milvus 可重建 | 待备份方案与投影作业完成后执行 |

演练前先建可恢复备份，禁止在唯一生产副本上直接清空数据。未实际跑过的项目应标记为“未验证”，不把文档步骤当成恢复证据。

## 8. 常用运维命令

```sh
docker compose ps
docker compose logs --tail=200 main-api
docker compose logs --tail=200 main-worker
docker compose logs postgres-app-role
docker compose logs --tail=200 migrate
docker compose stop main-worker
docker compose down                   # 停止容器，保留卷
```

排障时不要输出 Cookie、Authorization、API Key、签名 URL 或 provider 原始响应。需要更改密钥时先确认轮换窗口和回滚方案，不要只重启一个容器造成 API/Worker 配置不一致。

## 当前实现边界

当前分支已建立 Stage 1 拓扑、端口、数据迁移、会话登录界面、健康状态和测试基座，但以下项目仍需在后续 contract 迁移或目标环境中完成：

- 在目标环境完整应用迁移 025–031，核验迁移 030 的回填、`NOT NULL`、`ENABLE/FORCE RLS`，并确认 API/Worker 实际连接角色不是 superuser 且没有 `BYPASSRLS`；
- 将所有业务 Repository、后台任务和跨 workspace 访问路径完成 tenant contract/404 验收；
- 将 Production/Asset/Video 旧调度逐步迁入新的通用 `jobs` 租约队列；
- 对已接入的媒体对象记录/持久任务/Outbox/Worker 投影执行故障演练，验证签名入口的公网 HTTPS endpoint 与授权边界，并补齐孤儿对象 GC；
- 对已接入的 Milvus 持久投影任务、fencing/checkpoint 与 reconciler 执行目标环境验证，再完成显式授权全量回填与 Alias 切换；默认 `ASSET_VECTOR_ENABLED=0` 不代表已启用语义检索；
- 将模型连接从共享明文 JSON 迁入 Secret Manager/KMS，并解决 API 更新后 Worker 配置热刷新；
- 在真实云上验证 OSS/COS 兼容、PITR、异机备份、TLS/WAF 和故障切换。

因此，本 Compose 是可执行的 Stage 1 集成基线，不是未经环境验收就可以直接承载公网多租户数据的安全背书。
