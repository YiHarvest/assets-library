import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { assets, jobs, tasks } from "@/server/db/schema";
import { ApiV1Error } from "@/server/api/errors";
import type {
  ApiV1Service,
  StagedUpload,
} from "@/server/api/v1/service";
import { loadConfig } from "@/server/config";
import { mediaResponse } from "@/server/media/response";
import {
  acquireTaskItemUploadLease,
  createTaskWithItems,
  getAssetDetail,
  getAssetRecord,
  getTaskWithItems,
  queryAssetsPage,
  sealTaskIfComplete,
  updateTaskItemUploadProgress,
  type AssetScope,
} from "@/server/repositories/assets";
import {
  listPublishedMedia,
  summarizePublishedStorage,
  type PublishedMediaCursor,
} from "@/server/repositories/user-media";
import { thumbnailResponse } from "@/server/media/response";
import { apiV1ErrorCodeSchema } from "@/shared/contracts";
import type {
  AssetAction,
  AssetList,
  ApiTaskPhase,
  ApiTaskStatus,
  ApiV1ErrorCode,
  ApiV1AssetDetail,
  ApiV1AssetSummary,
  AssetSummary,
  AssetQuery,
  AssetQueryResponse,
  AnalysisResult,
  MutationContext,
  ProcessingStatus,
  TaskAccepted,
  TaskStatusResponse,
  UpdateAssetTask,
  UserMediaListResponse,
  UserScope,
  UserStorageUsageResponse,
} from "@/shared/contracts";

function directMediaUrl(
  origin: string,
  assetId: string,
  variant: "media" | "thumbnail",
) {
  const pathname = variant === "thumbnail" ? "/api/v1/thumbnail" : "/api/v1/media";
  const url = new URL(pathname, origin);
  url.searchParams.set("asset_id", assetId);
  return url.toString();
}

function shanghaiIso(value: Date | null) {
  if (!value) return null;
  return new Date(value.getTime() + 8 * 60 * 60 * 1_000)
    .toISOString()
    .replace("Z", "+08:00");
}

function apiStatus(status: string): ApiTaskStatus {
  if (status === "done" || status === "failed" || status === "running") {
    return status;
  }
  return "queued";
}

function apiPhase(phase: string, status: string): ApiTaskPhase {
  const phases = new Set<ApiTaskPhase>([
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
  if (phases.has(phase as ApiTaskPhase)) return phase as ApiTaskPhase;
  if (status === "done" || status === "failed") return "finished";
  if (phase === "sealed") return "validating";
  if (phase === "received") return "waiting_for_seal";
  return "receiving";
}

function publicErrorCode(code: string | null): ApiV1ErrorCode {
  const mapped: Partial<Record<string, ApiV1ErrorCode>> = {
    scene_service_unavailable: "service_unavailable",
    scene_manifest_invalid: "scene_detection_failed",
    scene_segment_download_failed: "scene_detection_failed",
    scene_segment_invalid: "scene_detection_failed",
    scene_segment_too_large: "segment_too_large",
    scene_persistence_failed: "storage_error",
    multiple_files: "invalid_request",
  };
  const normalized = mapped[code ?? ""];
  if (normalized) return normalized;
  const parsed = apiV1ErrorCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : "internal_error";
}

function detailList(value: unknown) {
  const snakeCase = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(snakeCase);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([key, child]) => [
        key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(),
        snakeCase(child),
      ]),
    );
  };

  if (Array.isArray(value)) return snakeCase(value) as unknown[];
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const segments = Array.isArray(record.segments) ? record.segments : null;
  if (!segments) return [snakeCase(record)];
  return segments.map((segment) => {
    if (!segment || typeof segment !== "object") return { value: segment };
    const source = segment as Record<string, unknown>;
    const normalized = snakeCase(source) as Record<string, unknown>;
    const sizeBytes = source.actualBytes ?? source.sizeBytes;
    const limitBytes = source.maximumBytes ?? source.limitBytes;
    delete normalized.actual_bytes;
    delete normalized.maximum_bytes;
    if (sizeBytes !== undefined) normalized.size_bytes = sizeBytes;
    if (limitBytes !== undefined) normalized.limit_bytes = limitBytes;
    return normalized;
  });
}

export function apiTaskErrorPayload(row: {
  errorCode: string | null;
  errorMessage: string | null;
  errorDetails: unknown;
}) {
  if (!row.errorCode && !row.errorMessage) return null;
  const details = detailList(row.errorDetails);
  return {
    code: publicErrorCode(row.errorCode),
    message: row.errorMessage ?? "任务处理失败。",
    ...(details ? { details } : {}),
  } as NonNullable<TaskStatusResponse["error"]>;
}

