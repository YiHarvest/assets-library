import crypto from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { MySqlRawQueryResult } from "drizzle-orm/mysql2";
import { alias } from "drizzle-orm/mysql-core";
import { db } from "@/server/db";
import {
  analysisResultEntries as analysisResults,
  assetEntries as assets,
  assetTagEntries as assetTags,
  assetTagRejections as assetTagRejectionRecords,
  assetTags as assetTagRecords,
  jobs,
  mediaObjects,
  privateAssets,
  publicAssets,
  tags,
  taskItems,
  tasks,
  users,
} from "@/server/db/schema";
import { AppError } from "@/server/errors";
import {
  canClaimAnalyzeTask,
  DEFAULT_ANALYZE_TASK_SOFT_LIMIT,
} from "@/server/jobs/scheduling";
import { searchAnalysis, semanticSearchEnabled } from "@/server/search/chroma";
import {
  DEFAULT_BUSINESS_ALIASES,
  DEFAULT_RELEVANCE_THRESHOLDS,
  hybridRelevanceScore,
  isBroadAiQuery,
  normalizeSearchText,
  normalizeSemanticText,
  scoreKeywordRelevance,
  selectBroadQueryRecallTier,
  tokenizeKeywordQuery,
  type KeywordRelevance,
  type LexicalMatchType,
  type SearchableTag,
} from "@/server/search/relevance";
import { apiV1Path } from "@/lib/paths";
import {
  analysisResultSchema,
  type AssetDetail,
  type AssetEdit,
  type AssetPage,
  type AssetSearchMeta,
  type AssetSummary,
  type AssetTag,
  type DescriptionSearch,
  type FailureCode,
  type MediaType,
  type ProcessingStatus,
  type ReviewStatus,
  type TagStatistics,
} from "@/shared/contracts";

function affectedRows(result: MySqlRawQueryResult) {
  return result[0].affectedRows;
}

export type AssetKind = "public" | "private";
export interface AssetRef {
  kind: AssetKind;
  id: string;
}

export function assetRef(assetId: string, userId?: string | null): AssetRef {
  return { kind: userId?.trim() ? "private" : "public", id: assetId };
}

export function jobTarget(ref: AssetRef) {
  return ref.kind === "private"
    ? { privateAssetId: ref.id }
    : { publicAssetId: ref.id };
}

export function associationTarget(ref: AssetRef) {
  return ref.kind === "private"
    ? { privateAssetId: ref.id, publicAssetId: null }
    : { publicAssetId: ref.id, privateAssetId: null };
}

export interface TaskItemManifest {
  id: string;
  ordinal: number;
  filename: string;
  declaredContentType?: string | null;
  totalBytes: number;
  stagingPath: string;
}

export interface CreateTaskManifest {
  id: string;
  type: "upload" | "delete" | "publish" | "update" | "retry";
  userId?: string | null;
  callbackUrl?: string | null;
  expiresAt?: Date | null;
  result?: Record<string, unknown> | null;
  items?: TaskItemManifest[];
}

export interface CreateMutationTaskInput {
  id?: string;
  type: "delete" | "publish" | "update" | "retry";
  assetId: string;
  userId?: string | null;
  callbackUrl?: string | null;
  expiresAt?: Date | null;
  payload?: Record<string, unknown>;
}

