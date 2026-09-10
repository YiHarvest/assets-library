# 素材中枢

<p align="center">
  <img src="./assets/assets-library-hero.svg" width="100%" alt="素材中枢：多模态素材从上传到语义检索">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-15-000000?style=flat&amp;logo=nextdotjs&amp;logoColor=white" alt="Next.js 15">
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat&amp;logo=react&amp;logoColor=082F49" alt="React 19">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat&amp;logo=typescript&amp;logoColor=white" alt="TypeScript 5.9">
  <img src="https://img.shields.io/badge/MySQL-8.4-4479A1?style=flat&amp;logo=mysql&amp;logoColor=white" alt="MySQL 8.4">
  <img src="https://img.shields.io/badge/FastAPI-Python-009688?style=flat&amp;logo=fastapi&amp;logoColor=white" alt="FastAPI and Python">
  <img src="https://img.shields.io/badge/FFmpeg-NVENC-007808?style=flat&amp;logo=ffmpeg&amp;logoColor=white" alt="FFmpeg and NVIDIA NVENC">
</p>

<p align="center">
  面向内部业务的多模态素材库：统一接收图片和视频，自动完成媒体校验、视频分镜、
  视觉分析、标签提取、对象存储与语义检索。
</p>

项目由 Next.js Web/API、MySQL 作业 worker、Elasticsearch、私有 ZOS，以及内置的
`scene-detect-service` 分镜子模块组成。默认针对支持 NVIDIA NVENC 的单机部署优化。

## 功能

- 批量上传图片与视频，支持任务状态、逐项进度、失败重试和可靠回调。
- 图片正规化后写入私有 ZOS；视频先切成独立分镜，再作为素材分析和入库。
- VLM 自动生成描述与结构化标签，支持主模型及有序 fallback 候选链。
- MySQL 负责关系数据和可靠作业，Elasticsearch 负责语义向量及按字段组织的关键词检索，经 RRF 融合排序。
- 支持待审核、发布、修改、删除，以及个人素材与公共素材的作用域管理。
- 媒体接口支持私有文件代理、下载和 HTTP Range，不向浏览器暴露 ZOS 密钥。
- 内置带 Bearer 鉴权的 MCP 服务，支持 URL/批量入库、任务恢复、素材检索与异步管理。
- MCP 写操作支持持久化幂等键；结构化审计日志可串联来源拉取、上传和 worker 处理链路。
- `dev`/`prd` 数据库目标硬隔离，启动和 Drizzle CLI 共用同一套安全校验。

## 技术栈

| 层级 | 技术 | 职责 |
| --- | --- | --- |
| Web 与 API | Next.js 15、React 19、TypeScript 5.9、Tailwind CSS 4 | 素材管理界面、Route Handlers、OpenAPI 文档 |
| 数据与作业 | MySQL 8.4、Drizzle ORM、`FOR UPDATE SKIP LOCKED` | 关系数据、migration、可靠异步作业与租约 |
| 视频分镜 | Python、FastAPI、PySceneDetect、FFmpeg | 异步场景检测、精确切片、状态轮询与崩溃恢复 |
| GPU 加速 | NVIDIA CUDA / NVENC | 视频硬件解码与 H.264 硬件编码，失败自动回退 CPU |
| 对象存储 | 电信云 ZOS、AWS S3 SDK | 私有父视频、分片、图片和缩略图存储 |
| AI 分析 | OpenAI-compatible VLM / Embedding API | 描述生成、结构化标签、模型 fallback |
| 语义检索 | Elasticsearch | 分析结果向量化与受作用域约束的语义召回 |
| 工程质量 | Zod、Vitest、Playwright、Pytest、Ruff、ESLint | 配置校验、单元/集成/E2E 与静态检查 |

## 视频处理流程

<p align="center">
  <img src="./assets/video-pipeline.svg" width="100%" alt="4 个视频 worker、8 路分片与 ZOS 并发的视频处理流水线">
</p>