function progress(received: number, total: number) {
  return total > 0 ? Math.min(100, (received / total) * 100) : 0;
}

async function taskResponse(taskId: string): Promise<TaskStatusResponse> {
  const { task, items } = await getTaskWithItems(taskId);
  const assetRows = items.length
    ? await db
        .select({ id: assets.id, taskItemId: assets.taskItemId })
        .from(assets)
        .where(eq(assets.taskId, taskId))
    : [];
  const assetsByItem = new Map<string, string[]>();
  for (const asset of assetRows) {
    if (!asset.taskItemId) continue;
    const current = assetsByItem.get(asset.taskItemId) ?? [];
    current.push(asset.id);
    assetsByItem.set(asset.taskItemId, current);
  }
  return {
    task_id: task.id,
    task_type: task.type,
    status: apiStatus(task.status),
    phase: apiPhase(task.phase, task.status),
    progress_percent: task.progressPercent,
    total_files: task.totalItems,
    done_files: task.doneItems,
    failed_files: task.failedItems,
    callback_url: task.callbackUrl,
    result: task.result,
    files: items.map((item) => ({
      item_id: item.id,
      filename: item.filename,
      media_type: item.mediaType,
      status: apiStatus(item.status),
      phase: apiPhase(item.phase, item.status),
      received_bytes: item.receivedBytes,
      total_bytes: item.totalBytes,
      progress_percent:
        item.status === "done"
          ? 100
          : progress(item.receivedBytes, item.totalBytes),
      asset_ids: assetsByItem.get(item.id) ?? [],
      error: apiTaskErrorPayload(item),
    })),
    error: apiTaskErrorPayload(task),
    created_at: shanghaiIso(task.createdAt)!,
    started_at: shanghaiIso(task.startedAt),
    finished_at: shanghaiIso(task.finishedAt),
    expires_at: shanghaiIso(task.expiresAt),
  };
}

function accepted(response: TaskStatusResponse): TaskAccepted {
  return {
    task_id: response.task_id,
    task_type: response.task_type,
    status: response.status,
    phase: response.phase,
    progress_percent: response.progress_percent,
    total_files: response.total_files,
    done_files: response.done_files,
    failed_files: response.failed_files,
    files: response.files,
    created_at: response.created_at,
  };
}

function scopeForRepository(scope: UserScope): AssetScope {
  switch (scope.mode) {
    case "user":
      return { userId: scope.user_id };
    case "all":
      return { includeAllUsers: true };
    case "exclude_user":
      return { excludeUserId: scope.user_id };
    default:
      return {};
  }
}

