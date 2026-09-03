# Metabase 独立只读部署

Metabase 是独立部署的只读数据入口。配置随业务仓库维护，但运行时不嵌入 Next.js 应用。它只连接目标业务库，展示 16 张应用基础表、1 张迁移表、2 个报表视图及全部字段；只读限制由 MySQL 账号授权强制执行。

完整表结构、字段含义和关系说明见 [`docs/DATABASE_DICTIONARY.md`](docs/DATABASE_DICTIONARY.md)。

## 架构

- Metabase：按 `.env` 中的 `MB_JETTY_HOST` / `MB_JETTY_PORT` 监听，外部入口由 `MB_SITE_URL` 指定。
- Metabase 元数据库：独立 PostgreSQL，监听地址与端口由环境配置注入。
- 数据源：只添加目标生产数据源，不把 DEV/TEST 数据源混入同一实例。
- Metabase 不读取应用的 `APP_MODE`，也不复用应用数据库账号。

元数据库保存用户、问题、仪表盘和数据源连接信息。它不是业务数据副本，必须单独备份。

## 1. 本地配置

```bash
cp ops/metabase/.env.example ops/metabase/.env
cp ops/metabase/.reader.env.example ops/metabase/.reader.env
openssl rand -base64 32
```

分别生成并填写以下随机密码：

- `MB_DB_PASS` / `POSTGRES_PASSWORD`：两项使用同一个值。
- `METABASE_PRD_DB_PASS`

再生成独立的 `MB_ENCRYPTION_SECRET_KEY`。真实环境文件已被 Git 忽略，权限应设置为仅当前用户可读：

```bash
chmod 600 ops/metabase/.env ops/metabase/.reader.env
```

## 2. 创建 MySQL 只读账号

执行者需要一个能够 `CREATE USER` 和 `GRANT` 的 DBA 连接。该连接只临时通过环境变量提供，不写入仓库：

```bash
METABASE_MYSQL_ADMIN_URL='mysql://<admin>:<password>@<host>:<port>/mysql' \
  pnpm run metabase:provision-reader
```

脚本执行以下保护：

- 禁止将允许来源设置为 `%`。
- 只授予目标库的 `SELECT`。
- 强制 TLS，并限制每个账号最多 5 个连接。
- 如果账号已存在则停止，不会擅自轮换已有密码。
- 授权失败时回滚刚创建的账号。

## 3. 启动

```bash
pnpm run metabase:config
pnpm run metabase:up
pnpm run metabase:status
pnpm run metabase:logs
```

首次访问 `.env` 中 `MB_SITE_URL` 指定的地址登录 Metabase。当前为公网 HTTP；长期使用应接入独立域名和 HTTPS。

PostgreSQL 始终只监听 loopback。只有 Metabase Web 端口对公网开放；不要公开 `25432`。

## 4. 添加数据源

在 `Admin > Databases > Add a database` 中只添加 `Assets Library · PRD ⚠️`。

连接字段来自 `.reader.env` 中的 `METABASE_PRD_DB_*`。远程 MySQL 必须启用 SSL，CA 以只读方式挂载到 `/certs/mysql-ca.pem`。

关闭以下需要写权限的功能：

- Editable table data
- Actions
- Uploads
- Model persistence
- Transforms

不要复用应用写账号，也不要添加 DEV/TEST 数据源。

## 5. 验证只读与全字段可见

```bash
pnpm run metabase:verify-reader
```

验证脚本会确认：

- 授权只有 `USAGE` 和 `SELECT`。
- 16 张应用表和 2 个报表视图全部可见。
- `INFORMATION_SCHEMA.COLUMNS` 能发现所有字段。

数据库迁移新增或修改报表对象后，同步 Metabase schema 和中文字段说明：

```bash
pnpm run metabase:sync-reporting-metadata
```

该命令只更新 Metabase 自身的元数据描述，不会修改 MySQL 业务数据。

业务表清单：

- `users`
- `tasks`
- `task_items`
- `idempotency_requests`
- `media_objects`
- `video_sources`
- `task_item_segments`
- `public_assets`
- `private_assets`
- `analysis_results`
- `tags`
- `asset_tags`
- `asset_tag_rejections`
- `jobs`
- `outbox_events`
- `callback_deliveries`
- `search_index_state`

报表视图：

- `reporting_database_tables`：所有基础表的用途和实时精确行数。
- `reporting_user_assets`：以 `user_id` 为入口，仅汇总私人素材、素材明细和父视频切片统计。

## 6. 数据模型关系

首次同步后，在 Metabase Metadata 中确认以下外键：

- `tasks.id` → `task_items.task_id`
- `tasks.id` → `jobs.task_id`
- `public_assets.id` / `private_assets.id` → `analysis_results.public_asset_id` / `private_asset_id`
- `public_assets.id` / `private_assets.id` → `asset_tags.public_asset_id` / `private_asset_id`
- `asset_tags.tag_id` → `tags.id`
- `public_assets.id` / `private_assets.id` → `jobs.public_asset_id` / `private_asset_id`
- `public_assets.id` / `private_assets.id` → `search_index_state.public_asset_id` / `private_asset_id`

数据库存储 UTC。Metabase/JVM 默认使用 `Asia/Shanghai`；上线前用一条已知记录核对时间显示。如果 MySQL `DATETIME` 被错误转换，先将 Metabase报告时区设为 UTC，再在正式问题中显式转换。

## 7. 首批仪表盘

- 素材总览：新增趋势、媒体类型、处理/审核状态、存储量。
- 任务与 Worker：队列深度、成功率、耗时、重试、错误码。
- 标签与模型：标签覆盖、热门标签、模型版本、人工/模型来源。
- 存储与检索：对象状态、回调状态、`search_index_state` 覆盖率。

Chroma 的向量内容不在 MySQL 中，Metabase只能展示 `search_index_state`。如需 Chroma容量和集合统计，需要另外汇总进 MySQL。

## 8. 备份与升级

- 每日备份 `assets-library-metabase-postgres` 卷或 PostgreSQL 逻辑备份。
- 将 `MB_ENCRYPTION_SECRET_KEY` 存入密钥管理系统；丢失后无法解密数据源密码。
- 升级前备份元数据库。
- `ops/metabase/compose.yaml` 固定镜像版本，不直接使用 `latest`。
- 停止服务使用 `pnpm run metabase:down`；不要附加 `-v`，否则会删除元数据库卷。

## 9. 远程 Podman Compose

- 远程运行目录使用 `~/services/assets-library-metabase`，与 MySQL 容器存储完全分离。
- `podman-compose` 安装在该目录的 Python venv 中，不修改系统 Python。
- Metabase/PostgreSQL 使用独立项目名和卷，不执行任何现有容器的 stop/restart/exec。
- PostgreSQL 元数据卷不要放到 MySQL 所在的高使用率数据盘。
- 管理员凭据保存在远程 `.admin.env`，权限为 `600`；数据库只读凭据保存在 `.reader.env`。
- 公网入口以远程 `.env` 的 `MB_SITE_URL` 为准。接入 HTTPS 后同步更新该值。
