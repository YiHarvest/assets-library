# 素材中枢

面向内部业务的多模态素材库。项目使用 Next.js 15、TypeScript、MySQL、
Chroma、电信云 ZOS 和独立分镜服务，提供图片与视频上传、视觉模型分析、
标签管理、语义检索及用户/公共素材管理。

## 当前架构

- Web 与 worker 共用远程 MySQL；数据库会话统一使用 UTC，API 时间统一返回
  ISO 8601 上海时区（`+08:00`）。
- 上传文件先流式写入 `MEDIA_ROOT/.staging`，不在进程内长期缓存完整文件或分析结果。
- 图片按文件名扩展名正规化为 JPEG、PNG 或 WebP，先保存到本地待审核区；
  发布后才进入私有 ZOS。
- 完整视频先正规化为 H.264/yuv420p MP4，再交给同机
  `scene-detect-service` 分镜。父视频仅作为内部来源保存，素材库对外只暴露子视频。
- 父视频不进入 ZOS。全部子视频和第一帧先在一个 MySQL 事务中建立本地待审核记录；
  任一切片损坏、下载不完整或超过 10 MiB 时，整批不建立素材。
- 整批持久化成功后，每个子视频独立提取 1–5 张关键帧并进入现有 VLM 分析流程。
- 语义向量保存到 Chroma；关系数据、任务状态和分析结果保存到 MySQL。
- 所有业务 API 使用 `/api/v1` 和 `snake_case`。项目部署于可信内网，接口不做
  API Key 或登录鉴权；素材可见范围仍由 `user_id` 规则约束。

## 环境要求

- Linux
- Node.js 22+
- pnpm 11.3+
- FFmpeg / ffprobe
- `uv` / `uvx`
- 可访问的 MySQL 8.4、私有 ZOS、VLM/embedding 服务
- 与本仓库同级的 `scene-detect-service` 仓库，或通过
  `SCENE_DETECT_PROJECT_DIR` 指向它

初始化：

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

真实连接串、模型令牌和 ZOS 密钥只能写在未提交的 `.env` 或部署平台的
Secret 中，不能写入 README、Compose、镜像或 Git 历史。

## 一键启动与停止

本地及同机部署的标准入口是：

```bash
./scripts/start.sh
./scripts/stop.sh
```

`start.sh` 会依次执行：

1. 固定版本启动本地 Chroma，并等待 heartbeat；
2. 从 `SCENE_DETECT_PROJECT_DIR` 启动仅监听 `127.0.0.1` 的分镜服务；
3. 通过 Drizzle 的数据库迁移账本幂等执行 MySQL migration；
4. 启动 Next.js Web 与 worker，并等待 Web 健康检查。

默认端口链固定为：Web `23015`、Chroma `23016`、分镜服务 `28200`。
Web 与 worker 分别写入 `.run/web.pid`、`.run/worker.pid`；worker 每 2 秒原子更新
`.run/worker.heartbeat.json`。脚本最终调用 `GET /health`，只有 Web、worker、
MySQL（UTC 会话）、Chroma、分镜服务与 ZOS bucket 全部可用时才报告启动成功。
分镜明确禁用时健康状态为 `disabled`，不阻塞图片场景启动。

任一依赖提前退出或超时，脚本会显示对应日志末尾、只清理本次启动的新进程并
返回非零状态，不会误报“全部就绪”。每次启动都会幂等执行 MySQL migration；
生产模式会重新构建以避免旧 `.next` 与源码不一致。运行日志位于 `.run/`。

`APP_MODE=dev` 使用 Turbopack 开发模式；`APP_MODE=prd` 使用构建产物。应用监听地址
由 `PORT` 控制。服务监听可以使用 `0.0.0.0`，但同机客户端连接地址应使用
`127.0.0.1`，不能把 `0.0.0.0` 当作目标地址。

浏览器打开应用即可使用，无登录页。服务间调用 `/api/v1` 也不需要鉴权 Header；
因此部署边界必须由可信内网、反向代理或防火墙保证，不能直接暴露到公网。

