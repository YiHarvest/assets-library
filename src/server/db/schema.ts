import {
  bigint,
  boolean,
  datetime,
  decimal,
  double,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

const uuid = (name: string) => varchar(name, { length: 36 });
const utcDateTime = (name: string) => datetime(name, { mode: "date", fsp: 3 });
const byteCount = (name: string) => bigint(name, { mode: "number", unsigned: true });

/**
 * 应用观察到的用户作用域。
 *
 * user_id 目前来自 API/MCP 请求，并不等同于已认证身份；姓名、邮箱和部门仅为
 * 后续接入身份系统预留，未获得可信来源前保持 NULL。
 */
export const users = mysqlTable(
  "users",
  {
    userId: varchar("user_id", { length: 191 }).primaryKey(),
    displayName: varchar("display_name", { length: 255 }),
    email: varchar("email", { length: 320 }),
    department: varchar("department", { length: 255 }),
    firstSeenAt: utcDateTime("first_seen_at").notNull(),
    lastSeenAt: utcDateTime("last_seen_at").notNull(),
    createdAt: utcDateTime("created_at").notNull(),
    updatedAt: utcDateTime("updated_at").notNull(),
  },
  (table) => [index("users_last_seen_idx").on(table.lastSeenAt)],
);

/**
 * 所有异步操作共享的任务主表。
 *
 * 数据库存储 UTC；API 层负责将时间转换成 Asia/Shanghai。任务状态只使用
 * queued/running/done/failed，细粒度执行位置通过 phase 表达。
 */
export const tasks = mysqlTable(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    type: mysqlEnum("type", [
      "upload",
      "delete",
      "publish",
      "update",
      "retry",
      "match",
    ]).notNull(),
    status: mysqlEnum("status", ["queued", "running", "done", "failed"])
      .notNull()
      .default("queued"),
    phase: varchar("phase", { length: 64 }).notNull().default("queued"),
    userId: varchar("user_id", { length: 191 }),
    callbackUrl: varchar("callback_url", { length: 2048 }),
    receivedBytes: byteCount("received_bytes").notNull().default(0),
    totalBytes: byteCount("total_bytes").notNull().default(0),
    totalItems: int("total_items", { unsigned: true }).notNull().default(0),
    doneItems: int("done_items", { unsigned: true }).notNull().default(0),
    failedItems: int("failed_items", { unsigned: true }).notNull().default(0),
    progressPercent: decimal("progress_percent", {
      precision: 5,
      scale: 2,
      mode: "number",
      unsigned: true,
    })
      .notNull()
      .default(0),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: text("error_message"),
    errorDetails: json("error_details").$type<Record<string, unknown>>(),
    result: json("result").$type<Record<string, unknown>>(),
    callbackAttempts: int("callback_attempts", { unsigned: true }).notNull().default(0),
    nextCallbackAt: utcDateTime("next_callback_at"),
    callbackCompletedAt: utcDateTime("callback_completed_at"),
    createdAt: utcDateTime("created_at").notNull(),
    startedAt: utcDateTime("started_at"),
    finishedAt: utcDateTime("finished_at"),
    expiresAt: utcDateTime("expires_at"),
    updatedAt: utcDateTime("updated_at").notNull(),
  },
  (table) => [
    index("tasks_status_created_idx").on(table.status, table.createdAt),
    index("tasks_expires_idx").on(table.expiresAt),
    index("tasks_user_created_idx").on(table.userId, table.createdAt),
  ],
);

/** 上传任务中的原始文件。文件字节流先写入 stagingPath，封存后才进入处理链。 */
export const taskItems = mysqlTable(
  "task_items",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    ordinal: int("ordinal", { unsigned: true }).notNull(),
    filename: varchar("filename", { length: 255 }).notNull(),
    declaredContentType: varchar("declared_content_type", { length: 255 }),
    mediaType: mysqlEnum("media_type", ["image", "video"]),
    stagingPath: varchar("staging_path", { length: 1024 }).notNull(),
    receivedBytes: byteCount("received_bytes").notNull().default(0),
    totalBytes: byteCount("total_bytes").notNull().default(0),
    status: mysqlEnum("status", ["queued", "running", "done", "failed"])
      .notNull()
      .default("queued"),
    phase: varchar("phase", { length: 64 }).notNull().default("receiving"),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: text("error_message"),
    errorDetails: json("error_details").$type<Record<string, unknown>>(),
    createdAt: utcDateTime("created_at").notNull(),
    updatedAt: utcDateTime("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("task_items_task_ordinal_unique").on(table.taskId, table.ordinal),
    index("task_items_task_status_idx").on(table.taskId, table.status),
  ],
);

