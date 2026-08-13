import { z } from "zod";

export const mediaTypeSchema = z.enum(["image", "video"]);
export type MediaType = z.infer<typeof mediaTypeSchema>;

export const processingStatusSchema = z.enum([
  "queued",
  "validating",
  "analyzing",
  "completed",
  "failed",
]);
export type ProcessingStatus = z.infer<typeof processingStatusSchema>;

export const reviewStatusSchema = z.enum([
  "pending_review",
  "published",
  "deleted",
]);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const failureCodeSchema = z.enum([
  "invalid_request",
  "multiple_files",
  "unsupported_media_type",
  "file_too_large",
  "corrupt_file",
  "unsupported_video_codec",
  "invalid_video_frames",
  "model_not_configured",
  "model_video_unsupported",
  "video_frames_missing",
  "model_request_failed",
  "model_response_invalid",
  "storage_error",
  "internal_error",
]);
export type FailureCode = z.infer<typeof failureCodeSchema>;

export const tagSchema = z.object({
  category: z.string().trim().min(1).max(64),
  value: z.string().trim().min(1).max(128),
  source: z.enum(["model", "human"]).optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});
export type AssetTag = z.infer<typeof tagSchema>;

const unavailableTextSchema = z.object({
  text: z.string().nullable(),
  unavailableReason: z.string().nullable(),
});

export const imageAnalysisSchema = z.object({
  kind: z.literal("image"),
  description: z.string().min(1),
  tags: z.object({
    scene: z.array(z.string()),
    object: z.array(z.string()),
    person: z.array(z.string()),
    style: z.array(z.string()),
    color_composition: z.array(z.string()),
  }),
  ocr: unavailableTextSchema,
});
export type ImageAnalysis = z.infer<typeof imageAnalysisSchema>;

const timedSummarySchema = z.object({
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().nonnegative(),
  summary: z.string().min(1),
});

export const videoAnalysisSchema = z.object({
  kind: z.literal("video"),
  description: z.string().min(1),
  topics: z.array(z.string()),
  tags: z.object({
    scene: z.array(z.string()),
    person: z.array(z.string()),
    form: z.array(z.string()),
  }),
  visualSegments: z.array(timedSummarySchema),
  keyMoments: z.array(
    z.object({
      seconds: z.number().nonnegative(),
      summary: z.string().min(1),
    }),
  ),
  timeline: z.array(timedSummarySchema),
});
export type VideoAnalysis = z.infer<typeof videoAnalysisSchema>;

export const analysisResultSchema = z.discriminatedUnion("kind", [
  imageAnalysisSchema,
  videoAnalysisSchema,
]);
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

export const assetEditSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(10_000),
  tags: z.array(tagSchema.omit({ source: true, confidence: true })).max(100),
});
export type AssetEdit = z.infer<typeof assetEditSchema>;

export const descriptionSearchSchema = z.object({
  description: z.string().trim().min(1).max(1_000),
  keywords: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
  limit: z.number().int().min(1).max(20).default(5),
});
export type DescriptionSearch = z.infer<typeof descriptionSearchSchema>;

export interface AssetSummary {
  id: string;
  name: string;
  description: string;
  mediaType: MediaType;
  processingStatus: ProcessingStatus;
  reviewStatus: ReviewStatus;
  tags: AssetTag[];
  mediaUrl: string;
  createdAt: string;
  searchScore?: number;
  semanticScore?: number;
}

export interface AssetDetail extends AssetSummary {
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  directPublish: boolean;
  failureCode: FailureCode | null;
  failureMessage: string | null;
  analysis: AnalysisResult | null;
  updatedAt: string;
}