/** 创建修改类任务和对应 durable job，供异步 API 共用。 */
export async function createMutationTask(input: CreateMutationTaskInput) {
  const taskId = input.id ?? crypto.randomUUID();
  const now = new Date();
  const userId = input.userId?.trim() || null;
  const target: AssetRef =
    input.type === "publish"
      ? { kind: "public", id: input.assetId }
      : assetRef(input.assetId, userId);
  const phase =
    input.type === "delete"
      ? "deleting"
      : input.type === "publish"
        ? "publishing"
        : input.type === "update"
          ? "updating"
          : "retrying";
  await db.transaction(async (tx) => {
    if (input.type === "publish") {
      const [privateAsset] = await tx
        .select({ id: privateAssets.id })
        .from(privateAssets)
        .where(eq(privateAssets.id, input.assetId))
        .limit(1);
      if (privateAsset) {
        throw new AppError("invalid_request", "私人素材无需审核。", 409);
      }
      const [publicAsset] = await tx
        .select({ id: publicAssets.id })
        .from(publicAssets)
        .where(eq(publicAssets.id, input.assetId))
        .limit(1);
      if (!publicAsset) {
        throw new AppError("invalid_request", "素材不存在。", 404);
      }
    }
    if (userId) {
      await tx
        .insert(users)
        .values({
          userId,
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onDuplicateKeyUpdate({
          set: { lastSeenAt: now, updatedAt: now },
        });
    }
    await tx.insert(tasks).values({
      id: taskId,
      type: input.type,
      status: "queued",
      phase,
      userId,
      callbackUrl: input.callbackUrl?.trim() || null,
      totalItems: 1,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(jobs).values({
      id: crypto.randomUUID(),
      taskId,
      ...jobTarget(target),
      type: input.type,
      phase,
      payload: input.payload ?? null,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
  return getTaskWithItems(taskId);
}

/** 在一个事务中创建异步任务及文件清单。 */
export async function createTaskWithItems(manifest: CreateTaskManifest) {
  const now = new Date();
  const userId = manifest.userId?.trim() || null;
  const items = manifest.items ?? [];
  const totalBytes = items.reduce((sum, item) => sum + item.totalBytes, 0);
  await db.transaction(async (tx) => {
    if (userId) {
      await tx
        .insert(users)
        .values({
          userId,
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onDuplicateKeyUpdate({
          set: { lastSeenAt: now, updatedAt: now },
        });
    }
    await tx.insert(tasks).values({
      id: manifest.id,
      type: manifest.type,
      phase: manifest.type === "upload" ? "receiving" : "queued",
      userId,
      callbackUrl: manifest.callbackUrl?.trim() || null,
      totalBytes,
      totalItems: items.length,
      expiresAt: manifest.expiresAt ?? null,
      result: manifest.result ?? null,
      createdAt: now,
      updatedAt: now,
    });
    if (items.length) {
      await tx.insert(taskItems).values(
        items.map((item) => ({
          id: item.id,
          taskId: manifest.id,
          ordinal: item.ordinal,
          filename: item.filename,
          declaredContentType: item.declaredContentType ?? null,
          stagingPath: item.stagingPath,
          totalBytes: item.totalBytes,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
  });
  return getTaskWithItems(manifest.id);
}

/** 读取任务和逐文件进度；不存在时统一返回 404。 */
export async function getTaskWithItems(taskId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) throw new AppError("invalid_request", "任务不存在。", 404);
  const items = await db
    .select()
    .from(taskItems)
    .where(eq(taskItems.taskId, taskId))
    .orderBy(asc(taskItems.ordinal));
  return { task, items };
}

/** 查询任务逐文件对应的素材 ID，供 API 展示层组装任务快照。 */
export async function listTaskItemAssetIds(taskId: string) {
  return db
    .select({
      id: assets.id,
      taskItemId: assets.taskItemId,
      kind: assets.kind,
      segmentIndex: assets.segmentIndex,
    })
    .from(assets)
    .where(eq(assets.taskId, taskId))
    .orderBy(asc(assets.segmentIndex), asc(assets.id));
}

export interface ListUserTaskIdsOptions {
  statuses?: Array<"queued" | "running" | "done" | "failed">;
  types?: Array<
    "upload" | "delete" | "publish" | "update" | "retry" | "match"
  >;
  before?: { createdAt: Date; id: string };
  limit: number;
}

/** MCP 恢复现场使用的用户任务索引；详情仍统一经 TaskService 组装。 */
export async function listUserTaskIds(
  userId: string,
  options: ListUserTaskIdsOptions,
) {
  const conditions: SQL[] = [eq(tasks.userId, userId)];
  if (options.statuses?.length) {
    conditions.push(inArray(tasks.status, options.statuses));
  }
  if (options.types?.length) {
    conditions.push(inArray(tasks.type, options.types));
  }
  if (options.before) {
    conditions.push(
      or(
        lt(tasks.createdAt, options.before.createdAt),
        and(
          eq(tasks.createdAt, options.before.createdAt),
          lt(tasks.id, options.before.id),
        ),
      )!,
    );
  }
  return db
    .select({ id: tasks.id, createdAt: tasks.createdAt })
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(options.limit);
}

/**
 * 为一次 PUT 原子地获取文件上传租约。
 *
 * 任务行始终先于文件行加锁，与封存流程保持相同的锁顺序。这样同一
 * item 的并发 PUT 只有一个能将 phase 切换为 uploading，封存也不会从
 * 正在写入的请求下面越过。
 */
export async function acquireTaskItemUploadLease(input: {
  taskId: string;
  itemId: string;
}) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .for("update")
      .limit(1);
    if (!task || task.type !== "upload") {
      throw new AppError("invalid_request", "上传任务不存在。", 404);
    }
    if (
      task.status !== "queued" ||
      !["receiving", "waiting_for_seal"].includes(task.phase)
    ) {
      throw new AppError("invalid_request", "上传任务已经封存。", 409);
    }

    const [item] = await tx
      .select()
      .from(taskItems)
      .where(
        and(eq(taskItems.id, input.itemId), eq(taskItems.taskId, input.taskId)),
      )
      .for("update")
      .limit(1);
    if (!item) throw new AppError("invalid_request", "上传文件不存在。", 404);
    if (
      item.phase === "waiting_for_seal" &&
      item.receivedBytes === item.totalBytes
    ) {
      return { state: "already_complete" as const, item };
    }
    if (item.phase === "uploading") {
      throw new AppError("invalid_request", "该文件正在上传，请勿并发重复提交。", 409);
    }
    if (item.phase !== "receiving" || item.status !== "queued") {
      throw new AppError("invalid_request", "该文件当前不能接收上传内容。", 409);
    }

    // 新的 PUT 始终从 0 开始，不把上一次中断的字节误当成断点续传。
    const taskReceivedBytes = Math.max(
      0,
      task.receivedBytes - item.receivedBytes,
    );
    await tx
      .update(taskItems)
      .set({
        receivedBytes: 0,
        status: "running",
        phase: "uploading",
        errorCode: null,
        errorMessage: null,
        errorDetails: null,
        updatedAt: now,
      })
      .where(eq(taskItems.id, input.itemId));
    await tx
      .update(tasks)
      .set({
        receivedBytes: taskReceivedBytes,
        progressPercent:
          task.totalBytes > 0
            ? Math.min(100, (taskReceivedBytes / task.totalBytes) * 100)
            : 0,
        phase: "receiving",
        updatedAt: now,
      })
      .where(eq(tasks.id, input.taskId));

    return {
      state: "acquired" as const,
      item: {
        ...item,
        receivedBytes: 0,
        status: "running" as const,
        phase: "uploading",
        updatedAt: now,
      },
    };
  });
}

/**
 * 释放中断的 PUT 租约并把进度归零，使客户端可以从头完整重试。
 * 若文件已完成或任务已封存，则不做回滚，避免模糊的数据库响应
 * 把已成功上传的文件删除。
 */
export async function releaseTaskItemUploadLease(input: {
  taskId: string;
  itemId: string;
}) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .for("update")
      .limit(1);
    if (!task || task.type !== "upload") return false;
    const [item] = await tx
      .select()
      .from(taskItems)
      .where(
        and(eq(taskItems.id, input.itemId), eq(taskItems.taskId, input.taskId)),
      )
      .for("update")
      .limit(1);
    if (!item || item.phase !== "uploading") return false;

    const taskReceivedBytes = Math.max(
      0,
      task.receivedBytes - item.receivedBytes,
    );
    await tx
      .update(taskItems)
      .set({
        receivedBytes: 0,
        status: "queued",
        phase: "receiving",
        updatedAt: now,
      })
      .where(eq(taskItems.id, input.itemId));
    await tx
      .update(tasks)
      .set({
        receivedBytes: taskReceivedBytes,
        progressPercent:
          task.totalBytes > 0
            ? Math.min(100, (taskReceivedBytes / task.totalBytes) * 100)
            : 0,
        phase: "receiving",
        updatedAt: now,
      })
      .where(eq(tasks.id, input.taskId));
    return true;
  });
}

/**
 * 更新持有租约的单文件流式接收进度。receivedBytes 只允许单调递增；
 * 完成更新与 seal 共用任务行锁，不会在封存后把状态改回接收中。
 */
export async function updateTaskItemUploadProgress(input: {
  taskId: string;
  itemId: string;
  receivedBytes: number;
  completed?: boolean;
}) {
  const now = new Date();
  await db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .for("update")
      .limit(1);
    if (
      !task ||
      task.type !== "upload" ||
      task.status !== "queued" ||
      task.phase !== "receiving"
    ) {
      throw new AppError("invalid_request", "上传任务已经封存或不存在。", 409);
    }
    const [item] = await tx
      .select()
      .from(taskItems)
      .where(
        and(eq(taskItems.id, input.itemId), eq(taskItems.taskId, input.taskId)),
      )
      .for("update")
      .limit(1);
    if (!item) throw new AppError("invalid_request", "上传文件不存在。", 404);
    if (item.phase !== "uploading" || item.status !== "running") {
      throw new AppError("invalid_request", "上传租约已失效。", 409);
    }
    if (input.receivedBytes < item.receivedBytes) {
      throw new AppError("invalid_request", "上传进度不能倒退。", 409);
    }
    if (input.receivedBytes > item.totalBytes) {
      throw new AppError("invalid_request", "接收字节数超过文件声明大小。", 409);
    }
    if (input.completed && input.receivedBytes !== item.totalBytes) {
      throw new AppError("invalid_request", "文件尚未完整接收，不能标记为上传完成。", 409);
    }
    await tx
      .update(taskItems)
      .set({
        receivedBytes: input.receivedBytes,
        status: input.completed ? "queued" : "running",
        phase: input.completed ? "waiting_for_seal" : "uploading",
        updatedAt: now,
      })
      .where(eq(taskItems.id, input.itemId));

    const receivedBytes = Math.max(
      0,
      task.receivedBytes - item.receivedBytes + input.receivedBytes,
    );
    const doneItems = task.doneItems + (input.completed ? 1 : 0);
    await tx
      .update(tasks)
      .set({
        receivedBytes,
        doneItems,
        progressPercent:
          task.totalBytes > 0
            ? Math.min(100, (receivedBytes / task.totalBytes) * 100)
            : 0,
        phase:
          doneItems === task.totalItems
            ? "waiting_for_seal"
            : "receiving",
        updatedAt: now,
      })
      .where(eq(tasks.id, input.taskId));
  });
  return getTaskWithItems(input.taskId);
}

/**
 * 封存已完整接收的上传任务，并为每个文件创建校验作业。
 * 封存后不再接受字节流；具体图片/视频流水线由 worker 根据 media type 分派。
 */
export async function sealTaskIfComplete(taskId: string) {
  const now = new Date();
  await db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .for("update")
      .limit(1);
    if (!task || task.type !== "upload") {
      throw new AppError("invalid_request", "上传任务不存在。", 404);
    }
    if (task.status !== "queued" || task.phase === "sealed") {
      throw new AppError("invalid_request", "上传任务已经封存。", 409);
    }
    const items = await tx
      .select()
      .from(taskItems)
      .where(eq(taskItems.taskId, taskId))
      .orderBy(asc(taskItems.ordinal))
      .for("update");
    if (
      items.length === 0 ||
      items.some(
        (item) =>
          item.phase !== "waiting_for_seal" ||
          item.receivedBytes !== item.totalBytes,
      )
    ) {
      throw new AppError("invalid_request", "仍有文件未完整上传。", 409);
    }
    await tx
      .update(tasks)
      .set({
        status: "running",
        phase: "validating",
        startedAt: task.startedAt ?? now,
        progressPercent: 0,
        doneItems: 0,
        updatedAt: now,
      })
      .where(eq(tasks.id, taskId));
    await tx
      .update(taskItems)
      .set({ status: "queued", phase: "validating", updatedAt: now })
      .where(eq(taskItems.taskId, taskId));
    await tx.insert(jobs).values(
      items.map((item) => ({
        id: crypto.randomUUID(),
        taskId,
        type: "validate" as const,
        payload: { taskItemId: item.id },
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      })),
    );
  });
  return getTaskWithItems(taskId);
}

export interface CreateAssetInput {
  assetId: string;
  taskId?: string | null;
  taskItemId?: string | null;
  taskItemSegmentId?: string | null;
  videoSourceId?: string | null;
  mediaObjectId?: string | null;
  segmentIndex?: number | null;
  segmentStartMs?: number | null;
  segmentEndMs?: number | null;
  userId?: string | null;
  name: string;
  originalFilename: string;
  originalPath: string;
  mimeType: string;
  mediaType: "image" | "video";
  sizeBytes: number;
  enqueueAnalysis?: boolean;
}

/** 创建素材及分析作业。父视频不得调用此函数，只为图片或已校验的视频切片建档。 */
export async function createAsset(input: CreateAssetInput) {
  const now = new Date();
  const ref = assetRef(input.assetId, input.userId);
  const values = {
    id: input.assetId,
    taskId: input.taskId ?? null,
    taskItemId: input.taskItemId ?? null,
    taskItemSegmentId: input.taskItemSegmentId ?? null,
    videoSourceId: input.videoSourceId ?? null,
    mediaObjectId: input.mediaObjectId ?? null,
    segmentIndex: input.segmentIndex ?? null,
    segmentStartMs: input.segmentStartMs ?? null,
    segmentEndMs: input.segmentEndMs ?? null,
    name: input.name,
    description: "",
    mediaType: input.mediaType,
    originalFilename: input.originalFilename,
    originalPath: input.originalPath,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    createdAt: now,
    updatedAt: now,
  };
  await db.transaction(async (tx) => {
    if (ref.kind === "private") {
      await tx.insert(privateAssets).values({
        ...values,
        userId: input.userId!.trim(),
      });
    } else {
      await tx.insert(publicAssets).values(values);
    }
    if (input.enqueueAnalysis !== false) {
      await tx.insert(jobs).values({
        id: crypto.randomUUID(),
        taskId: input.taskId ?? null,
        ...jobTarget(ref),
        type: "analyze",
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
  });
  return getAssetDetail(input.assetId, { includeAllUsers: true });
}

async function getTagsForAssets(assetIds: string[]) {
  if (!assetIds.length) return new Map<string, AssetTag[]>();
  const rows = await db
    .select({
      assetId: assetTags.assetId,
      category: tags.category,
      value: tags.value,
      source: assetTags.source,
      confidence: assetTags.confidence,
    })
    .from(assetTags)
    .innerJoin(tags, eq(assetTags.tagId, tags.id))
    .where(inArray(assetTags.assetId, assetIds))
    .orderBy(asc(tags.category), asc(tags.value));
  const result = new Map<string, AssetTag[]>();
  for (const row of rows) {
    const current = result.get(row.assetId) ?? [];
    current.push({
      category: row.category,
      value: row.value,
      source: row.source,
      confidence: row.confidence,
    });
    result.set(row.assetId, current);
  }
  return result;
}

function summaryFromRow(
  row: typeof assets.$inferSelect,
  tagList: AssetTag[],
): AssetSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    mediaType: row.mediaType,
    processingStatus: row.processingStatus,
    reviewStatus: row.reviewStatus,
    tags: tagList,
    mediaUrl: `${apiV1Path(`/media/${row.id}`)}?v=${row.updatedAt.getTime()}`,
    createdAt: row.createdAt.toISOString(),
  };
}

export type AssetOverviewView = "pending" | "published";

export interface AssetScope {
  userId?: string | null;
  excludeUserId?: string;
  includeAllUsers?: boolean;
}

export interface ListAssetsOptions extends AssetScope {
  page?: number;
  limit?: number;
  view?: AssetOverviewView;
  tagQuery?: string;
}

export interface ExactTagFilter {
  category: string;
  value: string;
}

/**
 * API v1 素材查询的数据库参数。
 *
 * 所有字段都会在 count 与分页之前生效；tags 和 keywords 都采用 AND 语义。
 */
export interface QueryAssetsOptions extends AssetScope {
  page?: number;
  limit?: number;
  mediaTypes?: MediaType[];
  processingStatuses?: ProcessingStatus[];
  reviewStatuses?: ReviewStatus[];
  tags?: ExactTagFilter[];
  keywords?: string[];
  semanticQuery?: string;
  includeTagStatistics?: boolean;
}

export interface AssetQueryPage extends AssetPage {
  tagStatistics?: TagStatistics;
  search?: AssetSearchMeta | null;
}

export interface UserStorageItem {
  assetId: string;
  name: string;
  mediaType: MediaType;
  mediaBytes: number;
  thumbnailBytes: number;
  totalBytes: number;
}

export interface UserStorageSummary {
  userId: string;
  totalFiles: number;
  totalBytes: number;
  imageBytes: number;
  videoBytes: number;
  items: UserStorageItem[];
}

/** 用户媒体列表的稳定游标；时间始终表示数据库中的 UTC 时刻。 */
export interface UserMediaCursor {
  createdAt: Date;
  assetId: string;
}

export interface UserMediaPage {
  items: Array<{
    assetId: string;
    name: string;
    mediaType: MediaType;
    sizeBytes: number;
    thumbnailBytes: number;
    createdAt: Date;
  }>;
  hasMore: boolean;
  nextCursor: UserMediaCursor | null;
}

const mainMediaObjects = alias(mediaObjects, "usage_main_media_objects");
const thumbnailMediaObjects = alias(
  mediaObjects,
  "usage_thumbnail_media_objects",
);

function scopeCondition(scope: AssetScope): SQL | undefined {
  if (scope.includeAllUsers) return undefined;
  if (scope.excludeUserId) {
    return and(
      eq(assets.kind, "public"),
      or(
        isNull(assets.uploaderUserId),
        ne(assets.uploaderUserId, scope.excludeUserId),
      ),
    );
  }
  const userId = scope.userId?.trim();
  return userId
    ? and(eq(assets.kind, "private"), eq(assets.userId, userId))
    : eq(assets.kind, "public");
}

function rowMatchesScope(
  row: Pick<typeof assets.$inferSelect, "kind" | "userId" | "uploaderUserId">,
  scope: AssetScope,
) {
  if (scope.includeAllUsers) return true;
  if (scope.excludeUserId) {
    return row.kind === "public" && row.uploaderUserId !== scope.excludeUserId;
  }
  const userId = scope.userId?.trim();
  return userId
    ? row.kind === "private" && row.userId === userId
    : row.kind === "public";
}

function normalizedUsageUserId(userId: string) {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new AppError("invalid_request", "user_id 不能为空。", 400);
  }
  return normalizedUserId;
}

function userStorageConditions(userId: string) {
  return and(
    eq(assets.kind, "private"),
    // MySQL 默认排序规则可能不区分大小写；BINARY 保证 user_id 真正精确匹配。
    sql<boolean>`BINARY ${assets.userId} = BINARY ${userId}`,
    isNull(assets.deletedAt),
  );
}

function mediaBytesSql() {
  return sql<number>`coalesce(${mainMediaObjects.sizeBytes}, 0)`;
}

function thumbnailBytesSql() {
  return sql<number>`case when ${assets.mediaType} = 'video' then coalesce(${thumbnailMediaObjects.sizeBytes}, 0) else 0 end`;
}

function totalAssetBytesSql() {
  return sql<number>`(${mediaBytesSql()} + ${thumbnailBytesSql()})`;
}

function userStorageItemSelection() {
  return {
    assetId: assets.id,
    name: assets.name,
    mediaType: assets.mediaType,
    mediaBytes: mediaBytesSql().mapWith(Number),
    thumbnailBytes: thumbnailBytesSql().mapWith(Number),
    totalBytes: totalAssetBytesSql().mapWith(Number),
  };
}

/**
 * 汇总单个用户当前持有的素材空间用量。
 *
 * 计费边界严格落在未删除的私有素材行：图片计入主媒体对象，视频计入分镜
 * 素材自身的媒体对象及其持久化首帧。完整父视频属于 video_sources，不在本查询
 * 的连接边界内，因此不会重复计费。
 */
export async function summarizeUserStorage(
  userId: string,
): Promise<UserStorageSummary> {
  const normalizedUserId = normalizedUsageUserId(userId);
  const conditions = userStorageConditions(normalizedUserId);

  return db.transaction(async (tx) => {
    const [totals] = await tx
      .select({
        totalFiles: sql<number>`count(*)`.mapWith(Number),
        totalBytes:
          sql<number>`coalesce(sum(${totalAssetBytesSql()}), 0)`.mapWith(Number),
        imageBytes:
          sql<number>`coalesce(sum(case when ${assets.mediaType} = 'image' then ${mediaBytesSql()} else 0 end), 0)`.mapWith(
            Number,
          ),
        videoBytes:
          sql<number>`coalesce(sum(case when ${assets.mediaType} = 'video' then ${totalAssetBytesSql()} else 0 end), 0)`.mapWith(
            Number,
          ),
      })
      .from(assets)
      .leftJoin(
        mainMediaObjects,
        and(
          eq(assets.mediaObjectId, mainMediaObjects.id),
          eq(mainMediaObjects.status, "persisted"),
        ),
      )
      .leftJoin(
        thumbnailMediaObjects,
        and(
          eq(assets.thumbnailMediaObjectId, thumbnailMediaObjects.id),
          eq(thumbnailMediaObjects.status, "persisted"),
        ),
      )
      .where(conditions);
    const items = await tx
      .select(userStorageItemSelection())
      .from(assets)
      .leftJoin(
        mainMediaObjects,
        and(
          eq(assets.mediaObjectId, mainMediaObjects.id),
          eq(mainMediaObjects.status, "persisted"),
        ),
      )
      .leftJoin(
        thumbnailMediaObjects,
        and(
          eq(assets.thumbnailMediaObjectId, thumbnailMediaObjects.id),
          eq(thumbnailMediaObjects.status, "persisted"),
        ),
      )
      .where(conditions)
      .orderBy(desc(assets.createdAt), desc(assets.id));

    return {
      userId: normalizedUserId,
      totalFiles: totals?.totalFiles ?? 0,
      totalBytes: totals?.totalBytes ?? 0,
      imageBytes: totals?.imageBytes ?? 0,
      videoBytes: totals?.videoBytes ?? 0,
      items,
    };
  });
}

/** 按同一精确 user_id 与计费边界分页列出用户素材。 */
export async function listUserMediaPage(
  userId: string,
  cursor: UserMediaCursor | null = null,
  pageSize = 20,
): Promise<UserMediaPage> {
  const normalizedUserId = normalizedUsageUserId(userId);
  const safePageSize = Math.min(
    Math.max(Number.isInteger(pageSize) ? pageSize : 20, 1),
    100,
  );
  const cursorCondition = cursor
    ? or(
        lt(assets.createdAt, cursor.createdAt),
        and(
          eq(assets.createdAt, cursor.createdAt),
          lt(assets.id, cursor.assetId),
        ),
      )
    : undefined;
  const rows = await db
    .select({
      assetId: assets.id,
      name: assets.name,
      mediaType: assets.mediaType,
      sizeBytes: mediaBytesSql().mapWith(Number),
      thumbnailBytes: thumbnailBytesSql().mapWith(Number),
      createdAt: assets.createdAt,
    })
    .from(assets)
    .leftJoin(
      mainMediaObjects,
      and(
        eq(assets.mediaObjectId, mainMediaObjects.id),
        eq(mainMediaObjects.status, "persisted"),
      ),
    )
    .leftJoin(
      thumbnailMediaObjects,
      and(
        eq(assets.thumbnailMediaObjectId, thumbnailMediaObjects.id),
        eq(thumbnailMediaObjects.status, "persisted"),
      ),
    )
    .where(and(userStorageConditions(normalizedUserId), cursorCondition))
    .orderBy(desc(assets.createdAt), desc(assets.id))
    // 多取一行即可判断下一页，避免 OFFSET 和额外 count(*) 扫描。
    .limit(safePageSize + 1);
  const hasMore = rows.length > safePageSize;
  const items = hasMore ? rows.slice(0, safePageSize) : rows;
  const lastItem = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && lastItem
        ? { createdAt: lastItem.createdAt, assetId: lastItem.assetId }
        : null,
  };
}

export interface RegisteredUserUsage {
  userId: string;
  displayName: string | null;
  email: string | null;
  department: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  assetCount: number;
}

/**
 * 以 users 注册表为准列出用户资料及当前有效素材数。
 * LEFT JOIN 保留还没有素材的用户，避免 MCP list_users 漏掉已注册身份。
 */
export async function listRegisteredUsers(): Promise<RegisteredUserUsage[]> {
  return db
    .select({
      userId: users.userId,
      displayName: users.displayName,
      email: users.email,
      department: users.department,
      firstSeenAt: users.firstSeenAt,
      lastSeenAt: users.lastSeenAt,
      assetCount: sql<number>`count(${assets.id})`.mapWith(Number),
    })
    .from(users)
    .leftJoin(
      assets,
      and(
        eq(assets.kind, "private"),
        eq(assets.userId, users.userId),
        isNull(assets.deletedAt),
      ),
    )
    .groupBy(
      users.userId,
      users.displayName,
      users.email,
      users.department,
      users.firstSeenAt,
      users.lastSeenAt,
    )
    .orderBy(desc(sql`count(${assets.id})`), asc(users.userId));
}

function intersectAssetIdSets(sets: ReadonlyArray<ReadonlySet<string>>) {
  if (!sets.length) return undefined;
  const [first, ...rest] = sets;
  return new Set(
    [...(first ?? [])].filter((assetId) =>
      rest.every((matches) => matches.has(assetId)),
    ),
  );
}

/** 精确标签过滤按 category + 规范化 value 匹配，多标签必须全部命中。 */
async function assetIdsMatchingExactTags(filters: ExactTagFilter[]) {
  const uniqueFilters = [
    ...new Map(
      filters.map((filter) => [
        `${filter.category}\u0000${normalizeTag(filter.value)}`,
        {
          category: filter.category,
          normalizedValue: normalizeTag(filter.value),
        },
      ]),
    ).values(),
  ];
  if (!uniqueFilters.length) return undefined;
  const matches = await Promise.all(
    uniqueFilters.map(async (filter) => {
      const rows = await db
        .select({ assetId: assetTags.assetId })
        .from(assetTags)
        .innerJoin(tags, eq(assetTags.tagId, tags.id))
        .where(
          and(
            eq(tags.category, filter.category),
            eq(tags.normalizedValue, filter.normalizedValue),
          ),
        );
      return new Set(rows.map((row) => row.assetId));
    }),
  );
  return intersectAssetIdSets(matches);
}

function processingCondition(statuses: ProcessingStatus[]) {
  if (!statuses.length) return undefined;
  return inArray(assets.processingStatus, statuses);
}

function emptyTagStatistics(): TagStatistics {
  return {
    total_assets: 0,
    assets_with_tags: 0,
    assets_without_tags: 0,
    average_tags_per_asset: 0,
    maximum_tags_per_asset: 0,
    top_tags: [],
    categories: [],
  };
}

/** 仅加载过滤结果的 ID 与标签，避免为统计读取素材描述等大字段。 */
async function tagStatisticsForAssetIds(assetIds: string[]): Promise<TagStatistics> {
  if (!assetIds.length) return emptyTagStatistics();
  const rows = await db
    .select({
      assetId: assetTags.assetId,
      category: tags.category,
      value: tags.value,
    })
    .from(assetTags)
    .innerJoin(tags, eq(assetTags.tagId, tags.id))
    .where(inArray(assetTags.assetId, assetIds));
  const taggedAssets = new Set<string>();
  const tagsPerAsset = new Map<string, number>();
  const tagCounts = new Map<
    string,
    { category: string; value: string; count: number }
  >();
  const categoryAssets = new Map<string, Set<string>>();
  for (const row of rows) {
    taggedAssets.add(row.assetId);
    tagsPerAsset.set(row.assetId, (tagsPerAsset.get(row.assetId) ?? 0) + 1);
    const tagKey = `${row.category}\u0000${row.value}`;
    const tag = tagCounts.get(tagKey) ?? {
      category: row.category,
      value: row.value,
      count: 0,
    };
    tag.count += 1;
    tagCounts.set(tagKey, tag);
    const ids = categoryAssets.get(row.category) ?? new Set<string>();
    ids.add(row.assetId);
    categoryAssets.set(row.category, ids);
  }
  const totalAssets = assetIds.length;
  const totalTags = rows.length;
  return {
    total_assets: totalAssets,
    assets_with_tags: taggedAssets.size,
    assets_without_tags: totalAssets - taggedAssets.size,
    average_tags_per_asset: totalAssets ? totalTags / totalAssets : 0,
    maximum_tags_per_asset: Math.max(0, ...tagsPerAsset.values()),
    top_tags: [...tagCounts.values()]
      .sort(
        (left, right) =>
          right.count - left.count ||
          left.category.localeCompare(right.category) ||
          left.value.localeCompare(right.value),
      )
      .slice(0, 20)
      .map((tag) => ({
        category: tag.category,
        value: tag.value,
        asset_count: tag.count,
        asset_share: tag.count / totalAssets,
      })),
    categories: [...categoryAssets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, ids]) => ({
        category,
        asset_count: ids.size,
        asset_share: ids.size / totalAssets,
      })),
  };
}

interface RankedAssetMatch {
  finalScore: number;
  keywordScore?: number;
  semanticScore?: number;
  matchType: LexicalMatchType | "semantic" | "hybrid";
  matchedTerms: string[];
  matchedCategories: string[];
}

interface KeywordMatches {
  assetIds?: Set<string>;
  scores?: Map<string, RankedAssetMatch>;
  threshold?: number;
  maxScore?: number | null;
  reason?: "matched" | "no_candidates" | "fallback_exhausted";
  broadQuery?: boolean;
  semanticText?: string;
}

function searchMetadata(
  mode: AssetSearchMeta["mode"],
  threshold: number,
  maxScore: number | null,
  reason: AssetSearchMeta["reason"],
): AssetSearchMeta {
  const formattedMaximum = maxScore === null ? null : maxScore.toFixed(3);
  const message =
    reason === "matched"
      ? null
      : reason === "semantic_unavailable"
        ? "语义搜索暂不可用，请稍后重试。"
        : reason === "below_threshold"
          ? `找到候选素材，但最高匹配分为 ${formattedMaximum ?? "0.000"}，未超过展示阈值 ${threshold.toFixed(3)}。`
          : reason === "fallback_exhausted"
            ? "强匹配和错别字兜底都没有找到超过展示阈值的素材。"
            : "没有召回任何候选素材。";
  return { mode, threshold, max_score: maxScore, reason, message };
}

function emptyAssetQueryPage(
  pageSize: number,
  includeTagStatistics: boolean,
  search: AssetSearchMeta | null,
) {
  return {
    items: [],
    page: 1,
    pageSize,
    total: 0,
    totalPages: 1,
    ...(includeTagStatistics ? { tagStatistics: emptyTagStatistics() } : {}),
    search,
  } satisfies AssetQueryPage;
}

function rankedKeywordMatch(
  relevance: KeywordRelevance,
): RankedAssetMatch {
  const evidence = [...relevance.evidence].sort(
    (left, right) => right.score - left.score,
  );
  return {
    finalScore: relevance.score,
    keywordScore: relevance.score,
    matchType: evidence.some((item) => item.matchType === "typo")
      ? "typo"
      : (evidence[0]?.matchType ?? "exact"),
    matchedTerms: relevance.matchedTokens,
    matchedCategories: [
      ...new Set(evidence.map((item) => item.category)),
    ],
  };
}

function qualifiedMatches(
  scores: Map<string, RankedAssetMatch>,
  threshold: number,
) {
  return new Map(
    [...scores].filter(([, match]) => match.finalScore > threshold),
  );
}

async function assetIdsMatchingKeywords(
  keywords: string[],
  baseConditions: readonly SQL[] = [],
): Promise<KeywordMatches> {
  const tokens = [
    ...new Set(keywords.flatMap((keyword) => tokenizeKeywordQuery(keyword))),
  ];
  if (!tokens.length) {
    return { assetIds: undefined, scores: undefined };
  }
  const tagRows = await db
    .select({
      assetId: assetTags.assetId,
      category: tags.category,
      normalizedValue: tags.normalizedValue,
    })
    .from(assetTags)
    .innerJoin(tags, eq(assetTags.tagId, tags.id))
    .innerJoin(assets, eq(assetTags.assetId, assets.id))
    // 必须先限定用户/状态等基础范围，再判断是否启用 typo 兜底；其他作用域的
    // exact 命中不能阻止当前作用域中的错别字候选被召回。
    .where(and(...baseConditions));

  const tagsByAsset = new Map<string, SearchableTag[]>();
  for (const row of tagRows) {
    const current = tagsByAsset.get(row.assetId) ?? [];
    current.push({ category: row.category, value: row.normalizedValue });
    tagsByAsset.set(row.assetId, current);
  }

  const scoringQuery = keywords.length === 1 ? keywords[0]! : tokens;
  const scoreAll = (allowTypo: boolean) => {
    const scores = new Map<string, RankedAssetMatch>();
    for (const [assetId, assetTagsForSearch] of tagsByAsset) {
      const relevance = scoreKeywordRelevance(scoringQuery, assetTagsForSearch, {
        allowTypo,
      });
      if (relevance.score > 0) {
        scores.set(assetId, rankedKeywordMatch(relevance));
      }
    }
    return scores;
  };

  const strongScores = scoreAll(false);
  const strongMatches = qualifiedMatches(
    strongScores,
    DEFAULT_RELEVANCE_THRESHOLDS.strongKeyword,
  );
  const queryText = keywords.join(" ");
  const shared = {
    broadQuery: isBroadAiQuery(tokens),
    semanticText: isBroadAiQuery(tokens)
      ? DEFAULT_BUSINESS_ALIASES[0]?.join(" ")
      : normalizeSemanticText(queryText),
  };
  if (strongMatches.size) {
    return {
      assetIds: new Set(strongMatches.keys()),
      scores: strongMatches,
      threshold: DEFAULT_RELEVANCE_THRESHOLDS.strongKeyword,
      maxScore: Math.max(...[...strongScores.values()].map((item) => item.finalScore)),
      reason: "matched",
      ...shared,
    };
  }

  const fallbackScores = scoreAll(true);
  const typoScores = new Map(
    [...fallbackScores].filter(([, match]) => match.matchType === "typo"),
  );
  const fallbackMatches = qualifiedMatches(
    typoScores,
    DEFAULT_RELEVANCE_THRESHOLDS.typoFallback,
  );
  const allFallbackScores = [...typoScores.values()].map(
    (item) => item.finalScore,
  );
  return {
    assetIds: new Set(fallbackMatches.keys()),
    scores: fallbackMatches,
    threshold: DEFAULT_RELEVANCE_THRESHOLDS.typoFallback,
    maxScore: allFallbackScores.length ? Math.max(...allFallbackScores) : null,
    reason: fallbackMatches.size
      ? "matched"
      : tagRows.length
        ? "fallback_exhausted"
        : "no_candidates",
    ...shared,
  };
}

/**
 * API v1 统一素材查询。
 *
 * 普通浏览先在 MySQL 完成全部过滤和 count，再执行分页。语义检索也先用同一组
 * MySQL 条件生成候选 ID，确保 Chroma 不会召回越权或不符合筛选条件的素材。
 * 语义检索当前定义为单页 top-k，因此不在这里伪造后续页。
 */
export async function queryAssetsPage({
  page = 1,
  limit = 20,
  mediaTypes = [],
  processingStatuses = [],
  reviewStatuses = ["published"],
  tags: exactTags = [],
  keywords = [],
  semanticQuery,
  includeTagStatistics = false,
  ...scope
}: QueryAssetsOptions = {}): Promise<AssetQueryPage> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const requestedPage = Number.isInteger(page) && page > 0 ? page : 1;
  const conditions: SQL[] = [isNull(assets.deletedAt)];
  const ownership = scopeCondition(scope);
  if (ownership) conditions.push(ownership);
  if (mediaTypes.length) conditions.push(inArray(assets.mediaType, mediaTypes));
  const processing = processingCondition(processingStatuses);
  if (processing) conditions.push(processing);
  if (reviewStatuses.length) {
    conditions.push(inArray(assets.reviewStatus, reviewStatuses));
  }
  // 关键词精确匹配和标签
  const [exactTagIds, initialKeywordMatches] = await Promise.all([
    assetIdsMatchingExactTags(exactTags),
    assetIdsMatchingKeywords(keywords, conditions),
  ]);
  let keywordMatches = initialKeywordMatches;
  const candidateSets = [exactTagIds, keywordMatches.assetIds].filter(
    (value): value is Set<string> => value !== undefined,
  );
  let candidateIds = intersectAssetIdSets(candidateSets);
  if (candidateIds && candidateIds.size === 0) {
    const mode = semanticQuery?.trim() ? "semantic" : "keyword";
    const threshold = semanticQuery?.trim()
      ? DEFAULT_RELEVANCE_THRESHOLDS.semantic
      : (keywordMatches.threshold ??
        DEFAULT_RELEVANCE_THRESHOLDS.strongKeyword);
    return emptyAssetQueryPage(
      safeLimit,
      includeTagStatistics,
      searchMetadata(
        mode,
        threshold,
        keywordMatches.maxScore ?? null,
        mode === "keyword"
          ? (keywordMatches.reason ?? "no_candidates")
          : "no_candidates",
      ),
    );
  }

  let keywordSearchMeta = keywordMatches.threshold
    ? searchMetadata(
        "keyword",
        keywordMatches.threshold,
        keywordMatches.maxScore ?? null,
        keywordMatches.reason ?? "matched",
      )
    : null;

  if (
    !semanticQuery?.trim() &&
    keywordMatches.broadQuery &&
    keywordMatches.scores &&
    candidateIds
  ) {
    const broadWhere = and(...conditions, inArray(assets.id, [...candidateIds]));
    const eligibleRows = await db
      .select({ id: assets.id })
      .from(assets)
      .where(broadWhere)
      .orderBy(desc(assets.createdAt), desc(assets.id));
    const eligibleIds = eligibleRows.map((row) => row.id);
    if (!eligibleIds.length) {
      return emptyAssetQueryPage(
        safeLimit,
        includeTagStatistics,
        searchMetadata(
          "hybrid",
          DEFAULT_RELEVANCE_THRESHOLDS.hybrid,
          null,
          "no_candidates",
        ),
      );
    }
    let semanticScores: Map<string, number> | undefined;
    if (semanticSearchEnabled()) {
      try {
        semanticScores = await searchAnalysis(
          keywordMatches.semanticText ?? keywords.join(" "),
          Math.min(800, Math.max(safeLimit * 8, eligibleIds.length * 5)),
          eligibleIds,
          { minimumSimilarity: 0 },
        );
      } catch (error) {
        console.error(
          "Broad keyword semantic rerank unavailable; using lexical fallback.",
          error,
        );
      }
    }

    const broadCandidates = eligibleIds.flatMap((assetId) => {
      const lexical = keywordMatches.scores?.get(assetId);
      return lexical
        ? [{
            assetId,
            lexicalScore: lexical.keywordScore ?? lexical.finalScore,
            semanticScore: semanticScores?.get(assetId),
          }]
        : [];
    });
    const tier = selectBroadQueryRecallTier(
      broadCandidates,
      DEFAULT_RELEVANCE_THRESHOLDS.semantic,
      broadCandidates.length,
    );
    const lexicalFallbackIds = selectBroadQueryRecallTier(
      broadCandidates,
      1,
      broadCandidates.length,
    ).assetIds;

    const applyLexicalFallback = () => {
      const fallbackScores = new Map<string, RankedAssetMatch>();
      for (const assetId of lexicalFallbackIds) {
        const lexical = keywordMatches.scores?.get(assetId);
        if (!lexical) continue;
        fallbackScores.set(assetId, {
          ...lexical,
          ...(semanticScores?.has(assetId)
            ? { semanticScore: semanticScores.get(assetId) }
            : {}),
        });
      }
      candidateIds = new Set(fallbackScores.keys());
      const lexicalScores = [...fallbackScores.values()].map(
        (match) => match.finalScore,
      );
      const maxScore = lexicalScores.length
        ? Math.max(...lexicalScores)
        : null;
      keywordMatches = {
        ...keywordMatches,
        assetIds: candidateIds,
        scores: fallbackScores,
        threshold: DEFAULT_RELEVANCE_THRESHOLDS.strongKeyword,
        maxScore,
        reason: fallbackScores.size ? "matched" : "fallback_exhausted",
      };
      keywordSearchMeta = searchMetadata(
        "keyword",
        DEFAULT_RELEVANCE_THRESHOLDS.strongKeyword,
        maxScore,
        fallbackScores.size ? "matched" : "fallback_exhausted",
      );
    };

    if (!tier.useSemanticRerank) {
      // exact/alias 是强证据：语义缺失或整体偏低时返回全部强命中，
      // 不能把 AI=1 惩罚成 0.4，也不能再人为截断为前三项。
      applyLexicalFallback();
    } else {
      const hybridScores = new Map<string, RankedAssetMatch>();
      for (const assetId of tier.assetIds) {
        const lexical = keywordMatches.scores.get(assetId);
        const semanticScore = semanticScores?.get(assetId);
        if (!lexical || semanticScore === undefined) continue;
        hybridScores.set(assetId, {
          ...lexical,
          finalScore: hybridRelevanceScore(
            lexical.keywordScore,
            semanticScore,
          ),
          semanticScore,
          matchType: "hybrid",
        });
      }
      const qualified = qualifiedMatches(
        hybridScores,
        DEFAULT_RELEVANCE_THRESHOLDS.hybrid,
      );
      if (!qualified.size) {
        applyLexicalFallback();
      } else {
        const allHybridScores = [...hybridScores.values()].map(
          (match) => match.finalScore,
        );
        const maxScore = Math.max(...allHybridScores);
        candidateIds = new Set(qualified.keys());
        keywordMatches = {
          ...keywordMatches,
          assetIds: candidateIds,
          scores: qualified,
          threshold: DEFAULT_RELEVANCE_THRESHOLDS.hybrid,
          maxScore,
          reason: "matched",
        };
        keywordSearchMeta = searchMetadata(
          "hybrid",
          DEFAULT_RELEVANCE_THRESHOLDS.hybrid,
          maxScore,
          "matched",
        );
      }
    }
  }

  if (candidateIds) conditions.push(inArray(assets.id, [...candidateIds]));
  const where = conditions.length ? and(...conditions) : undefined;

  if (semanticQuery?.trim()) {
    const semanticThreshold = DEFAULT_RELEVANCE_THRESHOLDS.semantic;
    if (!semanticSearchEnabled()) {
      return emptyAssetQueryPage(
        safeLimit,
        includeTagStatistics,
        searchMetadata(
          "semantic",
          semanticThreshold,
          null,
          "semantic_unavailable",
        ),
      );
    }
    const rows = await db
      .select()
      .from(assets)
      .where(where)
      .orderBy(desc(assets.createdAt), desc(assets.id));
    const filteredIds = rows.map((row) => row.id);
    if (!filteredIds.length) {
      return emptyAssetQueryPage(
        safeLimit,
        includeTagStatistics,
        searchMetadata(
          "semantic",
          semanticThreshold,
          null,
          "no_candidates",
        ),
      );
    }
    let semanticScores: Map<string, number>;
    try {
      semanticScores = await searchAnalysis(
        normalizeSemanticText(semanticQuery),
        // 每个素材可能包含多个向量分块，适度过采样后再按 asset_id 去重。
        Math.max(safeLimit * 8, safeLimit),
        filteredIds,
        { minimumSimilarity: 0 },
      );
    } catch {
      return emptyAssetQueryPage(
        safeLimit,
        includeTagStatistics,
        searchMetadata(
          "semantic",
          semanticThreshold,
          null,
          "semantic_unavailable",
        ),
      );
    }
    const rawScores = [...semanticScores.values()];
    const maxScore = rawScores.length ? Math.max(...rawScores) : null;
    const qualifiedScores = new Map(
      [...semanticScores].filter(([, score]) => score > semanticThreshold),
    );
    if (!qualifiedScores.size) {
      return emptyAssetQueryPage(
        safeLimit,
        includeTagStatistics,
        searchMetadata(
          "semantic",
          semanticThreshold,
          maxScore,
          semanticScores.size ? "below_threshold" : "no_candidates",
        ),
      );
    }
    const rankedIds = [...qualifiedScores.entries()]
      .sort(([, leftScore], [, rightScore]) => rightScore - leftScore)
      .slice(0, safeLimit)
      .map(([assetId]) => assetId);
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const tagMap = await getTagsForAssets(rankedIds);
    const items = rankedIds.flatMap((assetId) => {
      const row = rowsById.get(assetId);
      if (!row) return [];
      const semanticScore = qualifiedScores.get(assetId) ?? 0;
      return [
        {
          ...summaryFromRow(row, tagMap.get(assetId) ?? []),
          searchScore: semanticScore,
          semanticScore,
          matchType: "semantic" as const,
          matchedTerms: [],
          matchedCategories: [],
        },
      ];
    });
    return {
      items,
      page: 1,
      pageSize: safeLimit,
      total: items.length,
      totalPages: 1,
      ...(includeTagStatistics
        ? { tagStatistics: await tagStatisticsForAssetIds(rankedIds) }
        : {}),
      search: searchMetadata(
        "semantic",
        semanticThreshold,
        maxScore,
        "matched",
      ),
    };
  }

  const [countRow] = await db
    .select({ value: sql<number>`count(*)`.mapWith(Number) })
    .from(assets)
    .where(where);
  const total = countRow?.value ?? 0;
  if (total === 0 && keywordSearchMeta) {
    return emptyAssetQueryPage(
      safeLimit,
      includeTagStatistics,
      searchMetadata(
        keywordSearchMeta.mode,
        keywordSearchMeta.threshold,
        null,
        "no_candidates",
      ),
    );
  }
  const totalPages = Math.max(1, Math.ceil(total / safeLimit));
  const statisticsPromise = includeTagStatistics
    ? db
        .select({ id: assets.id })
        .from(assets)
        .where(where)
        .then((allRows) =>
          tagStatisticsForAssetIds(allRows.map((row) => row.id)),
        )
    : undefined;
  // cursor 指向已不存在的页时返回空页，不能回退并重复最后一页的数据。
  if (total > 0 && requestedPage > totalPages) {
    return {
      items: [],
      page: requestedPage,
      pageSize: safeLimit,
      total,
      totalPages,
      ...(statisticsPromise
        ? { tagStatistics: await statisticsPromise }
        : {}),
      search: keywordSearchMeta,
    };
  }
  const safePage = requestedPage;
  const offset = (safePage - 1) * safeLimit;

  let rows: Array<typeof assets.$inferSelect>;
  if (keywordMatches.scores) {
    const matchingRows = await db
      .select()
      .from(assets)
      .where(where)
      .orderBy(desc(assets.createdAt), desc(assets.id));
    rows = matchingRows
      .sort((left, right) => {
        const scoreDifference =
          (keywordMatches.scores?.get(right.id)?.finalScore ?? 0) -
          (keywordMatches.scores?.get(left.id)?.finalScore ?? 0);
        if (scoreDifference !== 0) return scoreDifference;
        const semanticDifference =
          (keywordMatches.scores?.get(right.id)?.semanticScore ?? -1) -
          (keywordMatches.scores?.get(left.id)?.semanticScore ?? -1);
        if (semanticDifference !== 0) return semanticDifference;
        const createdDifference =
          right.createdAt.getTime() - left.createdAt.getTime();
        if (createdDifference !== 0) return createdDifference;
        return right.id.localeCompare(left.id);
      })
      .slice(offset, offset + safeLimit);
  } else {
    rows = await db
      .select()
      .from(assets)
      .where(where)
      .orderBy(desc(assets.createdAt), desc(assets.id))
      .limit(safeLimit)
      .offset(offset);
  }
  const tagMap = await getTagsForAssets(rows.map((row) => row.id));
  return {
    items: rows.map((row) => {
      const match = keywordMatches.scores?.get(row.id);
      return {
        ...summaryFromRow(row, tagMap.get(row.id) ?? []),
        ...(match
          ? {
              searchScore: match.finalScore,
              keywordScore: match.keywordScore,
              semanticScore: match.semanticScore,
              matchType: match.matchType,
              matchedTerms: match.matchedTerms,
              matchedCategories: match.matchedCategories,
            }
          : {}),
      };
    }),
    page: safePage,
    pageSize: safeLimit,
    total,
    totalPages,
    ...(statisticsPromise
      ? { tagStatistics: await statisticsPromise }
      : {}),
    search: keywordSearchMeta,
  };
}

