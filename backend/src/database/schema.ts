import {
  bigint,
  boolean,
  datetime,
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
import {
  MEDIA_TYPES,
  TASK_PHASES,
  TASK_STATUSES,
  TASK_TYPES,
} from "../common/contract.constants";

const uuid = (name: string) => varchar(name, { length: 36 });
const utcDateTime = (name: string) => datetime(name, { mode: "date", fsp: 3 });
const byteCount = (name: string) =>
  bigint(name, { mode: "number", unsigned: true });

/** ZOS 中的真实对象；临时与永久对象都只保存引用和真实 HEAD 元数据。 */
export const mediaObjects = mysqlTable(
  "media_objects",
  {
    id: uuid("id").primaryKey(),
    // ZOS bucket 名最长远小于通用文件名；受控对象 key 仅由前缀、UUID 和扩展名组成。
    // 收紧长度可保证 utf8mb4 下的联合唯一索引不超过 MySQL 3072-byte 上限。
    bucket: varchar("bucket", { length: 63 }).notNull(),
    objectKey: varchar("object_key", { length: 512 }).notNull(),
    publicUrl: varchar("public_url", { length: 2048 }).notNull(),
    mimeType: varchar("mime_type", { length: 255 }).notNull(),
    sizeBytes: byteCount("size_bytes").notNull(),
    storageClass: mysqlEnum("storage_class", ["temporary", "permanent"])
      .notNull()
      .default("temporary"),
    createdAt: utcDateTime("created_at").notNull(),
    updatedAt: utcDateTime("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("media_bucket_key_unique").on(table.bucket, table.objectKey),
    index("media_storage_created_idx").on(table.storageClass, table.createdAt),
  ],
);

/** 上传、入库、编辑、重试和删除共享的任务主表。 */
export const tasks = mysqlTable(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    type: mysqlEnum("type", TASK_TYPES).notNull(),
    status: mysqlEnum("status", TASK_STATUSES).notNull().default("queued"),
    phase: mysqlEnum("phase", TASK_PHASES).notNull().default("processing"),
    userId: varchar("user_id", { length: 191 }),
    callbackUrl: varchar("callback_url", { length: 2048 }),
    autoPublish: boolean("auto_publish").notNull().default(false),
    totalFiles: int("total_files", { unsigned: true }).notNull().default(0),
    doneFiles: int("done_files", { unsigned: true }).notNull().default(0),
    failedFiles: int("failed_files", { unsigned: true }).notNull().default(0),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: text("error_message"),
    errorDetails: json("error_details").$type<Record<string, unknown>[]>(),
    callbackAttempts: int("callback_attempts", { unsigned: true })
      .notNull()
      .default(0),
    nextCallbackAt: utcDateTime("next_callback_at"),
    callbackCompletedAt: utcDateTime("callback_completed_at"),
    createdAt: utcDateTime("created_at").notNull(),
    finishedAt: utcDateTime("finished_at"),
    purgeAt: utcDateTime("purge_at"),
    updatedAt: utcDateTime("updated_at").notNull(),
  },
  (table) => [
    index("tasks_status_created_idx").on(table.status, table.createdAt),
    index("tasks_user_phase_created_idx").on(
      table.userId,
      table.phase,
      table.createdAt,
    ),
    index("tasks_purge_idx").on(table.purgeAt),
  ],
);

/** 父视频只用于关联切片；其原文件始终是24小时 ZOS tmp 对象。 */
export const videoSources = mysqlTable(
  "video_sources",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    userId: varchar("user_id", { length: 191 }),
    sourceObjectId: uuid("source_object_id").references(() => mediaObjects.id, {
      onDelete: "set null",
    }),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    sizeBytes: byteCount("size_bytes").notNull(),
    durationMs: bigint("duration_ms", { mode: "number", unsigned: true }),
    status: mysqlEnum("status", TASK_STATUSES).notNull().default("queued"),
    phase: mysqlEnum("phase", TASK_PHASES).notNull().default("uploading"),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: text("error_message"),
    errorDetails: json("error_details").$type<Record<string, unknown>[]>(),
    createdAt: utcDateTime("created_at").notNull(),
    updatedAt: utcDateTime("updated_at").notNull(),
  },
  (table) => [
    index("video_sources_task_idx").on(table.taskId),
    index("video_sources_user_created_idx").on(table.userId, table.createdAt),
  ],
);

/** files[] 的稳定原文件记录；视频切片通过 assets.task_file_id 反查。 */
export const taskFiles = mysqlTable(
  "task_files",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    ordinal: int("ordinal", { unsigned: true }).notNull(),
    fileId: uuid("file_id"),
    videoSourceId: uuid("video_source_id").references(() => videoSources.id, {
      onDelete: "set null",
    }),
    uploadObjectId: uuid("upload_object_id").references(() => mediaObjects.id, {
      onDelete: "set null",
    }),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    mediaType: mysqlEnum("media_type", MEDIA_TYPES).notNull(),
    sizeBytes: byteCount("size_bytes").notNull().default(0),
    status: mysqlEnum("status", TASK_STATUSES).notNull().default("queued"),
    phase: mysqlEnum("phase", TASK_PHASES).notNull().default("uploading"),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: text("error_message"),
    errorDetails: json("error_details").$type<Record<string, unknown>[]>(),
    createdAt: utcDateTime("created_at").notNull(),
    updatedAt: utcDateTime("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("task_files_task_ordinal_unique").on(table.taskId, table.ordinal),
    index("task_files_file_idx").on(table.fileId),
    index("task_files_video_source_idx").on(table.videoSourceId),
    index("task_files_task_status_idx").on(table.taskId, table.status),
  ],
);

