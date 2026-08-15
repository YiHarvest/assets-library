#!/usr/bin/env bash
# 以前台进程运行同机 scene-detect-service；由 scripts/start.sh 负责托管 PID。
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
scene_project="${SCENE_DETECT_PROJECT_DIR:-$project_root/../scene-detect-service}"
scene_port="${SCENE_DETECT_PORT:-28200}"
scene_workspace="${SCENE_DETECT_WORKSPACE_ROOT:-$project_root/media/.scene-service}"
uv_cache_dir="${SCENE_DETECT_UV_CACHE_DIR:-$project_root/.run/uv-cache}"

if [ ! -f "$scene_project/pyproject.toml" ] || [ ! -f "$scene_project/main.py" ]; then
  printf '未找到 scene-detect-service：%s\n' "$scene_project" >&2
  printf '请设置 SCENE_DETECT_PROJECT_DIR 指向该仓库。\n' >&2
  exit 1
fi

command -v uv >/dev/null 2>&1 || {
  printf '未找到 uv，无法启动 scene-detect-service。\n' >&2
  exit 1
}

mkdir -p "$scene_workspace" "$uv_cache_dir"

# 仅监听回环地址，分镜 API 不暴露到局域网；主应用通过 127.0.0.1 调用。
# 硬件加速与队列参数透传；uvicorn 必须单进程（并发由进程内队列控制）。
exec env \
  -u ALL_PROXY -u HTTPS_PROXY -u HTTP_PROXY \
  -u all_proxy -u https_proxy -u http_proxy \
  UV_CACHE_DIR="$uv_cache_dir" \
  WORKSPACE_ROOT="$scene_workspace" \
  MAX_UPLOAD_BYTES="${MAX_VIDEO_BYTES:-209715200}" \
  TASK_TTL_SECONDS="${SCENE_DETECT_TASK_TTL_SECONDS:-86400}" \
  FFMPEG_HW_ACCEL="${FFMPEG_HW_ACCEL:-auto}" \
  FFMPEG_ENCODER_QUALITY="${FFMPEG_ENCODER_QUALITY:-23}" \
  FFMPEG_ENCODER_PRESET="${FFMPEG_ENCODER_PRESET:-p4}" \
  QUEUE_WORKER_COUNT="${SCENE_DETECT_WORKERS:-4}" \
  QUEUE_MAX_SIZE="${SCENE_DETECT_QUEUE_MAX_SIZE:-20}" \
  QUEUE_MAX_RETRIES="${SCENE_DETECT_QUEUE_MAX_RETRIES:-1}" \
  uv run --project "$scene_project" \
  python "$scene_project/main.py" \
  --host 127.0.0.1 \
  --port "$scene_port" \
  --workers 1
