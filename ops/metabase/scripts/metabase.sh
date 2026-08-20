#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

compose_file="compose.yaml"
environment_file=".env"
compose_binary="${PODMAN_COMPOSE_BIN:-}"

if [ -z "$compose_binary" ]; then
  if [ -x .venv/bin/podman-compose ]; then
    compose_binary=".venv/bin/podman-compose"
  else
    compose_binary="podman-compose"
  fi
fi

if [ ! -f "$environment_file" ]; then
  echo "缺少 ops/metabase/$environment_file。请先复制 .env.example 并填写真实配置。" >&2
  exit 1
fi

compose() {
  "$compose_binary" --env-file "$environment_file" -f "$compose_file" "$@"
}

require_podman_compose() {
  if ! command -v "$compose_binary" >/dev/null 2>&1 && [ ! -x "$compose_binary" ]; then
    echo "缺少 podman-compose。请先安装到当前用户环境。" >&2
    exit 1
  fi
  if ! podman info >/dev/null 2>&1; then
    echo "Podman 不可用或当前用户无法访问 rootless Podman。" >&2
    exit 1
  fi
}

case "${1:-}" in
  config)
    require_podman_compose
    compose config --quiet
    echo "Metabase Podman Compose 配置有效。"
    ;;
  up)
    require_podman_compose
    compose up -d
    compose ps
    ;;
  down)
    require_podman_compose
    compose down
    ;;
  status)
    require_podman_compose
    compose ps
    ;;
  logs)
    require_podman_compose
    compose logs -f --tail=200 metabase metabase-postgres
    ;;
  *)
    echo "用法: $0 {config|up|down|status|logs}" >&2
    exit 1
    ;;
esac