/** 分页查询素材；未提供 userId 时严格限定为公共素材。 */
export async function listAssets({
  page = 1,
  limit = 8,
  view = "published",
  tagQuery,
  ...scope
}: ListAssetsOptions = {}): Promise<AssetPage> {
  const result = await queryAssetsPage({
    page,
    limit: Math.min(Math.max(limit, 1), 50),
    reviewStatuses: [
      view === "published" ? "published" : "pending_review",
    ],
    keywords:
      view === "published" && tagQuery?.trim()
        ? [tagQuery.trim().slice(0, 128)]
        : [],
    includeTagStatistics: false,
    ...scope,
  });
  return {
    items: result.items,
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    totalPages: result.totalPages,
  };
}

async function publishedAssetIdsMatchingKeywords(
  keywords: string[],
  scope: AssetScope,
) {
  const ownership = scopeCondition(scope);
  if (!keywords.length) {
    const conditions: SQL[] = [
      eq(assets.reviewStatus, "published"),
      isNull(assets.deletedAt),
    ];
    if (ownership) conditions.push(ownership);
    return (
      await db
        .select({ id: assets.id })
        .from(assets)
        .where(and(...conditions))
    ).map((row) => row.id);
  }
  const keywordMatches = await assetIdsMatchingKeywords(keywords);
  const matchedAssetIds = [...(keywordMatches.assetIds ?? [])];
  if (!matchedAssetIds.length) return [];
  const conditions: SQL[] = [
    eq(assets.reviewStatus, "published"),
    isNull(assets.deletedAt),
    inArray(assets.id, matchedAssetIds),
  ];
  if (ownership) conditions.push(ownership);
  return (
    await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(...conditions))
  ).map((row) => row.id);
}

