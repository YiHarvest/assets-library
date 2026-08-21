#!/usr/bin/env bash
# 启动 assets-library 的所有服务：Chroma + 分镜服务 + Next.js Web + worker
# 模式由 .env 的 APP_MODE 决定（dev 默认 / prd）
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

APP_MODE="${APP_MODE:-dev}"
CHROMA_VERSION="${CHROMA_VERSION:-1.5.9}"
CHROMA_WAIT_SECONDS="${CHROMA_WAIT_SECONDS:-30}"
SCENE_DETECT_ENABLED="${SCENE_DETECT_ENABLED:-true}"
SCENE_DETECT_WAIT_SECONDS="${SCENE_DETECT_WAIT_SECONDS:-30}"

required_env=(PORT API_INTERNAL_ORIGIN WEB_LISTEN_HOST CHROMA_INDEX_URL CHROMA_URL CHROMA_PORT CHROMA_LISTEN_HOST)
if [ "$SCENE_DETECT_ENABLED" = "true" ]; then
  required_env+=(SCENE_DETECT_BASE_URL SCENE_DETECT_PORT SCENE_DETECT_LISTEN_HOST)
fi
for name in "${required_env[@]}"; do
  [ -n "${!name:-}" ] || {
    printf '缺少必需环境变量：%s\n' "$name" >&2
    exit 1
  }
done
CHROMA_DIR="$(pwd)/chroma-data"
PID_DIR="$(pwd)/.run"
mkdir -p "$PID_DIR" "$CHROMA_DIR"

c_ok()    { printf '\033[0;32m%s\033[0m\n' "$*"; }
c_warn()  { printf '\033[0;33m%s\033[0m\n' "$*"; }
c_err()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
c_info()  { printf '\033[0;36m%s\033[0m\n' "$*"; }

case "$APP_MODE" in
  dev|prd) ;;
  *)
    c_err "APP_MODE 必须是 dev 或 prd，当前值：$APP_MODE"
    exit 1
    ;;
esac

# prd 缺少页面锁密钥时必须在数据库迁移、worker 和 Web 启动前终止。
# 中间件仍会在运行时重复校验，防止绕过此标准启动脚本后意外放行。
c_info "校验 WebUI 页面锁 ..."
pnpm run webui-lock:check

# 在启动任何依赖、执行任何迁移前，解析并校验最终数据库目标。
# dev 必须连接以 _test 结尾的数据库；prd 必须连接非测试数据库。
c_info "校验数据库目标 ..."
pnpm run db:check-target

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

chroma_url="$CHROMA_URL"
chroma_authority="${chroma_url#*://}"
chroma_authority="${chroma_authority%%/*}"
chroma_url_port="${chroma_authority##*:}"
if [ "$chroma_url_port" = "$chroma_authority" ] || ! [[ "$chroma_url_port" =~ ^[0-9]+$ ]]; then
  c_err "CHROMA_URL 必须包含由 CHROMA_PORT 配置的显式端口。"
  exit 1
fi
if [ "$CHROMA_PORT" != "$chroma_url_port" ]; then
  c_err "CHROMA_PORT 与 CHROMA_URL 中的端口不一致，请保持两者一致。"
  exit 1
fi
CHROMA_HEALTH_URL="${CHROMA_URL%/}"

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

  [ "$host" = "localhost" ] || [[ "$host" =~ ^127\. ]]
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
  c_err "Chroma 监听地址已被未纳入当前 PID 文件的服务占用。"
  c_err "请先停止该旧实例，确认端口释放后再运行 ./scripts/start.sh。"
  exit 1
fi

if is_running "$CHROMA_PID_FILE"; then
  c_warn "Chroma 已在运行 (PID $(cat "$CHROMA_PID_FILE"))"
else
  rm -f "$CHROMA_PID_FILE"
  : > "$CHROMA_LOG"
  prepare_chroma_runtime
  c_info "启动 Chroma ..."
  nohup setsid env -u ALL_PROXY -u HTTPS_PROXY -u HTTP_PROXY \
    -u all_proxy -u https_proxy -u http_proxy \
    UV_INDEX_URL="$CHROMA_INDEX_URL" \
    uvx --offline --from "chromadb==$CHROMA_VERSION" chroma run \
    --path "$CHROMA_DIR" \
    --host "$CHROMA_LISTEN_HOST" \
    --port "$CHROMA_PORT" \
    > "$CHROMA_LOG" 2>&1 &
  chroma_pid=$!
  echo "$chroma_pid" > "$CHROMA_PID_FILE"
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

  if is_running "$SCENE_PID_FILE" && ! scene_is_ready; then
    c_warn "分镜服务 PID 存在但健康检查失败，自动清理后重新启动。"
    stop_managed_process "$SCENE_PID_FILE" "分镜服务"
  fi

  if ! is_running "$SCENE_PID_FILE" && scene_is_ready; then
    c_err "分镜服务监听地址已被未纳入当前 PID 文件的服务占用。"
    c_err "请先停止该旧实例，确认端口释放后再运行 ./scripts/start.sh。"
    exit 1
  fi

  if is_running "$SCENE_PID_FILE"; then
    c_warn "分镜服务已在运行 (PID $(cat "$SCENE_PID_FILE"))"
  else
    rm -f "$SCENE_PID_FILE"
    : > "$SCENE_LOG"
    c_info "启动分镜服务 ..."
    # 直接执行并由 run-scene-service.sh exec 到 uv，PID 文件可可靠控制服务进程。
    nohup setsid ./scripts/run-scene-service.sh > "$SCENE_LOG" 2>&1 &
    scene_pid=$!
    echo "$scene_pid" > "$SCENE_PID_FILE"
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
APP_PID_FILE="$PID_DIR/app.pid"
APP_LOG="$PID_DIR/app.log"
APP_LOG_MAX_BYTES="${APP_LOG_MAX_BYTES:-104857600}"