function encodeCursor(page: number) {
  return Buffer.from(JSON.stringify({ page }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null) {
  if (!cursor) return 1;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { page?: unknown };
    if (Number.isInteger(value.page) && Number(value.page) > 0) {
      return Number(value.page);
    }
  } catch {
    // 统一在下面返回公开的请求错误，避免暴露解析细节。
  }
  throw new ApiV1Error("invalid_request", "cursor 无效或已经过期。", 400);
}

/** 用户媒体游标编码 UTC 时间和 UUID，避免新增数据导致 OFFSET 翻页漂移。 */
export function encodeUserMediaCursor(cursor: PublishedMediaCursor) {
  return Buffer.from(
    JSON.stringify({
      created_at: cursor.createdAt.toISOString(),
      asset_id: cursor.assetId,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeUserMediaCursor(
  cursor: string | null,
): PublishedMediaCursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { created_at?: unknown; asset_id?: unknown };
    if (
      typeof value.created_at !== "string" ||
      typeof value.asset_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value.asset_id,
      )
    ) {
      throw new Error("invalid cursor payload");
    }
    const createdAt = new Date(value.created_at);
    if (
      Number.isNaN(createdAt.getTime()) ||
      createdAt.toISOString() !== value.created_at
    ) {
      throw new Error("invalid cursor timestamp");
    }
    return { createdAt, assetId: value.asset_id };
  } catch {
    throw new ApiV1Error("invalid_request", "cursor 无效或已经过期。", 400);
  }
}

function processingStatusesFromApi(statuses: ApiTaskStatus[] | undefined) {
  if (!statuses?.length) return [];
  const mapped = new Set<ProcessingStatus>();
  for (const status of statuses) {
    if (status === "queued") mapped.add("queued");
    if (status === "running") {
      mapped.add("validating");
      mapped.add("analyzing");
    }
    if (status === "done") mapped.add("completed");
    if (status === "failed") mapped.add("failed");
  }
  return [...mapped];
}

function taskStatusFromProcessing(status: string): ApiTaskStatus {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "queued") return "queued";
  return "running";
}

/** 数据库保留模型原始契约；API v1 在边界统一转换为 snake_case。 */
function apiAnalysis(result: AnalysisResult | null) {
  if (!result) return null;
  if (result.kind === "image") {
    return {
      kind: result.kind,
      description: result.description,
      tags: result.tags,
      ocr: {
        text: result.ocr.text,
        unavailable_reason: result.ocr.unavailableReason,
      },
    } as const;
  }
  const timed = (item: {
    startSeconds: number;
    endSeconds: number;
    summary: string;
  }) => ({
    start_seconds: item.startSeconds,
    end_seconds: item.endSeconds,
    summary: item.summary,
  });
  return {
    kind: result.kind,
    description: result.description,
    topics: result.topics,
    tags: result.tags,
    visual_segments: result.visualSegments.map(timed),
    key_moments: result.keyMoments.map((item) => ({
      seconds: item.seconds,
      summary: item.summary,
    })),
    timeline: result.timeline.map(timed),
  } as const;
}

async function assetSummary(asset: AssetSummary) {
  const record = await getAssetRecord(asset.id);
  if (!record) throw new ApiV1Error("not_found", "素材不存在。", 404);
  return {
    asset_id: asset.id,
    parent_video_id: record.videoSourceId,
    segment_index: record.segmentIndex,
    user_id: record.userId,
    name: asset.name,
    description: asset.description,
    media_type: asset.mediaType,
    status: taskStatusFromProcessing(asset.processingStatus),
    review_status: asset.reviewStatus,
    tags: asset.tags,
    media_url: `/api/v1/media?asset_id=${encodeURIComponent(asset.id)}`,
    thumbnail_url:
      asset.mediaType === "video"
        ? `/api/v1/thumbnail?asset_id=${encodeURIComponent(asset.id)}`
        : null,
    created_at: shanghaiIso(record.createdAt)!,
    updated_at: shanghaiIso(record.updatedAt)!,
    ...(asset.searchScore === undefined
      ? {}
      : { search_score: asset.searchScore }),
    ...(asset.semanticScore === undefined
      ? {}
      : { semantic_score: asset.semanticScore }),
  } satisfies ApiV1AssetSummary;
}

async function createMutationTask(
  type: "delete" | "publish" | "update" | "retry",
  assetId: string,
  context: MutationContext,
  payload: Record<string, unknown> = {},
) {
  const id = crypto.randomUUID();
  const now = new Date();
  const phase =
    type === "delete"
      ? "deleting"
      : type === "publish"
        ? "publishing"
        : type === "update"
          ? "updating"
          : "retrying";
  await db.transaction(async (tx) => {
    await tx.insert(tasks).values({
      id,
      type,
      status: "queued",
      phase,
      userId: context.user_id,
      callbackUrl: context.callback_url,
      totalItems: 1,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(jobs).values({
      id: crypto.randomUUID(),
      taskId: id,
      assetId,
      type,
      payload: { ...payload, userId: context.user_id },
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
  return accepted(await taskResponse(id));
}

export class DefaultApiV1Service implements ApiV1Service {
  async submitUpload(input: StagedUpload) {
    let sealed = false;
    try {
      await createTaskWithItems({
        id: input.taskId,
        type: "upload",
        userId: input.user_id,
        callbackUrl: input.callback_url,
        result: { auto_publish: input.auto_publish },
        items: input.files.map((file) => ({
          id: file.id,
          ordinal: file.ordinal,
          filename: file.filename,
          declaredContentType: file.contentType,
          totalBytes: file.sizeBytes,
          stagingPath: file.stagingPath,
        })),
      });
      // 文件已由 multipart parser 原子落盘；这里只借用既有租约状态机登记实收字节。
      for (const file of input.files) {
        await acquireTaskItemUploadLease({
          taskId: input.taskId,
          itemId: file.id,
        });
        await updateTaskItemUploadProgress({
          taskId: input.taskId,
          itemId: file.id,
          receivedBytes: file.sizeBytes,
          completed: true,
        });
      }
      await sealTaskIfComplete(input.taskId);
      sealed = true;
      return taskResponse(input.taskId);
    } catch (error) {
      if (!sealed) {
        // 未成功入队时 staging 不再有消费者；完整回收该任务目录。
        const directory = path.join(
          loadConfig().mediaRoot,
          ".staging",
          input.taskId,
        );
        await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  getTask(taskId: string) {
    return taskResponse(taskId);
  }

  async searchAssets(input: AssetQuery): Promise<AssetQueryResponse> {
    if (input.query && input.cursor) {
      throw new ApiV1Error(
        "invalid_request",
        "语义检索返回单页 top-k 结果，不支持 cursor。",
        400,
      );
    }
    const pageNumber = input.query ? 1 : decodeCursor(input.cursor);
    const scope = scopeForRepository(input.filter.user_scope);
    const result = await queryAssetsPage({
      ...scope,
      page: pageNumber,
      limit: input.limit,
      mediaTypes: input.filter.media_types,
      processingStatuses: processingStatusesFromApi(input.filter.statuses),
      reviewStatuses: input.filter.review_statuses ?? ["published"],
      tags: input.filter.tags,
      keywords: input.keywords,
      semanticQuery: input.query,
      includeTagStatistics: input.include_tag_statistics,
    });
    const mapped = await Promise.all(result.items.map(assetSummary));
    // 语义查询是一个定义明确的 top-k 单页结果，不返回虚假的下一页游标。
    const hasMore = input.query ? false : result.page < result.totalPages;
    return {
      items: mapped,
      next_cursor: hasMore ? encodeCursor(result.page + 1) : null,
      has_more: hasMore,
      tag_statistics: input.include_tag_statistics
        ? (result.tagStatistics ?? null)
        : null,
    };
  }

  async getStorageUsage(
    userId: string | null,
  ): Promise<UserStorageUsageResponse> {
    const summary = await summarizePublishedStorage(userId);
    return {
      user_id: summary.userId,
      total_files: summary.totalFiles,
      image_files: summary.imageFiles,
      video_files: summary.videoFiles,
      total_bytes: summary.totalBytes,
      image_bytes: summary.imageBytes,
      video_bytes: summary.videoBytes,
      items: summary.items.map((item) => ({
        asset_id: item.assetId,
        name: item.name,
        media_type: item.mediaType,
        media_bytes: item.mediaBytes,
        thumbnail_bytes: item.thumbnailBytes,
        total_bytes: item.totalBytes,
      })),
    };
  }

  async listAssets(
    input: AssetList,
    origin: string,
  ): Promise<UserMediaListResponse> {
    const result = await listPublishedMedia(
      input.user_id,
      decodeUserMediaCursor(input.cursor),
      input.limit,
    );
    return {
      user_id: result.userId,
      items: result.items.map((item) => {
        const media_url = directMediaUrl(origin, item.assetId, "media");
        const common = {
          asset_id: item.assetId,
          name: item.name,
          size_bytes: item.mediaBytes,
          media_url,
          created_at: shanghaiIso(item.createdAt)!,
        };
        if (item.mediaType === "image") {
          return { ...common, media_type: "image" as const };
        }
        return {
          ...common,
          media_type: "video" as const,
          thumbnail_bytes: item.thumbnailBytes,
          thumbnail_url: directMediaUrl(origin, item.assetId, "thumbnail"),
        };
      }),
      next_cursor: result.nextCursor
        ? encodeUserMediaCursor(result.nextCursor)
        : null,
      has_more: result.hasMore,
    };
  }

  async getAsset(assetId: string): Promise<ApiV1AssetDetail> {
    const detail = await getAssetDetail(assetId, { includeAllUsers: true });
    const summary = await assetSummary(detail);
    return {
      ...summary,
      original_filename: detail.originalFilename,
      mime_type: detail.mimeType,
      size_bytes: detail.sizeBytes,
      auto_publish: detail.directPublish,
      failure:
        detail.failureCode || detail.failureMessage
          ? {
              code:
                detail.failureCode === "multiple_files"
                  ? "invalid_request"
                  : (detail.failureCode ?? "internal_error"),
              message: detail.failureMessage ?? "素材处理失败。",
            }
          : null,
      analysis: apiAnalysis(detail.analysis),
    };
  }

  updateAsset(input: UpdateAssetTask) {
    return createMutationTask("update", input.asset_id, input, {
      name: input.name,
      description: input.description,
      tags: input.tags,
    });
  }

  actOnAsset(input: AssetAction) {
    return createMutationTask(input.action, input.asset_id, input);
  }

  async getMedia(assetId: string, request: Request) {
    await getAssetDetail(assetId, { includeAllUsers: true });
    return mediaResponse(assetId, request);
  }

  async getThumbnail(assetId: string, request: Request) {
    await getAssetDetail(assetId, { includeAllUsers: true });
    return thumbnailResponse(assetId, request);
  }
}

export const defaultApiV1Service = new DefaultApiV1Service();
