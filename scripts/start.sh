#!/usr/bin/env bash
# 启动 assets-library 的所有服务：Chroma + 分镜服务 + NestJS + worker + Next.js
# 模式由 .env 的 APP_MODE 决定（prd 默认 / dev）
set -euo pipefail

cd "$(dirname "$0")/.."

# 读取 .env（APP_MODE 等变量在此定义）；命令行环境变量优先于 .env
if [ -f .env ]; then
  # 只导入 .env 中尚未在环境中设置的变量，避免覆盖 ./scripts/start.sh APP_MODE=dev 这类显式覆盖
  set -a
  while IFS='=' read -r key value || [ -n "$key" ]; do
    case "$key" in
      ''|\#*) continue ;;
    esac
    [ -n "${!key:-}" ] || export "$key=$value"
  done < .env
  set +a
fi

PORT="${PORT:-23015}"
APP_MODE="${APP_MODE:-prd}"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-23017}"
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:$BACKEND_PORT}"
RUN_DATABASE_MIGRATIONS="${RUN_DATABASE_MIGRATIONS:-false}"
PROCESS_STOP_TIMEOUT_SECONDS="${PROCESS_STOP_TIMEOUT_SECONDS:-35}"
WORKER_INSTANCES="${WORKER_INSTANCES:-1}"
WORKER_DATABASE_POOL_SIZE="${WORKER_DATABASE_POOL_SIZE:-5}"
CHROMA_VERSION="${CHROMA_VERSION:-1.5.9}"
CHROMA_INDEX_URL="${CHROMA_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
CHROMA_WAIT_SECONDS="${CHROMA_WAIT_SECONDS:-30}"
SCENE_DETECT_BASE_URL="${SCENE_DETECT_BASE_URL:-http://127.0.0.1:28200}"
SCENE_DETECT_PORT="${SCENE_DETECT_PORT:-28200}"
SCENE_DETECT_WAIT_SECONDS="${SCENE_DETECT_WAIT_SECONDS:-30}"
SCENE_HEALTH_TIMEOUT_MS="${SCENE_HEALTH_TIMEOUT_MS:-8000}"
PROJECT_ROOT="$(pwd)"
FRONTEND_ROOT="$PROJECT_ROOT/frontend"
BACKEND_ROOT="$PROJECT_ROOT/backend"
# .env 中的相对文件路径统一以项目根目录为基准，不能受 `pnpm --dir`
# 改变子进程工作目录的影响。
if [ -n "${DATABASE_SSL_CA_PATH:-}" ]; then
  case "$DATABASE_SSL_CA_PATH" in
    /*) ;;
    *) DATABASE_SSL_CA_PATH="$PROJECT_ROOT/${DATABASE_SSL_CA_PATH#./}" ;;
  esac
  if [ ! -f "$DATABASE_SSL_CA_PATH" ]; then
    printf '\033[0;31mMySQL CA 文件不存在：%s\033[0m\n' "$DATABASE_SSL_CA_PATH" >&2
    exit 1
  fi
  export DATABASE_SSL_CA_PATH
fi
SCENE_PROJECT_ROOT="${SCENE_DETECT_PROJECT_DIR:-$PROJECT_ROOT/../scene-detect-service}"
SCENE_WORKSPACE_ROOT="${SCENE_DETECT_WORKSPACE_ROOT:-$PROJECT_ROOT/.run/scene-workspace}"
SCENE_UV_CACHE_DIR="${SCENE_DETECT_UV_CACHE_DIR:-$PROJECT_ROOT/.run/uv-cache}"
runtime_dir="${RUNTIME_DIR:-.run}"
chroma_data_dir="${CHROMA_DATA_DIR:-chroma-data}"
case "$runtime_dir" in
  /*) PID_DIR="$runtime_dir" ;;
  *) PID_DIR="$PROJECT_ROOT/$runtime_dir" ;;
esac
case "$chroma_data_dir" in
  /*) CHROMA_DIR="$chroma_data_dir" ;;
  *) CHROMA_DIR="$PROJECT_ROOT/$chroma_data_dir" ;;
esac
UV_CACHE_DIR="${UV_CACHE_DIR:-$PID_DIR/uv-cache}"
UV_TOOL_DIR="${UV_TOOL_DIR:-$PID_DIR/uv-tools}"
export UV_CACHE_DIR UV_TOOL_DIR
export RUNTIME_DIR="$PID_DIR"
mkdir -p "$PID_DIR" "$CHROMA_DIR" "$UV_CACHE_DIR" "$UV_TOOL_DIR"

command -v flock >/dev/null 2>&1 || {
  printf '\033[0;31m未找到 flock，无法保证迁移和 worker 单实例启动。\033[0m\n' >&2
  exit 1
}
exec 9>"$PID_DIR/start.lock"
flock -n 9 || {
  printf '\033[0;31m另一个 start.sh 正在执行，请等待其结束。\033[0m\n' >&2
  exit 1
}

case "$RUN_DATABASE_MIGRATIONS" in
  true|false) ;;
  *)
    printf '\033[0;31mRUN_DATABASE_MIGRATIONS 只能是 true 或 false。\033[0m\n' >&2
    exit 1
    ;;
esac
case "$APP_MODE" in
  dev|prd) ;;
  *)
    printf '\033[0;31mAPP_MODE 只能是 dev 或 prd。\033[0m\n' >&2
    exit 1
    ;;
esac
if ! [[ "$SCENE_HEALTH_TIMEOUT_MS" =~ ^[1-9][0-9]*$ ]] \
  || [ "$SCENE_HEALTH_TIMEOUT_MS" -lt 1000 ] \
  || [ "$SCENE_HEALTH_TIMEOUT_MS" -gt 30000 ]; then
  printf '\033[0;31mSCENE_HEALTH_TIMEOUT_MS 必须是1000到30000之间的整数。\033[0m\n' >&2
  exit 1
fi
SCENE_HEALTH_TIMEOUT_SECONDS=$(( (SCENE_HEALTH_TIMEOUT_MS + 999) / 1000 ))
if ! [[ "$PROCESS_STOP_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  printf '\033[0;31mPROCESS_STOP_TIMEOUT_SECONDS 必须是正整数。\033[0m\n' >&2
  exit 1
fi
if ! [[ "$WORKER_INSTANCES" =~ ^[1-9][0-9]*$ ]] \
  || [ "$WORKER_INSTANCES" -gt 16 ]; then
  printf '\033[0;31mWORKER_INSTANCES 必须是1到16之间的整数。\033[0m\n' >&2
  exit 1
fi
if ! [[ "$WORKER_DATABASE_POOL_SIZE" =~ ^[1-9][0-9]*$ ]] \
  || [ "$WORKER_DATABASE_POOL_SIZE" -gt 100 ]; then
  printf '\033[0;31mWORKER_DATABASE_POOL_SIZE 必须是1到100之间的整数。\033[0m\n' >&2
  exit 1
fi
if [ "$BACKEND_HOST" != "127.0.0.1" ] && [ "$BACKEND_HOST" != "localhost" ] && [ "$BACKEND_HOST" != "0.0.0.0" ]; then
  printf '\033[0;31mBACKEND_HOST 必须是 127.0.0.1、localhost 或 0.0.0.0。\033[0m\n' >&2
  exit 1
fi
case "${BACKEND_URL%/}" in
  "http://127.0.0.1:$BACKEND_PORT"|"http://localhost:$BACKEND_PORT") ;;
  *)
    printf '\033[0;31mBACKEND_URL 必须指向 http://127.0.0.1:BACKEND_PORT 或 localhost。\033[0m\n' >&2
    exit 1
    ;;
esac
if [ "$PORT" = "$BACKEND_PORT" ] || [ "$PORT" = "$SCENE_DETECT_PORT" ]; then
  printf '\033[0;31mPORT、BACKEND_PORT、SCENE_DETECT_PORT 必须互不冲突。\033[0m\n' >&2
  exit 1
fi

startup_complete=false
started_chroma=false
started_scene=false
started_worker=false
STARTED_WORKER_PID_FILES=()
started_backend=false
started_frontend=false

c_ok()    { printf '\033[0;32m%s\033[0m\n' "$*"; }
c_warn()  { printf '\033[0;33m%s\033[0m\n' "$*"; }
c_err()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
c_info()  { printf '\033[0;36m%s\033[0m\n' "$*"; }

log_sink() {
  # 日志读取端必须脱离 start.sh 的会话。否则 start.sh 退出后读取端会收到
  # SIGHUP，业务进程下一次写 stdout 时也会因管道断开而退出。
  # 它仍会在对应业务进程关闭管道（EOF）后自行退出。
  exec 9>&-
  exec setsid env LOG_SERVICE="$1" RUNTIME_DIR="$PID_DIR" \
    LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-7}" \
    LOG_CLEANUP_INTERVAL_SECONDS="${LOG_CLEANUP_INTERVAL_SECONDS:-3600}" \
    node "$PROJECT_ROOT/scripts/log-pipe.mjs"
}

pid_from_file() {
  local file="$1" pid
  [ -f "$file" ] || return 1
  IFS= read -r pid < "$file" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] || return 1
  printf '%s' "$pid"
}

# 新进程用 setsid 启动，PID 同时也是进程组 ID；僵尸进程不算仍在运行。
managed_pid_running() {
  local pid="$1" process_pid process_group process_state
  while read -r process_pid process_group process_state; do
    if [ "$process_pid" = "$pid" ] || [ "$process_group" = "$pid" ]; then
      case "$process_state" in
        Z*) ;;
        *) return 0 ;;
      esac
    fi
  done < <(ps -eo pid=,pgid=,stat=)
  return 1
}

is_running() {
  local pid
  pid="$(pid_from_file "$1")" || return 1
  managed_pid_running "$pid"
}

stop_managed_process() {
  local file="$1" name="$2" pid
  pid="$(pid_from_file "$file")" || {
    rm -f "$file"
    return
  }
  if kill -0 -- "-$pid" 2>/dev/null; then
    c_info "停止异常的 $name 进程组 (PGID $pid) ..."
    kill -TERM -- "-$pid" 2>/dev/null || true
  elif kill -0 "$pid" 2>/dev/null; then
    c_info "停止异常的 $name 进程 (PID $pid) ..."
    kill -TERM "$pid" 2>/dev/null || true
  fi
  for _ in $(seq 1 "$PROCESS_STOP_TIMEOUT_SECONDS"); do
    if ! managed_pid_running "$pid"; then
      break
    fi
    sleep 1
  done
  if managed_pid_running "$pid"; then
    if kill -0 -- "-$pid" 2>/dev/null; then
      kill -KILL -- "-$pid" 2>/dev/null || true
    else
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$file"
}

project_worker_groups() {
  local pid pgid arguments cwd
  while read -r pid pgid arguments; do
    [[ "$arguments" == *"src/worker.ts"* || "$arguments" == *"dist/worker.js"* ]] || continue
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    [ "$cwd" = "$BACKEND_ROOT" ] || continue
    printf '%s\n' "$pgid"
  done < <(ps -eo pid=,pgid=,args=)
}

stop_orphan_worker_group() {
  local pgid="$1"
  c_warn "检测到当前项目未纳入 worker.pid 管理的 worker（PGID $pgid），自动清理。"
  kill -TERM -- "-$pgid" 2>/dev/null || true
  for _ in $(seq 1 "$PROCESS_STOP_TIMEOUT_SECONDS"); do
    kill -0 -- "-$pgid" 2>/dev/null || return
    sleep 1
  done
  c_warn "worker 未在 ${PROCESS_STOP_TIMEOUT_SECONDS}s 内退出，发送 SIGKILL。"
  kill -KILL -- "-$pgid" 2>/dev/null || true
}

# 失败回滚只停止本次 start 新建的 worker，保留调用前已健康运行的实例。
cleanup_started_workers() {
  for pid_file in "${STARTED_WORKER_PID_FILES[@]}"; do
    worker_index="${pid_file##*/worker-}"
    worker_index="${worker_index%.pid}"
    stop_managed_process "$pid_file" "worker-$worker_index"
    rm -f "$PID_DIR/worker-$worker_index.heartbeat.json"
  done
}