export interface AssetPage {
  items: AssetSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * API v1 对外只暴露四种稳定任务状态。处理步骤通过 phase 单独表达，
 * 避免调用方把新增的内部步骤误认为新的终态。
 */
export const apiTaskStatusSchema = z.enum([
  "queued",
  "running",
  "done",
  "failed",
]);
export type ApiTaskStatus = z.infer<typeof apiTaskStatusSchema>;

export const apiTaskTypeSchema = z.enum([
  "upload",
  "delete",
  "publish",
  "update",
  "retry",
]);
export type ApiTaskType = z.infer<typeof apiTaskTypeSchema>;

export const apiTaskPhaseSchema = z.enum([
  "receiving",
  "waiting_for_seal",
  "validating",
  "splitting",
  "persisting",
  "analyzing",
  "publishing",
  "updating",
  "retrying",
  "deleting",
  "notifying",
  "finished",
]);
export type ApiTaskPhase = z.infer<typeof apiTaskPhaseSchema>;

export const apiV1ErrorCodeSchema = z.enum([
  "invalid_request",
  "forbidden",
  "not_found",
  "conflict",
  "task_not_ready",
  "task_expired",
  "upload_incomplete",
  "upload_size_mismatch",
  "unsupported_media_type",
  "file_too_large",
  "corrupt_file",
  "unsupported_video_codec",
  "invalid_video_frames",
  "scene_detection_failed",
  "segment_too_large",
  "model_not_configured",
  "model_video_unsupported",
  "video_frames_missing",
  "model_request_failed",
  "model_response_invalid",
  "storage_error",
  "database_error",
  "callback_failed",
  "service_unavailable",
  "internal_error",
]);
export type ApiV1ErrorCode = z.infer<typeof apiV1ErrorCodeSchema>;

export const apiErrorDetailSchema = z
  .object({
    item_id: z.string().uuid().optional(),
    segment_index: z.number().int().nonnegative().optional(),
    filename: z.string().optional(),
    size_bytes: z.number().int().nonnegative().optional(),
    limit_bytes: z.number().int().positive().optional(),
  })
  .catchall(z.unknown());
export type ApiErrorDetail = z.infer<typeof apiErrorDetailSchema>;

export const apiV1ErrorSchema = z.object({
  code: apiV1ErrorCodeSchema,
  message: z.string().min(1),
  details: z.array(apiErrorDetailSchema).optional(),
});
export type ApiV1ErrorPayload = z.infer<typeof apiV1ErrorSchema>;

export const apiV1ErrorResponseSchema = z.object({
  error: apiV1ErrorSchema,
  request_id: z.string().uuid(),
});
export type ApiV1ErrorResponse = z.infer<typeof apiV1ErrorResponseSchema>;

export const userIdSchema = z.string().trim().min(1).max(191);

/** 空字符串按公共素材处理，并在进入服务层前统一转换为 null。 */
export const nullableUserIdSchema = z
  .union([userIdSchema, z.literal("").transform(() => null), z.null()])
  .default(null);

export const callbackUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "callback_url 仅支持 HTTP 或 HTTPS。")
  .nullable()
  .default(null);

export const MAX_UPLOAD_IMAGE_FILES = 5;

/** multipart 中除重复 files 外，仅允许这三个业务字段。 */
export const uploadMetadataSchema = z
  .object({
    user_id: nullableUserIdSchema,
    callback_url: callbackUrlSchema,
    auto_publish: z.boolean().default(false),
  })
  .strict();
export type UploadMetadata = z.infer<typeof uploadMetadataSchema>;

export const taskErrorSchema = apiV1ErrorSchema.nullable();

export const taskFileSchema = z.object({
  item_id: z.string().uuid(),
  filename: z.string(),
  media_type: mediaTypeSchema.nullable(),
  status: apiTaskStatusSchema,
  phase: apiTaskPhaseSchema,
  received_bytes: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  progress_percent: z.number().min(0).max(100),
  asset_ids: z.array(z.string().uuid()),
  error: taskErrorSchema,
});
export type TaskFile = z.infer<typeof taskFileSchema>;

const apiDateTimeSchema = z.string().datetime({ offset: true });

export const taskStatusResponseSchema = z.object({
  task_id: z.string().uuid(),
  task_type: apiTaskTypeSchema,
  status: apiTaskStatusSchema,
  phase: apiTaskPhaseSchema,
  progress_percent: z.number().min(0).max(100),
  total_files: z.number().int().nonnegative(),
  done_files: z.number().int().nonnegative(),
  failed_files: z.number().int().nonnegative(),
  callback_url: callbackUrlSchema,
  result: z.record(z.string(), z.unknown()).nullable(),
  files: z.array(taskFileSchema),
  error: taskErrorSchema,
  created_at: apiDateTimeSchema,
  started_at: apiDateTimeSchema.nullable(),
  finished_at: apiDateTimeSchema.nullable(),
  expires_at: apiDateTimeSchema.nullable(),
});
export type TaskStatusResponse = z.infer<typeof taskStatusResponseSchema>;

