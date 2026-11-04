# Lyra 一键部署（Docker Compose）

把一集剧本推进成可检查、可恢复、可交付的短剧成片。本包让你在自己电脑上以四个 compose 服务（PostgreSQL、一次性迁移、main、web）运行 Lyra，不需要安装 Node、数据库或 ffmpeg。

## 前置条件

- Docker Desktop（macOS / Windows）或 Docker Engine 24+ 与 compose 插件（Linux）
- 约 4 GB 可用内存、5 GB 磁盘
- 至少一个可用的模型账号（OpenAI 兼容接口的 Base URL + API Key）

## 三步启动

```sh
tar -xzf lyra-docker-v0.1.0.tar.gz
cd lyra-docker

cp .env.example .env
# 编辑 .env：必填 POSTGRES_PASSWORD（建议只用字母数字）；模型 key 可在页面里配置

docker compose up -d
```

浏览器打开 **http://127.0.0.1:8788**（或 `http://localhost:8788`）。

首次启动会拉取镜像并自动完成数据库迁移（`migrate` 一次性容器），稍等 1–2 分钟，待 `docker compose ps` 显示 web 为 healthy。

## 常用操作

```sh
docker compose ps                  # 查看服务状态（migrate 退出 0 属正常）
docker compose logs -f main        # 后端日志
docker compose down                # 停止（数据保留）
docker compose down -v             # 停止并删除数据卷（不可恢复）
```

- 改端口：在 `.env` 设置 `LYRA_PORT=9000`，然后 `docker compose up -d`。
- 升级版本：改 `.env` 里的 `LYRA_TAG=v0.2.0`，再 `docker compose up -d`。
- 只用本地自建镜像：设 `LYRA_IMAGE_PREFIX=lyra`，并自行 `docker build -f Dockerfile.main -t lyra-main .`（web 同理）。

## 数据落在哪里

| 卷 | 内容 |
| --- | --- |
| `lyra_pgdata` | PostgreSQL 数据（项目、剧本、运行记录） |
| `lyra_lyra_data` | `outputs/private`：模型连接配置与媒体产物（图片、视频、成片） |

`docker compose down` 不会删除这两个卷；只有 `down -v` 会。

## 安全与凭据

- 本包**不包含任何密钥**。所有模型 Base URL / API Key 由你填写，并只保存在 `lyra_data` 卷内。
- `main` 容器同时持有数据库连接与模型密钥；`web` 容器只通过 `/api` 反向代理访问后端，不直连数据库。
- 后端在容器内监听 `0.0.0.0`，仅通过 compose 内部网络暴露给 `web`；宿主只开放一个端口（默认 8788）。

## 排障

| 现象 | 处理 |
| --- | --- |
| 页面打不开 | `docker compose ps` 确认 `web`/`main` 为 healthy；`docker compose logs main` |
| 迁移失败 | 检查 `.env` 的 `POSTGRES_PASSWORD` 是否为空或含特殊字符；密码会拼进 `DATABASE_URL`。`docker compose logs migrate` 只给通用提示，真实原因需看该容器完整日志 |
| 提示模型未配置 | 进入页面「设置 / 模型」，填写 Base URL 与 Key，或补 `.env` 后重启 |
| 端口被占用 | 改 `.env` 的 `LYRA_PORT` |
| Apple Silicon 构建慢 | 正式镜像提供 arm64，无需本地构建；自建时可用 `--platform` 指定 |
| 拉不到镜像（网络受限） | 在 `.env` 设 `LYRA_POSTGRES_IMAGE=public.ecr.aws/docker/library/postgres:17-alpine`，并为自建镜像换 `--build-arg NODE_IMAGE=.../node:22-bookworm-slim` |

## 自建镜像（可选）

```sh
# 在仓库根目录
docker build -f deploy/Dockerfile.main -t ghcr.io/k80tom/frame-shortdrama-agent-main:dev .
docker build -f deploy/Dockerfile.web -t ghcr.io/k80tom/frame-shortdrama-agent-web:dev .
```

然后在 `.env` 设 `LYRA_TAG=dev` 或 `LYRA_IMAGE_PREFIX` 指向本地镜像名。
