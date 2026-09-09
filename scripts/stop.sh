#!/usr/bin/env bash
# 停止 assets-library 的所有服务：Web + worker + 分镜服务
set -euo pipefail

cd "$(dirname "$0")/.."

PID_DIR="$(pwd)/.run"

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
      for i in $(seq 1 10); do
        managed_running "$pid" || break
        sleep 1
      done
      if managed_running "$pid"; then
        c_warn "$name 未在 10s 内退出，发送 SIGKILL"
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

# 先停 Web+worker（dev/prd 都是 concurrently 父进程，会带走 next 和 tsx 子进程）
stop_pid_file "Web+worker" "$PID_DIR/app.pid"

# 再停只监听回环地址的分镜服务
stop_pid_file "分镜服务" "$PID_DIR/scene.pid"

echo
c_ok "全部已停止。数据保留在 ./data、./media。"