# 启动链中任一步失败时，只回收本次调用新建的进程；调用前已经健康运行的
# 服务保持不动，避免一次探针失败影响其他正在使用的实例。
cleanup_failed_startup() {
  local status=$?
  if [ "$status" -eq 0 ] || [ "$startup_complete" = true ]; then
    return
  fi
  set +e
  c_warn "启动未完成，清理本次新启动的进程 ..."
  [ "$started_frontend" = true ] && stop_managed_process "$PID_DIR/frontend.pid" "frontend"
  [ "$started_backend" = true ] && stop_managed_process "$PID_DIR/backend.pid" "backend"
  [ "$started_worker" = true ] && cleanup_started_workers
  [ "$started_scene" = true ] && stop_managed_process "$PID_DIR/scene.pid" "分镜服务"
  [ "$started_chroma" = true ] && stop_managed_process "$PID_DIR/chroma.pid" "Chroma"
  exit "$status"
}

trap cleanup_failed_startup EXIT

chroma_url="${CHROMA_URL:-http://127.0.0.1:23016}"
chroma_authority="${chroma_url#*://}"
chroma_authority="${chroma_authority%%/*}"
chroma_url_port="${chroma_authority##*:}"
if [ "$chroma_url_port" = "$chroma_authority" ] || ! [[ "$chroma_url_port" =~ ^[0-9]+$ ]]; then
  chroma_url_port=80
