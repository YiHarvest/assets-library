import crypto from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/server/db";
import { withDeadlockRetry } from "@/server/db/retry";
import {
  assets,
  jobs,
  mediaObjects,
  tasks,
  videoSources,
} from "@/server/db/schema";
import { loadConfig } from "@/server/config";
import { AppError } from "@/server/errors";
import {
  completeJob,
  publishAsset,
  releaseAssetToPublic,
  updateAssetMetadata,
  type AssetScope,
  type ClaimedJob,
} from "@/server/repositories/assets";
import { deleteAnalysis } from "@/server/search/chroma";
import {
  failMutationTask,
  finishMutationTask,
} from "@/server/services/task-lifecycle";
import type { ObjectStorage } from "@/server/storage/object-storage";
import { createZosObjectStorage } from "@/server/storage/zos";
import type { AssetEdit } from "@/shared/contracts";

function stringPayload(job: ClaimedJob, key: string) {
  const value = job.payload?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * 从 job payload 获取 userId；若 payload 中缺失（API 未传 user_id），
 * 则回退到数据库查出资产的实际归属，避免 worker 用 null scope 匹配不到
 * 用户私有资产。
 */
async function resolveScopeForJob(job: ClaimedJob): Promise<AssetScope> {
  const payloadUserId = stringPayload(job, "userId")?.trim();
  if (payloadUserId) return { userId: payloadUserId };
  const assetId = job.assetId ?? stringPayload(job, "assetId");
  if (!assetId) return { userId: null };
  const [row] = await db
    .select({ userId: assets.userId })
    .from(assets)
    .where(eq(assets.id, assetId))
    .limit(1);
  return row ? { userId: row.userId } : { userId: null };
}

async function markMutationRunning(job: ClaimedJob) {
  if (!job.taskId) throw new AppError("invalid_request", "变更作业缺少 taskId。", 500);
  const taskId = job.taskId;
  const phase =
    job.type === "delete"
      ? "deleting"
      : job.type === "publish"
        ? "publishing"
        : job.type === "update"
          ? "updating"
          : "retrying";
  await withDeadlockRetry(
    () => {
      const now = new Date();
      return db
        .update(tasks)
        .set({
          status: "running",
          phase,
          startedAt: now,
          updatedAt: now,
        })
        .where(eq(tasks.id, taskId));
    },
    { attempts: 5, backoffMs: 25 },
  );
}

function updatePayload(job: ClaimedJob): AssetEdit {
  const name = job.payload?.name;
  const description = job.payload?.description;
  const tags = job.payload?.tags;
  if (typeof name !== "string" || typeof description !== "string" || !Array.isArray(tags)) {
    throw new AppError("invalid_request", "素材更新作业参数无效。", 500);
  }
  return { name, description, tags } as AssetEdit;
}

async function queueRetryAnalysis(job: ClaimedJob) {
  if (!job.assetId || !job.taskId) {
    throw new AppError("invalid_request", "重试作业缺少素材或任务标识。", 500);
  }
  const assetId = job.assetId;
  const taskId = job.taskId;
  const now = new Date();
  await db.transaction(async (tx) => {
    const [asset] = await tx
      .select()
      .from(assets)
      .where(eq(assets.id, assetId))
      .for("update")
      .limit(1);
    const payloadUserId = stringPayload(job, "userId")?.trim() || null;
    const expectedUserId = payloadUserId ?? asset?.userId ?? null;
    if (
      !asset ||
      asset.reviewStatus === "deleted" ||
      asset.userId !== expectedUserId
    ) {
      throw new AppError("invalid_request", "素材不存在。", 404);
    }
    if (asset.processingStatus !== "failed") {
      throw new AppError("invalid_request", "只有失败的素材可以重试。", 409);
    }
    await tx
      .update(assets)
      .set({
        processingStatus: "queued",
        failureCode: null,
        failureMessage: null,
        updatedAt: now,
      })
      .where(eq(assets.id, assetId));
    await tx.insert(jobs).values({
      id: crypto.randomUUID(),
      taskId,
      assetId,
      type: "analyze",
      phase: "analyzing",
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await tx
      .update(jobs)
      .set({ status: "done", updatedAt: now })
      .where(eq(jobs.id, job.id));
    await tx
      .update(tasks)
      .set({ phase: "analyzing", updatedAt: now })
      .where(eq(tasks.id, taskId));
  });
}

interface DeletingObject {
  id: string;
  objectKey: string;
}

interface PublicDeletionReservation {
  alreadyGone: boolean;
  object?: DeletingObject;
  thumbnailObject?: DeletingObject;
  parent?: { sourceId: string; object?: DeletingObject };
}

/**
 * 先在短事务中隐藏素材并决定是否回收父视频。
 *
 * 视频切片先锁 video_sources，再锁目标 asset；同一父视频的并发删除因此会按
 * 父行串行，最后一个切片一定能观察到其他切片均已进入 deleted。
 */
async function reservePublicAssetDeletion(
  assetId: string,
): Promise<PublicDeletionReservation> {
  const [preflight] = await db
    .select({ videoSourceId: assets.videoSourceId })
    .from(assets)
    .where(eq(assets.id, assetId))
    .limit(1);
  if (!preflight) return { alreadyGone: true };

  return db.transaction(async (tx) => {
    let lockedSource: typeof videoSources.$inferSelect | undefined;
    if (preflight.videoSourceId) {
      [lockedSource] = await tx
        .select()
        .from(videoSources)
        .where(eq(videoSources.id, preflight.videoSourceId))
        .for("update")
        .limit(1);
    }

    const [asset] = await tx
      .select()
      .from(assets)
      .where(eq(assets.id, assetId))
      .for("update")
      .limit(1);
    if (!asset) return { alreadyGone: true };
    if (asset.userId !== null) {
      throw new AppError("invalid_request", "公共素材不存在。", 404);
    }
    if (
      asset.videoSourceId &&
      asset.videoSourceId !== preflight.videoSourceId
    ) {
      throw new AppError("internal_error", "视频父子关系在删除期间发生变化。", 409);
    }

    const now = new Date();
    if (asset.reviewStatus !== "deleted") {
      await tx
        .update(assets)
        .set({ reviewStatus: "deleted", deletedAt: now, updatedAt: now })
        .where(eq(assets.id, assetId));
    }

    let object: DeletingObject | undefined;
    if (asset.mediaObjectId) {
      const [stored] = await tx
        .select({ id: mediaObjects.id, objectKey: mediaObjects.objectKey })
        .from(mediaObjects)
        .where(eq(mediaObjects.id, asset.mediaObjectId))
        .limit(1);
      if (stored) {
        object = stored;
        await tx
          .update(mediaObjects)
          .set({ status: "deleting", updatedAt: now })
          .where(eq(mediaObjects.id, stored.id));
      }
    }

    let thumbnailObject: DeletingObject | undefined;
    if (asset.thumbnailMediaObjectId) {
      const [stored] = await tx
        .select({ id: mediaObjects.id, objectKey: mediaObjects.objectKey })
        .from(mediaObjects)
        .where(eq(mediaObjects.id, asset.thumbnailMediaObjectId))
        .limit(1);
      if (stored) {
        thumbnailObject = stored;
        await tx
          .update(mediaObjects)
          .set({ status: "deleting", updatedAt: now })
          .where(eq(mediaObjects.id, stored.id));
      }
    }

    let parent: PublicDeletionReservation["parent"];
    if (asset.videoSourceId && lockedSource) {
      // 父行锁已阻止其他兄弟切片越过；锁定读取确保使用最新提交状态。
      const remaining = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            eq(assets.videoSourceId, asset.videoSourceId),
            ne(assets.id, assetId),
            ne(assets.reviewStatus, "deleted"),
          ),
        )
        .for("update");
      if (remaining.length === 0) {
        parent = { sourceId: lockedSource.id };
        if (lockedSource.mediaObjectId) {
          const [parentObject] = await tx
            .select({ id: mediaObjects.id, objectKey: mediaObjects.objectKey })
            .from(mediaObjects)
            .where(eq(mediaObjects.id, lockedSource.mediaObjectId))
            .limit(1);
          if (parentObject) {
            parent.object = parentObject;
            await tx
              .update(mediaObjects)
              .set({ status: "deleting", updatedAt: now })
              .where(eq(mediaObjects.id, parentObject.id));
          }
        }
      }
    }
    return { alreadyGone: false, object, thumbnailObject, parent };
  });
}

async function finalizePublicAssetDeletion(
  assetId: string,
  record: PublicDeletionReservation,
) {
  await db.transaction(async (tx) => {
    // 保留所有修改类 durable job。删除完成前已排队的 update/publish/retry
    // 后续会读取 payload.assetId 并明确失败，不会因 FK 级联而永久卡在 queued。
    const linkedMutationJobs = await tx
      .select({ id: jobs.id, payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.assetId, assetId),
          inArray(jobs.type, ["delete", "update", "publish", "retry"]),
        ),
      )
      .for("update");
    for (const linkedJob of linkedMutationJobs) {
      await tx
        .update(jobs)
        .set({
          assetId: null,
          payload: { ...(linkedJob.payload ?? {}), assetId },
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, linkedJob.id));
    }
    await tx.delete(assets).where(eq(assets.id, assetId));
    if (record.object) {
      await tx.delete(mediaObjects).where(eq(mediaObjects.id, record.object.id));
    }
    if (record.thumbnailObject) {
      await tx
        .delete(mediaObjects)
        .where(eq(mediaObjects.id, record.thumbnailObject.id));
    }
    if (record.parent) {
      // 再次锁父行，使数据库收尾与潜在重试保持同一顺序。
      const [source] = await tx
        .select({ id: videoSources.id })
        .from(videoSources)
        .where(eq(videoSources.id, record.parent.sourceId))
        .for("update")
        .limit(1);
      if (source) {
        await tx.delete(videoSources).where(eq(videoSources.id, source.id));
      }
      if (record.parent.object) {
        await tx
          .delete(mediaObjects)
          .where(eq(mediaObjects.id, record.parent.object.id));
      }
    }
  });
}

