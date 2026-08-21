#!/usr/bin/env bash

set -Eeuo pipefail

# Playwright 的 webServer 由 shell 启动。把迁移和 Next 进程拆开，并用 exec
# 交出进程所有权，确保 stdout、退出信号和子进程生命周期都能被可靠管理。
pnpm db:migrate
export NEXT_DIST_DIR="${NEXT_DIST_DIR:-.next-e2e}"
: "${E2E_PORT:?E2E_PORT must be configured in the environment}"
exec pnpm exec next dev -p "$E2E_PORT"