```text
上传 MP4
  → 本地 staging + 完整媒体校验
  → scene-detect-service 异步队列（4 个视频 worker）
  → PySceneDetect + FFmpeg/NVENC 精确分片
  → 下载、校验、抽取缩略图（每批最多 8 路并发）
  → 父视频、分片、缩略图上传 ZOS（最多 8 路并发）
  → 单个 MySQL 事务整批建档
  → 主应用作业池（4 路）并行调用 VLM
  → 分析结果写入 MySQL，向量写入 Elasticsearch
```

分镜接口采用 `POST 202 + GET 轮询`，不会让上传请求一直阻塞。队列有容量上限，
满载时返回 503；任务状态落盘，服务重启会恢复 `queued`/`processing` 任务。客户端
超时、取消或失败时会主动删除远端任务目录。

ZOS 和 MySQL 无法共享事务，因此视频入库使用 Saga：所有对象上传完成后才提交一个
MySQL 事务；任一上传、校验或数据库操作失败，会等待在途上传结束并补偿删除整批对象。

## 快速开始

要求：Linux 或 macOS、Node.js 22+、pnpm 11.3+、FFmpeg/ffprobe、`uv`/`uvx`，以及可访问的
MySQL 8.4、ZOS 和 OpenAI-compatible 模型服务。

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env

./scripts/start.sh
```

浏览器访问脚本输出的 Web 地址。停止全部托管进程：

```bash
./scripts/stop.sh
```

`start.sh` 会依次执行数据库目标安全检查、启动分镜服务、执行
Drizzle migration、启动 Web 与 worker。任一服务异常会输出 `.run/` 中对应日志并终止，
不会继续执行后续步骤。

## dev 与 prd 数据库隔离

这是启动流程的硬约束，不只是注释约定。

| 模式 | 数据库 | 内部模型服务 | Web |
| --- | --- | --- | --- |
| `APP_MODE=dev` | 将 `DATABASE_URL` 的库名替换为 `DEV_DATABASE_NAME`；名称必须以 `_test` 结尾 | 保留 `.env` 中的远程地址，例如开发机访问 `<INTERNAL_SERVER_IP>` | `next dev --turbo` |
| `APP_MODE=prd` | 将库名强制替换为 `PRD_DATABASE_NAME`；拒绝 `_test` 库，并把主机改为 `PRD_INTERNAL_SERVICE_HOST` | VLM、LLM、Embedding 的 IP/localhost 主机由 `PRD_INTERNAL_SERVICE_HOST` 注入，外部域名保留 | `next start` |

当前开发配置应得到类似输出：

```text
Database target OK: mode=dev target=<INTERNAL_SERVER_IP>:<MYSQL_PORT>/assets_library_dev_test
```

可以在启动前单独确认，输出不会包含数据库密码：

```bash
pnpm db:check-target
```

安全边界：

- `dev` 连接非 `_test` 数据库时，应用、migration 和 Drizzle CLI 都会直接拒绝运行。
- `prd` 连接 `_test` 数据库时同样拒绝运行。
- `drizzle.config.ts` 不直接读取原始 `DATABASE_URL`，而是调用 `loadConfig()`，因此
  `pnpm db:generate` 等 Drizzle 命令与 `start.sh` 使用相同的最终目标解析。
- `start.sh` 在启动依赖和执行 migration 之前先运行 `db:check-target`。

推荐的开发配置：

```dotenv
APP_MODE=dev
PRD_INTERNAL_SERVICE_HOST=
DATABASE_URL=mysql://<user>:<url-encoded-password>@<INTERNAL_SERVER_IP>:<MYSQL_PORT>/assets_library_dev_test
DEV_DATABASE_NAME=assets_library_dev_test
PRD_DATABASE_NAME=assets_library
TEST_DATABASE_URL=mysql://<user>:<url-encoded-password>@<INTERNAL_SERVER_IP>:<MYSQL_PORT>/assets_library_test
```

`DATABASE_URL` 的主机和认证信息由两种模式共用，库名会被模式专用配置强制替换：dev 使用
`DEV_DATABASE_NAME`，prd 使用 `PRD_DATABASE_NAME`。当前 dev 的增、删、改、查和 migration
目标都是 `assets_library_dev_test`；正式部署必须显式设置 `APP_MODE=prd`。

## 关键配置

完整模板见 [.env.example](.env.example)。密钥只写入未提交的 `.env` 或部署平台 Secret，
不要写进 README、镜像或 Git 历史。

### 并发与分镜

```dotenv
DATABASE_POOL_SIZE=6
WORKER_CONCURRENCY=4
WORKER_ANALYZE_TASK_SOFT_LIMIT=2
SCENE_DETECT_WORKERS=4
SCENE_SEGMENT_CONCURRENCY=8
SCENE_PERSIST_CONCURRENCY=8

