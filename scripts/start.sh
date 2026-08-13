#!/usr/bin/env bash
# 启动 assets-library 的所有服务：Chroma + 分镜服务 + Next.js Web + worker
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
CHROMA_VERSION="${CHROMA_VERSION:-1.5.9}"
CHROMA_INDEX_URL="${CHROMA_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
CHROMA_WAIT_SECONDS="${CHROMA_WAIT_SECONDS:-30}"
SCENE_DETECT_ENABLED="${SCENE_DETECT_ENABLED:-true}"
SCENE_DETECT_BASE_URL="${SCENE_DETECT_BASE_URL:-http://127.0.0.1:28200}"
SCENE_DETECT_PORT="${SCENE_DETECT_PORT:-28200}"
SCENE_DETECT_WAIT_SECONDS="${SCENE_DETECT_WAIT_SECONDS:-30}"
CHROMA_DIR="$(pwd)/chroma-data"
PID_DIR="$(pwd)/.run"
PROJECT_ROOT="$(pwd)"
UV_CACHE_DIR="${UV_CACHE_DIR:-$PID_DIR/uv-cache}"
UV_TOOL_DIR="${UV_TOOL_DIR:-$PID_DIR/uv-tools}"
export UV_CACHE_DIR UV_TOOL_DIR
mkdir -p "$PID_DIR" "$CHROMA_DIR" "$UV_CACHE_DIR" "$UV_TOOL_DIR"

startup_complete=false
started_chroma=false
started_scene=false
started_worker=false
started_web=false

c_ok()    { printf '\033[0;32m%s\033[0m\n' "$*"; }
c_warn()  { printf '\033[0;33m%s\033[0m\n' "$*"; }
c_err()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
c_info()  { printf '\033[0;36m%s\033[0m\n' "$*"; }

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
  for _ in $(seq 1 10); do
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
    [[ "$arguments" == *"src/worker/index.ts"* ]] || continue
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    [ "$cwd" = "$PROJECT_ROOT" ] || continue
    printf '%s\n' "$pgid"
  done < <(ps -eo pid=,pgid=,args=)
}

stop_orphan_worker_group() {
  local pgid="$1"
  c_warn "检测到当前项目未纳入 worker.pid 管理的旧 worker（PGID $pgid），自动清理。"
  kill -TERM -- "-$pgid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    kill -0 -- "-$pgid" 2>/dev/null || return
    sleep 1
  done
  c_warn "旧 worker 未在 10s 内退出，发送 SIGKILL。"
  kill -KILL -- "-$pgid" 2>/dev/null || true
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
  [ "$started_web" = true ] && stop_managed_process "$PID_DIR/web.pid" "Web"
  [ "$started_worker" = true ] && stop_managed_process "$PID_DIR/worker.pid" "worker"
  [ "$started_scene" = true ] && stop_managed_process "$PID_DIR/scene.pid" "分镜服务"
  [ "$started_chroma" = true ] && stop_managed_process "$PID_DIR/chroma.pid" "Chroma"
  rm -f "$PID_DIR/worker.heartbeat.json"
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
  c_err "启动已中止，不会继续启动数据库迁移、Web 或 worker。"
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
    >> "$CHROMA_LOG" 2>&1; then
    return
  fi

  c_info "首次准备 Chroma $CHROMA_VERSION（后续启动将复用本机缓存）..."
  if env UV_INDEX_URL="$CHROMA_INDEX_URL" uvx --from "$package" chroma --version \
    >> "$CHROMA_LOG" 2>&1; then
    return
  fi

  if uses_loopback_proxy; then
    c_warn "通过本机代理准备 Chroma 失败，临时忽略代理环境变量后重试。"
    if env -u ALL_PROXY -u HTTPS_PROXY -u HTTP_PROXY \
      -u all_proxy -u https_proxy -u http_proxy \
      UV_INDEX_URL="$CHROMA_INDEX_URL" \
      uvx --from "$package" chroma --version >> "$CHROMA_LOG" 2>&1; then
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
  : > "$CHROMA_LOG"
  prepare_chroma_runtime
  c_info "启动 Chroma @ 0.0.0.0:$CHROMA_PORT（应用连接 $CHROMA_HEALTH_URL）..."
  nohup setsid env -u ALL_PROXY -u HTTPS_PROXY -u HTTP_PROXY \
    -u all_proxy -u https_proxy -u http_proxy \
    UV_INDEX_URL="$CHROMA_INDEX_URL" \
    uvx --offline --from "chromadb==$CHROMA_VERSION" chroma run \
    --path "$CHROMA_DIR" \
    --host 0.0.0.0 \
    --port "$CHROMA_PORT" \
    > "$CHROMA_LOG" 2>&1 &
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
  curl -q -fsS -m 2 "$SCENE_HEALTH_URL" >/dev/null 2>&1
}

