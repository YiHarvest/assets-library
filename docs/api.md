# 素材库 HTTP API v1

本文档描述当前代码实际提供的 HTTP 接口。业务接口统一使用 `/api/v1` 前缀和
`snake_case` 字段；不再提供旧版接口。

## 1. 通用约定

- Base URL：`http(s)://<assets-library-host>`，本文不绑定具体主机或端口。
- ID（`task_id`、`item_id`、`asset_id`、`parent_video_id`）均为 UUID。
- 关系数据库保存 UTC；JSON 时间使用 ISO 8601，并以上海时区偏移 `+08:00` 返回。
- 文件大小单位均为 byte。默认单任务最多 100 个文件、总计最多 2 GiB。
- JSON 请求体上限为 1 MiB；文件内容通过单独的流式 PUT 上传。
- 所有创建、更新、发布、重试、删除操作都是异步任务。调用方应保存
  `task_id`，再轮询统一任务接口，或提供 `callback_url`。
- 所有 `/api/v1` 业务响应均带 `X-Request-Id`；调用方也可传入合法
  UUID 格式的 `X-Request-Id` 便于链路排查。

完整的机器可读定义见 [`spec/contracts/openapi.yaml`](../spec/contracts/openapi.yaml)。

## 2. 访问边界

本项目仅部署在可信内网，HTTP 接口不要求 API Key、登录会话或签名 URL。
浏览器 Web UI 和 Server Components 都直接调用 `/api/v1/**`，服务间调用也不需要
鉴权 Header。这里没有额外的 UI 代理或身份认证层。

`user_id` 用于素材归属和查询范围，不是鉴权凭据；调用方可自行传入该字段。
因此服务不能直接暴露到公网，公网或跨信任域部署必须在上游反向代理、防火墙或
API 网关增加访问控制。

## 3. 统一错误格式

```json
{
  "error": {
    "code": "invalid_request",
    "message": "请求字段无效。",
    "details": [
      {
        "item_id": "8df50279-9094-44c4-bc5e-a2d9b7417504",
        "segment_index": 3,
        "size_bytes": 11534336,
        "limit_bytes": 10485760
      }
    ]
  },
  "request_id": "9264af56-01cc-4fbe-9560-8df51ef3f668"
}
```

`details` 仅在有逐文件或逐切片诊断时出现。稳定错误码包括：

- 请求与范围：`invalid_request`、`forbidden`、`not_found`、
  `conflict`、`task_not_ready`、`task_expired`。
- 上传与媒体：`upload_incomplete`、`upload_size_mismatch`、
  `unsupported_media_type`、`file_too_large`、`corrupt_file`、
  `unsupported_video_codec`、`invalid_video_frames`。
- 分镜：`scene_detection_failed`、`segment_too_large`。
- 模型：`model_not_configured`、`model_video_unsupported`、
  `video_frames_missing`、`model_request_failed`、`model_response_invalid`。
- 基础设施：`storage_error`、`database_error`、`callback_failed`、
  `service_unavailable`、`internal_error`。

常见 HTTP 状态：

| 状态 | 场景 |
| --- | --- |
| `400 Bad Request` | JSON、UUID、字段或媒体声明无效。 |
| `403 Forbidden` | 素材作用域不允许。 |
| `404 Not Found` | 任务、item、素材或持久化对象不存在。 |
| `409 Conflict` | 当前状态不允许操作、上传未完整或媒体尚不可读。 |
| `413 Content Too Large` | JSON 请求体超过 1 MiB。 |
| `416 Range Not Satisfiable` | 媒体 Range 语法错误或区间不可满足。 |
| `500/502/503` | 内部处理、上游存储或必要配置/服务异常。 |

## 4. 三步流式上传

一次上传对应一个 `task_id`，任务响应同时展示总体状态和每个文件的状态。

### 4.1 第一步：创建上传清单

`POST /api/v1/uploads`

```json
{
  "user_id": "user_123",
  "callback_url": "https://internal.example/callbacks/assets",
  "items": [
    {
      "filename": "product.png",
      "size_bytes": 182304,
      "content_type": "image/png"
    },
    {
      "filename": "demo.mp4",
      "size_bytes": 52428800,
      "content_type": "video/mp4"
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `user_id` | `string \| null` | 否 | 1–191 字符。非空时创建互相独立、均待审核的私人素材与公共副本；空字符串或 `null` 只创建公共素材。 |
| `callback_url` | `string(url) \| null` | 否 | 任务终态回调，只支持 HTTP/HTTPS，最长 2,048 字符。 |
| `items` | `array` | 是 | 1–100 项，总声明大小不超过 2 GiB。 |
| `items[].filename` | `string` | 是 | 1–255 字符；扩展名决定目标媒体格式。 |
| `items[].size_bytes` | `integer` | 是 | 正整数，文件的精确字节数。 |
| `items[].content_type` | `string \| null` | 否 | 客户端声明 MIME，仅用于记录；服务端以内容解码验证。 |

当前目标扩展名支持 `.jpg`、`.jpeg`、`.png`、`.webp`、`.mp4`。图片或视频
内容与扩展名不一致时，服务端会把内容真实转换成扩展名对应的标准格式；内容
损坏或无法转换时任务失败。

成功返回 `201 Created` 和完整 `TaskStatus`。从响应中的 `items[].item_id`
取得第二步上传地址。

### 4.2 第二步：逐文件流式上传

`PUT /api/v1/uploads/{task_id}/items/{item_id}`

请求体是该文件的原始二进制流，不是 multipart。建议发送准确的
`Content-Length` 和真实 `Content-Type`：

```bash
curl -X PUT \
  -H 'Content-Type: image/png' \
  -H 'Content-Length: 182304' \
  --data-binary @product.png \
  'https://<host>/api/v1/uploads/<task_id>/items/<item_id>'
