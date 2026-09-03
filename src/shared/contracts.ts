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
    scene: z.array(z.string()).max(5),
    object: z.array(z.string()).max(5),
    person: z.array(z.string()).max(5),
    style: z.array(z.string()).max(5),
    color_composition: z.array(z.string()).max(5),
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
    scene: z.array(z.string()).max(5),
    person: z.array(z.string()).max(5),
    form: z.array(z.string()).max(5),
  }),
  visualSegments: z.array(timedSummarySchema).max(5),
  keyMoments: z.array(
    z.object({
      seconds: z.number().nonnegative(),
      summary: z.string().min(1),
    }),
  ).max(3),
  timeline: z.array(timedSummarySchema).max(5),
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
  keywordScore?: number;
  semanticScore?: number;
  matchType?: "exact" | "alias" | "prefix" | "contains" | "typo" | "semantic" | "hybrid";
  matchedTerms?: string[];
  matchedCategories?: string[];
}

export interface AssetDetail extends AssetSummary {
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  failureCode: FailureCode | null;
  failureMessage: string | null;
  analysis: AnalysisResult | null;
  segmentStartMs: number | null;
  segmentEndMs: number | null;
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
  "match",
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
  "matching",
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

const compatibilityAsrWordSchema = z
  .object({
    text: z.string(),
    begin_time: z.number().int().nonnegative(),
    end_time: z.number().int().nonnegative(),
    punctuation: z.string().optional(),
  })
  .refine((word) => word.end_time >= word.begin_time, {
    message: "ASR 词语的 end_time 不得早于 begin_time。",
  })
  .passthrough();

const compatibilityAsrSentenceSchema = z
  .object({
    text: z.string(),
    words: z.array(compatibilityAsrWordSchema).min(1).max(10_000),
    begin_time: z.number().int().nonnegative().optional(),
    end_time: z.number().int().nonnegative().optional(),
    sentence_id: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const compatibilityLlmSegmentSchema = z
  .object({
    segment_id: z.number().int().positive(),
    text: z.string().trim().min(1).max(10_000),
    high_light_word: z.string().max(1_000).optional(),
    keyword: z.string().max(1_000).optional(),
    level: z.number().int().nonnegative(),
    group_id: z.tuple([z.number(), z.number()]).optional(),
    start_time: z.number().optional(),
    end_time: z.number().optional(),
  })
  .passthrough();

const compatibilityLlmPayloadSchema = z
  .object({
    segments: z.array(compatibilityLlmSegmentSchema).min(1).max(500),
  })
  .passthrough();

const compatibilityLlmSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}, compatibilityLlmPayloadSchema);

const compatibilityAssetUrlSchema = z.union([
  z.string().url(),
  z
    .object({
      file_url: z.string().url(),
      type: z.string(),
    })
    .passthrough(),
]);

/** 旧剪辑业务的分段匹配请求；兼容 ASR 对齐和 LLM 已带时间轴两种格式。 */
export const compatibilityMatchRequestSchema = z
  .object({
    asr: z
      .object({
        transcripts: z
          .array(
            z
              .object({
                sentences: z
                  .array(compatibilityAsrSentenceSchema)
                  .min(1)
                  .max(10_000),
              })
              .passthrough(),
          )
          .min(1)
          .max(20)
          .optional(),
      })
      .passthrough(),
    llm: compatibilityLlmSchema,
    text: z.string().max(1_000_000).optional(),
    asset_url_list: z
      .array(compatibilityAssetUrlSchema)
      .max(10_000)
      .default([]),
    callback_url: z
      .string()
      .url()
      .max(2_048)
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
        message: "callback_url 仅支持 HTTP 或 HTTPS。",
      }),
  })
  .passthrough();
export type CompatibilityMatchRequest = z.infer<
  typeof compatibilityMatchRequestSchema
>;

export const compatibilityMatchAcceptedSchema = z.object({
  taskId: z.string().uuid(),
  status: z.literal("processing"),
});
export type CompatibilityMatchAccepted = z.infer<
  typeof compatibilityMatchAcceptedSchema
>;

export const MAX_UPLOAD_TASK_ITEMS = 100;
export const MAX_UPLOAD_TASK_BYTES = 2 * 1024 * 1024 * 1024;

export const uploadManifestItemSchema = z
  .object({
    filename: z.string().trim().min(1).max(255),
    size_bytes: z.number().int().positive().max(MAX_UPLOAD_TASK_BYTES),
    content_type: z.string().trim().min(1).max(255).nullable().default(null),
  })
  .strict();
export type UploadManifestItem = z.infer<typeof uploadManifestItemSchema>;

export const createUploadTaskSchema = z
  .object({
    user_id: nullableUserIdSchema,
    callback_url: callbackUrlSchema,
    items: z
      .array(uploadManifestItemSchema)
      .min(1)
      .max(MAX_UPLOAD_TASK_ITEMS),
  })
  .strict()
  .superRefine((input, context) => {
    const totalBytes = input.items.reduce(
      (total, item) => total + item.size_bytes,
      0,
    );
    if (totalBytes > MAX_UPLOAD_TASK_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "单个上传任务的文件总大小不得超过 2 GiB。",
      });
    }
  });
