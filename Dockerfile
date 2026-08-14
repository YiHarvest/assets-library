# syntax=docker/dockerfile:1

# 同一 tag 镜像包含 frontend、backend 和 worker，运行时通过 command 选择角色。
FROM node:22-bookworm-slim AS base

LABEL org.opencontainers.image.source="https://github.com/onestudentforcode/assets-library"

ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV PNPM_HOME=/pnpm
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate

WORKDIR /app

FROM base AS dependencies

ARG DEBIAN_MIRROR=http://mirrors.aliyun.com/debian
ARG DEBIAN_SECURITY_MIRROR=http://mirrors.aliyun.com/debian-security
RUN sed -i \
      -e "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" \
      -e "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY frontend/package.json ./frontend/package.json
COPY backend/package.json ./backend/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder

ARG NEXT_PUBLIC_BASE_PATH=
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
COPY frontend ./frontend
COPY backend ./backend
COPY scripts/log-pipe.mjs ./scripts/log-pipe.mjs
RUN pnpm --dir backend run build && pnpm --dir frontend run build

FROM base AS runner

ARG DEBIAN_MIRROR=http://mirrors.aliyun.com/debian
ARG DEBIAN_SECURITY_MIRROR=http://mirrors.aliyun.com/debian-security
ENV NODE_ENV=production
ENV PORT=23015
ENV BACKEND_HOST=127.0.0.1
ENV BACKEND_PORT=23017
ENV BACKEND_URL=http://127.0.0.1:23017
ENV RUNTIME_DIR=/app/.run
ENV RUN_DATABASE_MIGRATIONS=false

RUN sed -i \
      -e "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" \
      -e "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder --chown=node:node /app /app
COPY --chown=root:root docker-entrypoint.sh /usr/local/bin/docker-entrypoint
RUN chmod 0755 /usr/local/bin/docker-entrypoint \
    && mkdir -p /app/.run \
    && chown node:node /app/.run

EXPOSE 23015 23017
ENTRYPOINT ["/usr/local/bin/docker-entrypoint"]
CMD ["pnpm", "--dir", "frontend", "start"]