export interface DescriptionSearchResult {
  items: AssetSummary[];
  threshold: number;
  maxScore: number | null;
  reason: AssetSearchMeta["reason"];
  message: string | null;
}

export async function searchAssetsByDescriptionDetailed(
  { description, keywords = [], limit }: DescriptionSearch,
  scope: AssetScope = {},
): Promise<DescriptionSearchResult> {
  const threshold = DEFAULT_RELEVANCE_THRESHOLDS.semantic;
  const result = (
    items: AssetSummary[],
    maxScore: number | null,
    reason: AssetSearchMeta["reason"],
  ): DescriptionSearchResult => {
    const metadata = searchMetadata("semantic", threshold, maxScore, reason);
    return {
      items,
      threshold,
      maxScore,
      reason,
      message: metadata.message,
    };
  };

  const normalizedKeywords = [
    ...new Set(keywords.map(normalizeSearchText).filter(Boolean)),
  ];
  const candidateIds = await publishedAssetIdsMatchingKeywords(
    normalizedKeywords,
    scope,
  );
  if (!candidateIds.length) return result([], null, "no_candidates");
  if (!semanticSearchEnabled()) {
    return result([], null, "semantic_unavailable");
  }
  let scores: Map<string, number>;
  try {
    scores = await searchAnalysis(
      normalizeSemanticText(description),
      Math.max(limit * 5, limit),
      candidateIds,
      { minimumSimilarity: 0 },
    );
  } catch {
    return result([], null, "semantic_unavailable");
  }
  const rawScores = [...scores.values()];
  const maxScore = rawScores.length ? Math.max(...rawScores) : null;
  const qualifiedScores = new Map(
    [...scores].filter(([, score]) => score > threshold),
  );
  const rankedIds = [...qualifiedScores.entries()]
    .sort(([, leftScore], [, rightScore]) => rightScore - leftScore)
    .slice(0, limit)
    .map(([assetId]) => assetId);
  if (!rankedIds.length) {
    return result(
      [],
      maxScore,
      scores.size ? "below_threshold" : "no_candidates",
    );
  }
  const rows = await db
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.reviewStatus, "published"),
        isNull(assets.deletedAt),
        inArray(assets.id, rankedIds),
      ),
    );
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const tagMap = await getTagsForAssets(rankedIds);
  const items = rankedIds.flatMap((assetId) => {
    const row = rowsById.get(assetId);
    if (!row) return [];
    const semanticScore = qualifiedScores.get(assetId) ?? 0;
    return [
      {
        ...summaryFromRow(row, tagMap.get(assetId) ?? []),
        searchScore: semanticScore,
        semanticScore,
        matchType: "semantic" as const,
        matchedTerms: [],
        matchedCategories: [],
      },
    ];
  });
  return result(items, maxScore, "matched");
}