/** 幂等键只在同一操作类型及用户作用域内唯一。 */
export const idempotencyRequests = mysqlTable(
  "idempotency_requests",
  {
    id: uuid("id").primaryKey(),
    operation: varchar("operation", { length: 64 }).notNull(),
    userScope: varchar("user_scope", { length: 191 }).notNull().default("public"),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    responseStatus: int("response_status", { unsigned: true }),
    responseBody: json("response_body").$type<Record<string, unknown>>(),
    createdAt: utcDateTime("created_at").notNull(),
    expiresAt: utcDateTime("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("idempotency_scope_key_unique").on(
      table.operation,
      table.userScope,
      table.idempotencyKey,
    ),
    index("idempotency_expires_idx").on(table.expiresAt),
  ],
);

/** 本地 staging 或 ZOS 中的一个真实对象，业务表只保存对象引用。 */
export const mediaObjects = mysqlTable(
  "media_objects",
  {
    id: uuid("id").primaryKey(),
    provider: mysqlEnum("provider", ["local", "zos"]).notNull(),
    bucket: varchar("bucket", { length: 255 }),
    // utf8mb4 唯一索引上限为 3072 bytes；700 字符为对象 key 留出枚举索引开销。
    objectKey: varchar("object_key", { length: 700 }).notNull(),
    publicUrl: varchar("public_url", { length: 2048 }),
    localPath: varchar("local_path", { length: 1024 }),
    sha256: varchar("sha256", { length: 64 }),
    mimeType: varchar("mime_type", { length: 255 }).notNull(),
    sizeBytes: byteCount("size_bytes").notNull(),
    status: mysqlEnum("status", ["staging", "persisted", "deleting", "deleted"])
      .notNull()
      .default("staging"),
    createdAt: utcDateTime("created_at").notNull(),
    updatedAt: utcDateTime("updated_at").notNull(),
    deletedAt: utcDateTime("deleted_at"),
  },
  (table) => [
    uniqueIndex("media_provider_object_unique").on(table.provider, table.objectKey),
    index("media_sha_size_idx").on(table.sha256, table.sizeBytes),
    index("media_status_updated_idx").on(table.status, table.updatedAt),
  ],
);

/**
 * 完整父视频记录。父视频不属于素材列表，仅作为切片来源和最后切片删除后的回收单元。
 */
export const videoSources = mysqlTable(
  "video_sources",
  {
    id: uuid("id").primaryKey(),
    // 任务明细只保留 7 天；父视频仍需存活到最后一个切片被删除，因此追溯引用可置空。
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    taskItemId: uuid("task_item_id").references(() => taskItems.id, {
      onDelete: "set null",
    }),
    userId: varchar("user_id", { length: 191 }),
    mediaObjectId: uuid("media_object_id").references(() => mediaObjects.id, {
      onDelete: "set null",
    }),
    originalFilename: varchar("original_filename", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 255 }).notNull(),
    sizeBytes: byteCount("size_bytes").notNull(),
    durationMs: bigint("duration_ms", { mode: "number", unsigned: true }),
    /** 分镜批次首次成功持久化时的切片总数，不随子素材删除或任务清理变化。 */
    generatedSegmentCount: int("generated_segment_count", { unsigned: true })
      .notNull()
      .default(0),
    status: mysqlEnum("status", ["queued", "running", "done", "failed"])
      .notNull()
      .default("queued"),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: text("error_message"),
    errorDetails: json("error_details").$type<Record<string, unknown>>(),
    expiresAt: utcDateTime("expires_at"),
    createdAt: utcDateTime("created_at").notNull(),
    updatedAt: utcDateTime("updated_at").notNull(),
    deletedAt: utcDateTime("deleted_at"),
  },
  (table) => [
    uniqueIndex("video_sources_task_item_unique").on(table.taskItemId),
    index("video_sources_user_created_idx").on(table.userId, table.createdAt),
    index("video_sources_expires_idx").on(table.expiresAt),
  ],
);

