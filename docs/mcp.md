# 素材库 MCP 服务

素材库通过 [MCP](https://modelcontextprotocol.io/)（Model Context Protocol）
Streamable HTTP 协议暴露为 AI 工具，让 LLM 客户端（Claude Desktop / Cursor /
Cherry Studio 等）可以直接搜索、上传、管理素材。

## 端点与鉴权

| 项 | 值 |
| --- | --- |
| 端点 | `<部署地址>/<NEXT_PUBLIC_BASE_PATH>/mcp`（如 `https://<公网域名>/feisu/assets-library/mcp`） |
| 协议 | MCP Streamable HTTP（无状态 `POST` JSON-RPC；路由同时保留 `GET` 入口） |
| 鉴权 | `Authorization: Bearer <MCP_ACCESS_TOKEN>`，所有请求必带；未配置 token 时端点返回 503（fail-closed） |

## 客户端配置

用户在自己的 MCP 客户端里粘贴以下 JSON（`<部署地址>` 换成实际地址，`<token>`
由服务方分配）：

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

**内网 IP 直连**（不经过反向代理时；端口为部署时配置的 Web 服务端口）：

```json
{
  "mcpServers": {
    "assets-library": {
      "type": "http",
      "url": "http://<服务器内网IP>:<Web端口>/feisu/assets-library/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_ACCESS_TOKEN>"
      }
    }
  }
}
```

> ⚠️ IP 直连走 `http://` 明文传输，token 会暴露在链路中，**仅限可信内网**；
> 公网或跨信任域必须走上方 `https://` 域名地址。

## 数据隔离模型

- **服务端注入 `user_id`**：优先取请求头 `x-request-userid`，未携带时回退
  `MCP_DEFAULT_USER_ID`。工具参数不暴露 `user_id`。
- **多用户切换（剪辑 agent 场景）**：请求头 `x-request-userid` 指定当前要
  操作的用户。两种访问模式（由 `MCP_ALLOW_ANY_USER_ID` 控制）：
  - 白名单模式（默认）：`x-request-userid` 只能在 `MCP_ALLOWED_USER_IDS`
    内取值，否则 403；`list_users` 也只返回白名单内用户。
  - 任意用户模式（`MCP_ALLOW_ANY_USER_ID=true`）：`x-request-userid` 可传
    任意值，agent 可访问任意注册用户（等价于 token 持有者可代理任意用户，
    需谨慎开启）。
- 公共素材通过 `scope: "public"` 显式访问；公共查询会自动排除当前
  `x-request-userid` 上传的公共副本，但已知公共 ID 的详情和媒体链接仍可直接读取。`query_assets` 支持
  `own`（默认）/ `user` / `public` / `all` 四种范围，`get_asset` 与
  `get_media_links` 支持前三种范围。三个工具复用同一个权限解析函数；`scope=user` 的目标在
  白名单模式下必须位于白名单中；`scope=all` 仅在任意用户模式下开放。
- `get_task_status` 只允许读取当前 `x-request-userid` 所属任务；其他用户的任务
  按不存在处理。
- `delete_asset` 永久删除当前用户的私人素材、分析和存储对象，不影响配对公共副本。

## 工具清单

| 工具 | 功能 | 同步性 |
| --- | --- | --- |
| `get_service_info` | 服务信息、支持扩展名、大小上限、当前 user_id、any_user_access | 同步 |
| `list_users` | 列出可访问的注册用户（资料字段 + 有效素材数，含零素材用户） | 同步 |
| `upload_from_url` | 从单个白名单 URL 拉取图片/视频并返回任务 ID | 异步 |
| `upload_batch_from_urls` | 批量拉取 1–100 个 URL，在一个任务中上传和处理 | 异步 |
| `get_task_status` | 查询异步任务状态（上传/更新/发布/重试/删除） | 同步 |
| `list_tasks` | 分页列出当前用户最近任务及逐文件状态，供 agent 恢复现场 | 同步 |
| `query_assets` | 语义搜索 + 过滤 + 游标分页 + 标签统计；scope 支持 own/user/public/all | 同步 |
| `get_asset` | 素材详情（含绝对分镜秒数及 VLM 描述、标签、OCR、视频时间线） | 同步 |
| `update_asset` | 整体替换名称/描述/标签 | 异步 |
| `publish_asset` | 发布分析成功的公共素材 | 异步 |
| `retry_asset` | 重试分析失败的素材 | 异步 |
| `delete_asset` | 永久删除本人私人素材 | 异步 |
| `list_user_media` | 分页列出本人素材（含媒体直链） | 同步 |
| `get_storage_usage` | 存储用量统计 | 同步 |
| `get_media_links` | 媒体链接；视频同时返回缩略图链接（返回相对路径） | 同步 |

## upload_from_url 详解

单文件 URL 入库参数：

```json
{
  "url": "https://storage.example.com/tmp/demo.mp4",
  "filename": "demo.mp4",
  "idempotency_key": "upload-demo-20260821"
}
```

- `url`：必填。支持扩展名 `.jpg/.jpeg/.png/.webp/.mp4`；扩展名决定媒体类型。
- `filename`：可选，覆盖 URL 推断的文件名（URL 无扩展名时必须提供）。
- `idempotency_key`：可选；同一用户、同一工具、同一参数重试时返回原任务。

批量上传使用独立工具，避免单文件参数变成 union：

```json
{
  "items": [
    { "url": "https://storage.example.com/tmp/a.jpg", "filename": "a.jpg" },
    { "url": "https://storage.example.com/tmp/b.mp4", "filename": "b.mp4" }
  ],
  "idempotency_key": "batch-20260821-001"
}
```

`items` 仅包含 `url` 和可选 `filename`。工具先探测全部来源的格式与精确大小，
再创建一个多 item 上传任务，最终只封存一次。MCP 上传始终携带当前用户 ID，因此
每个素材会创建私人记录及一份独立的待审核公共副本。文件数与
总大小沿用 REST API 的 `UPLOAD_MAX_ITEMS`（最多 100）和
`UPLOAD_MAX_TOTAL_BYTES`（默认 2 GiB）限制。

工具完成 URL 拉取和任务封存后立即返回 `task_id`，不会占用 MCP 连接等待最长约
10 分钟的 VLM 分析。之后调用 `get_task_status`；终态为 `done` 时，从
`items[].private_asset_ids` 和 `items[].public_asset_ids` 取得两组素材 ID。

如果 agent 丢失了 `task_id`，可调用 `list_tasks`，按状态/任务类型过滤并分页恢复
最近任务。返回值是完整任务快照，包含逐 item 进度、错误和公私素材 ID。

## 幂等写操作

`upload_from_url`、`upload_batch_from_urls`、`update_asset`、`publish_asset`、
`retry_asset`、`delete_asset` 都支持可选 `idempotency_key`。幂等范围是
`工具名 + 当前 user_id + idempotency_key`：

- 相同参数重试会复用数据库中保存的原响应和 `task_id`；
- 同一个键改传不同参数会返回 409，防止误复用；
- 幂等记录与任务保留期一致；同键并发调用通过数据库锁串行化；
- 未传键时保持原行为，每次调用创建新任务。

## 视频时间线详情

`get_asset` 不只是返回素材标题。视频分镜还返回：

- `segment_start_seconds` / `segment_end_seconds`：该分镜在父视频中的绝对时间；
- `analysis.visual_segments`：视觉片段的起止秒与摘要；
- `analysis.key_moments`：关键时刻秒数与摘要；
- `analysis.timeline`：按时间段描述“第几秒到第几秒发生了什么”；
- `description`、`topics`、`tags` 以及 `parent_video_id` / `segment_index`。

因此 agent 可以先用 `query_assets` 找到视频分镜，再对目标 `asset_id` 调
`get_asset` 获取完整时间线。分析尚未完成时 `analysis` 为 `null`，应先通过
`get_task_status` 或 `list_tasks` 等待任务终态。

**大小上限**：图片 ≤ 20 MiB（`MAX_IMAGE_BYTES`），视频 ≤ 200 MiB
（`MAX_VIDEO_BYTES`），拉取前通过 HEAD/对象元数据校验。

**SSRF 白名单**：只允许精确命中白名单的域名，禁止任何 IP 直连。默认白名单为
`ZOS_WEB_URL` / `ZOS_INTERNAL_URL` 的 host，
可用 `MCP_ALLOWED_DOMAINS` 追加。同 bucket 域名走 S3 内网拉流（不占用外网
带宽）；其他白名单域名走 HTTP GET（逐跳校验重定向，最多 5 跳）。

**本地文件上传工作流**（配合文件中转服务）：

```
本地文件 → 中转服务（如 Spring Boot 11111 的 /api/file/tmp/upload）
         → https://storage.example.com/<key>（临时 URL）
         → LLM 调 upload_from_url → 素材库拉取/分析 → 入库
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `MCP_ACCESS_TOKEN` | Bearer token，至少 32 字符；留空则 MCP 端点关闭（503） |
| `MCP_DEFAULT_USER_ID` | 未带 x-request-userid 时的默认 user_id；不配置时个人素材操作不可用 |
| `MCP_ALLOWED_USER_IDS` | 逗号分隔的允许 user_id 白名单（x-request-userid 只能取白名单内值） |
| `MCP_ALLOW_ANY_USER_ID` | 任意用户模式开关（默认 false）；true 时 x-request-userid 可传任意值 |
| `MCP_ALLOWED_DOMAINS` | 逗号分隔的额外 SSRF 白名单域名（upload_from_url 拉取） |

## 实现说明

- `src/app/mcp/route.ts`：Streamable HTTP 路由（GET SSE 握手 + POST JSON-RPC），
  Bearer 鉴权 + fail-closed。
- `src/server/mcp/tools.ts`：工具注册表（15 个工具），内部直接调用
  `ApiV1Service`；写操作返回异步任务，状态查询带用户归属校验。
- `src/server/mcp/url-ingest.ts`：URL 入站（SSRF 白名单 + 同桶 S3 拉流 + HTTP 拉取）。
- `src/server/mcp/scope.ts`：MCP 读取工具共用的 scope 权限解析。
- `src/server/mcp/idempotency.ts`：写工具的持久化幂等记录与并发锁。

## 测试

- 单元：`tests/unit/mcp-url-ingest.test.ts`（SSRF 白名单）、
  `tests/unit/mcp-tools.test.ts`（工具注册）。
- E2E：`tests/e2e/mcp.spec.ts`（鉴权 401、握手、listTools、工具调用全链路，
  需要 `MCP_ACCESS_TOKEN` 与测试数据库）。

## 调用审计与上传诊断日志

通过 `./scripts/start.sh` 启动时，Web 与 worker 的结构化 JSON 日志统一写入
`.run/app.log`。重启采用追加写入；文件超过 `APP_LOG_MAX_BYTES`（默认 100 MiB）时，
下次启动会轮转为 `.run/app-<UTC时间>.log`。

每次 MCP 调用可以用同一个 `request_id` 串起以下事件：

- `mcp_request_started`、`mcp_response_opened`、`mcp_request_completed/failed`：
  HTTP/RPC 方法、调用 IP、User-Agent、`x-request-userid`、响应头等待和流结束总耗时；
- `mcp_tool_started/completed/failed`：工具名、脱敏后的参数、实际用户、结果摘要和工具耗时；
- `mcp_source_*`：源 URL 的脱敏 host/path、HEAD/GET/重定向状态、响应头等待时间、
  `Content-Length` 和来源类型（HTTP 或同桶 ZOS）；
- `upload_stream_*`：首个数据块等待、每 4 MiB 进度、最大单次读取等待、实际/声明字节数、
  EOF 缺失字节数、平均吞吐量；
- `worker_job_*`：异步作业从 `available_at` 到领取的排队时间，以及实际处理耗时。

Bearer token、Cookie、签名 URL 查询参数和 API Key 不会写入日志。常用排查命令：

```bash
# 查看某次 MCP 请求完整链路
rg '"request_id":"<request-id>"' .run/app.log

# 查看源站提前 EOF、长度不一致和上传租约回滚
rg 'upload_stream_failed|upload_lease_released_after_failure|mcp_source_' .run/app.log

# 查看调用方、工具耗时和 worker 排队时间
rg 'mcp_tool_(completed|failed)|worker_job_started' .run/app.log
```