SCENE_DETECT_QUEUE_MAX_SIZE=20
SCENE_DETECT_QUEUE_MAX_RETRIES=1
SCENE_DETECT_TIMEOUT_MS=600000
SCENE_DETECT_POLL_INTERVAL_MS=1000

FFMPEG_HW_ACCEL=auto
FFMPEG_ENCODER_QUALITY=23
FFMPEG_ENCODER_PRESET=p4
```

Web 与 worker 是两个独立进程，会各自创建最多 6 条数据库连接。
数据库作业保持 4 个全局 worker；有多个视频等待分析时，每个任务最多占用 2 个
分析 worker，只有一个任务等待时可自动使用全部 4 个。新上传文件的 `validate`
作业优先领取，避免被上一条视频的大量分镜分析作业长时间阻塞。

`auto` 会实际编码一帧探测 NVENC，探测失败时回退 `libx264`。分镜服务固定使用一个
Uvicorn 进程，视频级并发由内部 4 个队列 worker 控制；不要再通过增加 Uvicorn workers
复制进程内队列。

召回的视频裁剪、图片转视频也复用 `FFMPEG_HW_ACCEL`：`auto` 优先 NVENC，探测或实际转码失败时使用 CPU；`none` 仅用 CPU；`cuda` 要求 GPU 编码成功，失败直接报错。CPU 负责输入解码、图片处理、滤镜与音频，GPU 负责编码 H.264。FFmpeg 通过异步子进程执行，每个 Web 进程最多同时准备两个片段；首次媒体下载会等转码完成后再返回，后续读取缓存。驱动与 FFmpeg 的 NVENC API 必须兼容，仅能在编码器列表里看到 `h264_nvenc` 不代表 GPU 可用。

### 模型与向量

```dotenv
VLM_PROTOCOL=openai_chat_completions
VLM_BASE_URL=http://<INTERNAL_SERVER_IP>:<VLM_PORT>/v1
VLM_API_KEY=<secret>
VLM_NAME=<primary-model-id>
VLM_FALLBACK_NAMES=<fallback-id-1>,<fallback-id-2>
VLM_ENABLE_THINKING=false
VLM_VIDEO_TIMEOUT_MS=120000
VLM_MAX_OUTPUT_TOKENS=1280
VLM_PRIMARY_BUDGET_MS=60000
VLM_TOTAL_BUDGET_MS=90000
VLM_FAST_RETRY_WINDOW_MS=5000
VLM_RETRY_COUNT=1
VLM_MAX_CONCURRENCY_PER_TARGET=2