fi
if [ -n "${CHROMA_PORT:-}" ] && [ "$CHROMA_PORT" != "$chroma_url_port" ]; then
  c_err "CHROMA_PORT=$CHROMA_PORT 与 CHROMA_URL=$chroma_url 端口不一致，请只设置一致的端口。"
  exit 1
fi
CHROMA_PORT="${CHROMA_PORT:-$chroma_url_port}"
if [ "$PORT" = "$CHROMA_PORT" ] || [ "$BACKEND_PORT" = "$CHROMA_PORT" ] || [ "$SCENE_DETECT_PORT" = "$CHROMA_PORT" ]; then
  c_err "PORT、BACKEND_PORT、CHROMA_PORT、SCENE_DETECT_PORT 必须互不冲突。"
  exit 1
fi
case "$chroma_url" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    c_err "scripts/start.sh 只负责启动本机 Chroma，CHROMA_URL 必须使用 http://127.0.0.1:<port> 或 http://localhost:<port>。"
    exit 1
    ;;
esac
CHROMA_HEALTH_URL="http://127.0.0.1:$CHROMA_PORT"

chroma_is_ready() {
  # -q 必须放在第一个参数，避免用户级 ~/.curlrc 注入额外 URL 或代理。
  curl -q -fsS -m 1 "$CHROMA_HEALTH_URL/api/v2/heartbeat" >/dev/null 2>&1 \
    || curl -q -fsS -m 1 "$CHROMA_HEALTH_URL/api/v1/heartbeat" >/dev/null 2>&1
}

