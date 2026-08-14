#!/bin/sh
set -eu

runtime_dir="${RUNTIME_DIR:-/app/.run}"
mkdir -p "$runtime_dir"
chown node:node "$runtime_dir"

log_fifo=""
logger_pid=""
if [ -n "${LOG_SERVICE:-}" ]; then
  log_fifo="$runtime_dir/${LOG_SERVICE}.pipe.$$"
  mkfifo "$log_fifo"
  chown node:node "$log_fifo"
  setpriv --reuid=node --regid=node --init-groups \
    node /app/scripts/log-pipe.mjs <"$log_fifo" &
  logger_pid=$!
  # 父进程持续持有写端，避免 migration 与正式服务之间出现 EOF/重新打开竞态。
  exec 3>"$log_fifo"
fi

case "${RUN_DATABASE_MIGRATIONS:-false}" in
  true)
    # compose 只允许 backend 角色打开此开关；flock 防止同一主机并发迁移。
    if [ -n "$log_fifo" ]; then
      setpriv --reuid=node --regid=node --init-groups \
        flock "$runtime_dir/database-migration.lock" \
        pnpm --dir backend run db:migrate >&3 2>&1
    else
      setpriv --reuid=node --regid=node --init-groups \
        flock "$runtime_dir/database-migration.lock" \
        pnpm --dir backend run db:migrate
    fi
    ;;
  false)
    if [ -n "$log_fifo" ]; then
      echo "RUN_DATABASE_MIGRATIONS=false，已跳过数据库迁移。" >&3
    else
      echo "RUN_DATABASE_MIGRATIONS=false，已跳过数据库迁移。"
    fi
    ;;
  *)
    echo "RUN_DATABASE_MIGRATIONS 只能是 true 或 false。" >&2
    exit 1
    ;;
esac

if [ -z "${LOG_SERVICE:-}" ]; then
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

# 容器角色也沿用宿主机的一套按日日志、脱敏和保留策略。
setpriv --reuid=node --regid=node --init-groups "$@" >&3 2>&1 &
service_pid=$!

forward_signal() {
  kill -TERM "$service_pid" 2>/dev/null || true
}
trap forward_signal INT TERM

set +e
wait "$service_pid"
service_status=$?
exec 3>&-
wait "$logger_pid"
set -e
rm -f "$log_fifo"
exit "$service_status"