EMBEDDING_BASE_URL=http://<INTERNAL_SERVER_IP>:<EMBEDDING_PORT>/v1
EMBEDDING_API_KEY=<secret>
EMBEDDING_MODEL=<model-id>
```

dev 保留上述远程地址。prd 仅将 VLM、LLM 和 Embedding 的 IP/localhost 主机
替换为 `PRD_INTERNAL_SERVICE_HOST`，外部域名和路径保持不变。主模型与 fallback 合计最多 5 个。
单次视频请求仍有 120 秒保护，但主模型预算为 60 秒、全候选链路总预算为 90 秒；预算从
素材开始分析时计算，并包含同模型并发排队、首次请求、纯文本格式修复和 fallback。只有
5 秒内返回的 HTTP 5xx、429 或短暂网络中断才按 `VLM_RETRY_COUNT` 重试当前候选。模型输出
最多 1280 tokens，同一模型目标最多并发 2 个请求。

视频切片在分镜校验阶段会同步生成分析关键帧。分析 worker 优先复用这些本地帧，跳过
从 ZOS 重新下载切片、再次校验视频和 FFmpeg 二次抽帧；关键帧种子缺失时自动回退旧链路，
不改变 `/api/v1` 请求与响应格式。关键帧保持宽高比且最大宽度为 640px，JPEG 质量为
`q=4`；不足 10 秒的分镜最多取 3 帧，达到 10 秒后最多取 5 帧。每类标签最多 5 个，
key moments 最多 3 个、timeline 最多 5 段，visualSegments 在服务端由 timeline 派生。
模型会收到精确分镜时长，服务端保证 timeline 从 0 连续覆盖到真实结束时间，并按人物、
形式、场景的语义优先级去除跨分类重复标签。模型返回格式无效、分析文本夹杂英文，或仅凭
稀疏关键帧推断慢镜头/长镜头等不可靠摄影结论时，第二次请求只发送原始文本进行 JSON
修复，不会重新发送关键帧。

### 存储与生命周期

```dotenv
MEDIA_ROOT=./media
SCENE_SEGMENT_MAX_BYTES=10485760
STAGING_RETENTION_HOURS=24
TASK_RETENTION_DAYS=7

