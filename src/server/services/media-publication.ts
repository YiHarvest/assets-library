import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { loadConfig } from "@/server/config";
import { db } from "@/server/db";
import { assets, mediaObjects } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { resolveMediaPath } from "@/server/media/storage";
import { removePendingAsset } from "@/server/services/pending-media";
import type { ObjectStorage, StoredObject } from "@/server/storage/object-storage";

type StoredMedia = typeof mediaObjects.$inferSelect;
type StoredAsset = typeof assets.$inferSelect;

interface PublishTarget {
  asset: StoredAsset;
  object: StoredMedia;
  thumbnailObject: StoredMedia | null;
}

interface UploadedMedia {
  source: StoredMedia;
  stored: StoredObject;
}

function datePrefix(now: Date) {
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  ].join("/");
}

function extension(filename: string, fallback: string) {
  return path.extname(filename).toLowerCase() || fallback;
}

function objectKeys(target: PublishTarget) {
  const prefix = datePrefix(target.asset.createdAt);
  if (target.asset.mediaType === "image") {
    return {
      object: `assets/images/${prefix}/${target.asset.id}/original${extension(target.asset.originalFilename, ".bin")}`,
      thumbnail: null,
    };
  }
  const source = target.asset.videoSourceId ?? target.asset.id;
  const segment = String(target.asset.segmentIndex ?? 0).padStart(3, "0");
  return {
    object: `assets/videos/${prefix}/${source}/segments/${segment}-${target.asset.id}.mp4`,
    thumbnail: `assets/videos/${prefix}/${source}/thumbnails/${segment}-${target.asset.id}.jpg`,
  };
}

async function reserveTargets(
  assetId: string,
  expectedUserId: string | null,
  publishSiblingBatch: boolean,
) {
  return db.transaction(async (tx) => {
    const [anchor] = await tx
      .select()
      .from(assets)
      .where(eq(assets.id, assetId))
      .for("update")
      .limit(1);
    if (
      !anchor ||
      anchor.reviewStatus === "deleted" ||
      anchor.userId !== expectedUserId
    ) {
      throw new AppError("invalid_request", "素材不存在。", 404);
    }
    const targetAssets =
      publishSiblingBatch && anchor.taskItemId
        ? await tx
            .select()
            .from(assets)
            .where(eq(assets.taskItemId, anchor.taskItemId))
            .for("update")
        : [anchor];
    if (
      targetAssets.some(
        (asset) =>
          asset.userId !== expectedUserId ||
          asset.processingStatus !== "completed" ||
          asset.reviewStatus === "deleted",
      )
    ) {
      throw new AppError("invalid_request", "全部素材分析完成后才能入库。", 409);
    }
    if (targetAssets.every((asset) => asset.reviewStatus === "published")) {
      return [];
    }
    if (targetAssets.some((asset) => asset.reviewStatus !== "pending_review")) {
      throw new AppError("invalid_request", "素材发布状态不一致，请重试。", 409);
    }

    const mediaIds = targetAssets.flatMap((asset) =>
      [asset.mediaObjectId, asset.thumbnailMediaObjectId].filter(
        (id): id is string => Boolean(id),
      ),
    );
    const objects = mediaIds.length
      ? await tx
          .select()
          .from(mediaObjects)
          .where(inArray(mediaObjects.id, mediaIds))
          .for("update")
      : [];
    const byId = new Map(objects.map((object) => [object.id, object]));
    const targets = targetAssets.map((asset): PublishTarget => {
      const object = asset.mediaObjectId
        ? byId.get(asset.mediaObjectId)
        : undefined;
      const thumbnailObject = asset.thumbnailMediaObjectId
        ? (byId.get(asset.thumbnailMediaObjectId) ?? null)
        : null;
      if (
        !object ||
        object.provider !== "local" ||
        object.status !== "persisted" ||
        !object.localPath ||
        (asset.mediaType === "video" &&
          (!thumbnailObject ||
            thumbnailObject.provider !== "local" ||
            thumbnailObject.status !== "persisted" ||
            !thumbnailObject.localPath))
      ) {
        throw new AppError(
          "storage_error",
          "待审核素材的本地媒体对象不完整或正在被其他任务处理。",
          409,
        );
      }
      return { asset, object, thumbnailObject };
    });
    await tx
      .update(mediaObjects)
      .set({ status: "staging", updatedAt: new Date() })
      .where(inArray(mediaObjects.id, mediaIds));
    return targets;
  });
}

