#!/bin/sh
set -eu

target="${LYRA_RUNTIME_CONFIG_PATH:-/usr/share/nginx/html/runtime-config.js}"
video_url="${LYRA_BACKDROP_VIDEO_URL:-}"
poster_url="${LYRA_BACKDROP_POSTER_URL:-}"

validate_public_asset_url() {
  name="$1"
  value="$2"
  [ -z "$value" ] && return 0
  case "$value" in
    https://*) ;;
    *) echo "$name 必须为空或使用 https:// URL" >&2; exit 1 ;;
  esac
  [ "${#value}" -le 2048 ] || { echo "$name 超过 2048 字符" >&2; exit 1; }
  if printf '%s' "$value" | LC_ALL=C grep -q '[[:cntrl:]"\\]'; then
    echo "$name 包含不安全字符" >&2
    exit 1
  fi
  if ! printf '%s' "$value" | LC_ALL=C grep -Eq '^[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$'; then
    echo "$name 包含不受支持的 URL 字符" >&2
    exit 1
  fi
}

validate_public_asset_url LYRA_BACKDROP_VIDEO_URL "$video_url"
validate_public_asset_url LYRA_BACKDROP_POSTER_URL "$poster_url"

umask 022
temporary="${target}.tmp"
{
  printf '%s\n' 'window.__LYRA_RUNTIME_CONFIG__ = Object.freeze({'
  printf "  backdropVideoUrl: '%s',\n" "$video_url"
  printf "  backdropPosterUrl: '%s',\n" "$poster_url"
  printf '%s\n' '});'
} > "$temporary"
mv "$temporary" "$target"
