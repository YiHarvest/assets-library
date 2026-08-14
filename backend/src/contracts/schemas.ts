import { z } from "zod";
import {
  ASSET_PHASE_FILTERS,
  MEDIA_TYPES,
  TASK_PHASES,
  TASK_STATUSES,
} from "../common/contract.constants";

export const uuidSchema = z.uuid();
export const nonEmptyUserIdSchema = z.string().trim().min(1).max(191);
export const nullableUserIdSchema = z
  .union([nonEmptyUserIdSchema, z.literal(""), z.null()])
  .optional()
  .transform((value) => (value ? value : null));
export const callbackUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol))
  .optional();
export const mediaTypeSchema = z.enum(MEDIA_TYPES);
export const mediaTypeFilterSchema = z
  .union([mediaTypeSchema, z.literal("all"), z.null()])
  .optional()
  .transform((value) => (value === "all" || value == null ? undefined : value));
export const taskStatusSchema = z.enum(TASK_STATUSES);
export const taskPhaseSchema = z.enum(TASK_PHASES);

const cursorSchema = z.string().min(1).max(2048).nullable().optional();
const limitSchema = z.coerce.number().int().min(1).max(100).default(20);

export const createUploadSchema = z
  .object({
    user_id: nullableUserIdSchema,
    auto_publish: z.boolean().default(false),
    callback_url: callbackUrlSchema,
    files: z
      .array(
        z.object({
          media_type: mediaTypeSchema,
          file_name: z.string().trim().min(1).max(255).optional(),
        }).strict(),
      )
      .min(1)
      .max(9),
  })
  .strict()
  .superRefine(({ files }, context) => {
    const videoCount = files.filter((file) => file.media_type === "video").length;
    if (videoCount > 0 && (videoCount !== 1 || files.length !== 1)) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "只能上传最多9张图片，或恰好1个视频，不能混合。",
      });
    }
  });

export const completeUploadSchema = z
  .object({ task_id: uuidSchema })
  .strict();

const ownershipFields = {
  user_id: nullableUserIdSchema,
  include_all_users: z.boolean().optional(),
  exclude_user_id: nonEmptyUserIdSchema.optional(),
};

function validateOwnership(
  value: { user_id?: string | null; include_all_users?: boolean; exclude_user_id?: string },
  context: z.RefinementCtx,
) {
  const provided = [
    Boolean(value.user_id),
    value.include_all_users === true,
    Boolean(value.exclude_user_id),
  ].filter(Boolean).length;
  if (provided > 1) {
    context.addIssue({
      code: "custom",
      message: "user_id、include_all_users、exclude_user_id 三者互斥。",
    });
  }
}

export const assetListSchema = z
  .object({
    ...ownershipFields,
    phases: z.array(z.enum(ASSET_PHASE_FILTERS)).min(1).max(4).default(["published"]),
    media_type: mediaTypeFilterSchema,
    cursor: cursorSchema,
    limit: limitSchema,
  })
  .strict()
  .superRefine(validateOwnership);

const tagFiltersSchema = z
  .object({
    all: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
    any: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
    exclude: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
  })
  .strict();

export const assetSearchSchema = z
  .object({
    ...ownershipFields,
    description: z.string().trim().min(1).max(1000).optional(),
    tags: tagFiltersSchema.optional(),
    media_type: mediaTypeFilterSchema,
    cursor: cursorSchema,
    limit: limitSchema,
  })
  .strict()
  .superRefine((value, context) => {
    validateOwnership(value, context);
    const tags = value.tags;
    if (
      !value.description &&
      !tags?.all?.length &&
      !tags?.any?.length &&
      !tags?.exclude?.length
    ) {
      context.addIssue({
        code: "custom",
        message: "description 或至少一种标签过滤条件必须提供。",
      });
    }
  });

export const assetDetailQuerySchema = z
  .object({ file_id: uuidSchema })
  .strict();

export const updateAssetSchema = z
  .object({
    file_id: uuidSchema,
    user_id: nonEmptyUserIdSchema,
    file_name: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(10_000).optional(),
    tags: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
    callback_url: callbackUrlSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.file_name !== undefined ||
      value.description !== undefined ||
      value.tags !== undefined,
    "file_name、description、tags 至少提供一项。",
  );

export const publishAssetSchema = z
  .object({
    file_id: uuidSchema,
    user_id: nullableUserIdSchema,
    callback_url: callbackUrlSchema,
  })
  .strict();

export const retryAssetSchema = z
  .object({
    file_id: uuidSchema.optional(),
    video_source_id: uuidSchema.optional(),
    user_id: nullableUserIdSchema,
    callback_url: callbackUrlSchema,
  })
  .strict()
  .refine(
    (value) => Boolean(value.file_id) !== Boolean(value.video_source_id),
    "file_id 与 video_source_id 必须且只能提供一个。",
  );

export const deleteAssetSchema = z
  .object({
    file_id: uuidSchema.optional(),
    video_source_id: uuidSchema.optional(),
    user_id: nullableUserIdSchema,
    callback_url: callbackUrlSchema,
  })
  .strict()
  .refine(
    (value) => Boolean(value.file_id) !== Boolean(value.video_source_id),
    "file_id 与 video_source_id 必须且只能提供一个。",
  );

export const storageUsageSchema = z
  .object({ user_id: nullableUserIdSchema })
  .strict();

export const taskQuerySchema = z
  .object({
    task_id: uuidSchema.optional(),
    view: z.literal("pending").optional(),
    user_id: nullableUserIdSchema,
    cursor: cursorSchema,
    limit: limitSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.task_id) === Boolean(value.view)) {
      context.addIssue({
        code: "custom",
        message: "task_id 与 view=pending 必须且只能提供一种查询模式。",
      });
    }
    if (value.task_id && (value.cursor || value.user_id)) {
      context.addIssue({
        code: "custom",
        message: "单任务查询不能同时提供 user_id 或 cursor。",
      });
    }
  });

export type CreateUploadInput = z.infer<typeof createUploadSchema>;
export type AssetListInput = z.infer<typeof assetListSchema>;
export type AssetSearchInput = z.infer<typeof assetSearchSchema>;