## 关键配置

完整模板见 [.env.example](.env.example)。主要配置包括：

```dotenv
DATABASE_URL=mysql://<user>:<url-encoded-password>@<host>:<port>/<database>
DATABASE_SSL_CA_PATH=./data/mysql-ca.pem
DATABASE_POOL_SIZE=20
PORT=23015
APP_MODE=prd
MEDIA_ROOT=./media
UPLOAD_MAX_TOTAL_BYTES=2147483648
PENDING_ASSET_RETENTION_HOURS=24
TASK_HISTORY_RETENTION_HOURS=24
CLEANUP_INTERVAL_SECONDS=3600

SCENE_DETECT_ENABLED=true
SCENE_DETECT_BASE_URL=http://127.0.0.1:28200
SCENE_DETECT_PROJECT_DIR=../scene-detect-service
SCENE_SEGMENT_MAX_BYTES=10485760

CHROMA_URL=http://127.0.0.1:23016

ZOS_API_ENDPOINT=<s3-compatible-api-endpoint>
ZOS_BUCKET=<private-bucket>
ZOS_ACCESS_KEY_ID=<secret>
ZOS_SECRET_ACCESS_KEY=<secret>
```

远程 MySQL 必须配置 CA。应用连接会验证证书链，禁用明文远程连接。数据库从空库
开始时执行：

```bash
pnpm db:migrate
```

迁移由 MySQL 中的 Drizzle 迁移表判断，不使用本地 marker。数据库 schema 的唯一来源为
[schema.ts](src/server/db/schema.ts)，迁移文件位于 `drizzle/`。

## API v1

完整请求/响应、字段类型和错误码见 [API 文档](docs/api.md)；机器可读规范见
[OpenAPI](spec/contracts/openapi.yaml)，浏览器文档页位于 `/api-docs`。项目不提供
`/docs` 路由，避免产生两个含义相同的文档入口。

`GET /health` 是无需业务参数的部署探针，成功返回 `200`，任一必需依赖不可用时
返回 `503`。响应只包含 `web`、`worker`、`mysql`、`chroma`、`scene_detect`、
`zos` 的 `up`/`down`/`disabled` 状态和上海时区检查时间，不会返回连接地址、
密钥或底层异常。