/**
 * 开关 ZOS_DELETE_BEST_EFFORT=true 时，对象删除失败只告警不抛出，
 * 硬删除仅回收数据库记录；未开启时保持原有的严格删除语义。
 */
async function deleteObjectBestEffort(
  storage: ObjectStorage,
  key: string | undefined,
  bestEffort: boolean,
) {
  if (!key) return;
  try {
    await storage.deleteObject(key);
  } catch (error) {
    if (bestEffort) {
      console.warn(`跳过 ZOS 对象删除（ZOS_DELETE_BEST_EFFORT）：${key}`, error);
      return;
    }
    throw error;
  }
}

async function hardDeletePublicAsset(
  assetId: string,
  storage: ObjectStorage,
) {
  const record = await reservePublicAssetDeletion(assetId);
  if (record.alreadyGone) {
    return { released_to_public: false, parent_video_reclaimed: false };
  }
  const bestEffort = loadConfig().ZOS_DELETE_BEST_EFFORT === "true";

  // 外部对象先幂等删除；若进程中断，隐藏的 deleted 行可由同一任务重试收尾。
  await deleteAnalysis(assetId);
  await deleteObjectBestEffort(storage, record.object?.objectKey, bestEffort);
  await deleteObjectBestEffort(
    storage,
    record.thumbnailObject?.objectKey,
    bestEffort,
  );
  await deleteObjectBestEffort(
    storage,
    record.parent?.object?.objectKey,
    bestEffort,
  );

  await finalizePublicAssetDeletion(assetId, record);
  return { released_to_public: false, parent_video_reclaimed: Boolean(record.parent) };
}

