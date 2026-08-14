#!/usr/bin/env bash
# 停止 assets-library 的所有服务：frontend + backend + worker + 分镜服务 + Chroma
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  while IFS='=' read -r key value || [ -n "$key" ]; do
    case "$key" in
      ''|\#*) continue ;;
    esac
    [ -n "${!key:-}" ] || export "$key=$value"
  done < .env
  set +a
fi

PROJECT_ROOT="$(pwd)"
BACKEND_ROOT="$PROJECT_ROOT/backend"
runtime_dir="${RUNTIME_DIR:-.run}"
case "$runtime_dir" in
  /*) PID_DIR="$runtime_dir" ;;
  *) PID_DIR="$PROJECT_ROOT/$runtime_dir" ;;
esac
PROCESS_STOP_TIMEOUT_SECONDS="${PROCESS_STOP_TIMEOUT_SECONDS:-35}"
if ! [[ "$PROCESS_STOP_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  printf '\033[0;31mPROCESS_STOP_TIMEOUT_SECONDS 必须是正整数。\033[0m\n' >&2
  exit 1
fi

mkdir -p "$PID_DIR"
command -v flock >/dev/null 2>&1 || {
  printf '\033[0;31m未找到 flock，无法安全停止服务。\033[0m\n' >&2
  exit 1
}
exec 9>"$PID_DIR/start.lock"
flock -w "$PROCESS_STOP_TIMEOUT_SECONDS" 9 || {
  printf '\033[0;31m启动流程仍在执行，暂时无法停止；请稍后重试。\033[0m\n' >&2
  exit 1
}

c_ok()   { printf '\033[0;32m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[0;33m%s\033[0m\n' "$*"; }
c_info() { printf '\033[0;36m%s\033[0m\n' "$*"; }

pid_from_file() {
  local file="$1" pid
  [ -f "$file" ] || return 1
  IFS= read -r pid < "$file" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] || return 1
  printf '%s' "$pid"
}

managed_running() {
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

stop_pid_file() {
  local name="$1" file="$2"
  if [ -f "$file" ]; then
    local pid
    if ! pid="$(pid_from_file "$file")"; then
      c_warn "$name PID 文件无效（清理残留文件）"
      rm -f "$file"
      return
    fi
    if managed_running "$pid"; then
      c_info "停止 $name (PID $pid) ..."
      if kill -0 -- "-$pid" 2>/dev/null; then
        kill -TERM -- "-$pid" 2>/dev/null || true
      else
        kill -TERM "$pid" 2>/dev/null || true
      fi
      for _ in $(seq 1 "$PROCESS_STOP_TIMEOUT_SECONDS"); do
        managed_running "$pid" || break
        sleep 1
      done
      if managed_running "$pid"; then
        c_warn "$name 未在 ${PROCESS_STOP_TIMEOUT_SECONDS}s 内退出，发送 SIGKILL"
        if kill -0 -- "-$pid" 2>/dev/null; then
          kill -KILL -- "-$pid" 2>/dev/null || true
        else
          kill -KILL "$pid" 2>/dev/null || true
        fi
      fi
      c_ok "$name 已停止"
    else
      c_warn "$name 进程已不存在（清理残留 PID 文件）"
    fi
    rm -f "$file"
  else
    c_warn "$name 未在运行（无 PID 文件）"
  fi
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
  c_info "停止未纳入 PID 文件管理的旧 worker (PGID $pgid) ..."
  kill -TERM -- "-$pgid" 2>/dev/null || true
  for _ in $(seq 1 "$PROCESS_STOP_TIMEOUT_SECONDS"); do
    kill -0 -- "-$pgid" 2>/dev/null || {
      c_ok "旧 worker 已停止"
      return
    }
    sleep 1
  done
  c_warn "worker 未在 ${PROCESS_STOP_TIMEOUT_SECONDS}s 内退出，发送 SIGKILL"
  kill -KILL -- "-$pgid" 2>/dev/null || true
}

# 先停对外 frontend，再停内部 backend 和 worker。
stop_pid_file "frontend" "$PID_DIR/frontend.pid"
stop_pid_file "backend" "$PID_DIR/backend.pid"

# 停止所有 worker 实例
for pid_file in "$PID_DIR"/worker-*.pid; do
  [ -f "$pid_file" ] || continue
  worker_index="${pid_file##*/worker-}"
  worker_index="${worker_index%.pid}"
  stop_pid_file "worker-$worker_index" "$pid_file"
  rm -f "$PID_DIR/worker-$worker_index.heartbeat.json"
done
# 兼容旧的 worker.pid 文件（如果存在）
if [ -f "$PID_DIR/worker.pid" ]; then
  stop_pid_file "worker" "$PID_DIR/worker.pid"
  rm -f "$PID_DIR/worker.heartbeat.json"
fi

# PID 文件丢失时仍按 cwd 精确识别当前仓库的 worker，避免留下重复队列消费者。
while IFS= read -r worker_group; do
  [ -n "$worker_group" ] || continue
  stop_orphan_worker_group "$worker_group"
done < <(project_worker_groups | sort -u)

# 再停只监听回环地址的分镜服务
stop_pid_file "分镜服务" "$PID_DIR/scene.pid"

# 最后停 Chroma
stop_pid_file "Chroma" "$PID_DIR/chroma.pid"

echo
c_ok "全部已停止。数据库、ZOS 对象和 Chroma 数据均保留。"