export type CreateUploadTask = z.infer<typeof createUploadTaskSchema>;

export const taskErrorSchema = apiV1ErrorSchema.nullable();

export const uploadTaskItemSchema = z.object({
  item_id: z.string().uuid(),
  filename: z.string(),
  media_type: mediaTypeSchema.nullable(),
  status: apiTaskStatusSchema,
  phase: apiTaskPhaseSchema,
  received_bytes: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  progress_percent: z.number().min(0).max(100),
  private_asset_ids: z.array(z.string().uuid()),
  public_asset_ids: z.array(z.string().uuid()),
  error: taskErrorSchema,
});
export type UploadTaskItem = z.infer<typeof uploadTaskItemSchema>;

const apiDateTimeSchema = z.string().datetime({ offset: true });

export const taskStatusResponseSchema = z.object({
  task_id: z.string().uuid(),
  task_type: apiTaskTypeSchema,
  status: apiTaskStatusSchema,
  phase: apiTaskPhaseSchema,
  progress_percent: z.number().min(0).max(100),
  received_bytes: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  total_items: z.number().int().nonnegative(),
  done_items: z.number().int().nonnegative(),
  failed_items: z.number().int().nonnegative(),
  callback_url: callbackUrlSchema,
  result: z.record(z.string(), z.unknown()).nullable(),
  items: z.array(uploadTaskItemSchema),
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
  total_items: true,
  items: true,
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
  created_at: apiDateTimeSchema,
  updated_at: apiDateTimeSchema,
  search_score: z.number().min(0).max(1).optional(),
  keyword_score: z.number().min(0).max(1).optional(),
  semantic_score: z.number().min(0).max(1).optional(),
  match_type: z
    .enum(["exact", "alias", "prefix", "contains", "typo", "semantic", "hybrid"])
    .optional(),
  matched_terms: z.array(z.string()).optional(),
  matched_categories: z.array(z.string()).optional(),
});
export type ApiV1AssetSummary = z.infer<typeof apiV1AssetSummarySchema>;

export const assetSearchModeSchema = z.enum(["keyword", "semantic", "hybrid"]);
export type AssetSearchMode = z.infer<typeof assetSearchModeSchema>;

export const assetSearchReasonSchema = z.enum([
  "matched",
  "no_candidates",
  "below_threshold",
  "semantic_unavailable",
  "fallback_exhausted",
]);
export type AssetSearchReason = z.infer<typeof assetSearchReasonSchema>;

export const assetSearchMetaSchema = z.object({
  mode: assetSearchModeSchema,
  threshold: z.number().min(0).max(1),
  max_score: z.number().min(0).max(1).nullable(),
  reason: assetSearchReasonSchema,
  message: z.string().nullable(),
});
export type AssetSearchMeta = z.infer<typeof assetSearchMetaSchema>;

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
  search: assetSearchMetaSchema.nullable(),
});
export type AssetQueryResponse = z.infer<typeof assetQueryResponseSchema>;

/** 受页面锁保护的管理界面用户目录。 */
export const userDirectoryEntrySchema = z.object({
  user_id: userIdSchema,
  display_name: z.string().nullable(),
  email: z.string().nullable(),
  department: z.string().nullable(),
  first_seen_at: apiDateTimeSchema,
  last_seen_at: apiDateTimeSchema,
  asset_count: z.number().int().nonnegative(),
});
export type UserDirectoryEntry = z.infer<typeof userDirectoryEntrySchema>;

export const userDirectoryResponseSchema = z.object({
  items: z.array(userDirectoryEntrySchema),
});
export type UserDirectoryResponse = z.infer<typeof userDirectoryResponseSchema>;

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
  user_id: userIdSchema,
  total_files: z.number().int().nonnegative(),
  image_files: z.number().int().nonnegative(),
  video_files: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  image_bytes: z.number().int().nonnegative(),
  video_bytes: z.number().int().nonnegative(),
  items: z.array(userStorageUsageItemSchema),
});
export type UserStorageUsageResponse = z.infer<typeof userStorageUsageResponseSchema>;

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

export const userMediaListQuerySchema = z.object({
  cursor: z.string().min(1).max(2_048).nullable().default(null),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type UserMediaListQuery = z.infer<typeof userMediaListQuerySchema>;

export const userMediaListResponseSchema = z.object({
  user_id: userIdSchema,
  items: z.array(userMediaItemSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
export type UserMediaListResponse = z.infer<typeof userMediaListResponseSchema>;

export const apiV1AssetDetailSchema = apiV1AssetSummarySchema.extend({
  original_filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().int().nonnegative(),
  segment_start_seconds: z.number().nonnegative().nullable(),
  segment_end_seconds: z.number().nonnegative().nullable(),
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
    name: assetEditSchema.shape.name,
    description: assetEditSchema.shape.description,
    tags: assetEditSchema.shape.tags,
  })
  .strict();
export type UpdateAssetTask = z.infer<typeof updateAssetTaskSchema>;
