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

该接口统一素材浏览、游标分页、标签统计和语义搜索。
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
| `query` | `string?` | 1–1,000 字符；存在时执行描述语义搜索。 |
| `keywords` | `string[]?` | 最多 10 项，每项 1–64 字符；用于标签候选粗筛。 |
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

关键词搜索会保留完整查询文本并同时分词，再依次执行精确/别名、前缀、包含
匹配；只有强匹配没有合格结果时才启用错别字兜底。完整文本证据可避免短句被
分词后丢失整句错别字匹配。多词查询中，任一精确/别名命中可进入结果，未命中词
会降低排序分但不会直接清空结果。场景、图片风格和视频形式会按标签分类参与
权重计算。自然语言应放入 `query`，使用完整文本执行语义搜索，不使用关键词
分词结果代替原句。

所有检索分数统一在 `[0,1]` 范围内。系统先为候选计算最终分数，再过滤未超过
阈值的素材，之后才统计、排序和分页。因此 `total`、标签统计和实际返回项均不
包含低于阈值的候选。`AI`、`AIGC`、`人工智能` 等宽泛别名会优先用语义门槛
去噪并融合排序，但不会改变查询作用域。语义不可用或全部低于门槛时，回退
全部强词法候选，避免精确标签被误过滤或被固定数量截断，结果仍按 `limit` 分页。

当前默认展示阈值为：强关键词 `0.60`、仅在强匹配为空时启用的错别字兜底
`0.40`、自然语言语义搜索 `0.55`、宽泛 AI 词的关键词/语义融合 `0.65`；比较规则
均为严格大于（`score > threshold`）。

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
| `keyword_score` / `semantic_score` | `number?` | `[0,1]` 关键词分和语义分；未参与计算的分项省略。 |
| `match_type` | `string?` | `exact`、`alias`、`prefix`、`contains`、`typo`、`semantic` 或 `hybrid`。 |
| `matched_terms` | `string[]?` | 实际命中的规范化查询词。 |
| `matched_categories` | `string[]?` | 命中标签所属分类，如 `scene`、`style`、`form`。 |

有合格结果时，`search.message` 为 `null`：

```json
{
  "items": [
    {
      "asset_id": "00000000-0000-4000-8000-000000000001",
      "search_score": 0.86,
      "keyword_score": 1,
      "semantic_score": 0.767,
      "match_type": "hybrid",
      "matched_terms": ["ai"],
      "matched_categories": ["style"]
    }
  ],
  "next_cursor": null,
  "has_more": false,
  "tag_statistics": null,
  "search": {
    "mode": "hybrid",
    "threshold": 0.65,
    "max_score": 0.86,
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
    "mode": "semantic",
    "threshold": 0.55,
    "max_score": 0.49,
    "reason": "below_threshold",
    "message": "找到候选素材，但最高匹配分为 0.490，未超过展示阈值 0.550。"
  }
}
```

`search.reason` 的取值如下：

- `matched`：存在超过阈值的结果，此时 `message` 为 `null`。
- `no_candidates`：召回阶段没有候选，`max_score` 为 `null`。
- `below_threshold`：存在候选，但最高分未超过阈值。
- `semantic_unavailable`：语义服务暂不可用，`max_score` 为 `null`。
- `fallback_exhausted`：强匹配和错别字兜底均无合格结果。

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

接收旧剪辑业务的分段、`callback_url` 和素材地址列表，持久化为异步 `match`
任务。支持两种请求格式：传入 ASR 逐词时间时自动对齐；`asr` 为空对象时，直接
复用 `llm.segments` 中已有的 `group_id`、`start_time` 和 `end_time`。`llm` 可传
对象或字符串化 JSON，`asset_url_list` 可传 URL 字符串或
`{"file_url":"...","type":"video"}` 对象。接口立即返回 `202 Accepted`：

```json
{
  "taskId": "ff34e53d-884e-4945-a2d3-3caadfbb6e28",
  "status": "processing"
}
```

存在 ASR transcripts 时，worker 会按 LLM 分段顺序在 ASR 文本中逐字对齐，生成
秒制 `start_time` / `end_time`，并按 ASR 原句生成 `[句内序号, 句内总数]` 形式的
`group_id`；ASR 为空时不重复对齐，直接保留分段自带的三个时间轴字段。
`high_light_word` 会转换为 `keyword`；LLM 每个 segment 上的其他字段会继续保留。

每个分段都复用描述语义匹配：候选范围是所有已发布的公共及个人素材，归一化
相似度必须严格大于 `0.55`，按相似度降序只取一个。每段始终返回六个
`matched_candidate_*` 字段。命中时 URL、类型、描述和 `[0,1]` 分数有值，
`reason` / `message` 为 `null`；未命中时前三项为 `null`，若存在低分候选则
`score` 返回阈值过滤前最高分，并通过 `reason` / `message` 说明原因。个人素材 URL
会自动附加 `user_id`。当前 `asset_url_list` 仅作为旧契约兼容字段接收，不限制候选范围。

成功后系统向 `callback_url` 发送：

```json
{
  "business_id": "调用方自定义字段会透传",
  "taskId": "ff34e53d-884e-4945-a2d3-3caadfbb6e28",
  "status": "success",
  "result": {
    "segments": [
      {
        "segment_id": 1,
        "text": "如果能回到二十岁",
        "keyword": "",
        "level": 1,
        "group_id": [1, 3],
        "start_time": 0.32,
        "end_time": 2.2,
        "matched_candidate_url": "https://example.com/api/v1/media/asset-id?v=1",
        "matched_candidate_type": "video",
        "matched_candidate_desc": "夕阳下女性剪影",
        "matched_candidate_score": 0.91,
        "matched_candidate_reason": null,
        "matched_candidate_message": null
      }
    ]
  },
  "completed_at": "2026-09-02T07:59:38.839000"
}
```

请求中除 `asr`、`llm`、`text`、`asset_url_list`、`callback_url` 外的未知顶层
字段会原样放入回调；这些体积较大的已知输入字段不重复回传。匹配作业失败可重试
最多 3 次，终态回调沿用统一回调投递器，失败指数退避、最多投递 5 次。

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
  Chroma 向量、ZOS 对象和 MySQL 素材记录。
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