show_chroma_failure() {
  local message="$1"
  c_err "$message"
  if [ -s "$CHROMA_LOG" ]; then
    c_err "Chroma 日志末尾："
    tail -n 20 "$CHROMA_LOG" >&2 || true
  else
    c_err "Chroma 未产生日志。"
  fi
  c_err "启动已中止，不会继续启动数据库迁移、backend、frontend 或 worker。"
  exit 1
}

uses_loopback_proxy() {
  local proxy_url authority host
  proxy_url="${ALL_PROXY:-${all_proxy:-${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}}}"
  [ -n "$proxy_url" ] || return 1

  authority="${proxy_url#*://}"
  authority="${authority#*@}"
  authority="${authority%%/*}"
  host="${authority%%:*}"

  case "$host" in
    127.0.0.1|localhost) return 0 ;;
    *) return 1 ;;
  esac
}

prepare_chroma_runtime() {
  local package="chromadb==$CHROMA_VERSION"

  command -v uvx >/dev/null 2>&1 \
    || show_chroma_failure "未找到 uvx。请先安装 uv，再重新运行 ./scripts/start.sh。"

  # 固定版本并优先使用本机缓存，避免每次启动都访问 Python 包索引。
  if env -u ALL_PROXY -u HTTPS_PROXY -u HTTP_PROXY \
    -u all_proxy -u https_proxy -u http_proxy \
    UV_INDEX_URL="$CHROMA_INDEX_URL" \
    uvx --offline --from "$package" chroma --version \
    > >(log_sink chroma) 2>&1; then
    return
  fi

  c_info "首次准备 Chroma $CHROMA_VERSION（后续启动将复用本机缓存）..."
  if env UV_INDEX_URL="$CHROMA_INDEX_URL" uvx --from "$package" chroma --version \
    > >(log_sink chroma) 2>&1; then
    return
  fi

  if uses_loopback_proxy; then
    c_warn "通过本机代理准备 Chroma 失败，临时忽略代理环境变量后重试。"
    if env -u ALL_PROXY -u HTTPS_PROXY -u HTTP_PROXY \
      -u all_proxy -u https_proxy -u http_proxy \
      UV_INDEX_URL="$CHROMA_INDEX_URL" \
      uvx --from "$package" chroma --version > >(log_sink chroma) 2>&1; then
      return
    fi
  fi

  show_chroma_failure \
    "无法准备 Chroma $CHROMA_VERSION。请检查网络/代理，或设置可访问的 CHROMA_INDEX_URL。日志: $CHROMA_LOG"
}

# ---------- Chroma ----------
CHROMA_PID_FILE="$PID_DIR/chroma.pid"
CHROMA_LOG="$PID_DIR/chroma.log"

if is_running "$CHROMA_PID_FILE" && ! chroma_is_ready; then
  c_warn "Chroma PID 存在但健康检查失败，自动清理后重新启动。"
  stop_managed_process "$CHROMA_PID_FILE" "Chroma"
fi

if ! is_running "$CHROMA_PID_FILE" && chroma_is_ready; then
  c_err "Chroma 端口 $CHROMA_PORT 已被未纳入当前 PID 文件的服务占用。"
  c_err "请先停止该旧实例，确认端口释放后再运行 ./scripts/start.sh。"
  exit 1
fi

if is_running "$CHROMA_PID_FILE"; then
  c_warn "Chroma 已在运行 (PID $(cat "$CHROMA_PID_FILE"))"
else
  rm -f "$CHROMA_PID_FILE"
  prepare_chroma_runtime
  c_info "启动 Chroma @ 0.0.0.0:$CHROMA_PORT（应用连接 $CHROMA_HEALTH_URL）..."
  nohup setsid env -u ALL_PROXY -u HTTPS_PROXY -u HTTP_PROXY \
    -u all_proxy -u https_proxy -u http_proxy \
    UV_INDEX_URL="$CHROMA_INDEX_URL" \
    uvx --offline --from "chromadb==$CHROMA_VERSION" chroma run \
    --path "$CHROMA_DIR" \
    --host 0.0.0.0 \
    --port "$CHROMA_PORT" \
    9>&- > >(log_sink chroma) 2>&1 &
  chroma_pid=$!
  echo "$chroma_pid" > "$CHROMA_PID_FILE"
  started_chroma=true
  # 等待端口就绪
  chroma_ready=false
  for i in $(seq 1 "$CHROMA_WAIT_SECONDS"); do
    if chroma_is_ready; then
      c_ok "Chroma 就绪 (PID $chroma_pid)"
      chroma_ready=true
      break
    fi
    if ! is_running "$CHROMA_PID_FILE"; then
      wait "$chroma_pid" 2>/dev/null || chroma_status=$?
      rm -f "$CHROMA_PID_FILE"
      show_chroma_failure \
        "Chroma 启动进程提前退出（状态码 ${chroma_status:-0}）。日志: $CHROMA_LOG"
    fi
    sleep 1
  done
  if [ "$chroma_ready" != true ]; then
    stop_managed_process "$CHROMA_PID_FILE" "Chroma"
    show_chroma_failure \
      "Chroma ${CHROMA_WAIT_SECONDS}s 内未就绪，已停止启动进程。日志: $CHROMA_LOG"
  fi