export async function searchAssetsByDescription(
  input: DescriptionSearch,
  scope: AssetScope = {},
) {
  return (await searchAssetsByDescriptionDetailed(input, scope)).items;
}

/** 获取素材详情；默认只能读取公共素材，内部调用可显式 includeAllUsers。 */
export async function getAssetDetail(
  assetId: string,
  scope: AssetScope = {},
): Promise<AssetDetail> {
  const conditions: SQL[] = [
    eq(assets.id, assetId),
    ne(assets.reviewStatus, "deleted"),
    isNull(assets.deletedAt),
  ];
  const ownership = scopeCondition(scope);
  if (ownership) conditions.push(ownership);
  const [row] = await db
    .select()
    .from(assets)
    .where(and(...conditions))
    .limit(1);
  if (!row) throw new AppError("invalid_request", "素材不存在。", 404);
  const [analysis] = await db
    .select()
    .from(analysisResults)
    .where(eq(analysisResults.assetId, assetId))
    .limit(1);
  return {
    ...summaryFromRow(row, (await getTagsForAssets([assetId])).get(assetId) ?? []),
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    failureCode: row.failureCode as FailureCode | null,
    failureMessage: row.failureMessage,
    analysis: analysis ? analysisResultSchema.parse(analysis.resultJson) : null,
    segmentStartMs: row.segmentStartMs,
    segmentEndMs: row.segmentEndMs,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** worker 内部按主键读取，不执行 user_id 作用域过滤。 */
export async function getAssetRecord(assetId: string) {
  const [row] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  return row;
}

type AssetTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function resolveAssetRef(assetId: string, scope: AssetScope): Promise<AssetRef> {
  if (scope.userId?.trim()) return { kind: "private", id: assetId };
  if (!scope.includeAllUsers) return { kind: "public", id: assetId };
  const [row] = await db
    .select({ kind: assets.kind })
    .from(assets)
    .where(eq(assets.id, assetId))
    .limit(1);
  return { kind: row?.kind ?? "public", id: assetId };
}

async function lockedAsset(tx: AssetTransaction, ref: AssetRef) {
  if (ref.kind === "private") {
    const [row] = await tx
      .select()
      .from(privateAssets)
      .where(eq(privateAssets.id, ref.id))
      .for("update")
      .limit(1);
    return row
      ? { ...row, kind: "private" as const, uploaderUserId: null, reviewStatus: "published" as const }
      : undefined;
  }
  const [row] = await tx
    .select()
    .from(publicAssets)
    .where(eq(publicAssets.id, ref.id))
    .for("update")
    .limit(1);
  return row
    ? { ...row, kind: "public" as const, userId: null, publicAssetId: null }
    : undefined;
}

function updateAssetRow(
  tx: AssetTransaction,
  ref: AssetRef,
  values: Partial<{
    name: string;
    description: string;
    processingStatus: ProcessingStatus;
    reviewStatus: ReviewStatus;
    failureCode: string | null;
    failureMessage: string | null;
    deletedAt: Date | null;
    updatedAt: Date;
  }>,
) {
  if (ref.kind === "private") {
    const privateValues = {
      name: values.name,
      description: values.description,
      processingStatus: values.processingStatus,
      failureCode: values.failureCode,
      failureMessage: values.failureMessage,
      deletedAt: values.deletedAt,
      updatedAt: values.updatedAt,
    };
    return tx.update(privateAssets).set(privateValues).where(eq(privateAssets.id, ref.id));
  }
  return tx.update(publicAssets).set(values).where(eq(publicAssets.id, ref.id));
}

function normalizeTag(value: string) {
  return value.trim().toLocaleLowerCase();
}

export async function updateAssetMetadata(
  assetId: string,
  edit: AssetEdit,
  scope: AssetScope = {},
) {
  const now = new Date();
  const ref = await resolveAssetRef(assetId, scope);
  await db.transaction(async (tx) => {
    // 所有权与 deleted 状态必须在行锁内判断，避免检查后被删除/转公共。
    const asset = await lockedAsset(tx, ref);
    if (
      !asset ||
      asset.deletedAt !== null ||
      asset.reviewStatus === "deleted" ||
      !rowMatchesScope(asset, scope)
    ) {
      throw new AppError("invalid_request", "素材不存在。", 404);
    }
    const existing = await tx
      .select({
        category: tags.category,
        value: tags.value,
        source: assetTags.source,
      })
      .from(assetTags)
      .innerJoin(tags, eq(assetTags.tagId, tags.id))
      .where(eq(assetTags.assetId, assetId));
    const requested = new Set(
      edit.tags.map((tag) => `${tag.category}:${normalizeTag(tag.value)}`),
    );
    const removedModelTags = existing.filter(
      (tag) =>
        tag.source === "model" &&
        !requested.has(`${tag.category}:${normalizeTag(tag.value)}`),
    );
    await updateAssetRow(tx, ref, {
      name: edit.name,
      description: edit.description,
      updatedAt: now,
    });
    for (const tag of removedModelTags) {
      await tx
        .insert(assetTagRejectionRecords)
        .ignore()
        .values({
          id: crypto.randomUUID(),
          ...associationTarget(ref),
          category: tag.category,
          normalizedValue: normalizeTag(tag.value),
        });
    }
    await tx
      .delete(assetTagRecords)
      .where(
        ref.kind === "private"
          ? eq(assetTagRecords.privateAssetId, assetId)
          : eq(assetTagRecords.publicAssetId, assetId),
      );
    for (const tag of edit.tags) {
      const normalizedValue = normalizeTag(tag.value);
      await tx
        .insert(tags)
        .ignore()
        .values({
          id: crypto.randomUUID(),
          category: tag.category,
          value: tag.value.trim(),
          normalizedValue,
          createdAt: now,
        });
      const [storedTag] = await tx
        .select({ id: tags.id })
        .from(tags)
        .where(
          and(
            eq(tags.category, tag.category),
            eq(tags.normalizedValue, normalizedValue),
          ),
        )
        .limit(1);
      if (!storedTag) throw new Error("标签创建后无法读取。");
      await tx
        .insert(assetTagRecords)
        .ignore()
        .values({
          id: crypto.randomUUID(),
          ...associationTarget(ref),
          tagId: storedTag.id,
          source: "human",
          confidence: null,
        });
    }
  });
  return getAssetDetail(assetId, { includeAllUsers: true });
}

export async function publishAsset(assetId: string, scope: AssetScope = {}) {
  const ref = await resolveAssetRef(assetId, scope);
  if (ref.kind === "private") {
    throw new AppError("invalid_request", "私人素材无需审核。", 409);
  }
  await db.transaction(async (tx) => {
    const asset = await lockedAsset(tx, ref);
    if (
      !asset ||
      asset.reviewStatus === "deleted" ||
      !rowMatchesScope(asset, scope)
    ) {
      throw new AppError("invalid_request", "素材不存在。", 404);
    }
    if (asset.processingStatus !== "completed") {
      throw new AppError("invalid_request", "素材分析完成后才能入库。", 409);
    }
    await updateAssetRow(tx, ref, {
      reviewStatus: "published",
      updatedAt: new Date(),
    });
  });
  return getAssetDetail(assetId, { includeAllUsers: true });
}

export async function retryAsset(assetId: string, scope: AssetScope = {}) {
  const now = new Date();
  const ref = await resolveAssetRef(assetId, scope);
  await db.transaction(async (tx) => {
    const asset = await lockedAsset(tx, ref);
    if (
      !asset ||
      asset.deletedAt !== null ||
      asset.reviewStatus === "deleted" ||
      !rowMatchesScope(asset, scope)
    ) {
      throw new AppError("invalid_request", "素材不存在。", 404);
    }
    if (asset.processingStatus !== "failed") {
      throw new AppError("invalid_request", "只有失败的素材可以重试。", 409);
    }
    await updateAssetRow(tx, ref, {
      processingStatus: "queued",
      failureCode: null,
      failureMessage: null,
      updatedAt: now,
    });
    await tx.insert(jobs).values({
      id: crypto.randomUUID(),
      taskId: asset.taskId,
      ...jobTarget(ref),
      type: "analyze",
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
  return getAssetDetail(assetId, { includeAllUsers: true });
}

/** 公共素材删除先进入异步 delete 作业，worker 完成外部清理后再回收记录。 */
export async function queuePublicAssetDeletion(assetId: string, taskId: string) {
  const now = new Date();
  await db.transaction(async (tx) => {
    const result = await tx
      .update(publicAssets)
      .set({ reviewStatus: "deleted", deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(publicAssets.id, assetId),
          ne(publicAssets.reviewStatus, "deleted"),
        ),
      );
    if (affectedRows(result) !== 1) {
      throw new AppError("invalid_request", "公共素材不存在。", 404);
    }
    await tx.insert(jobs).values({
      id: crypto.randomUUID(),
      taskId,
      publicAssetId: assetId,
      type: "delete",
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export interface ClaimedJob {
  id: string;
  taskId: string | null;
  assetId: string | null;
  assetKind?: AssetKind | null;
  type: typeof jobs.$inferSelect.type;
  attempt: number;
  payload: Record<string, unknown> | null;
  availableAt?: Date;
  createdAt?: Date;
  claimedAt?: Date | null;
  leaseOwner?: string | null;
}

export interface ClaimNextJobOptions {
  analyzeTaskSoftLimit?: number;
}

type JobTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type JobRow = typeof jobs.$inferSelect;

const nonAnalysisClaimableTypes = [
  "embed",
  "delete",
  "cleanup",
  "callback",
  "match",
  "publish",
  "update",
  "retry",
] as const;

async function claimQueuedJob(
  tx: JobTransaction,
  row: JobRow,
  leaseOwner: string,
  now: Date,
): Promise<ClaimedJob | null> {
  const attempt = row.attempt + 1;
  const updated = await tx
    .update(jobs)
    .set({
      status: "running",
      claimedAt: now,
      leaseOwner,
      attempt,
      updatedAt: now,
    })
    .where(and(eq(jobs.id, row.id), eq(jobs.status, "queued")));
  if (affectedRows(updated) !== 1) return null;
  return {
    id: row.id,
    taskId: row.taskId,
    assetId: row.privateAssetId ?? row.publicAssetId,
    assetKind: row.privateAssetId
      ? "private"
      : row.publicAssetId
        ? "public"
        : null,
    type: row.type,
    attempt,
    payload: row.payload,
    availableAt: row.availableAt,
    createdAt: row.createdAt,
    claimedAt: now,
    leaseOwner,
  };
}

async function selectPriorityValidationJob(tx: JobTransaction, now: Date) {
  const [row] = await tx
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "queued"),
        eq(jobs.type, "validate"),
        sql`${jobs.availableAt} <= ${now}`,
      ),
    )
    .orderBy(asc(jobs.createdAt))
    .limit(1)
    .for("update", { skipLocked: true });
  return row ?? null;
}

/**
 * 为分析作业锁定一个任务行后再计算并发数，确保多个 worker 同时领取时不会共同
 * 穿透软上限。任务之间按最早等待作业排序；并发 worker 等待同一个候选任务的
 * 短事务提交后重新计算配额，避免把“候选暂时被锁”误判为“队列为空”。
 */
async function selectFairAnalysisJob(
  tx: JobTransaction,
  now: Date,
  softLimit: number,
) {
  const excludedTaskIds: string[] = [];
  for (;;) {
    const conditions: SQL[] = [
      sql`exists (
        select 1
          from jobs as queued_analysis
         where queued_analysis.task_id = ${tasks.id}
           and queued_analysis.type = 'analyze'
           and queued_analysis.status = 'queued'
           and queued_analysis.available_at <= ${now}
      )`,
    ];
    if (excludedTaskIds.length) {
      conditions.push(notInArray(tasks.id, excludedTaskIds));
    }
    const [candidateTask] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(...conditions))
      .orderBy(
        sql`(
          select min(queued_analysis.created_at)
            from jobs as queued_analysis
           where queued_analysis.task_id = ${tasks.id}
             and queued_analysis.type = 'analyze'
             and queued_analysis.status = 'queued'
             and queued_analysis.available_at <= ${now}
        )`,
      )
      .limit(1);
    if (!candidateTask) return null;

    // 候选查询会使用 status/created_at 等二级索引。直接在该查询上 FOR UPDATE
    // 会形成“二级索引 -> 主键”的加锁顺序，而 mutation worker 更新 task 时是
    // “主键 -> 二级索引”，高并发下会产生 InnoDB 死锁。先无锁选候选，再通过
    // 主键锁定具体 task；等待锁后重新检查作业状态和并发计数即可保持公平性。
    const [lockedTask] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, candidateTask.id))
      .limit(1)
      .for("update");
    if (!lockedTask) {
      excludedTaskIds.push(candidateTask.id);
      continue;
    }

    const [runningRow] = await tx
      .select({ value: sql<number>`count(*)`.mapWith(Number) })
      .from(jobs)
      .where(
        and(
          eq(jobs.taskId, candidateTask.id),
          eq(jobs.type, "analyze"),
          eq(jobs.status, "running"),
        ),
      );
    const [competingJob] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, "analyze"),
          eq(jobs.status, "queued"),
          sql`${jobs.availableAt} <= ${now}`,
          isNotNull(jobs.taskId),
          ne(jobs.taskId, candidateTask.id),
        ),
      )
      .limit(1);
    if (
      canClaimAnalyzeTask(
        runningRow?.value ?? 0,
        Boolean(competingJob),
        softLimit,
      )
    ) {
      const [row] = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.taskId, candidateTask.id),
            eq(jobs.type, "analyze"),
            eq(jobs.status, "queued"),
            sql`${jobs.availableAt} <= ${now}`,
          ),
        )
        .orderBy(asc(jobs.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (row) return row;
    }
    excludedTaskIds.push(candidateTask.id);
  }
}

async function selectOtherQueuedJob(tx: JobTransaction, now: Date) {
  const [row] = await tx
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "queued"),
        or(
          inArray(jobs.type, nonAnalysisClaimableTypes),
          and(eq(jobs.type, "analyze"), isNull(jobs.taskId)),
        ),
        sql`${jobs.availableAt} <= ${now}`,
      ),
    )
    .orderBy(asc(jobs.createdAt))
    .limit(1)
    .for("update", { skipLocked: true });
  return row ?? null;
}