/** 分镜服务返回的切片清单；整批校验通过后才会创建 assets 行。 */
export const taskItemSegments = mysqlTable(
  "task_item_segments",
  {
    id: uuid("id").primaryKey(),
    taskItemId: uuid("task_item_id")
      .notNull()
      .references(() => taskItems.id, { onDelete: "cascade" }),
    videoSourceId: uuid("video_source_id")
      .notNull()
      .references(() => videoSources.id, { onDelete: "cascade" }),
    segmentIndex: int("segment_index", { unsigned: true }).notNull(),
    startMs: bigint("start_ms", { mode: "number", unsigned: true }).notNull(),
    endMs: bigint("end_ms", { mode: "number", unsigned: true }).notNull(),
    stagingPath: varchar("staging_path", { length: 1024 }).notNull(),
    mimeType: varchar("mime_type", { length: 255 }).notNull(),
    sizeBytes: byteCount("size_bytes").notNull(),
    status: mysqlEnum("status", ["queued", "running", "done", "failed"])
      .notNull()
      .default("queued"),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: text("error_message"),
    errorDetails: json("error_details").$type<Record<string, unknown>>(),
    createdAt: utcDateTime("created_at").notNull(),
    updatedAt: utcDateTime("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("segments_source_index_unique").on(
      table.videoSourceId,
      table.segmentIndex,
    ),
    index("segments_item_status_idx").on(table.taskItemId, table.status),
  ],
);

/**
 * 素材库可检索实体。user_id 为 NULL 表示公共素材；视频仅保存分镜后的子视频。
 */
export const assets = mysqlTable(
  "assets",
  {
    id: uuid("id").primaryKey(),
    userId: varchar("user_id", { length: 191 }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    taskItemId: uuid("task_item_id").references(() => taskItems.id, {
      onDelete: "set null",
    }),
    taskItemSegmentId: uuid("task_item_segment_id").references(
      () => taskItemSegments.id,
      { onDelete: "set null" },
    ),
    videoSourceId: uuid("video_source_id").references(() => videoSources.id, {
      onDelete: "set null",
    }),
    mediaObjectId: uuid("media_object_id").references(() => mediaObjects.id, {
      onDelete: "restrict",
    }),
    /** 视频子素材首帧的长期对象；图片保持为空并直接使用原媒体。 */
    thumbnailMediaObjectId: uuid("thumbnail_media_object_id").references(
      () => mediaObjects.id,
      { onDelete: "restrict" },
    ),
    segmentIndex: int("segment_index", { unsigned: true }),
    segmentStartMs: bigint("segment_start_ms", { mode: "number", unsigned: true }),
    segmentEndMs: bigint("segment_end_ms", { mode: "number", unsigned: true }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description").notNull(),
    mediaType: mysqlEnum("media_type", ["image", "video"]).notNull(),
    originalFilename: varchar("original_filename", { length: 255 }).notNull(),
    originalPath: varchar("original_path", { length: 1024 }).notNull(),
    mimeType: varchar("mime_type", { length: 255 }).notNull(),
    sizeBytes: byteCount("size_bytes").notNull(),
    directPublish: boolean("direct_publish").notNull().default(false),
    processingStatus: mysqlEnum("processing_status", [
      "queued",
      "validating",
      "analyzing",
      "completed",
      "failed",
    ])
      .notNull()
      .default("queued"),
    reviewStatus: mysqlEnum("review_status", [
      "pending_review",
      "published",
      "deleted",
    ])
      .notNull()
      .default("pending_review"),
    failureCode: varchar("failure_code", { length: 64 }),
    failureMessage: text("failure_message"),
    createdAt: utcDateTime("created_at").notNull(),
    updatedAt: utcDateTime("updated_at").notNull(),
    deletedAt: utcDateTime("deleted_at"),
  },
  (table) => [
    index("assets_user_review_created_idx").on(
      table.userId,
      table.reviewStatus,
      table.createdAt,
    ),
    index("assets_review_created_idx").on(table.reviewStatus, table.createdAt),
    uniqueIndex("assets_task_segment_unique").on(table.taskItemSegmentId),
    uniqueIndex("assets_source_segment_unique").on(
      table.videoSourceId,
      table.segmentIndex,
    ),
  ],
);

export const analysisResults = mysqlTable("analysis_results", {
  assetId: uuid("asset_id")
    .primaryKey()
    .references(() => assets.id, { onDelete: "cascade" }),
  schemaVersion: int("schema_version", { unsigned: true }).notNull().default(1),
  resultJson: json("result_json").$type<Record<string, unknown>>().notNull(),
  modelProtocol: varchar("model_protocol", { length: 64 }).notNull(),
  modelName: varchar("model_name", { length: 255 }).notNull(),
  completedAt: utcDateTime("completed_at").notNull(),
});

export const tags = mysqlTable(
  "tags",
  {
    id: uuid("id").primaryKey(),
    category: varchar("category", { length: 64 }).notNull(),
    value: varchar("value", { length: 128 }).notNull(),
    normalizedValue: varchar("normalized_value", { length: 128 }).notNull(),
    createdAt: utcDateTime("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("tags_category_normalized_unique").on(
      table.category,
      table.normalizedValue,
    ),
  ],
);

export const assetTags = mysqlTable(
  "asset_tags",
  {
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    source: mysqlEnum("source", ["model", "human"]).notNull(),
    confidence: double("confidence"),
  },
  (table) => [primaryKey({ columns: [table.assetId, table.tagId] })],
);

export const assetTagRejections = mysqlTable(
  "asset_tag_rejections",
  {
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    category: varchar("category", { length: 64 }).notNull(),
    normalizedValue: varchar("normalized_value", { length: 128 }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.assetId, table.category, table.normalizedValue],
    }),
  ],
);