ZOS_API_ENDPOINT=<s3-compatible-api-endpoint>
ZOS_BUCKET=<private-bucket>
ZOS_ACCESS_KEY_ID=<secret>
ZOS_SECRET_ACCESS_KEY=<secret>
```

成功入库后本地 staging、分析下载文件和分镜工作区会立即清理。失败或未封存 staging
默认保留 24 小时；终态任务记录默认保留 7 天。完整父视频、分片和图片长期保存于 ZOS。

## MCP / AI 工具接入

应用在 `<部署地址>/<NEXT_PUBLIC_BASE_PATH>/mcp` 暴露无状态 MCP Streamable HTTP
端点。配置 `MCP_ACCESS_TOKEN` 后，Claude Desktop、Cursor、Cherry Studio 等 MCP
客户端可以直接使用素材库；未配置 token 时端点会以 503 关闭。

```json
{
  "mcpServers": {
    "assets-library": {
      "type": "http",
      "url": "https://<公网域名>/feisu/assets-library/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_ACCESS_TOKEN>"
      }
    }
  }
}
```

当前提供 15 个工具，覆盖以下工作流：

- 从单个或最多 100 个白名单 URL 创建上传任务，并通过任务状态或最近任务列表恢复现场。
- 语义搜索、条件过滤、标签统计，以及个人、指定用户和公共素材的受控访问。
- 查询视频分镜的绝对时间与 VLM 时间线，获取媒体和缩略图链接。
- 异步更新、发布、重试和软删除素材；所有写工具均支持持久化 `idempotency_key`。
- 查询用户、分页列出个人素材，并统计文件数和存储用量。

`user_id` 由服务端默认值或 `x-request-userid` 请求头注入，不作为工具参数暴露；可选择
白名单模式或显式开启任意用户代理模式。URL 拉取仅允许精确命中域名白名单，禁止 IP
直连，并会逐跳校验重定向。生产环境应通过 HTTPS 传输 Bearer token。

完整的客户端配置、工具参数、数据隔离和排障方法见 [docs/mcp.md](docs/mcp.md)。通过
`./scripts/start.sh` 启动后，MCP 请求、来源拉取、上传进度和 worker 耗时会以同一个
`request_id` 写入 `.run/app.log`，便于定位连接中断、字节数不一致和排队延迟。
API（含管理、登录和退出接口）与 MCP 的请求日志包含路径、`query` 实际值、`input`
入参，以及完成/失败时的 `output` 出参、状态码和耗时；可按 `request_id` 串联。
JSON 与 MCP SSE 返回内容随响应流记录，不预读媒体流；二进制仅记录类型和字节数。
密钥、Cookie、token 和 URL 签名会脱敏；响应体最多采集 64 KiB，字符串最多 512 字符、
数组最多 50 项、嵌套最多 12 层；超大响应体或无法解析的内容会标注省略原因。

## API

完整文档见 [docs/api.md](docs/api.md)，MCP（AI 工具）接入见
[docs/mcp.md](docs/mcp.md)，独立只读 Metabase 部署见
[ops/metabase/README.md](ops/metabase/README.md)，OpenAPI 文件位于
[spec/contracts/openapi.yaml](spec/contracts/openapi.yaml)，运行后也可访问 `/docs`。

管理页面可通过 `WEBUI_LOCK_KEY` 启用可信内网页面锁。浏览器在 `/lock` 解锁后
使用 12 小时 HttpOnly 签名 Cookie；脚本读取 OpenAPI 时可发送
`Authorization: Bearer <WEBUI_LOCK_KEY>`。`APP_MODE=prd` 缺少该配置会拒绝启动，
dev 留空则关闭页面锁。此机制不保护也不改变任何既有 `/api/v1/**` 业务接口。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/v1/uploads` | 创建批量上传任务 |
| `PUT` | `/api/v1/uploads/{task_id}/items/{item_id}` | 流式上传单个文件 |
| `POST` | `/api/v1/uploads/{task_id}` | 封存并启动处理 |
| `GET` | `/api/v1/tasks/{task_id}` | 查询任务和所有 item 状态 |
| `POST` | `/api/v1/assets/query` | 浏览、标签过滤与语义搜索 |
| `GET/PATCH/DELETE` | `/api/v1/assets/{asset_id}` | 查询、修改或删除素材 |
| `POST` | `/api/v1/assets/{asset_id}/publish` | 发布素材 |
| `POST` | `/api/v1/assets/{asset_id}/retry` | 重试失败分析 |
| `GET` | `/api/v1/media/{asset_id}` | 私有媒体流与下载 |

所有业务 API 使用 `/api/v1` 和 `snake_case`。当前应用面向可信内网，不提供登录或 API Key
鉴权；生产入口必须由反向代理、防火墙或上游身份系统限制，不能直接暴露到公网。
浏览器组件和 Server Components 都通过 HTTP 调用该 facade，不直接导入数据库或领域服务。

## 项目结构

```text
src/
  app/                 Next.js 页面与 Route Handlers
  components/          Web UI 组件
  server/
    api/v1/            稳定 API facade 与显式组合根
    db/                Drizzle schema、连接与 migration
    mcp/               AI 工具、URL 入站、作用域与幂等控制
    media/             媒体探测、正规化、抽帧
    model/             OpenAI-compatible VLM/LLM 客户端
    modules/           assets/media/tasks/uploads/users 领域服务
    repositories/      MySQL 查询与 SKIP LOCKED 作业领取
    scene/             分镜客户端、下载校验与批次工作区
    services/          上传、分析、持久化和任务生命周期
    storage/           ZOS/S3 对象存储
  worker/              4 路数据库作业循环

scene-detect-service/
  app/api/             上传、轮询、下载、删除接口
  app/services/        队列、状态存储、PySceneDetect/FFmpeg

drizzle/               版本化 MySQL migration
scripts/               一键启动、停止及分镜服务入口
tests/                 unit、integration、e2e
docs/                  API 与设计文档
spec/                  OpenAPI、数据模型和验收说明
```

## 测试与构建

不访问数据库的日常验证：

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
uv run --project scene-detect-service pytest -q
```

数据库集成测试会清空 `TEST_DATABASE_URL` 所指独立 `_test` 库中的业务表：

```bash
pnpm test:integration
pnpm test:e2e
pnpm build
```

测试入口会拒绝库名不以 `_test` 结尾的连接，也会拒绝与 WebUI
`DATABASE_URL` 指向同一数据库。该测试库必须独立创建并执行 migration；每个用例前后和
测试套件退出时都会清理业务表，测试进程被强制终止时则由下一次运行的前置清理兜底。上述测试
不会、也不允许操作正式 `assets_library`。

## 部署

生产服务器设置 `APP_MODE=prd` 后执行：

```bash
./scripts/start.sh
```

首次启动会构建 Next.js，随后复用 `.next`。外部 API 地址前缀由 `NEXT_PUBLIC_BASE_PATH` 环境变量控制，默认为空。MySQL migration 以数据库中的 Drizzle
迁移账本为准并幂等执行；schema 来源为 [src/server/db/schema.ts](src/server/db/schema.ts)。
服务日志和 PID 位于 `.run/`。

Dockerfile 可将同一镜像分别作为 Web 和 worker 运行，但 Elasticsearch、MySQL、ZOS 与分镜服务
需要单独部署或挂载。当前完整单机部署的推荐入口仍是 `./scripts/start.sh`。

## ES 索引与存量重建

在 `.env` 配置 `ELASTICSEARCH_URL`、用户名、密码和两个环境的索引名：

```dotenv
DEV_ELASTICSEARCH_INDEX=asset_library_dev
PRD_ELASTICSEARCH_INDEX=asset_library_prd
```

`APP_MODE=dev` 使用开发数据库与 `DEV_ELASTICSEARCH_INDEX`，`APP_MODE=prd` 使用生产数据库与
`PRD_ELASTICSEARCH_INDEX`；入库、检索、删除和重建统一按此选择。两个索引名不能相同。
旧的 `ELASTICSEARCH_INDEX` 环境变量不再生效，请迁移到对应的分环境配置；更换目标索引后需重建。
使用现有 ES 8.11+ 服务，不由启动脚本或 Compose 部署 ES。
本地模型连接沿用 `EMBEDDING_BASE_URL`、`EMBEDDING_API_KEY`、`EMBEDDING_MODEL`。
向量维度根据 embedding 返回值自动创建，关键词默认使用 qagent 同款 `standard` 分析器。
v1 在每路内先按素材 ID 去重，再做素材级 RRF，避免同一素材的多个分块挤占排名。
分段匹配同时检索当前短句和完整局部语境；语境使用当前组，指代或残缺开头才补前一组。
两路语义候选取并集，并补齐候选的短句、语境原始余弦分数。通常排序质量为短句 70% + 语境 30%；
没有独立语境时沿用短句分数。对“的姿势”“拿别人已经”等有限语法规则识别的碎片，要求完整语境
达到语义门槛，质量使用语境分数的 90%，避免孤立词义主导。这是初始启发式，不是完整语言理解。
对已有整片描述的候选，复用查询向量校验画面主题：质量取原值与“局部质量 75% + 整片相似度 25%”的较小值，
低于语义门槛则退出候选。整片描述只降低缺少支持的局部高分，不能补入播放窗口外的证据；旧索引缺少这类文档时保持兼容。
明确无可见内容的黑白屏和测试卡只用于明确寻找这些画面的查询，不作为普通文案的填充素材。
BM25 分为动作/事件/物体/主题和人物/场景两个方向，均须通过语义门槛。RRF 权重为语义 0.5、
两个词法方向各 0.25，词法总票重不随字段数量增长；字段命中对分配质量最多增加 0.01。
最终素材数可能少于请求数量；RRF 分数是排序贡献，不是匹配概率，不启用 LLM 召回或重排。

分段分配最大化超过语义门槛的质量收益，时间均匀性仅加小幅代价；宁可留空，也不为增加命中数
挤走更相关的素材。短片先生成可替换搭档的组合候选，再统一分配源素材；超过 16 条候选时，每条
保留语义排名相邻的 8 个循环搭档，并另找贴近目标时长的组合。共享源片段时最多搜索 32 次换组，
不保证任意大规模组合的全局最优。裁剪开启时，每个组合成员必须实际出现在成片中，按 25 fps 校验帧边界，
并要求其实际播放窗口内存在原始语义分数大于 0.5 的证据；不能使用成员被剪掉部分的高分。
每条短片的校验后质量也须大于 0.5，不能用另一个高分成员抬过门槛。分配、组队和补片统一按来源身份去重：
同一父视频的同一时间区间、公私库迁移复制对象共用一次使用名额，返回仍保留原素材 ID 和 URL。
这是来源去重，无法识别没有共同来源记录的独立重复上传；当前不会在线下载文件计算哈希。

v1 将当前完整 `description`、视频 `visualSegments` / `keyMoments` / `timeline` 的摘要独立索引；
带时间的摘要不再拼接整片描述，避免片尾事实污染片头。记录 `evidenceKind`、`startMs`、`endMs`，
时间点须位于播放窗口内，区间摘要须完整落入窗口。裁剪开启时，播放证据的向量检索与补分均应用该过滤；
不能用整片摘要或片尾高分绕过。图片事实全程有效；没有可靠时间信息的存量描述以 `unknown` 兼容，
其时间匹配未经验证，不应统计为已验证命中。摘要和描述不截断，同内容不同时间仍保留独立证据。
当前生效的 topic、scene、person、object 标签另写一条仅用于 BM25 的元数据文档，过滤“科技”等
宽泛主分类及“无人物”；不重复嵌入每条摘要，不恢复原始分析中已被人工删除的标签。名称、OCR、
镜头形式和颜色标签不进入召回文档，原有展示与结构化过滤照常使用全部生效标签。
新 VLM 提示词说明用途是短视频文案逐段匹配画面，要求描述和摘要保留可核验的视觉事实、功能、
技术名称及人数年龄，不针对文案编造用途；视频保留最早提供的关键帧及其准确时间，禁止把后续事实提前。
这些时间来自 VLM 对抽样帧的观察，仍可能有识别误差。存量正确解析无需重跑 VLM，部署后执行下方
`search:reindex` 即可补齐分块及标签文档；重建不会修复已有错误描述，也不会覆盖人工编辑内容。

- `SEARCH_VECTOR_TOP_K` / `SEARCH_KEYWORD_TOP_K`：每路候选分块数，默认各 100。
- `SEARCH_SEMANTIC_THRESHOLD`：原始余弦相似度下限，两个业务接口共用，默认 `0.5`，范围 `[-1,1]`；设为 `-1` 不限制。v2 使用策略文件中的 `semanticThreshold`，当前同为 `0.5`。
- `SEGMENT_MATCH_CLIP_ENABLED`：默认 `true`。分段匹配命中长视频时，在原媒体 URL 上附带 `clip_ms`，首次下载截取素材开头 N 秒（N 为文本段时长）并缓存 MP4。设为 `false` 后独立视频使用原 URL，短片组合返回完整拼接视频。原视频达到 2 秒（含）即可直接参与匹配，不足 2 秒时可作为补充组合候选：各片段对当前文本的原始语义分数须大于 0.5，组合累计至少 2 秒，尽量贴近目标时长，否则放弃；图片固定生成 3 秒静态视频（URL 带 `still_ms=3000`，返回类型为 `video`），这两条规则不受裁剪开关影响。达到 2 秒但短于文本的视频不循环或拼接。下游原样使用 `matched_candidate_url`，请求和响应字段不变。
- `SEARCH_KEYWORD_THRESHOLD`：BM25 原始分数下限，默认 `0`，不限制关键词分数；最终仍受语义门槛约束。
- `SEARCH_NUM_CANDIDATES`：向量近邻候选数，默认 200，不小于向量 Top-K。
- `SEARCH_RRF_K`：RRF 常数，默认 60；语义 0.5、事件/物体/主题 0.25、人物/场景 0.25。
- `SEARCH_RERANK_ENABLED`：默认 false；开启调用预留函数，当前原样返回。
- `SEARCH_TIMEOUT_MS`：ES 与 embedding 单次请求超时，默认 30000 毫秒。

通常短句或语境的原始语义分数达到门槛即可进入候选，识别为碎片时要求语境达标，等于阈值也保留；
只有 BM25 过线不能绕过语义门槛。这里新增的字段检索和播放窗口校验仅用于 v1，v2 仍为实验方案。
两个阈值都不是接口返回的 `semantic_score` / `keyword_score`（这两个字段仍是 RRF 贡献）。
修改阈值后重启 Web/worker 即可生效，无需重建索引；旧请求字段 `semantic_threshold` 仍仅兼容接收。

真实任务回放使用 `pnpm benchmark:matching <snapshot.json>`，运行当前入库、召回和分配，记录逐段结果、
原始分数、命中字段与时间证据，并核对接口字段、时间轴、素材范围和源素材复用。
使用独立临时 ES 索引、真实 embedding 和数据库快照，详见 [回放说明](benchmarks/material-matching/README.md)。
历史 [合成阈值报告](benchmarks/search/results/report.md) 对应旧召回逻辑，不代表当前业务质量；
`benchmarks/search` 的旧调参脚本不作为本版本验收入口。

素材分析完成和人工编辑后自动提交索引任务。索引失败保留素材和分析结果，后台最多执行
3 次，可从 `search_index_state` 查看状态和错误。新素材在 ES 索引成功前不能被内容搜索召回；
编辑后的索引异步更新，接口始终读取当前素材内容与权限。
发布状态和所有权过滤以 MySQL 为准，不依赖异步 ES 状态。

存量素材已有准确解析时无需重新分析，但需要重建索引才能补齐新字段与时间证据，执行：

```bash
# 开发环境
APP_MODE=dev pnpm search:reindex
APP_MODE=dev pnpm start:worker # 已运行同环境 worker 时不必重复启动

# 生产环境（在生产服务环境执行）
APP_MODE=prd pnpm search:reindex
APP_MODE=prd pnpm start:worker
```

重建命令按批将未删除、分析完成的公私素材提交到现有任务队列，并不等待索引完成。
命令会打印当前环境、源数据库和目标索引；worker 须使用相同的 `APP_MODE` 与索引配置。
按素材 ID 删除旧文档后批量写入所有新分块，可重复执行；也会清理旧版单文档记录。
替换不是原子操作，期间可能短暂查不到该素材；不要并发重建同一素材。
更换 embedding 模型、向量维度或分析器时，使用新的独立索引名并全量重建；旧索引由运维在验证后清理。
旧索引的新字段可能由 ES 动态映射为默认分析器；使用自定义分析器时必须新建索引，确保按新 mapping 创建。
本次本地回放没有修改业务索引，也没有执行生产重建。

线上尚未更新代码时，使用独立进程构建新索引，不要运行上面的队列重建命令：

```bash
# 在新代码的独立目录运行，使用对应环境配置；自动生成全新索引名。
pnpm search:rebuild:staging
# 中断续跑或切换前再次补齐变更，使用日志中输出的状态文件。
pnpm search:rebuild:staging .run/search-rebuild/<状态文件>.json
```

该脚本只读数据库，直接复用当前 `indexAsset`，不投递作业、不修改 `search_index_state`，
也不改 `.env` 或索引别名。每次只处理一条素材，写入后暂停 100ms；两轮扫描补齐期间的变更。
状态文件记录源码指纹、模型、独立索引 UUID、逐素材内容指纹和失败项；内容未变时跳过 embedding。
续跑发现新索引已被业务配置或别名使用会停止。结果 `snapshot_complete` 仅代表此次扫描完成，
不代表已经启用；旧 worker 仍向旧索引写新素材，正式切换前还需再次补齐，并协调新旧写入进程。

检索不降级：embedding 或 ES 失败返回明确错误；异步分段匹配通过任务失败状态和回调报告。
普通浏览不访问 ES。当前复用 MySQL 候选 ID 过滤，单次候选范围受 ES terms 默认 65536 项上限约束。

实现参考：[Elasticsearch kNN 过滤与召回](https://www.elastic.co/docs/solutions/search/vector/knn)。