/**
 * 并发安全领取一个作业：validate 始终优先；其余类型保持 FIFO；多个任务竞争时，
 * analyze 按任务执行软并发上限，单任务独占队列时可突发使用全部全局 worker。
 */
export async function claimNextJob(
  leaseOwner = `${process.pid}`,
  options: ClaimNextJobOptions = {},
): Promise<ClaimedJob | null> {
  const now = new Date();
  const softLimit =
    options.analyzeTaskSoftLimit ?? DEFAULT_ANALYZE_TASK_SOFT_LIMIT;
  if (!Number.isInteger(softLimit) || softLimit < 1) {
    throw new Error("analyzeTaskSoftLimit 必须是大于 0 的整数。");
  }
  return db.transaction(
    async (tx) => {
      const validation = await selectPriorityValidationJob(tx, now);
      if (validation) {
        return claimQueuedJob(tx, validation, leaseOwner, now);
      }

      const analysis = await selectFairAnalysisJob(tx, now, softLimit);
      const other = await selectOtherQueuedJob(tx, now);
      const row =
        analysis && other
          ? analysis.createdAt.getTime() <= other.createdAt.getTime()
            ? analysis
            : other
          : (analysis ?? other);
      return row ? claimQueuedJob(tx, row, leaseOwner, now) : null;
    },
    { isolationLevel: "read committed" },
  );
}

