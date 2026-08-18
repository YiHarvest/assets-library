import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { assets, jobs, tasks } from "@/server/db/schema";
import { ApiV1Error } from "@/server/api/errors";
import type {
  ApiV1Service,
  ReceiveUploadItemInput,
} from "@/server/api/v1/service";
import { loadConfig } from "@/server/config";
import { AppError } from "@/server/errors";
import { mediaResponse } from "@/server/media/response";
import { targetFormatFromFilename } from "@/server/media/target-format";
import { writeAll } from "@/server/storage/object-storage";
import {
  acquireTaskItemUploadLease,
  createTaskWithItems,
  getAssetDetail,
  getAssetRecord,
  getTaskWithItems,
  queryAssetsPage,
  listUserMediaPage,
  releaseTaskItemUploadLease,
  sealTaskIfComplete,
  summarizeUserStorage,
  updateTaskItemUploadProgress,
  type AssetScope,
  type UserMediaCursor,
} from "@/server/repositories/assets";
import { thumbnailResponse } from "@/server/media/response";
import { apiV1ErrorCodeSchema } from "@/shared/contracts";
import type {
  ApiTaskPhase,
  ApiTaskStatus,
  ApiV1ErrorCode,
  ApiV1AssetDetail,
  ApiV1AssetSummary,
  AssetSummary,
  AssetQuery,
  AssetQueryResponse,
  AnalysisResult,
  CreateUploadTask,
  MutationContext,
  ProcessingStatus,
  TaskAccepted,
  TaskStatusResponse,
  UpdateAssetTask,
  UserMediaListQuery,
  UserMediaListResponse,
  UserScope,
  UserStorageUsageResponse,
} from "@/shared/contracts";

const uploadProgressFlushBytes = 4 * 1024 * 1024;

function directMediaUrl(
  origin: string,
  assetId: string,
  userId: string,
  variant: "media" | "thumbnail",
) {
  const suffix = variant === "thumbnail" ? "/thumbnail" : "";
  const url = new URL(`/api/v1/media/${assetId}${suffix}`, origin);
  url.searchParams.set("user_id", userId);
  return url.toString();
}