show_scene_failure() {
  local message="$1"
  c_err "$message"
  if [ -s "$SCENE_LOG" ]; then
    c_err "分镜服务日志末尾："
    tail -n 30 "$SCENE_LOG" >&2 || true
  fi
  c_err "启动已中止，不会继续执行数据库迁移、Web 或 worker。"
  exit 1
}

if [ "$SCENE_DETECT_ENABLED" = "true" ]; then
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
    : > "$SCENE_LOG"
    c_info "启动分镜服务 @ 127.0.0.1:$SCENE_DETECT_PORT ..."
    # 直接执行并由 run-scene-service.sh exec 到 uv，PID 文件可可靠控制服务进程。
    nohup setsid ./scripts/run-scene-service.sh > "$SCENE_LOG" 2>&1 &
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
else
  c_warn "已通过 SCENE_DETECT_ENABLED=false 禁用分镜服务"
fi

# ---------- 数据库迁移 ----------
# 远程 MySQL 的迁移账本才是唯一事实来源；本机 marker 会在换库或换机器后误跳过迁移。
c_info "检查并执行数据库迁移 ..."
pnpm run db:migrate
c_ok "数据库迁移完成"

# ---------- Web + worker ----------
WEB_PID_FILE="$PID_DIR/web.pid"
WORKER_PID_FILE="$PID_DIR/worker.pid"
LEGACY_APP_PID_FILE="$PID_DIR/app.pid"
WEB_LOG="$PID_DIR/web.log"
WORKER_LOG="$PID_DIR/worker.log"
WORKER_HEARTBEAT="$PID_DIR/worker.heartbeat.json"
HEALTH_URL="http://127.0.0.1:$PORT/health"
APP_WAIT_SECONDS="${APP_WAIT_SECONDS:-90}"

web_is_responding() {
  # curl 在 HTTP 503 时仍返回 0；这里仅判断端口上的 Web 是否能响应 HTTP。
  curl -q -sS -m 2 -o /dev/null "$HEALTH_URL" >/dev/null 2>&1
}

application_is_healthy() {
  curl -q -fsS -m 8 "$HEALTH_URL" >/dev/null 2>&1
}

worker_heartbeat_is_fresh() {
  local modified now
  [ -f "$WORKER_HEARTBEAT" ] || return 1
  modified="$(stat -c %Y "$WORKER_HEARTBEAT" 2>/dev/null)" || return 1
  now="$(date +%s)"
  [ $((now - modified)) -le 10 ]
}

unmanaged_worker_is_alive() {
  local heartbeat_pid
  worker_heartbeat_is_fresh || return 1
  heartbeat_pid="$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$WORKER_HEARTBEAT")"
  [[ "$heartbeat_pid" =~ ^[0-9]+$ ]] && [ "$heartbeat_pid" -gt 1 ] \
    && kill -0 "$heartbeat_pid" 2>/dev/null
}

# 兼容旧版 start.sh 的 concurrently 进程组；升级后首次启动会先停止旧托管组，
# 再分别托管 Web 与 worker，健康接口才能准确区分两者。
if is_running "$LEGACY_APP_PID_FILE"; then
  c_warn "检测到旧版 Web+worker 进程组，迁移到独立 PID 管理。"
  stop_managed_process "$LEGACY_APP_PID_FILE" "旧版 Web+worker"
else
  rm -f "$LEGACY_APP_PID_FILE"
fi

# PID 文件丢失或旧版 concurrently 被外部终止时，其 worker 子进程可能继续运行，
# 不占端口却会重复消费 MySQL 队列。只清理 cwd 精确等于当前仓库的 worker 进程组。
managed_worker_pid="$(pid_from_file "$WORKER_PID_FILE" 2>/dev/null || true)"
while IFS= read -r worker_group; do
  [ -n "$worker_group" ] || continue
  [ "$worker_group" = "$managed_worker_pid" ] && continue
  stop_orphan_worker_group "$worker_group"
done < <(project_worker_groups | sort -u)
if [ -z "$managed_worker_pid" ]; then
  rm -f "$WORKER_HEARTBEAT"
fi

if is_running "$WORKER_PID_FILE" && ! worker_heartbeat_is_fresh; then
  c_warn "worker PID 存在但心跳已过期，自动清理后重新启动。"
  stop_managed_process "$WORKER_PID_FILE" "worker"
  rm -f "$WORKER_HEARTBEAT"
fi