fi

# ---------- 分镜服务 ----------
SCENE_PID_FILE="$PID_DIR/scene.pid"
SCENE_LOG="$PID_DIR/scene.log"
SCENE_HEALTH_URL="${SCENE_DETECT_BASE_URL%/}/health"

scene_is_ready() {
  curl -q -fsS -m "$SCENE_HEALTH_TIMEOUT_SECONDS" "$SCENE_HEALTH_URL" >/dev/null 2>&1
}

show_scene_failure() {
  local message="$1"
  c_err "$message"
  if [ -s "$SCENE_LOG" ]; then
    c_err "分镜服务日志末尾："
    tail -n 30 "$SCENE_LOG" >&2 || true
  fi
  c_err "启动已中止，不会继续执行数据库迁移、backend、frontend 或 worker。"
  exit 1
}

  case "$SCENE_DETECT_BASE_URL" in
    "http://127.0.0.1:$SCENE_DETECT_PORT"|"http://localhost:$SCENE_DETECT_PORT") ;;
    *)
      show_scene_failure \
        "scripts/start.sh 托管的分镜服务必须使用 http://127.0.0.1:$SCENE_DETECT_PORT 或 http://localhost:$SCENE_DETECT_PORT。"
      ;;
  esac

  if is_running "$SCENE_PID_FILE" && ! scene_is_ready; then
    c_warn "分镜服务 PID 存在但健康检查失败，自动清理后重新启动。"
    stop_managed_process "$SCENE_PID_FILE" "分镜服务"
  fi

  if ! is_running "$SCENE_PID_FILE" && scene_is_ready; then
    c_err "分镜服务端口 $SCENE_DETECT_PORT 已被未纳入当前 PID 文件的服务占用。"
    c_err "请先停止该旧实例，确认端口释放后再运行 ./scripts/start.sh。"
    exit 1
  fi

  if is_running "$SCENE_PID_FILE"; then
    c_warn "分镜服务已在运行 (PID $(cat "$SCENE_PID_FILE"))"
  else
    rm -f "$SCENE_PID_FILE"
    if [ ! -f "$SCENE_PROJECT_ROOT/pyproject.toml" ] || [ ! -f "$SCENE_PROJECT_ROOT/main.py" ]; then
      show_scene_failure "未找到分镜项目 $SCENE_PROJECT_ROOT，请设置 SCENE_DETECT_PROJECT_DIR。"
    fi
    command -v uv >/dev/null 2>&1 \
      || show_scene_failure "未找到 uv，无法启动 scene-detect-service。"
    mkdir -p "$SCENE_WORKSPACE_ROOT" "$SCENE_UV_CACHE_DIR"
    c_info "启动分镜服务 @ 127.0.0.1:$SCENE_DETECT_PORT ..."
    # 分镜启动内联在一键脚本中：使用固定回环地址、独立工作区，并清除代理变量。
    nohup setsid env \
      -u ALL_PROXY -u HTTPS_PROXY -u HTTP_PROXY \
      -u all_proxy -u https_proxy -u http_proxy \
      UV_CACHE_DIR="$SCENE_UV_CACHE_DIR" \
      WORKSPACE_ROOT="$SCENE_WORKSPACE_ROOT" \
      MAX_UPLOAD_BYTES="${MAX_VIDEO_BYTES:-209715200}" \
      TASK_TTL_SECONDS="${SCENE_DETECT_TASK_TTL_SECONDS:-86400}" \
      uv run --project "$SCENE_PROJECT_ROOT" \
      python "$SCENE_PROJECT_ROOT/main.py" \
      --host 127.0.0.1 \
      --port "$SCENE_DETECT_PORT" \
      9>&- > >(log_sink scene) 2>&1 &
    scene_pid=$!
    echo "$scene_pid" > "$SCENE_PID_FILE"
    started_scene=true
    scene_ready=false
    for i in $(seq 1 "$SCENE_DETECT_WAIT_SECONDS"); do
      if scene_is_ready; then
        c_ok "分镜服务就绪 (PID $scene_pid)"
        scene_ready=true
        break
      fi
      if ! is_running "$SCENE_PID_FILE"; then
        wait "$scene_pid" 2>/dev/null || scene_status=$?
        rm -f "$SCENE_PID_FILE"
        show_scene_failure \
          "分镜服务启动进程提前退出（状态码 ${scene_status:-0}）。"
      fi
      sleep 1
    done
    if [ "$scene_ready" != true ]; then
      stop_managed_process "$SCENE_PID_FILE" "分镜服务"
      show_scene_failure \
        "分镜服务 ${SCENE_DETECT_WAIT_SECONDS}s 内未就绪，已停止启动进程。"
    fi
  fi

