#!/usr/bin/env bash
# 在维护者本地受控环境生成 Lyra Docker 一键包（不推送镜像、不创建 Release）。
#
# 原 .github/workflows/release-docker.yml 的版本校验与打包逻辑迁移到此脚本。
# GitHub Actions 只做只读 CI，不再持有 contents/packages 写权限。
#
# 用法：
#   deploy/build-release-bundle.sh v0.2.0
#   deploy/build-release-bundle.sh            # 使用根 package.json 的版本
#
# 前置条件：
#   - 当前 HEAD 必须等于最新 origin/main，且工作树干净；
#   - 版本必须与根 package.json 一致；已存在的同名标签必须指向当前 HEAD。
#
# 产物（仓库根目录）：
#   lyra-docker-vX.Y.Z.tar.gz
#   lyra-docker-vX.Y.Z.tar.gz.sha256
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  VERSION="v$(node -p 'require("./package.json").version')"
  echo "未指定版本，使用根 package.json 版本：$VERSION"
fi

if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "版本必须使用稳定标签格式 vX.Y.Z，实际为：$VERSION" >&2
  exit 1
fi

MANIFEST_VERSION="v$(node -p 'require("./package.json").version')"
if [[ "$VERSION" != "$MANIFEST_VERSION" ]]; then
  echo "发布版本必须与根 package.json 一致：input=$VERSION manifest=$MANIFEST_VERSION" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "工作树不干净，拒绝在未提交/未审查的内容上产出发布包：" >&2
  git status --short >&2
  exit 1
fi

git fetch origin main --no-tags
MAIN_SHA="$(git rev-parse origin/main)"
HEAD_SHA="$(git rev-parse HEAD)"
if [[ "$HEAD_SHA" != "$MAIN_SHA" ]]; then
  echo "只允许从最新 origin/main 发布：HEAD=$HEAD_SHA origin/main=$MAIN_SHA" >&2
  exit 1
fi

if git show-ref --verify --quiet "refs/tags/$VERSION"; then
  TAG_SHA="$(git rev-parse "$VERSION^{commit}")"
  if [[ "$TAG_SHA" != "$HEAD_SHA" ]]; then
    echo "已存在的 $VERSION 指向 $TAG_SHA，不能用 $HEAD_SHA 覆盖同版本镜像" >&2
    exit 1
  fi
else
  echo "提示：$VERSION 尚未打标签；请在确认镜像与发布说明后由受控流程创建指向 $HEAD_SHA 的标签。"
fi

FILES=(
  deploy/compose.yaml
  deploy/nginx.conf
  deploy/.env.example
  deploy/README.md
  deploy/minio-media-policy.json
  deploy/postgres-init-app-role.sql
  deploy/Dockerfile.main
  deploy/Dockerfile.web
  deploy/web-runtime-config.sh
)
for file in "${FILES[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "缺少发布文件：$file" >&2
    exit 1
  fi
done

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/lyra-docker"

cp "${FILES[@]}" "$STAGE/lyra-docker/"

sed "s/^LYRA_TAG=.*/LYRA_TAG=${VERSION}/" \
  "$STAGE/lyra-docker/.env.example" > "$STAGE/lyra-docker/.env.example.next"
mv "$STAGE/lyra-docker/.env.example.next" "$STAGE/lyra-docker/.env.example"
grep -Fx "LYRA_TAG=${VERSION}" "$STAGE/lyra-docker/.env.example" >/dev/null

OUT="lyra-docker-${VERSION}.tar.gz"
if [[ -e "$OUT" || -e "$OUT.sha256" ]]; then
  echo "已存在 $OUT 或校验文件；请先移走并记录原因，避免覆盖已审计的发布产物。" >&2
  exit 1
fi
tar -czf "$OUT" -C "$STAGE" lyra-docker

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUT" > "$OUT.sha256"
else
  shasum -a 256 "$OUT" > "$OUT.sha256"
fi

echo "已生成 $OUT"
echo "校验文件 $OUT.sha256"
echo "审计：sha256sum -c $OUT.sha256（macOS 可用 shasum -a 256 -c $OUT.sha256）"
echo "注意：本脚本不构建/推送镜像，也不创建 GitHub Release；这些步骤见 deploy/README.md 第 9 节。"