if ! is_running "$WORKER_PID_FILE" && unmanaged_worker_is_alive; then
  c_err "检测到未纳入 worker.pid 管理但仍在更新心跳的 worker。"
  c_err "请先停止该旧实例，再运行 ./scripts/start.sh，避免重复消费任务。"
  exit 1
fi

if is_running "$WEB_PID_FILE" && ! web_is_responding; then
  c_warn "Web PID 存在但 HTTP 无响应，自动清理后重新启动。"
  stop_managed_process "$WEB_PID_FILE" "Web"
fi

if ! is_running "$WEB_PID_FILE" && web_is_responding; then
  c_err "端口 $PORT 已被未纳入当前 PID 文件的 Web 服务占用。"
  c_err "请先停止该旧实例，确认端口释放后再运行 ./scripts/start.sh。"
  exit 1
fi

if is_running "$WORKER_PID_FILE"; then
  c_warn "worker 已在运行 (PID $(cat "$WORKER_PID_FILE"))"
else
  rm -f "$WORKER_PID_FILE" "$WORKER_HEARTBEAT"
  : > "$WORKER_LOG"
  c_info "启动 worker ..."
  nohup setsid pnpm run start:worker > "$WORKER_LOG" 2>&1 &
  worker_pid=$!
  echo "$worker_pid" > "$WORKER_PID_FILE"
  started_worker=true
fi

if is_running "$WEB_PID_FILE"; then
  c_warn "Web 已在运行 (PID $(cat "$WEB_PID_FILE"))"
else
  rm -f "$WEB_PID_FILE"
  : > "$WEB_LOG"
  if [ "$APP_MODE" = "dev" ]; then
    c_info "启动 Web [dev/turbopack] (PORT=$PORT) ..."
    nohup setsid env PORT="$PORT" HOSTNAME=0.0.0.0 \
      pnpm exec next dev --turbo > "$WEB_LOG" 2>&1 &
  else
    # 每次新启生产 Web 都重新构建，避免残留 .next 与当前源码不一致。
    c_info "构建生产 Web ..."
    pnpm run build
    c_info "启动 Web [prd] (PORT=$PORT) ..."
    nohup setsid env PORT="$PORT" HOSTNAME=0.0.0.0 \
      pnpm run start:web > "$WEB_LOG" 2>&1 &
  fi
  web_pid=$!
  echo "$web_pid" > "$WEB_PID_FILE"
  started_web=true
fi

# 最终就绪条件不是“首页可访问”，而是 /health 确认 Web、worker、MySQL、
# Chroma、分镜服务和 ZOS 全部可用。
app_ready=false
app_deadline=$((SECONDS + APP_WAIT_SECONDS))
while [ "$SECONDS" -lt "$app_deadline" ]; do
  if application_is_healthy; then
    app_ready=true
    break
  fi
  if ! is_running "$WORKER_PID_FILE"; then
    c_err "worker 启动进程提前退出。日志末尾："
    [ -s "$WORKER_LOG" ] && tail -n 40 "$WORKER_LOG" >&2 || true
    exit 1
  fi
  if ! is_running "$WEB_PID_FILE"; then
    c_err "Web 启动进程提前退出。日志末尾："
    [ -s "$WEB_LOG" ] && tail -n 40 "$WEB_LOG" >&2 || true
    exit 1
  fi
  sleep 1
done

if [ "$app_ready" != true ]; then
  c_err "应用 ${APP_WAIT_SECONDS}s 内未通过聚合健康检查：$HEALTH_URL"
  if web_is_responding; then
    c_err "健康状态（不含密钥和底层异常）："
    curl -q -sS -m 8 "$HEALTH_URL" >&2 || true
    echo >&2
  fi
  [ -s "$WORKER_LOG" ] && tail -n 30 "$WORKER_LOG" >&2 || true
  [ -s "$WEB_LOG" ] && tail -n 30 "$WEB_LOG" >&2 || true
  exit 1
fi

startup_complete=true
trap - EXIT

echo
c_ok "全部就绪。  [mode=$APP_MODE]"
echo "  Web:     http://127.0.0.1:$PORT"
echo "  健康:    $HEALTH_URL"
echo "  Chroma:  $CHROMA_HEALTH_URL"
if [ "$SCENE_DETECT_ENABLED" = "true" ]; then
  echo "  分镜:    $SCENE_HEALTH_URL"
fi
echo "  模式:    $APP_MODE  (改 .env 的 APP_MODE=dev 切开发模式)"
echo "  日志:    $PID_DIR/{chroma,scene,worker,web}.log"
echo "  关闭:    ./scripts/stop.sh"