async function deleteAsset(job: ClaimedJob, storage: ObjectStorage) {
  const assetId = job.assetId ?? stringPayload(job, "assetId");
  if (!assetId) throw new AppError("invalid_request", "删除作业缺少素材标识。", 500);
  const payloadUserId = stringPayload(job, "userId")?.trim() ?? null;
  let userId: string | null = payloadUserId;
  if (!userId) {
    const [row] = await db
      .select({ userId: assets.userId })
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);
    userId = row?.userId ?? null;
  }
  if (userId) {
    await releaseAssetToPublic(assetId, userId);
    return { released_to_public: true, parent_video_reclaimed: false };
  }
  return hardDeletePublicAsset(assetId, storage);
}

/** 执行 update/publish/retry/delete 变更作业。 */
export async function processMutationJob(
  job: ClaimedJob,
  storage: ObjectStorage = createZosObjectStorage(),
) {
  const assetId = job.assetId ?? stringPayload(job, "assetId");
  if (!job.taskId || !assetId) {
    throw new AppError("invalid_request", "变更作业缺少任务或素材标识。", 500);
  }
  try {
    await markMutationRunning(job);
    if (job.type === "retry") {
      await queueRetryAnalysis(job);
      return;
    }
    let result: Record<string, unknown>;
    if (job.type === "update") {
      const scope = await resolveScopeForJob(job);
      await updateAssetMetadata(assetId, updatePayload(job), scope);
      result = { asset_id: assetId };
    } else if (job.type === "publish") {
      const scope = await resolveScopeForJob(job);
      await publishAsset(assetId, scope);
      result = { asset_id: assetId, review_status: "published" };
    } else if (job.type === "delete") {
      result = { asset_id: assetId, ...(await deleteAsset(job, storage)) };
    } else {
      throw new AppError("invalid_request", `不支持的变更作业：${job.type}`, 500);
    }
    await finishMutationTask(job.taskId, result);
    await completeJob(job);
  } catch (error) {
    await failMutationTask(job.taskId, error);
    throw error;
  }
}