function taskRetentionMs() {
  return loadConfig().TASK_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
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
    received_bytes: task.receivedBytes,
    total_bytes: task.totalBytes,
    total_items: task.totalItems,
    done_items: task.doneItems,
    failed_items: task.failedItems,
    callback_url: task.callbackUrl,
    result: task.result,
    items: items.map((item) => ({
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
    total_items: response.total_items,
    items: response.items,
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
export function encodeUserMediaCursor(cursor: UserMediaCursor) {
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
): UserMediaCursor | null {
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
  const mediaUrl = record.userId
    ? `${asset.mediaUrl}${asset.mediaUrl.includes("?") ? "&" : "?"}user_id=${encodeURIComponent(record.userId)}`
    : asset.mediaUrl;
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
    media_url: mediaUrl,
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

function stagingRelativePath(taskId: string, itemId: string, filename: string) {
  const target = targetFormatFromFilename(filename);
  if (!target) {
    throw new ApiV1Error(
      "unsupported_media_type",
      "图片仅支持 JPEG、PNG、WebP，视频目标格式仅支持 MP4。",
      415,
    );
  }
  return path.posix.join(".staging", taskId, `${itemId}${target.extension}`);
}

function resolveStagingPath(relativePath: string) {
  const root = loadConfig().mediaRoot;
  const absolute = path.resolve(root, relativePath);
  if (!absolute.startsWith(`${root}${path.sep}`)) {
    throw new ApiV1Error("storage_error", "上传暂存路径无效。", 500);
  }
  return absolute;
}

async function writeUploadBody(
  input: ReceiveUploadItemInput,
  expectedBytes: number,
  destination: string,
) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.uploading`;
  const handle = await fs.open(temporary, "wx");
  let received = 0;
  let lastFlushed = 0;
  try {
    const reader = input.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      received += value.byteLength;
      if (received > expectedBytes) {
        throw new ApiV1Error(
          "upload_size_mismatch",
          "实际上传字节数超过清单声明大小。",
          409,
        );
      }
      await writeAll(handle, value);
      if (received - lastFlushed >= uploadProgressFlushBytes) {
        await updateTaskItemUploadProgress({
          taskId: input.taskId,
          itemId: input.itemId,
          receivedBytes: received,
        });
        lastFlushed = received;
      }
    }
    if (received !== expectedBytes) {
      throw new ApiV1Error(
        "upload_size_mismatch",
        `实际上传 ${received} 字节，与声明的 ${expectedBytes} 字节不一致。`,
        409,
      );
    }
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, destination);
    return received;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function normalizeUploadRepositoryError(error: unknown) {
  if (!(error instanceof AppError)) return error;
  if (error.status === 404) {
    return new ApiV1Error("not_found", error.message, 404);
  }
  if (error.status === 409) {
    return new ApiV1Error("conflict", error.message, 409);
  }
  return new ApiV1Error("invalid_request", error.message, error.status);
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
      expiresAt: new Date(now.getTime() + taskRetentionMs()),
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
  async createUploadTask(input: CreateUploadTask) {
    const config = loadConfig();
    if (input.items.length > config.UPLOAD_MAX_ITEMS) {
      throw new ApiV1Error(
        "file_too_large",
        `每个上传任务最多包含 ${config.UPLOAD_MAX_ITEMS} 个文件。`,
        413,
      );
    }
    const totalBytes = input.items.reduce(
      (total, item) => total + item.size_bytes,
      0,
    );
    if (totalBytes > config.UPLOAD_MAX_TOTAL_BYTES) {
      throw new ApiV1Error(
        "file_too_large",
        `上传任务总大小不得超过 ${config.UPLOAD_MAX_TOTAL_BYTES} 字节。`,
        413,
        [{ size_bytes: totalBytes, limit_bytes: config.UPLOAD_MAX_TOTAL_BYTES }],
      );
    }
    const taskId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + taskRetentionMs());
    const manifests = input.items.map((item, ordinal) => {
      const id = crypto.randomUUID();
      return {
        id,
        ordinal,
        filename: item.filename,
        declaredContentType: item.content_type,
        totalBytes: item.size_bytes,
        stagingPath: stagingRelativePath(taskId, id, item.filename),
      };
    });
    await createTaskWithItems({
      id: taskId,
      type: "upload",
      userId: input.user_id,
      callbackUrl: input.callback_url,
      expiresAt,
      result: { auto_publish: input.auto_publish },
      items: manifests,
    });
    return taskResponse(taskId);
  }

  async receiveUploadItem(input: ReceiveUploadItemInput) {
    let leaseAcquired = false;
    let destination: string | undefined;
    try {
      const lease = await acquireTaskItemUploadLease({
        taskId: input.taskId,
        itemId: input.itemId,
      });
      if (lease.state === "already_complete") {
        return taskResponse(input.taskId);
      }
      leaseAcquired = true;
      const { item } = lease;
      if (input.contentLength !== null && input.contentLength !== item.totalBytes) {
        throw new ApiV1Error(
          "upload_size_mismatch",
          "Content-Length 与上传清单声明大小不一致。",
          409,
        );
      }

      destination = resolveStagingPath(item.stagingPath);
      // 只有持有行级租约的请求才能替换目标文件。
      await fs.rm(destination, { force: true });
      const received = await writeUploadBody(input, item.totalBytes, destination);
      await updateTaskItemUploadProgress({
        taskId: input.taskId,
        itemId: input.itemId,
        receivedBytes: received,
        completed: true,
      });
      leaseAcquired = false;
      return taskResponse(input.taskId);
    } catch (error) {
      if (leaseAcquired) {
        // 先确认租约仍有效，再删文件；如完成事务已提交，则不误删成品。
        const released = await releaseTaskItemUploadLease({
          taskId: input.taskId,
          itemId: input.itemId,
        }).catch(() => false);
        if (released && destination) {
          await fs.rm(destination, { force: true }).catch(() => undefined);
        }
      }
      throw normalizeUploadRepositoryError(error);
    }
  }

  async sealUploadTask(taskId: string) {
    await sealTaskIfComplete(taskId);
    return taskResponse(taskId);
  }

  getTask(taskId: string) {
    return taskResponse(taskId);
  }

  async queryAssets(input: AssetQuery): Promise<AssetQueryResponse> {
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

  async getUserStorageUsage(
    userId: string,
  ): Promise<UserStorageUsageResponse> {
    const summary = await summarizeUserStorage(userId);
    const imageFiles = summary.items.filter(
      (item) => item.mediaType === "image",
    ).length;
    return {
      user_id: summary.userId,
      total_files: summary.totalFiles,
      image_files: imageFiles,
      video_files: summary.totalFiles - imageFiles,
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

  async listUserMedia(
    userId: string,
    input: UserMediaListQuery,
    origin: string,
  ): Promise<UserMediaListResponse> {
    const result = await listUserMediaPage(
      userId,
      decodeUserMediaCursor(input.cursor),
      input.limit,
    );
    return {
      user_id: userId,
      items: result.items.map((item) => {
        const media_url = directMediaUrl(
          origin,
          item.assetId,
          userId,
          "media",
        );
        const common = {
          asset_id: item.assetId,
          name: item.name,
          size_bytes: item.sizeBytes,
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
          thumbnail_url: directMediaUrl(
            origin,
            item.assetId,
            userId,
            "thumbnail",
          ),
        };
      }),
      next_cursor: result.nextCursor
        ? encodeUserMediaCursor(result.nextCursor)
        : null,
      has_more: result.hasMore,
    };
  }

  async getAsset(assetId: string, scope: UserScope): Promise<ApiV1AssetDetail> {
    const detail = await getAssetDetail(assetId, scopeForRepository(scope));
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

  updateAsset(assetId: string, input: UpdateAssetTask) {
    return createMutationTask("update", assetId, input, {
      name: input.name,
      description: input.description,
      tags: input.tags,
    });
  }

  publishAsset(assetId: string, input: MutationContext) {
    return createMutationTask("publish", assetId, input);
  }

  retryAsset(assetId: string, input: MutationContext) {
    return createMutationTask("retry", assetId, input);
  }

  deleteAsset(assetId: string, input: MutationContext) {
    return createMutationTask("delete", assetId, input);
  }

  async getMedia(assetId: string, scope: UserScope, request: Request) {
    await getAssetDetail(assetId, scopeForRepository(scope));
    return mediaResponse(assetId, request);
  }

  async getThumbnail(assetId: string, scope: UserScope, request: Request) {
    await getAssetDetail(assetId, scopeForRepository(scope));
    return thumbnailResponse(assetId, request);
  }
}

export const defaultApiV1Service = new DefaultApiV1Service();
