import { and, eq, inArray, lt, ne, notExists, or } from "drizzle-orm";
import { loadConfig } from "@/server/config";
import { db } from "@/server/db";
import {
  assets,
  assetTags,
  mediaObjects,
  tags,
  taskItems,
  taskItemSegments,
  tasks,
  videoSources,
} from "@/server/db/schema";
import { deleteAnalysis } from "@/server/search/chroma";
import {
  deleteMediaObjectBytes,
  type DeletableMediaObject,
} from "@/server/services/pending-media";
import { taskHistoryExpiresAt } from "@/server/services/task-lifecycle";
import type { ObjectStorage } from "@/server/storage/object-storage";
import { createZosObjectStorage } from "@/server/storage/zos";

interface CleanupReservation {
  assetId: string;
  taskId: string | null;
  taskItemId: string | null;
  taskItemSegmentId: string | null;
  videoSourceId: string | null;
  object: (DeletableMediaObject & { id: string }) | null;
  thumbnailObject: (DeletableMediaObject & { id: string }) | null;
  deleteVideoSource: boolean;
}

async function reserveExpiredAsset(assetId: string, cutoff: Date) {
  const [preflight] = await db
    .select({ videoSourceId: assets.videoSourceId })
    .from(assets)
    .where(eq(assets.id, assetId))
    .limit(1);
  if (!preflight) return null;

  return db.transaction(async (tx): Promise<CleanupReservation | null> => {
    if (preflight.videoSourceId) {
      await tx
        .select({ id: videoSources.id })
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
    if (
      !asset ||
      !(
        (asset.reviewStatus === "pending_review" && asset.updatedAt < cutoff) ||
        (asset.reviewStatus === "deleted" &&
          asset.failureCode === "pending_asset_expired")
      ) ||
      asset.videoSourceId !== preflight.videoSourceId
    ) {
      return null;
    }
    const objectIds = [asset.mediaObjectId, asset.thumbnailMediaObjectId].filter(
      (id): id is string => Boolean(id),
    );
    const stored = objectIds.length
      ? await tx
          .select()
          .from(mediaObjects)
          .where(inArray(mediaObjects.id, objectIds))
          .for("update")
      : [];
    if (
      stored.length !== objectIds.length ||
      stored.some(
        ({ status }) => status !== "persisted" && status !== "deleting",
      )
    ) {
      return null;
    }
    const byId = new Map(stored.map((object) => [object.id, object]));
    const remaining = asset.videoSourceId
      ? await tx
          .select({ id: assets.id })
          .from(assets)
          .where(
            and(
              eq(assets.videoSourceId, asset.videoSourceId),
              ne(assets.id, asset.id),
              ne(assets.reviewStatus, "deleted"),
            ),
          )
          .for("update")
      : [];
    const now = new Date();
    if (asset.reviewStatus !== "deleted") {
      await tx
        .update(assets)
        .set({
          reviewStatus: "deleted",
          failureCode: "pending_asset_expired",
          failureMessage: "待审核素材超过保留期，已自动清理。",
          deletedAt: now,
          updatedAt: now,
        })
        .where(eq(assets.id, asset.id));
    }
    for (const objectId of objectIds) {
      await tx
        .update(mediaObjects)
        .set({ status: "deleting", updatedAt: now })
        .where(eq(mediaObjects.id, objectId));
    }
    const shape = (id: string | null) => {
      const object = id ? byId.get(id) : undefined;
      return object
        ? {
            id: object.id,
            provider: object.provider,
            objectKey: object.objectKey,
            localPath: object.localPath,
          }
        : null;
    };
    return {
      assetId: asset.id,
      taskId: asset.taskId,
      taskItemId: asset.taskItemId,
      taskItemSegmentId: asset.taskItemSegmentId,
      videoSourceId: asset.videoSourceId,
      object: shape(asset.mediaObjectId),
      thumbnailObject: shape(asset.thumbnailMediaObjectId),
      deleteVideoSource: Boolean(asset.videoSourceId && remaining.length === 0),
    };
  });
}

async function finalizeExpiredAsset(reservation: CleanupReservation) {
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx.delete(assets).where(eq(assets.id, reservation.assetId));
    if (reservation.taskItemSegmentId) {
      await tx
        .delete(taskItemSegments)
        .where(eq(taskItemSegments.id, reservation.taskItemSegmentId));
    }
    if (reservation.object) {
      await tx
        .delete(mediaObjects)
        .where(eq(mediaObjects.id, reservation.object.id));
    }
    if (reservation.thumbnailObject) {
      await tx
        .delete(mediaObjects)
        .where(eq(mediaObjects.id, reservation.thumbnailObject.id));
    }
    if (reservation.deleteVideoSource && reservation.videoSourceId) {
      await tx
        .delete(videoSources)
        .where(eq(videoSources.id, reservation.videoSourceId));
    }
    if (reservation.taskId && reservation.taskItemId) {
      await tx
        .update(taskItems)
        .set({
          status: "failed",
          phase: "finished",
          errorCode: "pending_asset_expired",
          errorMessage: "待审核素材超过保留期，媒体与分析记录已自动清理。",
          updatedAt: now,
        })
        .where(
          and(
            eq(taskItems.id, reservation.taskItemId),
            eq(taskItems.taskId, reservation.taskId),
          ),
        );
      const itemStates = await tx
        .select({ status: taskItems.status })
        .from(taskItems)
        .where(eq(taskItems.taskId, reservation.taskId));
      const failedItems = itemStates.filter(
        ({ status }) => status === "failed",
      ).length;
      const doneItems = itemStates.filter(({ status }) => status === "done").length;
      await tx
        .update(tasks)
        .set({
          status: "failed",
          phase: "finished",
          doneItems,
          failedItems,
          progressPercent: 100,
          errorCode: "pending_asset_expired",
          errorMessage: "一个或多个待审核素材超过保留期，已自动清理。",
          finishedAt: now,
          expiresAt: taskHistoryExpiresAt(now),
          updatedAt: now,
        })
        .where(eq(tasks.id, reservation.taskId));
    }
    // 标签字典只保留仍被至少一个素材引用的值。
    await tx.delete(tags).where(
      notExists(
        tx
          .select({ assetId: assetTags.assetId })
          .from(assetTags)
          .where(eq(assetTags.tagId, tags.id)),
      ),
    );
  });
}

