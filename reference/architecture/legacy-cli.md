# shortdrama-cli

`shortdrama-cli` 是中文在线短剧平台的 Agent 友好命令行入口。v0.3 只消费主服务冻结的 `/api/v1` 合同，覆盖项目、剧本、资产、备戏、生成、队列、审核和交付；不直连数据库、对象存储或模型供应商。

## 安装与登录

私有仓库先完成 GitHub 认证，再安装当前发行版：

```bash
gh auth login
gh api -H "Accept: application/vnd.github.raw+json" \
  repos/col-shortdrama/zhongwen-shortdrama-cli/contents/scripts/install-shortdrama-cli.sh | sh
```

Windows PowerShell：

```powershell
gh auth login
gh api -H "Accept: application/vnd.github.raw+json" `
  repos/col-shortdrama/zhongwen-shortdrama-cli/contents/scripts/install-shortdrama-cli.ps1 | iex
```

选择受信环境（默认 `prod`）并注入自动化 token：

```bash
export SHORTDRAMA_ENV=prod
export SHORTDRAMA_API_TOKEN="..."
shortdrama-cli doctor
shortdrama-cli doctor --require-auth
shortdrama-cli auth whoami
```

会话 token 只保存在用户私有配置目录，也可以由受控运行环境通过 `SHORTDRAMA_API_TOKEN` 注入。命令输出不会回显 token。需要交互式登录时，执行 `shortdrama-cli auth login --env prod` 并按提示输入账号和密码。

## v0.3 命令面

```text
auth        登录、查看当前身份、退出
project     项目与集
script      粘贴剧本、拆解、确认
asset       检索、登记、加入项目
prep        场级备戏、指定镜头或铺全场
generation  估价、确认、提交
queue       在途状态与显式重试
review      媒体人工审核与镜头主版本
delivery    清单、交付记录、媒体与 CSV
```

完整命令与主服务 API 映射见 [v030-command-api-matrix.md](docs/v030-command-api-matrix.md)；给外部 Agent 的技能包位于 [SKILL.md](skills/shortdrama-cli/SKILL.md)。

## 付费与失败边界

生成必须分阶段执行：

```text
estimate → 人工审阅 → confirm → submit
batch-estimate → 人工审阅 → batch-confirm → batch-submit
```

CLI 没有 `--yes`、一键 pipeline 或 mock 成功模式。未配置站点、认证失败、服务端错误都会以非零退出码失败；命令成功只代表当前 API 阶段成功，不代表媒体已经生成或交付。

## 本地开发

```bash
uv sync
.venv/bin/pytest -p no:cacheprovider -q
.venv/bin/python -m shortdrama_cli --help
```

测试通过进程内假客户端冻结 method、path、header 和 body，不会连接用户环境，也不会在发行包中打开假成功入口。

## Release

`.github/workflows/release.yml` 在推送与源码版本一致的 `v*` tag 后构建 macOS x64/arm64、Linux x64/arm64 和 Windows x64 产物，生成 SHA-256 与 manifest，并把同版本 Skills 包放入归档。

发布前同步更新：

- `pyproject.toml`
- `src/shortdrama_cli/__init__.py`
- `skills/shortdrama-cli/manifest.json`

安装器默认写入 `~/.shortdrama` 和 `~/.agents/skills/shortdrama-cli`，并在安装前校验 `checksums.txt`。

Release 工作流先构建并扫描五平台产物，再创建 draft；CLI 仓内可负责的确定性门禁会下载同一工作流的 Linux x64 构建产物，真实执行二进制并核对版本与 Skill 文件。自动发版门只需要仓库只读权限，不持有测试站业务凭据，不检出 `zhongwen-shortdrama-main`，不连接 PostgreSQL，也不执行真实业务写入或付费生成。

Skill 零指导评测已拆到 `.github/workflows/skill-zero-guidance.yml`，按需手动运行三次干净 Codex 会话；它需要单独的模型凭据和费用授权，但不阻塞 CLI Release。测试站产品链与主服务真 PostgreSQL 付费红线暂时延期，不能把 CLI 的负向合同测试表述为服务端真库验收已通过。