export const taskAcceptedSchema = taskStatusResponseSchema.pick({
  task_id: true,
  task_type: true,
  status: true,
  phase: true,
  progress_percent: true,
  total_files: true,
  done_files: true,
  failed_files: true,
  files: true,
  created_at: true,
});
export type TaskAccepted = z.infer<typeof taskAcceptedSchema>;

export const userScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("public") }).strict(),
  z.object({ mode: z.literal("user"), user_id: userIdSchema }).strict(),
  z.object({ mode: z.literal("all") }).strict(),
  z
    .object({ mode: z.literal("exclude_user"), user_id: userIdSchema })
    .strict(),
]);
export type UserScope = z.infer<typeof userScopeSchema>;

export const assetQueryFilterSchema = z
  .object({
    user_scope: userScopeSchema.default({ mode: "public" }),
    media_types: z.array(mediaTypeSchema).max(2).optional(),
    statuses: z.array(apiTaskStatusSchema).max(4).optional(),
    review_statuses: z.array(reviewStatusSchema).max(3).optional(),
    tags: z.array(tagSchema.pick({ category: true, value: true })).max(20).optional(),
  })
  .strict();
export type AssetQueryFilter = z.infer<typeof assetQueryFilterSchema>;

export const assetQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(1_000).optional(),
    keywords: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
    filter: assetQueryFilterSchema.default({
      user_scope: { mode: "public" },
    }),
    cursor: z.string().min(1).max(2_048).nullable().default(null),
    limit: z.number().int().min(1).max(100).default(20),
    include_tag_statistics: z.boolean().default(true),
  })
  .strict();
export type AssetQuery = z.infer<typeof assetQuerySchema>;

export const apiV1AssetSummarySchema = z.object({
  asset_id: z.string().uuid(),
  parent_video_id: z.string().uuid().nullable(),
  segment_index: z.number().int().nonnegative().nullable(),
  user_id: userIdSchema.nullable(),
  name: z.string(),
  description: z.string(),
  media_type: mediaTypeSchema,
  status: apiTaskStatusSchema,
  review_status: reviewStatusSchema,
  tags: z.array(tagSchema),
  media_url: z.string(),
  thumbnail_url: z.string().nullable(),
  created_at: apiDateTimeSchema,
  updated_at: apiDateTimeSchema,
  search_score: z.number().optional(),
  semantic_score: z.number().min(0).max(1).optional(),
});
export type ApiV1AssetSummary = z.infer<typeof apiV1AssetSummarySchema>;

export const tagStatisticSchema = z.object({
  category: z.string(),
  value: z.string(),
  asset_count: z.number().int().nonnegative(),
  asset_share: z.number().min(0).max(1),
});

export const tagStatisticsSchema = z.object({
  total_assets: z.number().int().nonnegative(),
  assets_with_tags: z.number().int().nonnegative(),
  assets_without_tags: z.number().int().nonnegative(),
  average_tags_per_asset: z.number().nonnegative(),
  maximum_tags_per_asset: z.number().int().nonnegative(),
  top_tags: z.array(tagStatisticSchema),
  categories: z.array(
    z.object({
      category: z.string(),
      asset_count: z.number().int().nonnegative(),
      asset_share: z.number().min(0).max(1),
    }),
  ),
});
export type TagStatistics = z.infer<typeof tagStatisticsSchema>;