主要接口：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/v1/uploads` | 单次 multipart 上传 1–5 张图片或一个视频，并启动异步处理 |
| `GET` | `/api/v1/tasks?task_id=...` | 查询上传及所有异步变更任务 |
| `POST` | `/api/v1/assets/list` | 列出已发布图片和视频第一帧直链 |
| `POST` | `/api/v1/assets/search` | 组合过滤、标签统计与语义搜索 |
| `GET` | `/api/v1/assets/detail?asset_id=...` | 获取素材详情 |
| `PATCH` | `/api/v1/assets` | 异步修改素材 |
| `POST` | `/api/v1/assets/actions` | 异步发布、重试或删除素材 |
| `POST` | `/api/v1/storage/usage` | 统计用户或公共库的已发布对象空间 |
| `GET` | `/api/v1/media?asset_id=...` | 图片/子视频直链和 HTTP Range |
| `GET` | `/api/v1/thumbnail?asset_id=...` | 视频第一帧直链和 HTTP Range |

上传请求使用重复的 `files` multipart 字段，一次只允许 1–5 张图片，或恰好一个视频，
两类不能混合。`content_type` 由后端根据目标扩展名和完整解码结果确定，不由调用者提交。
请求中途断开时整批重新上传；项目不提供三阶段上传、断点续传或 Idempotency-Key。

任务及 item 的 `status` 仅使用 `queued`、`running`、`done`、`failed`；详细阶段由
`phase` 表达。创建任务时可选 `callback_url`。没有回调时按 `task_id` 轮询；有回调时
服务会在终态发送与查询接口同结构的任务摘要，并记录、退避重试投递。回调目标属于内部
可信配置，服务不会跟随 HTTP 重定向。

## 用户与公共素材

`assets.user_id IS NULL` 表示公共素材；非空表示对应用户的个人素材。`user_id` 是由上游
系统提供的外部字符串，本项目当前不维护 users 表。

- 查询不提供用户范围时只返回公共素材；`mode=user` 精确查询一个用户；`all` 和
  `exclude_user` 必须显式请求。
- 个人素材删除必须提供匹配的 `user_id`，操作只把 `user_id` 置空，使其转为公共素材，
  不删除 ZOS 文件、向量或分析结果。
- 不提供 `user_id` 的删除只针对公共素材，worker 会幂等清理 Chroma、ZOS 与 MySQL。
- 视频切片可独立删除；同一父视频的最后一个切片删除后，父视频对象自动回收。

本阶段是可信内网、无应用层鉴权模型。调用者可以声明任意 `user_id`，因此生产入口必须由
内网网关或防火墙限制来源；若未来面向不可信客户端，必须从受信身份令牌派生 user_id。

## 文件与任务生命周期

- 上传 staging、分析下载文件和分镜工作区在处理完成后立即清理；异常残留最多保留
  `PENDING_ASSET_RETENTION_HOURS`（默认 24 小时）。
- 待审核图片、子视频和第一帧仅保存在 `media/.pending`。分析完成后未发布满 24 小时，
  worker 会硬删除媒体、素材/分析/标签/父子关系和 Chroma 向量。
- 发布时才把图片，或子视频及其第一帧上传 ZOS；成功切换 MySQL 引用后立即删除本地副本。
  完整父视频始终不上传 ZOS。
- 终态任务从最后一次完成/过期清理起继续保留 `TASK_HISTORY_RETENTION_HOURS`（默认
  24 小时），之后从 MySQL 删除。

## 模型与候选链

图片以及子视频关键帧使用 VLM。配置主模型和有序候选：

```dotenv
VLM_PROTOCOL=openai_chat_completions
VLM_BASE_URL=<openai-compatible-base-url>
VLM_API_KEY=<secret>
VLM_NAME=<primary-model-id>
VLM_FALLBACK_NAMES=<fallback-id-1>,<fallback-id-2>
VLM_ENABLE_THINKING=false
```

主模型与 fallback 合计最多 5 个，精确去重，并共享 protocol、Base URL 和 API Key。
额度耗尽、模型不存在或明确不支持图片输入时会切换候选；网络、超时、普通限流和 5xx
先按 `VLM_RETRY_COUNT` 重试。401/403 和普通请求参数错误会立即失败。成功结果保存实际
使用的模型名与协议。LLM 组已独立配置，但当前业务尚未调用。

设置 `EMBEDDING_MODEL` 后启用 Chroma 语义索引。`POST /api/v1/assets/query` 会先在
MySQL 中应用 user scope、媒体类型、状态、精确标签和关键词过滤，再用这些候选 ID 查询
Chroma，防止越权召回。当前语义查询是单页 top-k，不接受 cursor。

## 测试与构建

所有会修改数据库的集成测试只允许连接名称以 `_test` 结尾的专用 MySQL 数据库：

```dotenv
TEST_DATABASE_URL=mysql://<test-user>:<password>@<host>:<port>/assets_library_test
```

执行完整验证：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm build
```

媒体测试依赖 FFmpeg；MySQL 集成测试会清空 `_test` 库中的业务表，禁止把
`TEST_DATABASE_URL` 指向生产库。详细人工验收见 [quickstart](spec/quickstart.md)。

## Docker 说明

Dockerfile 仍可用同一镜像分别运行 Web 和 worker，但 MySQL、ZOS、Chroma 与分镜服务属于
外部依赖。当前推荐的完整同机启动路径仍是 `./scripts/start.sh`；在容器环境中使用前，
需要单独部署或挂载 `scene-detect-service`，并通过环境变量提供远程 MySQL CA 与 ZOS
Secret。镜像和 Git 仓库不包含 `.env`、证书、上传文件或数据库数据。