/** 素材库实体：一张图片或一个视频切片，状态只由 status + phase 表达。 */
export const assets = mysqlTable(
  "assets",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    taskFileId: uuid("task_file_id").references(() => taskFiles.id, {
      onDelete: "set null",
    }),
    videoSourceId: uuid("video_source_id").references(() => videoSources.id, {
      onDelete: "set null",
    }),
    mediaObjectId: uuid("media_object_id")
      .notNull()
      .references(() => mediaObjects.id, { onDelete: "restrict" }),
    coverObjectId: uuid("cover_object_id").references(() => mediaObjects.id, {
      onDelete: "restrict",
    }),
    userId: varchar("user_id", { length: 191 }),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    mediaType: mysqlEnum("media_type", MEDIA_TYPES).notNull(),
    description: text("description").notNull(),
    sizeBytes: byteCount("size_bytes").notNull(),
    width: int("width", { unsigned: true }),
    height: int("height", { unsigned: true }),
    durationMs: bigint("duration_ms", { mode: "number", unsigned: true }),
    segmentStartMs: bigint("segment_start_ms", {
      mode: "number",
      unsigned: true,
    }),
    segmentEndMs: bigint("segment_end_ms", {
      mode: "number",
      unsigned: true,
    }),
    segmentOrder: int("segment_order", { unsigned: true }),
    status: mysqlEnum("status", TASK_STATUSES).notNull().default("queued"),
    phase: mysqlEnum("phase", TASK_PHASES).notNull().default("processing"),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: text("error_message"),
    errorDetails: json("error_details").$type<Record<string, unknown>[]>(),
    publicationLeaseToken: uuid("publication_lease_token"),
    publicationLeaseAt: utcDateTime("publication_lease_at"),
    createdAt: utcDateTime("created_at").notNull(),
    updatedAt: utcDateTime("updated_at").notNull(),
  },
  (table) => [
    index("assets_user_phase_created_idx").on(
      table.userId,
      table.phase,
      table.createdAt,
    ),
    index("assets_phase_media_created_idx").on(
      table.phase,
      table.mediaType,
      table.createdAt,
    ),
    index("assets_video_source_idx").on(table.videoSourceId),
    uniqueIndex("assets_video_segment_unique").on(
      table.videoSourceId,
      table.segmentOrder,
    ),
  ],
);

export const analysisResults = mysqlTable("analysis_results", {
  assetId: uuid("asset_id")
    .primaryKey()
    .references(() => assets.id, { onDelete: "cascade" }),
  resultJson: json("result_json").$type<Record<string, unknown>>().notNull(),
  modelProtocol: varchar("model_protocol", { length: 64 }).notNull(),
  modelName: varchar("model_name", { length: 255 }).notNull(),
  completedAt: utcDateTime("completed_at").notNull(),
  indexedAt: utcDateTime("indexed_at"),
  indexError: text("index_error"),
});

/** 对外标签只有 value；normalized_value 用于去重与过滤。 */
export const tags = mysqlTable(
  "tags",
  {
    id: uuid("id").primaryKey(),
    value: varchar("value", { length: 128 }).notNull(),
    normalizedValue: varchar("normalized_value", { length: 128 }).notNull(),
    createdAt: utcDateTime("created_at").notNull(),
  },
  (table) => [uniqueIndex("tags_normalized_unique").on(table.normalizedValue)],
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

/** worker 的持久化作业队列；任务清理不会删除已发布 asset。 */
export const jobs = mysqlTable(
  "jobs",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    // validate/retry 作业可能在 assets 行创建前就携带稳定 file_id，因此这里
    // 不能建立到 assets 的外键；作业生命周期由 task_id 外键统一管理。
    fileId: uuid("file_id"),
    videoSourceId: uuid("video_source_id").references(() => videoSources.id, {
      onDelete: "cascade",
    }),
    type: mysqlEnum("type", [
      "validate",
      "transcode",
      "split",
      "analyze_segment",
      "finalize",
      "embed",
      "publish",
      "update",
      "retry",
      "delete",
      "callback",
      "cleanup",
    ]).notNull(),
    /**
     * 内部编排作业的幂等键。普通业务变更作业保持 null；视频切片与汇总作业
     * 与 embedding 作业使用稳定键，避免 worker 恢复或并发完成时重复入队。
     */
    dedupeKey: varchar("dedupe_key", { length: 191 }),
    status: mysqlEnum("status", ["queued", "running", "done", "failed"])
      .notNull()
      .default("queued"),
    attempts: int("attempts", { unsigned: true }).notNull().default(0),
    payload: json("payload").$type<Record<string, unknown>>(),
    availableAt: utcDateTime("available_at").notNull(),
    lockedAt: utcDateTime("locked_at"),
    errorMessage: text("error_message"),
    finishedAt: utcDateTime("finished_at"),
    createdAt: utcDateTime("created_at").notNull(),
    updatedAt: utcDateTime("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("jobs_dedupe_key_unique").on(table.dedupeKey),
    index("jobs_claim_idx").on(table.status, table.availableAt),
    index("jobs_task_idx").on(table.taskId),
  ],
);