export async function completeJob(job: Pick<ClaimedJob, "id" | "attempt">) {
  const result = await db
    .update(jobs)
    .set({ status: "done", updatedAt: new Date() })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.status, "running"),
        eq(jobs.attempt, job.attempt),
      ),
    );
  return affectedRows(result);
}

export async function heartbeatJob(job: Pick<ClaimedJob, "id" | "attempt">) {
  const now = new Date();
  const result = await db
    .update(jobs)
    .set({ claimedAt: now, updatedAt: now })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.status, "running"),
        eq(jobs.attempt, job.attempt),
      ),
    );
  return affectedRows(result);
}

export async function failJob(job: Pick<ClaimedJob, "id" | "attempt">) {
  const result = await db
    .update(jobs)
    .set({ status: "failed", updatedAt: new Date() })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.status, "running"),
        eq(jobs.attempt, job.attempt),
      ),
    );
  return affectedRows(result);
}

export async function requeueJob(
  job: Pick<ClaimedJob, "id" | "attempt">,
  delayMs: number,
) {
  const now = new Date();
  const result = await db
    .update(jobs)
    .set({
      status: "queued",
      availableAt: new Date(now.getTime() + delayMs),
      claimedAt: null,
      leaseOwner: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.status, "running"),
        eq(jobs.attempt, job.attempt),
      ),
    );
  return affectedRows(result);
}