# ---------- 数据库迁移 ----------
# 远程 MySQL 的迁移账本才是唯一事实来源；本机 marker 会在换库或换机器后误跳过迁移。
if [ "$RUN_DATABASE_MIGRATIONS" = "true" ]; then
  c_info "RUN_DATABASE_MIGRATIONS=true，检查并执行数据库迁移 ..."
  pnpm --dir "$BACKEND_ROOT" run db:migrate
  c_ok "数据库迁移完成"
else
  c_warn "RUN_DATABASE_MIGRATIONS=false，已跳过数据库迁移"
fi

# ---------- frontend + backend + worker ----------
FRONTEND_PID_FILE="$PID_DIR/frontend.pid"
BACKEND_PID_FILE="$PID_DIR/backend.pid"
FRONTEND_LOG="$PID_DIR/frontend.log"
BACKEND_LOG="$PID_DIR/backend.log"
WORKER_LOG="$PID_DIR/worker.log"

# 初始化所有 worker PID 文件路径
WORKER_PID_FILES=()
WORKER_HEARTBEAT_FILES=()
for i in $(seq 1 "$WORKER_INSTANCES"); do
  WORKER_PID_FILES+=("$PID_DIR/worker-$i.pid")
  WORKER_HEARTBEAT_FILES+=("$PID_DIR/worker-$i.heartbeat.json")
done
FRONTEND_URL="http://127.0.0.1:$PORT"
public_base_path="${NEXT_PUBLIC_BASE_PATH:-}"
public_base_path="${public_base_path#/}"
public_base_path="${public_base_path%/}"
PUBLIC_BASE_PATH="${public_base_path:+/$public_base_path}"
FRONTEND_PUBLIC_URL="$FRONTEND_URL$PUBLIC_BASE_PATH"
FRONTEND_HEALTH_URL="$FRONTEND_PUBLIC_URL/"
BACKEND_HEALTH_URL="${BACKEND_URL%/}/health"
APP_WAIT_SECONDS="${APP_WAIT_SECONDS:-90}"

frontend_is_ready() {
  curl -q -fsSL -m 3 -o /dev/null "$FRONTEND_HEALTH_URL" >/dev/null 2>&1
}

backend_is_ready() {
  curl -q -fsS -m 8 "$BACKEND_HEALTH_URL" >/dev/null 2>&1
}

worker_heartbeat_is_fresh() {
  local heartbeat_file="${1:-$WORKER_HEARTBEAT}"
  local modified now
  [ -f "$heartbeat_file" ] || return 1
  modified="$(stat -c %Y "$heartbeat_file" 2>/dev/null)" || return 1
  now="$(date +%s)"
  [ $((now - modified)) -le 10 ]
}

unmanaged_worker_is_alive() {
  local heartbeat_file="${1:-$WORKER_HEARTBEAT}"
  local heartbeat_pid
  worker_heartbeat_is_fresh "$heartbeat_file" || return 1
  heartbeat_pid="$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$heartbeat_file")"
  [[ "$heartbeat_pid" =~ ^[0-9]+$ ]] && [ "$heartbeat_pid" -gt 1 ] \
    && kill -0 "$heartbeat_pid" 2>/dev/null
}

# worker 数量调小时，先停止并清理由旧配置留下的多余实例。
for pid_file in "$PID_DIR"/worker-*.pid; do
  [ -f "$pid_file" ] || continue
  worker_index="${pid_file##*/worker-}"
  worker_index="${worker_index%.pid}"
  if ! [[ "$worker_index" =~ ^[1-9][0-9]*$ ]] \
    || [ "$worker_index" -gt "$WORKER_INSTANCES" ]; then
    stop_managed_process "$pid_file" "旧 worker-$worker_index"
    rm -f "$PID_DIR/worker-$worker_index.heartbeat.json"
  fi
done

# 清理孤儿 worker 进程组
managed_worker_pids=()
for pid_file in "${WORKER_PID_FILES[@]}"; do
  pid="$(pid_from_file "$pid_file" 2>/dev/null || true)"
  [ -n "$pid" ] && managed_worker_pids+=("$pid")
done
while IFS= read -r worker_group; do
  [ -n "$worker_group" ] || continue
  local found=false
  for managed_pid in "${managed_worker_pids[@]}"; do
    [ "$worker_group" = "$managed_pid" ] && found=true && break
  done
  $found || stop_orphan_worker_group "$worker_group"
done < <(project_worker_groups | sort -u)