export const assetQueryResponseSchema = z.object({
  items: z.array(apiV1AssetSummarySchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  tag_statistics: tagStatisticsSchema.nullable(),
});
export type AssetQueryResponse = z.infer<typeof assetQueryResponseSchema>;

/** 已发布素材列表只接受归属和分页参数；空 user_id 表示公共素材库。 */
export const assetListSchema = z
  .object({
    user_id: nullableUserIdSchema,
    cursor: z.string().min(1).max(2_048).nullable().default(null),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export type AssetList = z.infer<typeof assetListSchema>;

/** 用户空间统计中的逐素材字节明细。视频的 total_bytes 包含首帧缩略图。 */
export const userStorageUsageItemSchema = z.object({
  asset_id: z.string().uuid(),
  name: z.string(),
  media_type: mediaTypeSchema,
  media_bytes: z.number().int().nonnegative(),
  thumbnail_bytes: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
});
export type UserStorageUsageItem = z.infer<typeof userStorageUsageItemSchema>;

export const userStorageUsageResponseSchema = z.object({
  user_id: userIdSchema.nullable(),
  total_files: z.number().int().nonnegative(),
  image_files: z.number().int().nonnegative(),
  video_files: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  image_bytes: z.number().int().nonnegative(),
  video_bytes: z.number().int().nonnegative(),
  items: z.array(userStorageUsageItemSchema),
});
export type UserStorageUsageResponse = z.infer<typeof userStorageUsageResponseSchema>;

export const storageUsageRequestSchema = z
  .object({ user_id: nullableUserIdSchema })
  .strict();
export type StorageUsageRequest = z.infer<typeof storageUsageRequestSchema>;

const signedUrlSchema = z.string().min(1);

export const userImageMediaItemSchema = z.object({
  asset_id: z.string().uuid(),
  name: z.string(),
  media_type: z.literal("image"),
  size_bytes: z.number().int().nonnegative(),
  media_url: signedUrlSchema,
  created_at: apiDateTimeSchema,
});

export const userVideoMediaItemSchema = z.object({
  asset_id: z.string().uuid(),
  name: z.string(),
  media_type: z.literal("video"),
  size_bytes: z.number().int().nonnegative(),
  thumbnail_bytes: z.number().int().nonnegative(),
  thumbnail_url: signedUrlSchema,
  media_url: signedUrlSchema,
  created_at: apiDateTimeSchema,
});

export const userMediaItemSchema = z.discriminatedUnion("media_type", [
  userImageMediaItemSchema,
  userVideoMediaItemSchema,
]);
export type UserMediaItem = z.infer<typeof userMediaItemSchema>;

export const userMediaListResponseSchema = z.object({
  user_id: userIdSchema.nullable(),
  items: z.array(userMediaItemSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
export type UserMediaListResponse = z.infer<typeof userMediaListResponseSchema>;

export const apiV1AssetDetailSchema = apiV1AssetSummarySchema.extend({
  original_filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().int().nonnegative(),
  auto_publish: z.boolean(),
  failure: taskErrorSchema,
  analysis: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("image"),
        description: z.string(),
        tags: imageAnalysisSchema.shape.tags,
        ocr: z.object({
          text: z.string().nullable(),
          unavailable_reason: z.string().nullable(),
        }),
      }),
      z.object({
        kind: z.literal("video"),
        description: z.string(),
        topics: z.array(z.string()),
        tags: videoAnalysisSchema.shape.tags,
        visual_segments: z.array(
          z.object({
            start_seconds: z.number().nonnegative(),
            end_seconds: z.number().nonnegative(),
            summary: z.string(),
          }),
        ),
        key_moments: z.array(
          z.object({
            seconds: z.number().nonnegative(),
            summary: z.string(),
          }),
        ),
        timeline: z.array(
          z.object({
            start_seconds: z.number().nonnegative(),
            end_seconds: z.number().nonnegative(),
            summary: z.string(),
          }),
        ),
      }),
    ])
    .nullable(),
});
export type ApiV1AssetDetail = z.infer<typeof apiV1AssetDetailSchema>;

export const mutationContextSchema = z
  .object({
    user_id: nullableUserIdSchema,
    callback_url: callbackUrlSchema,
  })
  .strict();
export type MutationContext = z.infer<typeof mutationContextSchema>;

export const updateAssetTaskSchema = mutationContextSchema
  .extend({
    asset_id: z.string().uuid(),
    name: assetEditSchema.shape.name,
    description: assetEditSchema.shape.description,
    tags: assetEditSchema.shape.tags,
  })
  .strict();
export type UpdateAssetTask = z.infer<typeof updateAssetTaskSchema>;

export const assetActionSchema = mutationContextSchema
  .extend({
    asset_id: z.string().uuid(),
    action: z.enum(["publish", "retry", "delete"]),
  })
  .strict();
export type AssetAction = z.infer<typeof assetActionSchema>;