rotate_app_log_if_needed() {
  [ -f "$APP_LOG" ] || return 0
  local current_size rotated
  current_size="$(stat -c '%s' "$APP_LOG" 2>/dev/null || printf '0')"
  [ "$current_size" -lt "$APP_LOG_MAX_BYTES" ] || {
    rotated="$PID_DIR/app-$(date -u +%Y%m%dT%H%M%SZ).log"
    mv "$APP_LOG" "$rotated"
    c_info "app.log 已达到 ${current_size} bytes，轮转为 $rotated"
  }
}

web_is_ready() {
  curl -q -fsS -m 1 "$API_INTERNAL_ORIGIN" >/dev/null 2>&1
}

if is_running "$APP_PID_FILE" \
  && ! web_is_ready; then
  c_warn "Web+worker PID 存在但健康检查失败，自动清理后重新启动。"
  stop_managed_process "$APP_PID_FILE" "Web+worker"
fi

# PID 文件缺失时不能直接覆盖一个已经监听的旧实例，否则新进程会因
# EADDRINUSE 退出，并把原实例留在重建后的 .next 上造成客户端 chunk 异常。
if ! is_running "$APP_PID_FILE" && web_is_ready; then
  c_err "Web 监听地址已被未纳入当前 PID 文件的服务占用。"
  c_err "请先停止该旧实例，确认端口释放后再运行 ./scripts/start.sh。"
  exit 1
fi

if is_running "$APP_PID_FILE"; then
  c_warn "Web+worker 已在运行 (PID $(cat "$APP_PID_FILE"))"
else
  rotate_app_log_if_needed
  if [ "$APP_MODE" = "dev" ]; then
    c_info "启动 Web + worker [dev/turbopack] ..."
    nohup setsid env PORT="$PORT" HOSTNAME="$WEB_LISTEN_HOST" \
      pnpm run dev >> "$APP_LOG" 2>&1 &
  else
    # prd: 确保 build 产物存在
    if [ ! -d ".next" ] || [ ! -f ".next/BUILD_ID" ]; then
      c_info "生产模式首次启动，执行 build ..."
      pnpm run build
    fi
    c_info "启动 Web + worker [prd] ..."
    nohup setsid env PORT="$PORT" HOSTNAME="$WEB_LISTEN_HOST" \
      pnpm run start:all >> "$APP_LOG" 2>&1 &
  fi
  app_pid=$!
  echo "$app_pid" > "$APP_PID_FILE"
  # prd 秒起，dev 首次编译慢，统一给 60s
  app_ready=false
  for i in $(seq 1 60); do
    if web_is_ready; then
      c_ok "Web 就绪 [mode=$APP_MODE]"
      app_ready=true
      break
    fi
    if ! is_running "$APP_PID_FILE"; then
      wait "$app_pid" 2>/dev/null || app_status=$?
      rm -f "$APP_PID_FILE"
      c_err "Web+worker 启动进程提前退出（状态码 ${app_status:-0}）。"
      [ -s "$APP_LOG" ] && tail -n 40 "$APP_LOG" >&2 || true
      exit 1
    fi
    sleep 1
  done
  if [ "$app_ready" != true ]; then
    stop_managed_process "$APP_PID_FILE" "Web+worker"
    c_err "Web 60s 内未响应，已停止 Web+worker 启动进程。日志末尾："
    [ -s "$APP_LOG" ] && tail -n 40 "$APP_LOG" >&2 || true
    exit 1
  fi
fi

echo
c_ok "全部就绪。  [mode=$APP_MODE]"
echo "  Web、Chroma 与已启用的辅助服务均已就绪。"
echo "  模式:    $APP_MODE  (改 .env 的 APP_MODE=dev 切开发模式)"
echo "  日志:    $PID_DIR/{chroma,scene,app}.log"
echo "  关闭:    ./scripts/stop.sh"