# 检查并清理过期心跳的 worker
for pid_file in "${WORKER_PID_FILES[@]}"; do
  worker_index="${pid_file##*/worker-}"
  worker_index="${worker_index%.pid}"
  WORKER_HEARTBEAT="$PID_DIR/worker-$worker_index.heartbeat.json"
  if is_running "$pid_file" && ! worker_heartbeat_is_fresh "$WORKER_HEARTBEAT"; then
    c_warn "worker-$worker_index PID 存在但心跳已过期，自动清理后重新启动。"
    stop_managed_process "$pid_file" "worker-$worker_index"
    rm -f "$WORKER_HEARTBEAT"
  fi
done

# 检查未纳入管理但仍在运行的 worker
for pid_file in "${WORKER_PID_FILES[@]}"; do
  worker_index="${pid_file##*/worker-}"
  worker_index="${worker_index%.pid}"
  WORKER_HEARTBEAT="$PID_DIR/worker-$worker_index.heartbeat.json"
  if ! is_running "$pid_file" && unmanaged_worker_is_alive "$WORKER_HEARTBEAT"; then
    c_err "检测到未纳入 worker-$worker_index.pid 管理但仍在更新心跳的 worker。"
    c_err "请先停止该旧实例，再运行 ./scripts/start.sh，避免重复消费任务。"
    exit 1
  fi
done

if is_running "$BACKEND_PID_FILE" && ! backend_is_ready; then
  c_warn "backend PID 存在但健康检查失败，自动清理后重新启动。"
  stop_managed_process "$BACKEND_PID_FILE" "backend"
fi

if ! is_running "$BACKEND_PID_FILE" && backend_is_ready; then
  c_err "backend 内部端口 $BACKEND_PORT 已被未纳入 PID 文件的服务占用。"
  exit 1
fi

if is_running "$FRONTEND_PID_FILE" && ! frontend_is_ready; then
  c_warn "frontend PID 存在但 HTTP 无响应，自动清理后重新启动。"
  stop_managed_process "$FRONTEND_PID_FILE" "frontend"
fi

if ! is_running "$FRONTEND_PID_FILE" && frontend_is_ready; then
  c_err "端口 $PORT 已被未纳入当前 PID 文件的 frontend 服务占用。"
  c_err "请先停止该旧实例，确认端口释放后再运行 ./scripts/start.sh。"
  exit 1
fi

backend_runtime_needs_build=false
if ! is_running "$BACKEND_PID_FILE"; then
  backend_runtime_needs_build=true
fi
for pid_file in "${WORKER_PID_FILES[@]}"; do
  if ! is_running "$pid_file"; then
    backend_runtime_needs_build=true
    break
  fi
done
if [ "$APP_MODE" = "prd" ] && [ "$backend_runtime_needs_build" = true ]; then
  c_info "构建生产 backend ..."
  pnpm --dir "$BACKEND_ROOT" run build
fi
if [ "$APP_MODE" = "prd" ] && ! is_running "$FRONTEND_PID_FILE"; then
  c_info "构建生产 frontend ..."
  pnpm --dir "$FRONTEND_ROOT" run build
fi

# 启动多个 worker 实例
started_worker=false
for i in $(seq 1 "$WORKER_INSTANCES"); do
  WORKER_PID_FILE="$PID_DIR/worker-$i.pid"
  WORKER_HEARTBEAT="$PID_DIR/worker-$i.heartbeat.json"

  if is_running "$WORKER_PID_FILE"; then
    c_warn "worker-$i 已在运行 (PID $(cat "$WORKER_PID_FILE"))"
  else
    rm -f "$WORKER_PID_FILE" "$WORKER_HEARTBEAT"
    c_info "启动 worker-$i ..."
    if [ "$APP_MODE" = "dev" ]; then
      nohup setsid env WORKER_INDEX="$i" WORKER_INSTANCES="$WORKER_INSTANCES" \
        DATABASE_POOL_SIZE="$WORKER_DATABASE_POOL_SIZE" \
        pnpm --dir "$BACKEND_ROOT" run start:worker:dev 9>&- > >(log_sink worker) 2>&1 &
    else
      nohup setsid env WORKER_INDEX="$i" WORKER_INSTANCES="$WORKER_INSTANCES" \
        DATABASE_POOL_SIZE="$WORKER_DATABASE_POOL_SIZE" \
        pnpm --dir "$BACKEND_ROOT" run start:worker 9>&- > >(log_sink worker) 2>&1 &
    fi
    worker_pid=$!
    echo "$worker_pid" > "$WORKER_PID_FILE"
    STARTED_WORKER_PID_FILES+=("$WORKER_PID_FILE")
    started_worker=true
  fi
done

if is_running "$BACKEND_PID_FILE"; then
  c_warn "backend 已在运行 (PID $(cat "$BACKEND_PID_FILE"))"