/** worker 可抢占的作业队列；领取使用 FOR UPDATE SKIP LOCKED。 */
export const jobs = mysqlTable(
  "jobs",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "cascade" }),
    type: mysqlEnum("type", [
      "validate",
      "scene_detect",
      "persist",
      "analyze",
      "embed",
      "delete",
      "cleanup",
      "publish",
      "update",
      "retry",
      "match",
      "callback",
    ]).notNull(),
    status: mysqlEnum("status", ["queued", "running", "done", "failed"])
      .notNull()
      .default("queued"),
    phase: varchar("phase", { length: 64 }).notNull().default("queued"),
    payload: json("payload").$type<Record<string, unknown>>(),
    attempt: int("attempt", { unsigned: true }).notNull().default(0),
    availableAt: utcDateTime("available_at").notNull(),
    claimedAt: utcDateTime("claimed_at"),
    leaseOwner: varchar("lease_owner", { length: 191 }),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: text("error_message"),
    errorDetails: json("error_details").$type<Record<string, unknown>>(),
    createdAt: utcDateTime("created_at").notNull(),
    updatedAt: utcDateTime("updated_at").notNull(),
  },
  (table) => [
    index("jobs_queue_idx").on(table.status, table.availableAt, table.createdAt),
    index("jobs_task_idx").on(table.taskId, table.status),
    index("jobs_asset_idx").on(table.assetId, table.status),
  ],
);

/** 数据库事务内写入的可靠事件，外部副作用由 dispatcher 异步发送。 */
export const outboxEvents = mysqlTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey(),
    aggregateType: varchar("aggregate_type", { length: 64 }).notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    eventType: varchar("event_type", { length: 128 }).notNull(),
    payload: json("payload").$type<Record<string, unknown>>().notNull(),
    status: mysqlEnum("status", ["queued", "running", "done", "failed"])
      .notNull()
      .default("queued"),
    attempt: int("attempt", { unsigned: true }).notNull().default(0),
    availableAt: utcDateTime("available_at").notNull(),
    claimedAt: utcDateTime("claimed_at"),
    processedAt: utcDateTime("processed_at"),
    errorMessage: text("error_message"),
    createdAt: utcDateTime("created_at").notNull(),
    updatedAt: utcDateTime("updated_at").notNull(),
  },
  (table) => [index("outbox_queue_idx").on(table.status, table.availableAt)],
);

export const callbackDeliveries = mysqlTable(
  "callback_deliveries",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    attempt: int("attempt", { unsigned: true }).notNull(),
    requestBody: json("request_body").$type<Record<string, unknown>>().notNull(),
    responseStatus: int("response_status", { unsigned: true }),
    responseBody: text("response_body"),
    errorMessage: text("error_message"),
    startedAt: utcDateTime("started_at").notNull(),
    completedAt: utcDateTime("completed_at"),
  },
  (table) => [
    uniqueIndex("callback_task_attempt_unique").on(table.taskId, table.attempt),
  ],
);

/** Chroma 最终一致性水位；每个素材只保留一行状态。 */
export const searchIndexState = mysqlTable(
  "search_index_state",
  {
    assetId: uuid("asset_id")
      .primaryKey()
      .references(() => assets.id, { onDelete: "cascade" }),
    status: mysqlEnum("status", ["queued", "running", "done", "failed", "deleted"])
      .notNull()
      .default("queued"),
    contentHash: varchar("content_hash", { length: 64 }),
    indexedAt: utcDateTime("indexed_at"),
    errorMessage: text("error_message"),
    updatedAt: utcDateTime("updated_at").notNull(),
  },
  (table) => [index("search_index_status_idx").on(table.status, table.updatedAt)],
);