```

服务端流式写入 `media/.staging`，不会把整个文件保存在 Node.js 内存中。
实际字节数必须与第一步声明完全相等；多或少都会返回
`upload_size_mismatch`。成功返回 `202 Accepted` 和更新后的完整
`TaskStatus`。已封存任务不能继续写入。

### 4.3 第三步：封存并启动处理

`POST /api/v1/uploads/{task_id}`

无请求体。只有全部 item 都完整接收后才能封存；否则返回 `409`。成功返回
`202 Accepted`，并开始校验、图片正规化、视频分镜、ZOS 持久化、MySQL
建档和模型分析。封存后不能增加、删除或重传 item。

### 4.4 图片处理语义

图片会完整解码并按文件扩展名正规化。私人上传分别写入两份 ZOS 对象并建立
公私两条记录，公共直传只写一份；任一步失败都会补偿删除本次全部 ZOS 对象。
两份记录首次共享一次 VLM 调用，分析结果、标签和搜索索引分别落库。

### 4.5 视频父子模型与整批边界

- 完整视频先正规化为标准 H.264 MP4，作为内部父视频持久化，但不作为可检索
  素材，也不执行 VLM 分析。
- 分镜服务把父视频切成多个子视频；每个子视频才是一条 `video` 素材。
- 所有切片必须下载完整、可解码、符合标准格式，并且每个切片不超过
  10 MiB（10,485,760 bytes）。
- 任一切片损坏、下载不完整或超限，父视频和全部切片都不进入 ZOS/MySQL，
  错误 `details` 会指出失败切片。
- 父视频、全部切片的 ZOS 上传验证和 MySQL 建档属于“整批全有或全无”边界。
  MySQL 事务失败时会反向补偿删除已上传对象。
- 整批持久化成功后，各子视频沿用原有 1–5 张关键帧 VLM 流程独立分析。
  某个子视频分析失败不会回滚已经持久化的兄弟切片，但上传任务会显示对应
  item/asset 的失败状态。
- 成功后立即清理本地父视频、切片和分镜服务副本；失败或未封存 staging 文件
  保留 24 小时，并由 worker 每小时扫描。

## 5. 统一任务查询与回调

### `GET /api/v1/tasks/{task_id}`

统一查询上传、更新、发布、重试、删除和兼容匹配任务。任务历史默认保留 7 天。

```json
{
  "task_id": "cb953fd7-1f91-44a9-8ef6-c65635b954d0",
  "task_type": "upload",
  "status": "running",
  "phase": "analyzing",
  "progress_percent": 50,
  "received_bytes": 52611104,
  "total_bytes": 52611104,
  "total_items": 2,
  "done_items": 1,
  "failed_items": 0,
  "callback_url": null,
  "result": null,
  "items": [
    {
      "item_id": "8df50279-9094-44c4-bc5e-a2d9b7417504",
      "filename": "product.png",
      "media_type": "image",
      "status": "done",
      "phase": "finished",
      "received_bytes": 182304,
      "total_bytes": 182304,
      "progress_percent": 100,
      "private_asset_ids": ["101ed605-3dc8-46b8-aebb-57fca02b75f7"],
      "public_asset_ids": ["b1b29fcf-c3e4-4c7a-9ed7-23b9dccdbb51"],
      "error": null
    }
  ],
  "error": null,
  "created_at": "2026-08-12T18:00:00.000+08:00",
  "started_at": "2026-08-12T18:00:03.000+08:00",
  "finished_at": null,
  "expires_at": "2026-08-19T18:00:00.000+08:00"
}
```

`TaskStatus` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `task_id` | `string(uuid)` | 全局任务 ID，所有后续轮询都使用它。 |
| `task_type` | `upload\|update\|publish\|retry\|delete\|match` | 异步操作类型。 |
| `status` | `queued\|running\|done\|failed` | 稳定总体状态。 |
| `phase` | `TaskPhase` | 当前细粒度阶段。 |
| `progress_percent` | `number` | 0–100 的总体进度。 |
| `received_bytes` / `total_bytes` | `integer` | 整个任务已接收/声明字节数。 |
| `total_items` / `done_items` / `failed_items` | `integer` | 文件总数、成功数和失败数。 |
| `callback_url` | `string(url) \| null` | 创建任务时登记的终态回调。 |
| `result` | `object \| null` | 任务终态业务结果，未完成时通常为 `null`。 |
| `items` | `TaskItem[]` | 每个原始上传文件的状态。 |
| `error` | `ApiError \| null` | 总体失败信息。 |
| `created_at` | `string(date-time)` | 任务创建时间。 |
| `started_at` / `finished_at` / `expires_at` | `string(date-time) \| null` | 开始、结束和任务记录过期时间。 |

`TaskItem` 额外包含 `item_id`、`filename`、`media_type`、逐文件 `status` /
`phase` / 字节进度、`private_asset_ids`、`public_asset_ids` 和 `error`。视频数组按
`segment_index` 排序，父视频 ID 不在数组中。

稳定任务状态只有 `queued`、`running`、`done`、`failed`。更细的执行位置由
`phase` 表示：`receiving`、`waiting_for_seal`、`validating`、`splitting`、
`persisting`、`analyzing`、`publishing`、`updating`、`retrying`、`deleting`、
`matching`、`notifying`、`finished`。

如果提供 `callback_url`，系统在任务进入 `done` 或 `failed` 后以 `POST JSON`
发送任务快照（不重复发送 `callback_url`），并附带 `X-Assets-Task-Id`。回调失败
会指数退避重试，最多 5 次；回调失败不会回滚已经完成的业务操作。调用方仍应
支持用 `task_id` 主动查询，不得只依赖一次回调。

## 6. 素材查询

### `POST /api/v1/assets/query`

该接口统一素材浏览、游标分页、标签统计和混合搜索。
请求 `{}` 即按默认公共作用域浏览第一页。

```json
{
  "query": "白色背景下的橙色产品静物",
  "keywords": ["橙子", "白色背景"],
  "filter": {
    "user_scope": { "mode": "user", "user_id": "user_123" },
    "media_types": ["image"],
    "statuses": ["done"],
    "review_statuses": ["published"],
    "tags": [{ "category": "object", "value": "橙子" }]
  },
  "cursor": null,
  "limit": 20,
  "include_tag_statistics": true
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `query` | `string?` | 1–1,000 字符；与 keywords 合并执行 ES 双路召回；存在时仍返回单页 Top-K。 |
| `keywords` | `string[]?` | 最多 10 项，每项 1–64 字符；与 query 合并为检索文本，不作为标签硬过滤。 |
| `filter.user_scope` | `UserScope` | 默认 `{ "mode": "public" }`。 |
| `filter.media_types` | `("image"\|"video")[]?` | 最多 2 项。 |
| `filter.statuses` | `TaskStatus[]?` | 最多 4 项。 |
| `filter.review_statuses` | `ReviewStatus[]?` | `pending_review`、`published`、`deleted`，最多 3 项。 |
| `filter.tags` | `{category,value}[]?` | 受控标签条件，最多 20 项。 |
| `cursor` | `string \| null` | 上一页返回的不可解析游标；首页传 `null`。 |
| `limit` | `integer` | 1–100，默认 20。 |
| `include_tag_statistics` | `boolean` | 默认 `true`。 |

`UserScope` 语义：

- `{ "mode": "public" }`：仅查询公共素材。
- `{ "mode": "user", "user_id": "..." }`：仅该用户的个人素材。
- `{ "mode": "all" }`：公共素材和所有用户素材。
- `{ "mode": "exclude_user", "user_id": "..." }`：仅查询公共素材，并排除该用户上传的公共副本。

成功响应包含 `items`、`next_cursor`、`has_more`、可为 `null` 的
`tag_statistics`，以及可为 `null` 的 `search`。素材摘要字段全部为
`snake_case`；视频切片会返回 `parent_video_id` 和 `segment_index`。

`query` 和 `keywords` 合并为完整查询文本，同时执行 ES 向量检索与关键词检索，
按分块 ID 用等权 RRF 融合，再按素材 ID 去重，保留最高分块。用户范围、审核状态、媒体类型和 `filter.tags` 仍在召回前严格过滤。
无搜索文本时维持普通列表；带 `query` 时不接受非空 cursor；仅带 `keywords` 时，
在 `.env` 配置的双路分块候选融合、素材去重后分页，翻完返回 `has_more=false`。
同素材不同分块不提前合并分数，素材分数及分项贡献取自最高 RRF 分块。
Top-K 配置按分块计数，去重后素材数可能少于请求数量，不额外补召回。

RRF 前分别使用服务端 `.env` 阈值过滤分块：`SEARCH_SEMANTIC_THRESHOLD` 是原始余弦相似度下限
（默认 `0.705`），`SEARCH_KEYWORD_THRESHOLD` 是 BM25 原始分数下限（默认 `22.25`）。
等于阈值也保留；任一路通过即可融合，不要求同时通过。两路均无结果时返回 `no_candidates`。

`search_score = Σ 1/(k+rank) × (k+1)/2`，范围 `[0,1]`，表示融合排名强度，
不代表语义相似度或匹配概率；每路未命中贡献为零。`keyword_score` 和 `semantic_score`
返回对应路的归一化 RRF 贡献（每路最高 0.5）。融合分数不另设阈值，兼容字段 `search.threshold=0`，不代表两路原始分数未过滤。
embedding 或 ES 失败返回明确的 502/503 错误，不回退为单路或伪装为空结果。

| 素材摘要字段 | 类型 | 说明 |
| --- | --- | --- |
| `asset_id` | `string(uuid)` | 素材 ID。 |
| `parent_video_id` | `string(uuid) \| null` | 视频切片所属父视频；图片为 `null`。 |
| `segment_index` | `integer \| null` | 子视频的零基序号；图片为 `null`。 |
| `user_id` | `string \| null` | 个人归属；`null` 表示公共素材。 |
| `name` / `description` | `string` | 素材名称和最终描述。 |
| `media_type` | `image\|video` | 媒体类型；`video` 指子视频切片。 |
| `status` | `queued\|running\|done\|failed` | 素材处理状态的 v1 表示。 |
| `review_status` | `pending_review\|published\|deleted` | 审核/发布状态。 |
| `tags` | `Tag[]` | 分类、值、来源和可选置信度。 |
| `media_url` | `string` | 已附带必要用户作用域的媒体相对 URL。 |
| `created_at` / `updated_at` | `string(date-time)` | 上海时区 ISO 8601 时间。 |
| `search_score` | `number?` | `[0,1]` 最终排序分；检索命中时返回。 |
| `keyword_score` / `semantic_score` | `number?` | 对应路的归一化 RRF 贡献；未命中的分项省略。 |
| `match_type` | `string?` | 保留原枚举，新检索返回 `hybrid`。 |
| `matched_terms` | `string[]?` | 保留字段，新检索暂返回空数组。 |
| `matched_categories` | `string[]?` | 保留字段，新检索暂返回空数组。 |

有合格结果时，`search.message` 为 `null`：

```json
{
  "items": [
    {
      "asset_id": "00000000-0000-4000-8000-000000000001",
      "search_score": 1,
      "keyword_score": 0.5,
      "semantic_score": 0.5,
      "match_type": "hybrid",
      "matched_terms": [],
      "matched_categories": []
    }
  ],
  "next_cursor": null,
  "has_more": false,
  "tag_statistics": null,
  "search": {
    "mode": "hybrid",
    "threshold": 0,
    "max_score": 1,
    "reason": "matched",
    "message": null
  }
}
```

示例仅展示检索相关字段，实际素材项还包含上表中的必填摘要字段。普通浏览时
`search` 为 `null`。搜索没有可展示素材时，`items` 保持空数组，`search` 提供
机器可读原因和可直接展示的消息：

```json
{
  "items": [],
  "next_cursor": null,
  "has_more": false,
  "tag_statistics": null,
  "search": {
    "mode": "hybrid",
    "threshold": 0,
    "max_score": null,
    "reason": "no_candidates",
    "message": "没有召回任何候选素材。"
  }
}
```

`search.reason` 新检索返回 `matched` 或 `no_candidates`；保留旧枚举以兼容接口结构。
服务错误走统一错误响应，不再返回 `semantic_unavailable` 空成功结果。

### `GET /api/v1/assets/{asset_id}`

获取素材详情。查询参数 `user_id` 可选：填写时只读该用户素材；省略或空值时
只读公共素材。不接受 `all` 作用域，避免单资源读取绕过归属边界。

除摘要字段外，详情包含 `original_filename`、`mime_type`、`size_bytes`、
`failure` 和 `analysis`。API 边界会把模型内部字段统一转换为
`snake_case`：图片 OCR 使用 `unavailable_reason`；视频使用
`visual_segments`、`key_moments`，时间段使用 `start_seconds` 和
`end_seconds`。

图片 `analysis` 包含 `kind`、`description`、分类 `tags` 和 `ocr`。视频
`analysis` 包含 `kind`、`description`、`topics`、分类 `tags`、
`visual_segments`、`key_moments` 和 `timeline`；这些分析只属于子视频，父视频
没有详情接口和分析结果。

## 7. 旧业务分段匹配兼容

### `POST /api/v1/compat/segment-match`

为 `llm.segments` 中的每个文本分段匹配一个图片或视频素材。接口先持久化异步
`match` 任务并返回 `202 Accepted`，Worker 完成后再向 `callback_url` 发送结果。
同步响应不包含匹配结果；某段或全部分段未命中素材，也可以正常完成任务。

#### 请求格式与顶层字段

使用 `Content-Type: application/json`，请求体上限为 **1 MiB**（包含所有嵌套字段
及自定义字段）。以下“无”表示不提供默认值；可选字段省略与显式传 `null` 不等价，
下列已知请求字段均不接受 `null`。数字和布尔值不接受字符串形式。

| 字段 | 类型 | 必填 | 默认值 | 作用与约束 |
| --- | --- | --- | --- | --- |
| `asr` | object | 是 | 无 | 语音识别结果，用于给 LLM 分段对齐时间轴。已有时间轴时传 `{}`，不能省略整个字段。 |
| `llm` | object 或 JSON string | 是 | 无 | 包含 `segments` 的分段结果；支持直接传对象，也支持该对象序列化后的 JSON 字符串。接口使用已有分段，不负责调用 LLM 生成分段。 |
| `text` | string | 否 | 无 | 兼容旧调用方的全文字段，最长 1,000,000 字符。当前不参与对齐或素材搜索，也不回传。搜索使用每段的 `text`。 |
| `asset_url_list` | array | 否 | `[]` | 最多 10,000 项。空数组表示从所有待审核或已发布、未删除的公共及个人素材中召回；非空时限定素材范围，详见下文。 |
| `semantic_threshold` | number | 否 | `0.3` | 兼容参数，仍校验范围 `[0,1]`，暂不参与过滤。 |
| `is_random` | boolean | 否 | `true` | `true`：从本次融合候选中等概率随机选一个；`false`：选最高分。两种模式均按分段顺序排除本任务已使用的素材。 |
| `callback_url` | string (URL) | 是 | 无 | 接收任务成功或失败结果的地址，仅支持 HTTP/HTTPS，最长 2,048 字符。 |
| 其他顶层字段 | 任意 JSON 值 | 否 | 无 | 作为业务自定义字段透传到终态回调，例如 `business_id`。不参与匹配；顶层 `user_id` 也不会限制素材范围。避免使用回调保留字段 `taskId`、`status`、`result`、`error`、`completed_at`，同名值可能被系统覆盖。 |

`asset_url_list` 每项可以是 URL 字符串，也可以是以下对象，两种格式可混用：

| 对象字段 | 类型 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- | --- |
| `file_url` | string (URL) | 是 | 无 | 素材库媒体 URL，其路径须能解析为 `/api/v1/media/{asset_id}`，其中 `asset_id` 为 UUID。查询参数不影响素材 ID 解析。 |
| `type` | string | 是 | 无 | 旧业务的素材类型标记，如 `image`、`video`。当前仅接收，不用于类型过滤；结果类型以素材库记录为准。 |

重复素材 ID 会合并。非空列表中无法识别的 URL 不参与召回；若全部无法识别，
所有分段返回 `no_candidates`，不会回退到全库，也不会下载列表中的外部文件。

#### ASR 字段：自动对齐模式

下表中数组元素的“必填”表示提供对应父对象时必填；ASR 可选字段均无默认值。

| 字段路径 | 类型 | 必填 | 含义与约束 |
| --- | --- | --- | --- |
| `asr.transcripts` | object[] | 否 | 提供时为 1–20 项；当前仅使用第一项 `transcripts[0]` 进行对齐。省略时使用分段自带时间轴；不能用空数组代替省略。 |
| `asr.transcripts[].sentences` | object[] | 是 | 按语音顺序排列的原句，1–10,000 项。 |
| `sentences[].text` | string | 是 | 原句文本。当前实际对齐依据是 `words[].text`。 |
| `sentences[].words` | object[] | 是 | 按顺序排列的词及其时间，1–10,000 项。 |
| `sentences[].begin_time` | integer | 否 | 原句开始时间，单位毫秒，非负；当前不用于计算输出时间。 |
| `sentences[].end_time` | integer | 否 | 原句结束时间，单位毫秒，非负；当前不用于计算输出时间。 |
| `sentences[].sentence_id` | integer | 否 | 原句业务编号，非负。分组依据是原句在数组中的位置，不使用此编号。 |
| `words[].text` | string | 是 | 词语文本，用于顺序匹配 LLM 分段。 |
| `words[].begin_time` | integer | 是 | 词语开始时间，单位毫秒，非负。 |
| `words[].end_time` | integer | 是 | 词语结束时间，单位毫秒，非负，且不得早于该词的 `begin_time`。 |
| `words[].punctuation` | string | 否 | 词后的标点，当前不参与对齐。 |

对齐时会归一化文字、忽略大小写及标点等非字母数字字符，按 `llm.segments` 的
数组顺序在 ASR 词语文本中向后查找，不会自动重排分段或改写文字。每段的开始时间
取首个匹配词的开始时间，结束时间取最后一个匹配词的结束时间，并从毫秒转换为秒。
没有可对齐文字或无法顺序匹配时，任务以 `invalid_request` 失败并回调。

#### LLM 分段字段

`llm.segments` 必填，为包含 **1–500** 个对象的数组；对象字段如下：

| 字段 | 类型 | 必填 | 默认值／缺省行为 | 含义与约束 |
| --- | --- | --- | --- | --- |
| `segment_id` | integer | 是 | 无 | 正整数分段编号，原样返回。处理和返回顺序由数组顺序决定，不按此编号排序。 |
| `text` | string | 是 | 无 | 分段文本，去除首尾空白后为 1–10,000 字符；同时用于 ASR 对齐和混合搜索。 |
| `high_light_word` | string | 否 | 回退到 `keyword` | 旧格式的高亮词，最长 1,000 字符；优先转换为输出的 `keyword`，不再输出 `high_light_word`。显式空字符串也优先。 |
| `keyword` | string | 否 | 输出时回退到 `""` | 关键词，最长 1,000 字符。仅在未提供 `high_light_word` 时使用；不参与关键词检索或筛选。 |
| `level` | integer | 是 | 无 | 非负整数业务等级，原样返回，当前不影响搜索、排序或随机概率。 |
| `group_id` | `[number, number]` | 条件必填 | ASR 模式自动计算 | 含义为 `[句内分段序号, 该句分段总数]`。无 ASR transcripts 时必须提供并原样返回；有 ASR 时覆盖为从 1 开始的计算结果。跨句分段按起始词所在原句分组。 |
| `start_time` | number | 条件必填 | ASR 模式自动计算 | 分段开始时间，单位秒。无 ASR transcripts 时必须提供并原样返回；有 ASR 时覆盖。 |
| `end_time` | number | 条件必填 | ASR 模式自动计算 | 分段结束时间，单位秒。无 ASR transcripts 时必须提供并原样返回；有 ASR 时覆盖。 |
| 其他分段字段 | 任意 JSON 值 | 否 | 无 | 保留到对应结果分段；系统生成的时间轴、关键词和 `matched_candidate_*` 等同名字段以系统结果为准。 |

已有时间轴模式下，调用方应保证 `group_id` 的业务含义及起止时间合理；当前校验
仅要求 `group_id` 为两个数字、起止时间为数字，不额外验证正数、整数或时间先后关系。
缺少条件必填字段的检查发生在 Worker 中，因此可能先收到 `202`，随后收到失败回调。

#### 请求示例

已有时间轴时可直接发送：

```json
{
  "business_id": "edit_20260908_001",
  "asr": {},
  "llm": {
    "segments": [
      {
        "segment_id": 1,
        "text": "夕阳下的海边",
        "keyword": "海边",
        "level": 1,
        "group_id": [1, 1],
        "start_time": 0.32,
        "end_time": 2.2
      }
    ]
  },
  "asset_url_list": [
    {
      "file_url": "https://assets.example.com/api/v1/media/7f5966d8-598f-43a1-bc79-5d8b8ba21fe4",
      "type": "video"
    }
  ],
  "semantic_threshold": 0.3,
  "is_random": true,
  "callback_url": "https://internal.example/callbacks/segment-match"
}
```

需要自动对齐时，提供 ASR 词语时间即可省略分段时间轴。本例还省略了三个可选
控制字段，实际使用 `asset_url_list=[]`、`semantic_threshold=0.3`、`is_random=true`：

```json
{
  "asr": {
    "transcripts": [
      {
        "sentences": [
          {
            "text": "夕阳下的海边",
            "words": [
              { "text": "夕阳下的", "begin_time": 320, "end_time": 1200 },
              { "text": "海边", "begin_time": 1200, "end_time": 2200 }
            ]
          }
        ]
      }
    ]
  },
  "llm": {
    "segments": [
      { "segment_id": 1, "text": "夕阳下的海边", "high_light_word": "海边", "level": 1 }
    ]
  },
  "callback_url": "https://internal.example/callbacks/segment-match"
}
```

此例生成的时间轴为 `group_id=[1,1]`、`start_time=0.32`、`end_time=2.2`。
若使用字符串格式的 `llm`，应将整个 `{ "segments": [...] }` 对象序列化为字符串，
其内部字段和校验规则完全相同。

#### 匹配与选择规则

1. 按分段顺序，以每段 `text` 执行 ES 双路召回，使用 RRF 融合；每段最多一个结果。
2. 召回前应用指定素材范围并排除本任务已用素材。每个描述和视频摘要各一个文档、一个向量，分块候选数由 `.env` 配置，RRF 后按素材去重。
3. 请求中的 `semantic_threshold` 保留校验与接收，暂不参与过滤；使用服务端 `.env` 的双路阈值。`matched_candidate_score` 返回归一化 RRF 分数。
4. `is_random=true` 从融合候选中等概率选择一个；`false` 选择融合排序第一项。同一素材不重复使用。
5. 返回前再次校验素材可用状态，个人素材 URL 追加 `user_id`。embedding 或 ES 错误导致任务失败并走原有重试、回调流程。

本接口没有可配置的 `limit` 请求字段。

#### 同步响应：任务已受理

HTTP `202 Accepted`，JSON 格式如下：

```json
{
  "taskId": "ff34e53d-884e-4945-a2d3-3caadfbb6e28",
  "status": "processing"
}
```

| 字段／响应头 | 类型 | 含义 |
| --- | --- | --- |
| `taskId` | string (UUID) | 已创建的任务 ID。本兼容接口使用 camelCase `taskId`，不是 `task_id`。 |
| `status` | string | 固定为 `processing`，表示已受理，任务可能仍在排队，不代表已完成或已命中。 |
| `Location`（响应头） | string | 任务查询路径 `/api/v1/tasks/{taskId}`，部署配置了路径前缀时包含该前缀。 |
| `X-Request-Id`（响应头） | string (UUID) | 本次 HTTP 请求的跟踪 ID，与任务 ID 不同。 |
| `Cache-Control`（响应头） | string | 固定为 `no-store`。 |

#### 成功回调及结果字段

系统向 `callback_url` 发起 HTTP `POST`，请求头包含 `Content-Type: application/json`
及 `X-Assets-Task-Id: <taskId>`。成功回调示例：

```json
{
  "business_id": "edit_20260908_001",
  "taskId": "ff34e53d-884e-4945-a2d3-3caadfbb6e28",
  "status": "success",
  "result": {
    "segments": [
      {
        "segment_id": 1,
        "text": "夕阳下的海边",
        "keyword": "海边",
        "level": 1,
        "group_id": [1, 1],
        "start_time": 0.32,
        "end_time": 2.2,
        "matched_candidate_url": "https://assets.example.com/api/v1/media/7f5966d8-598f-43a1-bc79-5d8b8ba21fe4?v=1",
        "matched_candidate_type": "video",
        "matched_candidate_desc": "夕阳下的海岸与沙滩",
        "matched_candidate_score": 0.91,
        "matched_candidate_reason": null,
        "matched_candidate_message": null
      }
    ]
  },
  "completed_at": "2026-09-08T07:59:38.839000"
}
```

| 回调字段 | 类型 | 含义 |
| --- | --- | --- |
| `taskId` | string (UUID) | 与受理响应一致的任务 ID，可用于关联业务和回调去重。 |
| `status` | string | 正常完成为 `success`，任务执行失败为 `failed`。`success` 不保证每段都命中素材。 |
| `result` | object | 成功时提供，包含 `segments`；系统在失败回调中改为提供 `error`。 |
| `result.segments` | object[] | 与输入 `llm.segments` 数量和顺序一致的处理结果，未命中的分段也保留。 |
| `completed_at` | string | 任务完成时间，格式为 `YYYY-MM-DDTHH:mm:ss.SSS000`。本兼容接口的实际值按 **UTC** 生成，但不带 `Z` 或时区偏移；精度为毫秒，末三位补零。不同于本文通用接口的上海时区时间格式。 |
| 自定义业务字段 | 与请求一致 | 请求中的未知顶层字段在成功、失败回调中均透传；七个已知顶层请求字段不重复回传。 |

`result.segments[]` 字段如下。所有列出的结果字段都会出现；可空字段用 `null`
表示无值，不以省略字段代替：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `segment_id` | integer | 输入分段编号。 |
| `text` | string | 去除首尾空白后的输入分段文本。 |
| `keyword` | string | 优先取输入 `high_light_word`，其次取 `keyword`，均未提供时为 `""`。 |
| `level` | integer | 输入业务等级。 |
| `group_id` | `[number, number]` | `[句内序号, 句内总数]`；来自 ASR 对齐计算或调用方已有时间轴。 |
| `start_time` | number | 分段开始时间，单位秒，来自 ASR 计算或输入。不是所选素材内的裁剪起点。 |
| `end_time` | number | 分段结束时间，单位秒，来自 ASR 计算或输入。不是所选素材内的裁剪终点。 |
| `matched_candidate_url` | string (URL) 或 null | 命中素材的绝对媒体 URL；个人素材带 `user_id`。未命中为 `null`。 |
| `matched_candidate_type` | `image`、`video` 或 null | 命中素材的实际媒体类型，未命中为 `null`。 |
| `matched_candidate_desc` | string 或 null | 命中素材的描述，未命中为 `null`。 |
| `matched_candidate_score` | number 或 null | `[0,1]` 归一化 RRF 排名分数。命中时为所选素材分数；因去重或最终检查失效而未命中时可能保留候选分数；没有可用分数时为 `null`。不能只凭分数判断是否命中。 |
| `matched_candidate_reason` | string 或 null | 命中为 `null`；未命中时为下表中的机器可读原因。 |
| `matched_candidate_message` | string 或 null | 命中为 `null`；未命中时为说明文本。文本可能变化，业务判断应使用 `reason`。 |
| 其他分段字段 | 与请求一致 | 保留输入分段的自定义字段，系统生成字段除外。 |

| `matched_candidate_reason` | 含义 |
| --- | --- |
| `no_candidates` | 没有可用候选，包括指定 URL 无法识别、范围内没有待审核或已发布素材、没有召回结果、所选素材失效或可用素材已被前面的分段用完等；具体情况见 `message`。 |
| `below_threshold` / `semantic_unavailable` | 保留旧枚举，新检索不再产生；服务错误通过任务失败报告。 |

没有候选时，六个匹配字段示例：

```json
{
  "matched_candidate_url": null,
  "matched_candidate_type": null,
  "matched_candidate_desc": null,
  "matched_candidate_score": null,
  "matched_candidate_reason": "no_candidates",
  "matched_candidate_message": "没有召回任何候选素材。"
}
```

上例只展示匹配字段，完整结果仍包含分段编号、文本、时间轴等字段。

#### 失败格式与回调重试

请求受理前的错误直接返回 HTTP 错误响应。例如发送无效 JSON 时返回 `400`：

```json
{
  "error": {
    "code": "invalid_request",
    "message": "请求体必须是有效的 JSON。"
  },
  "request_id": "9264af56-01cc-4fbe-9560-8df51ef3f668"
}
```

| 同步错误字段 | 类型 | 含义 |
| --- | --- | --- |
| `error` | object | 错误信息容器。 |
| `error.code` | string | 机器可读错误码，例如 `invalid_request`、`internal_error`。 |
| `error.message` | string | 本次错误的说明文本；字段校验错误通常只返回首条说明。 |
| `error.details` | array（可选） | 统一错误格式的附加诊断；普通 JSON／字段校验错误不提供。 |
| `request_id` | string (UUID) | 与响应头 `X-Request-Id` 一致，用于定位请求。 |

| HTTP 状态 | 本接口的典型场景 |
| --- | --- |
| `400` | 无效 JSON、缺少必填字段、类型错误、数组或字符串超限、阈值越界、非法回调 URL。 |
| `413` | 整个 JSON 请求体超过 1 MiB，错误码为 `invalid_request`。 |
| `409` | 创建任务时遇到数据库死锁等已映射的操作冲突。 |
| `500` | 创建任务时发生未处理的内部错误。 |

这些错误不返回成功受理的 `taskId`，也不会建立一个成功受理任务的终态回调流程。
已经返回 `202` 后发生的时间轴检查、对齐或执行错误通过失败回调报告，例如：

```json
{
  "business_id": "edit_20260908_001",
  "taskId": "ff34e53d-884e-4945-a2d3-3caadfbb6e28",
  "status": "failed",
  "error": {
    "code": "invalid_request",
    "message": "分段 1 缺少 group_id、start_time 或 end_time。"
  },
  "completed_at": "2026-09-08T07:59:38.839000"
}
```

失败回调的 `taskId`、`status`、`completed_at` 和业务透传字段含义同上；`error`
是错误对象，其中 `code` 为任务错误码，`message` 为失败说明。对齐／时间轴输入错误
通常为 `invalid_request`，未分类执行异常为 `internal_error`。此回调不会自动附带
同步错误响应中的 `request_id` 或 `error.details`。

匹配作业最多执行 **3 次（含首次）**，`invalid_request` 不重试；可重试执行错误
在前两次失败后分别延迟 30 秒、60 秒再尝试。回调投递独立重试，最多 **5 次（含首次）**，
失败后按 1、2、4、8 分钟退避。接收方应在 15 秒内返回任意 `2xx` 状态；系统不跟随
重定向，非 `2xx`、超时或网络失败都算投递失败。接收方应按 `taskId` 幂等处理可能
重复到达的回调。回调重试只重新投递已保存的结果，不重新随机选择素材。

## 8. 异步素材变更

以下接口均返回 `202 Accepted` 和 `TaskAccepted`，并通过响应头 `Location` 指向
`/api/v1/tasks/{task_id}`。请求可带 `callback_url`。

### `PATCH /api/v1/assets/{asset_id}`

整体替换名称、描述和人工标签：

```json
{
  "user_id": "user_123",
  "callback_url": null,
  "name": "产品主视觉",
  "description": "人工确认后的描述。",
  "tags": [
    { "category": "scene", "value": "白色背景" },
    { "category": "object", "value": "橙子" }
  ]
}
```

`name` 为 1–255 字符，`description` 最长 10,000 字符，`tags` 最多 100 项；
标签分类最长 64 字符、值最长 128 字符。

### `POST /api/v1/assets/{asset_id}/publish`

请求体可为空，也可传 `{"user_id":"user_123","callback_url":null}`。分析成功后，
公共素材不传 `user_id` 发布；私人素材传入其所属 `user_id` 发布。公私审核状态互不联动。

### `POST /api/v1/assets/{asset_id}/retry`

请求体同发布接口。只有分析失败的素材可以重试；重试任务通过统一任务接口
跟踪新的分析结果。

### `DELETE /api/v1/assets/{asset_id}`

请求体是可选的 `MutationContext`：

- 传入非空 `user_id`：只删除该用户的私人记录、分析数据、搜索索引和私人 ZOS
  对象，不影响配对的公共副本。
- 不传 `user_id`、传空字符串或 `null`：只允许删除公共素材。worker 会删除
  ES 索引、ZOS 对象和 MySQL 素材记录。
- 视频切片独立删除；删除某一侧最后一个切片时只回收该侧父视频对象。公私两侧
  都清空后才回收共享的逻辑父视频记录。

## 9. 用户资源占用与展示列表

这两个接口都只处理指定 `user_id` 的个人素材，不会混入 `user_id IS NULL` 的
公共素材。路径中的 `user_id` 会先进行 URL 解码，解码后必须为 1–191 个字符。

### `GET /api/v1/users/{user_id}/storage-usage`

使用 MySQL 中该用户每条素材记录的字节字段直接聚合，适合配额展示、容量告警
和用户空间管理。返回：

- `total_files`、`image_files`、`video_files`：素材条数；视频切片各算一条。
- `image_bytes`：全部图片对象大小之和。
- `video_bytes`：全部视频对象加各自第一帧 JPEG 对象大小之和。
- `total_bytes`：`image_bytes + video_bytes`。
- `items`：逐素材的 `asset_id`、`name`、`media_type`、`media_bytes`、
  `thumbnail_bytes` 和 `total_bytes`；图片的 `thumbnail_bytes` 为 0。

该统计不读取或下载 ZOS 文件；数值来自已持久化并登记在 MySQL 的对象元数据。

### `GET /api/v1/users/{user_id}/media`

查询参数 `cursor` 可选，`limit` 为 1–100、默认 20。响应包含 `items`、
`next_cursor` 和 `has_more`：

- 图片项返回 `media_url`，可直接作为 `<img src>`。
- 视频项返回第一帧 `thumbnail_url` 和视频 `media_url`。首帧在视频入库时即
  作为独立 JPEG 对象持久化到 ZOS 并在 MySQL 关联，不会在列表请求时临时抽帧，
  也不会返回 base64。列表先把
  `thumbnail_url` 用作 `<img src>`；用户点击播放后，用 `media_url` 替换为
  `<video src>` 并开始播放。
- 每项同时返回 `asset_id`、`name`、`media_type`、`size_bytes` 和上海时区
  `created_at`；视频还返回 `thumbnail_bytes`。

列表接口无需鉴权。媒体 URL 是带 `user_id` 查询参数的绝对直链（以当前请求的
origin 为主机），不含 base64、密钥、签名或过期时间，可直接用于 `<img>` 和
`<video>`。`user_id` 只限定数据范围，不提供身份认证能力。

## 10. 媒体读取

### `GET /api/v1/media/{asset_id}`

该接口无需鉴权 Header。查询参数：

- `user_id`：与详情接口相同；省略表示公共素材。
- `download=1`：使用原始文件名作为附件下载；否则内联展示。

支持单段 HTTP Range：`bytes=start-end`、`bytes=start-`、`bytes=-suffix`。

- `200 OK`：完整对象。
- `206 Partial Content`：部分对象，包含 `Content-Range`。
- `416 Range Not Satisfiable`：范围无效，返回 `Content-Range: bytes */<size>`。
- `409 Conflict`：媒体尚未完成校验，暂不可读取。

响应包括 `Content-Type`、`Content-Length`、`Accept-Ranges: bytes`、
`Content-Disposition`、`X-Content-Type-Options: nosniff`。持久化素材直接从 ZOS
流式读取，不依赖本地 staging 文件。

### `GET /api/v1/media/{asset_id}/thumbnail`

读取视频切片持久化的第一帧 JPEG，支持与视频相同的单段 Range 语义。页面展示
直接使用用户媒体列表返回的 `thumbnail_url`，点击播放后切换到对应
`media_url`。

## 11. OpenAPI

`GET /api/v1/openapi` 返回 OpenAPI 3.1 YAML。启用 WebUI 页面锁后，浏览器需先
通过 `/lock` 建立 HttpOnly Cookie 会话；curl 或自动同步脚本可发送
`Authorization: Bearer <WEBUI_LOCK_KEY>`。未认证时只对此规范端点返回 `401`。

```bash
curl -H "Authorization: Bearer $WEBUI_LOCK_KEY" \
  "$BASE_URL/api/v1/openapi"
```

`/api/v1/openapi` 是唯一受页面锁影响的 API。上传、查询、媒体等既有
`/api/v1/**` 业务端点继续无需该密钥；生产部署的 basePath（例如
`/feisu/assets-library/api/v1/**`）及请求、响应契约均保持不变。浏览器访问
`/docs` 可打开 Swagger UI，原 `/api-docs` 路径继续保留。