else
  rm -f "$BACKEND_PID_FILE"
  if [ "$APP_MODE" = "dev" ]; then
    c_info "启动 backend [dev] ($BACKEND_HOST:$BACKEND_PORT) ..."
    nohup setsid env BACKEND_HOST="$BACKEND_HOST" BACKEND_PORT="$BACKEND_PORT" \
      pnpm --dir "$BACKEND_ROOT" run start:dev 9>&- > >(log_sink backend) 2>&1 &
  else
    c_info "启动 backend [prd] ($BACKEND_HOST:$BACKEND_PORT) ..."
    nohup setsid env BACKEND_HOST="$BACKEND_HOST" BACKEND_PORT="$BACKEND_PORT" \
      pnpm --dir "$BACKEND_ROOT" run start 9>&- > >(log_sink backend) 2>&1 &
  fi
  backend_pid=$!
  echo "$backend_pid" > "$BACKEND_PID_FILE"
  started_backend=true
fi

if is_running "$FRONTEND_PID_FILE"; then
  c_warn "frontend 已在运行 (PID $(cat "$FRONTEND_PID_FILE"))"
else
  rm -f "$FRONTEND_PID_FILE"
  if [ "$APP_MODE" = "dev" ]; then
    c_info "启动 frontend [dev/turbopack] (PORT=$PORT) ..."
    nohup setsid env PORT="$PORT" HOSTNAME=0.0.0.0 BACKEND_URL="$BACKEND_URL" \
      pnpm --dir "$FRONTEND_ROOT" run dev 9>&- > >(log_sink frontend) 2>&1 &
  else
    c_info "启动 frontend [prd] (PORT=$PORT) ..."
    nohup setsid env PORT="$PORT" HOSTNAME=0.0.0.0 BACKEND_URL="$BACKEND_URL" \
      pnpm --dir "$FRONTEND_ROOT" run start 9>&- > >(log_sink frontend) 2>&1 &
  fi
  frontend_pid=$!
  echo "$frontend_pid" > "$FRONTEND_PID_FILE"
  started_frontend=true
fi

# 检查所有 worker 是否都在运行
all_workers_running() {
  for pid_file in "${WORKER_PID_FILES[@]}"; do
    is_running "$pid_file" || return 1
  done
  return 0
}

# 检查所有 worker 心跳是否都新鲜
all_workers_heartbeat_fresh() {
  for heartbeat_file in "${WORKER_HEARTBEAT_FILES[@]}"; do
    worker_heartbeat_is_fresh "$heartbeat_file" || return 1
  done
  return 0
}

# 最终就绪条件：frontend 可访问、backend 聚合健康检查通过、所有 worker 心跳新鲜。
app_ready=false
app_deadline=$((SECONDS + APP_WAIT_SECONDS))
while [ "$SECONDS" -lt "$app_deadline" ]; do
  if frontend_is_ready && backend_is_ready && all_workers_heartbeat_fresh; then
    app_ready=true
    break
  fi
  if ! all_workers_running; then
    c_err "某个 worker 启动进程提前退出。日志末尾："
    [ -s "$WORKER_LOG" ] && tail -n 40 "$WORKER_LOG" >&2 || true
    exit 1
  fi
  if ! is_running "$BACKEND_PID_FILE"; then
    c_err "backend 启动进程提前退出。日志末尾："
    [ -s "$BACKEND_LOG" ] && tail -n 40 "$BACKEND_LOG" >&2 || true
    exit 1
  fi
  if ! is_running "$FRONTEND_PID_FILE"; then
    c_err "frontend 启动进程提前退出。日志末尾："
    [ -s "$FRONTEND_LOG" ] && tail -n 40 "$FRONTEND_LOG" >&2 || true
    exit 1
  fi
  sleep 1
done

if [ "$app_ready" != true ]; then
  c_err "应用 ${APP_WAIT_SECONDS}s 内未全部就绪。"
  c_err "backend 健康状态（不含密钥和底层异常）："
  curl -q -sS -m 8 "$BACKEND_HEALTH_URL" >&2 || true
  echo >&2
  [ -s "$WORKER_LOG" ] && tail -n 30 "$WORKER_LOG" >&2 || true
  [ -s "$BACKEND_LOG" ] && tail -n 30 "$BACKEND_LOG" >&2 || true
  [ -s "$FRONTEND_LOG" ] && tail -n 30 "$FRONTEND_LOG" >&2 || true
  exit 1
fi

startup_complete=true
trap - EXIT

echo
c_ok "全部就绪。  [mode=$APP_MODE]"
echo "  应用:    $FRONTEND_PUBLIC_URL"
echo "  API:     $FRONTEND_PUBLIC_URL/api/v1（同源转发）"
echo "  backend: $BACKEND_HEALTH_URL（仅回环）"
echo "  Chroma:  $CHROMA_HEALTH_URL"
echo "  分镜:    $SCENE_HEALTH_URL"
echo "  worker:  $WORKER_INSTANCES 个（每个连接池 $WORKER_DATABASE_POOL_SIZE）"
echo "  模式:    $APP_MODE  (改 .env 的 APP_MODE=dev 切开发模式)"
echo "  日志:    $PID_DIR/{chroma,scene,worker,backend,frontend}.log"
echo "  关闭:    ./scripts/stop.sh"