/** 清理超过待审核保留期的素材，并让原上传任务从清理时刻重新进入保留期。 */
export async function cleanupExpiredPendingAssets(
  now = new Date(),
  storage: ObjectStorage = createZosObjectStorage(),
) {
  const config = loadConfig();
  const cutoff = new Date(
    now.getTime() - config.PENDING_ASSET_RETENTION_HOURS * 60 * 60 * 1_000,
  );
  const candidates = await db
    .select({ id: assets.id })
    .from(assets)
    .where(
      or(
        and(
          eq(assets.reviewStatus, "pending_review"),
          lt(assets.updatedAt, cutoff),
        ),
        and(
          eq(assets.reviewStatus, "deleted"),
          eq(assets.failureCode, "pending_asset_expired"),
        ),
      ),
    );
  let removed = 0;
  for (const candidate of candidates) {
    const reservation = await reserveExpiredAsset(candidate.id, cutoff);
    if (!reservation) continue;
    await deleteAnalysis(reservation.assetId);
    // 同一 pending 目录同时容纳本体、缩略图和关键帧，只删除一次即可。
    const objects = [reservation.object, reservation.thumbnailObject].filter(
      (object): object is NonNullable<typeof object> => Boolean(object),
    );
    const uniqueDeletionTargets = new Map(
      objects.map((object) => [
        object.provider === "local"
          ? `local:${object.localPath?.split("/").slice(0, 2).join("/")}`
          : `zos:${object.objectKey}`,
        object,
      ]),
    );
    for (const object of uniqueDeletionTargets.values()) {
      await deleteMediaObjectBytes(object, storage, config.mediaRoot);
    }
    await finalizeExpiredAsset(reservation);
    removed += 1;
  }
  return removed;
}