export async function requeueFailedEmbeddingJobs() {
  const now = new Date();
  const result = await db
    .update(jobs)
    .set({
      status: "queued",
      attempt: 0,
      availableAt: now,
      claimedAt: null,
      leaseOwner: null,
      updatedAt: now,
    })
    .where(and(eq(jobs.type, "embed"), eq(jobs.status, "failed")));
  return affectedRows(result);
}

/** recoverStaleJobs 单批最多处理的行数，避免单次范围 UPDATE 长时间持锁。 */
const STALE_JOB_BATCH_SIZE = 50;

/**
 * 把超时仍处于 running 的作业重置为 queued，供其他 worker 重新领取。
 *
 * 原实现用一次范围 UPDATE（status + claimedAt 区间）锁定大批行，与并发的
 * 作业 INSERT 事务互锁导致偶发死锁（1213/1205）。这里改为在单个事务里用
 * FOR UPDATE SKIP LOCKED 分批选中要恢复的作业，再按选中的主键集合批量 UPDATE；
 * 小批量限制锁窗口，且 SKIP LOCKED 让已被领取的行直接跳过。
 */
export async function recoverStaleJobs(staleAfterMs = 2 * 60_000) {
  const now = new Date();
  const stale = new Date(now.getTime() - staleAfterMs);
  let recovered = 0;
  for (;;) {
    const batch = await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.status, "running"), lt(jobs.claimedAt, stale)))
        .orderBy(asc(jobs.claimedAt))
        .limit(STALE_JOB_BATCH_SIZE)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return 0;
      const result = await tx
        .update(jobs)
        .set({
          status: "queued",
          claimedAt: null,
          leaseOwner: null,
          availableAt: now,
          updatedAt: now,
        })
        .where(
          and(
            inArray(
              jobs.id,
              rows.map((row) => row.id),
            ),
            eq(jobs.status, "running"),
          ),
        );
      return affectedRows(result);
    });
    if (batch === 0) break;
    recovered += batch;
  }
  return recovered;
}

/**
 * 删除已到期且处于终态的任务明细。
 *
 * 公私素材/video_sources 的追溯外键会自动置空；正在排队或运行的任务即使超过
 * expires_at 也不会被清理，避免长视频处理过程中丢失状态。
 */
export async function deleteExpiredTasks(now = new Date()) {
  const result = await db
    .delete(tasks)
    .where(
      and(
        inArray(tasks.status, ["done", "failed"]),
        lt(tasks.expiresAt, now),
      ),
    );
  return affectedRows(result);
}