async function uploadAndVerify(
  storage: ObjectStorage,
  source: StoredMedia,
  key: string,
): Promise<UploadedMedia> {
  if (!source.localPath) {
    throw new AppError("storage_error", "待审核媒体缺少本地路径。", 500);
  }
  const stored = await storage.storeFile({
    key,
    filePath: resolveMediaPath(source.localPath),
    contentType: source.mimeType,
  });
  try {
    const head = await storage.headObject(key);
    if (
      stored.sizeBytes !== source.sizeBytes ||
      head.sizeBytes !== source.sizeBytes
    ) {
      throw new AppError("storage_error", "ZOS 对象大小校验失败。", 502);
    }
  } catch (error) {
    await storage.deleteObject(key).catch(() => undefined);
    throw error;
  }
  return { source, stored };
}

/**
 * 将一个待审核素材（自动视频批次时为全部兄弟切片）迁移到 ZOS。
 * 上传和 HEAD 校验完成后，MySQL 单事务切换所有对象并发布；失败反向补偿。
 */
export async function publishAssetMedia(input: {
  assetId: string;
  expectedUserId: string | null;
  publishSiblingBatch?: boolean;
  storage: ObjectStorage;
}) {
  const config = loadConfig();
  const targets = await reserveTargets(
    input.assetId,
    input.expectedUserId,
    input.publishSiblingBatch === true,
  );
  if (!targets.length) return [input.assetId];

  const uploaded: UploadedMedia[] = [];
  const reservedIds = targets.flatMap(({ object, thumbnailObject }) =>
    thumbnailObject ? [object.id, thumbnailObject.id] : [object.id],
  );
  try {
    for (const target of targets) {
      const keys = objectKeys(target);
      uploaded.push(
        await uploadAndVerify(input.storage, target.object, keys.object),
      );
      if (target.thumbnailObject && keys.thumbnail) {
        uploaded.push(
          await uploadAndVerify(
            input.storage,
            target.thumbnailObject,
            keys.thumbnail,
          ),
        );
      }
    }
    const uploadedById = new Map(
      uploaded.map((entry) => [entry.source.id, entry]),
    );
    await db.transaction(async (tx) => {
      const lockedObjects = await tx
        .select()
        .from(mediaObjects)
        .where(inArray(mediaObjects.id, reservedIds))
        .for("update");
      if (
        lockedObjects.length !== reservedIds.length ||
        lockedObjects.some(
          (object) => object.provider !== "local" || object.status !== "staging",
        )
      ) {
        throw new AppError("storage_error", "素材发布租约已失效。", 409);
      }
      const now = new Date();
      for (const object of lockedObjects) {
        const entry = uploadedById.get(object.id)!;
        await tx
          .update(mediaObjects)
          .set({
            provider: "zos",
            bucket: config.ZOS_BUCKET,
            objectKey: entry.stored.key,
            publicUrl: entry.stored.url ?? null,
            localPath: null,
            sizeBytes: entry.stored.sizeBytes,
            status: "persisted",
            updatedAt: now,
          })
          .where(eq(mediaObjects.id, object.id));
      }
      for (const target of targets) {
        const entry = uploadedById.get(target.object.id)!;
        await tx
          .update(assets)
          .set({
            originalPath: entry.stored.key,
            reviewStatus: "published",
            updatedAt: now,
          })
          .where(eq(assets.id, target.asset.id));
      }
    });
  } catch (error) {
    await Promise.allSettled(
      uploaded.reverse().map(({ stored }) =>
        input.storage.deleteObject(stored.key),
      ),
    );
    await db
      .update(mediaObjects)
      .set({ status: "persisted", updatedAt: new Date() })
      .where(inArray(mediaObjects.id, reservedIds))
      .catch(() => undefined);
    throw error;
  }

  // 数据库已指向 ZOS 后再回收本地；失败只会留下可离线清理的孤儿副本。
  await Promise.allSettled(
    targets.map(({ object }) =>
      removePendingAsset(object.localPath!, config.mediaRoot),
    ),
  );
  return targets.map(({ asset }) => asset.id);
}
